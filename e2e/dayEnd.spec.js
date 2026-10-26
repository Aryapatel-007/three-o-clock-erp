/**
 * P44 and P61 through the screens: the manager emails the day-end message,
 * then closes the day on Day End's one screen, with a stray empty table that
 * closes by itself. The cashier reaches the same screen.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { typeOnKeypad } from './pages/keypad.js';

const DAY = '2026-09-26';
const APP = 'http://127.0.0.1:5055/api/v1';
const CONTROL = 'http://127.0.0.1:5056';

async function api(method, path, token, body) {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(parsed)}`);
  return parsed.data;
}
const tokenOf = async (golden, name) => (await api('POST', '/auth/login', null, { phone: golden.phones[name], password: golden.password })).accessToken;

test.describe.configure({ mode: 'serial' });

test('the manager emails the day-end message and closes the day on one screen', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', DAY);
  const [owner, manager, captain, cashier] = await Promise.all(['Owner', 'Manager', 'Budha Singh', 'Counter'].map((name) => tokenOf(golden, name)));
  await api('PATCH', '/settings', owner, { reason: 'Day-end email', reports: { dayEndEmails: ['z.chaat25@gmail.com'] } });

  // Table 3: one pizza, billed and paid in cash.
  const { items, tables } = golden.ids;
  const order = await api('POST', '/orders', captain, {
    orderType: 'DINE_IN',
    tableId: tables['Table 3'],
    guestCount: 2,
    lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 1 }],
  });
  const fired = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);
  const served = await api('GET', `/orders/${order.id}`, captain);
  const bill = await api('POST', '/bills', cashier, { orderId: order.id, version: served.version });
  await api('POST', `/bills/${bill.id}/payments`, cashier, { method: 'CASH', amountInPaise: bill.grandTotalInPaise });

  // P61. A stray tap on Table 5 opened an order with nothing on it.
  const stray = await api('POST', '/orders', captain, { orderType: 'DINE_IN', tableId: tables['Table 5'], guestCount: 1 });
  // And Table 4: food sent, never billed.
  const sentOrder = await api('POST', '/orders', captain, {
    orderType: 'DINE_IN',
    tableId: tables['Table 4'],
    guestCount: 1,
    lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 1 }],
  });
  await api('POST', `/orders/${sentOrder.id}/fire`, captain, { version: sentOrder.version });

  await at('22:30', DAY);
  const person = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });
  const page = person.page;
  await page.getByRole('link', { name: 'Day End' }).first().click();
  await expect(page).toHaveURL(/\/day-end/);
  await expect(page.getByRole('heading', { name: 'Day End', level: 1 })).toBeVisible();

  // The day in one line.
  await expect(page.getByRole('region', { name: 'Today' }).getByText('₹399.00').first()).toBeVisible();

  // The stray table does not stop the close; it closes by itself.
  const before = page.getByRole('region', { name: 'Before you close' });
  await expect(before).toContainText('These close by themselves');
  await expect(before).toContainText('Table 5 · nothing added');
  // Table 4 stops the close: Cancel order is the manager's cancel, kept in the cancellations report.
  await expect(before).toContainText(`Order ${sentOrder.orderNumber} on Table 4 is still open.`);
  await expect(page.getByRole('button', { name: /^Close 26 / })).toBeDisabled();
  await before.getByRole('link', { name: 'Cancel order' }).click();
  const cancel = page.getByRole('dialog', { name: `Cancel order #${sentOrder.orderNumber}` });
  await cancel.getByRole('button', { name: 'Opened twice', exact: true }).click();
  await cancel.getByText('No, it was not started').click();
  await cancel.getByRole('button', { name: /^Cancel it/ }).click();
  await expect(page).toHaveURL(/\/day-end/);
  await expect(page.getByRole('region', { name: 'Before you close' })).not.toContainText('Table 4');

  // The day's details and the message, folded below.
  await page.getByText("Day's details").click();
  await expect(page.getByRole('region', { name: 'Day at a glance' }).getByText('₹399.00')).toBeVisible();
  const messageBox = page.getByRole('region', { name: 'Day-end message' });
  await expect(messageBox).toContainText('Gross Sale - 399');
  await expect(messageBox).toContainText('Grand Total Cash in hand - —');
  await messageBox.getByRole('button', { name: 'Email this report' }).click();
  await expect(page.getByText('Emailed to z.chaat25@gmail.com.')).toBeVisible();
  const { emails } = await (await fetch(`${CONTROL}/emails`)).json();
  const last = emails.at(-1);
  expect(last.to).toEqual(['z.chaat25@gmail.com']);
  expect(last.text).toContain('Gross Sale - 399');
  expect(last.text).not.toContain('Cash in hand - —');
  await page.screenshot({ path: 'e2e/screenshots/day-end.png', fullPage: true });

  // Count the drawer and close: the ₹399 cash sale, blind.
  await expect(page.getByText('Expected cash')).toHaveCount(0);
  await typeOnKeypad(page.getByRole('region', { name: 'Cash in the drawer' }), '399');
  await expect(page.getByText('stays in the drawer for tomorrow')).toBeVisible();
  await page.getByRole('button', { name: /^Close 26 / }).click();
  await expect(page.getByText('Closed', { exact: true })).toBeVisible();
  await expect(page.getByText('kept for tomorrow')).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/day-end-closed.png', fullPage: true });

  const strayAfter = await api('GET', `/orders/${stray.id}`, manager);
  expect(strayAfter.status).toBe('CANCELLED');
  expect(strayAfter.cancelReasonCode).toBe('OPENED_BY_MISTAKE');

  // P61. The cashier reaches Day End from the menu.
  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto(`/day-end?date=${DAY}`);
  await expect(counter.page.getByRole('heading', { name: 'Day End', level: 1 })).toBeVisible();
  await expect(counter.page.getByText('Closed', { exact: true })).toBeVisible();
});
