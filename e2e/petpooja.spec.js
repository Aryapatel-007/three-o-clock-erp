/**
 * P48 through the screens, PetPooja's way: the floor's colours, 🖨 and 👁; a
 * table's history; Recall Bill by number; the counter screen with a typed
 * extra and Send to the kitchen; Guest gave and Give back; and a busy kitchen board.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { addFromPanel, skipGuestDetails } from './pages/order.js';

const DAY = '2026-09-26';
const APP = 'http://127.0.0.1:5055/api/v1';

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

test('PetPooja\'s way: floor, history, Recall Bill, counter, change, kitchen', async ({ browser }) => {
  const golden = await resetGolden();
  await at('13:10', DAY);
  const [manager, captain, cashier] = await Promise.all(['Manager', 'Khuman Singh', 'Counter'].map((name) => tokenOf(golden, name)));
  const { items, tables } = golden.ids;
  const send = async (table, dishes) => {
    const order = await api('POST', '/orders', captain, { orderType: 'DINE_IN', tableId: tables[table], guestCount: 2, lines: dishes.map((name) => ({ menuItemId: items[name], quantity: 1 })) });
    return api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  };

  // A busy service: six tables sent.
  const busy = ['Table 3', 'Table 4', 'Table 5', 'Table 7', 'Table 11', 'Table 12'];
  for (const table of busy) await send(table, ['Creamy Pesto Pasta', 'Half & Half Pizza', 'Mexican Bowl']);

  // Table 2: served, billed and paid, for Recall Bill.
  const t2 = await send('Table 2', ['Caffe Latte']);
  for (const kot of t2.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);
  const served = await api('GET', `/orders/${t2.order.id}`, captain);
  const bill = await api('POST', '/bills', cashier, { orderId: served.id, version: served.version });
  await api('POST', `/bills/${bill.id}/printed`, cashier);

  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  const page = counter.page;

  // The floor: the legend, the PetPooja words, 🖨 and 👁 under a busy table.
  await page.goto('/floor');
  const legend = page.getByRole('list', { name: 'Table colours' });
  for (const word of ['Blank table', 'Running KOT table', 'Running table', 'Printed table']) await expect(legend).toContainText(word);
  await expect(page.getByRole('button', { name: /^Table 3, open, / })).toContainText('Running KOT');
  await expect(page.getByRole('button', { name: /^Table 2, bill printed, / })).toContainText('Printed');
  await page.screenshot({ path: 'e2e/screenshots/p48-floor.png' });

  // 👁: Table 3's day, read-only.
  await page.getByRole('button', { name: 'What Table 3 has had today' }).click();
  // Only the current order, simply: each KOT with its time and dishes, and the total.
  const history = page.getByRole('dialog', { name: 'Table 3' });
  await expect(history).toContainText('KOT');
  await expect(history).toContainText('Creamy Pesto Pasta');
  await expect(history).toContainText('Item total');
  await page.screenshot({ path: 'e2e/screenshots/p48-history.png' });
  await page.keyboard.press('Escape');

  // Recall Bill: the number opens the bill.
  const sequence = Number(bill.billNumber.split('/').at(-1));
  await page.getByRole('textbox', { name: 'Bill No' }).fill(String(sequence));
  await page.getByRole('textbox', { name: 'Bill No' }).press('Enter');
  await expect(page).toHaveURL(new RegExp(`/bills/${bill.id}`));

  // Guest gave ₹500 for the latte: Give back, large.
  const area = page.getByRole('region', { name: 'Take payment' });
  await area.getByRole('button', { name: /^Cash/ }).click();
  const gave = area.getByRole('region', { name: 'Guest gave' });
  await gave.getByRole('button', { name: /₹500/ }).click();
  await expect(gave).toContainText('Guest gave ₹500.00');
  await expect(gave).toContainText(/Give back ₹(?!0\.00)/);
  await page.screenshot({ path: 'e2e/screenshots/p48-change.png' });
  await area.getByRole('button', { name: /^Record payment/ }).click();
  await expect(page.getByText(/^Payment recorded/)).toBeVisible();
  const paid = await api('GET', `/bills/${bill.id}`, cashier);
  expect(paid.status).toBe('PAID');
  expect(paid.payments[0].tender.tenderedInPaise).toBe(50000);

  // The counter screen: Table 3's order beside the menu, a typed extra, Send to the kitchen.
  await page.goto('/floor');
  await page.getByRole('button', { name: /^Table 3, open, / }).click();
  const panel = page.getByRole('complementary', { name: 'This order' });
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Add Mexican Bowl', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Mexican Bowl' });
  await sheet.getByRole('button', { name: '+ Extra' }).click();
  await sheet.getByLabel('Extra 1', { exact: true }).fill('Extra cheese');
  await sheet.getByLabel('₹', { exact: true }).fill('30');
  await addFromPanel(page);
  await panel.getByRole('button', { name: /^Send \d+ to the kitchen$/ }).click();
  // P56. The table's first Send asks for the guest's details.
  const asked = await page.getByRole('dialog', { name: 'Guest details' }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (asked) await skipGuestDetails(page);
  await expect.poll(() => counter.prints.length).toBeGreaterThan(0);
  const order3 = (await api('GET', `/tables/${tables['Table 3']}/history`, cashier)).orders[0];
  expect(JSON.stringify(order3)).toContain('Extra cheese');
  await page.screenshot({ path: 'e2e/screenshots/p48-counter.png' });

  // The kitchen board, busy, on a wide screen.
  const kitchen = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });
  await kitchen.page.goto('/kitchen');
  await kitchen.page.getByRole('tab', { name: 'All stations' }).click();
  await expect(kitchen.page.getByText('KOT', { exact: false }).first()).toBeVisible();
  await kitchen.page.screenshot({ path: 'e2e/screenshots/p48-kitchen.png' });
});
