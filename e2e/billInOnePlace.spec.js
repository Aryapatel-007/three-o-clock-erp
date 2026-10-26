/**
 * P57 through the screens: a served table's Bill box shows the total before
 * anything is made, a 10% discount lowers it before saving, and Save & Print
 * makes the bill with the discount, prints it once, and asks for the payment.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';

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

test('a manager discounts a served table before the bill is made, then Save & Print', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', DAY);
  const [manager, captain] = await Promise.all(['Manager', 'Budha Singh'].map((name) => tokenOf(golden, name)));

  // Table 3: two pizzas, made and served, no bill.
  const { items, tables } = golden.ids;
  const order = await api('POST', '/orders', captain, {
    orderType: 'DINE_IN',
    tableId: tables['Table 3'],
    guestCount: 2,
    lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 2 }],
  });
  const fired = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);

  await at('15:40', DAY);
  const desk = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });
  const page = desk.page;
  await page.goto(`/orders/${order.id}`);

  // The Bill box, with its total, before anything is made. No old one-tap bill button.
  const box = page.getByRole('region', { name: 'Bill' });
  await expect(box.getByText('Bill total')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bill this order' })).toHaveCount(0);
  const total = box.getByText('Bill total').locator('xpath=following-sibling::*[1]');
  const before = await total.textContent();
  const served = await api('GET', `/orders/${order.id}`, captain);
  expect(served.billId ?? null).toBeNull();

  // 10% for a regular guest: chosen here, nothing saved yet, and the total falls.
  await box.getByRole('button', { name: 'Add discount' }).click();
  const sheet = page.getByRole('dialog', { name: 'Apply discount' });
  await sheet.getByRole('button', { name: /^10%/ }).click();
  await sheet.getByRole('button', { name: 'Regular guest', exact: true }).click();
  await sheet.getByRole('button', { name: /^Apply discount/ }).click();
  await expect(sheet).toBeHidden();
  await expect(box.getByText('10% · Regular guest')).toBeVisible();
  await expect(total).not.toHaveText(before);
  const after = await total.textContent();
  expect((await api('GET', `/orders/${order.id}`, captain)).billId ?? null).toBeNull();

  // Save & Print: one bill, with the discount, printed once, and the payment asked next.
  await box.getByRole('button', { name: 'Save & Print' }).click();
  await expect(page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
  await expect(page.getByRole('region', { name: 'Take payment' })).toBeVisible();
  await expect.poll(() => desk.prints.length).toBe(1);
  const bill = await api('GET', `/bills/${page.url().split('/').at(-1)}`, manager);
  expect(bill.discount.rateBps).toBe(1000);
  expect(bill.discount.reasonCode).toBe('REGULAR_GUEST');
  expect(bill.printCount).toBe(1);
  await expect(page.getByText(after.trim()).first()).toBeVisible();
});

test('a captain on a phone sees the Bill box, gives no discount, and sends the bill to the counter', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', DAY);
  const [manager, captainToken] = await Promise.all(['Manager', 'Khuman Singh'].map((name) => tokenOf(golden, name)));
  const { items, tables } = golden.ids;
  const order = await api('POST', '/orders', captainToken, {
    orderType: 'DINE_IN',
    tableId: tables['Table 4'],
    guestCount: 2,
    lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 1 }],
  });
  const fired = await api('POST', `/orders/${order.id}/fire`, captainToken, { version: order.version });
  for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const page = captain.page;
  await page.goto(`/orders/${order.id}`);
  const box = page.getByRole('region', { name: 'Bill' });
  await expect(box.getByText('Bill total')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Add discount' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e/screenshots/p57-bill-box-phone.png', fullPage: true });

  await box.getByRole('button', { name: 'Save & Print at counter' }).click();
  await expect(page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
  const bill = await api('GET', `/bills/${page.url().split('/').at(-1)}`, manager);
  expect(bill.printRequestedAt).not.toBeNull();
  expect(captain.prints.length).toBe(0);
});
