/**
 * P40 through the screens: a cashier adds dishes to a bill already printed.
 * The first dish asks for a manager's PIN; once it is on, the next dish in the
 * same visit goes straight on. The bill keeps its number and shows both
 * additions, each approved by the manager.
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

test('a cashier adds to a printed bill with a manager PIN, asked once', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', DAY);
  const [manager, captain, cashier] = await Promise.all(['Manager', 'Budha Singh', 'Counter'].map((name) => tokenOf(golden, name)));

  // Table 3: a pizza, cooked, billed and printed at the counter.
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
  await api('POST', `/bills/${bill.id}/printed`, cashier);

  await at('15:40', DAY);
  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  const page = counter.page;
  await page.goto(`/bills/${bill.id}`);
  await page.getByRole('button', { name: 'Add to this bill' }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${order.id}`));

  // The first dish asks a manager.
  await page.getByRole('button', { name: 'Add Water Bottle', exact: true }).click();
  let sheet = page.getByRole('dialog');
  await expect(sheet.getByText('This bill has been printed. A manager approves adding to it.')).toBeVisible();
  const add = sheet.getByRole('button', { name: /^Add to order/ });
  await expect(add).toBeDisabled();
  await sheet.getByRole('button', { name: 'Manager', exact: true }).click();
  await sheet.getByLabel('Their PIN').fill('2468');
  await add.click();
  await expect(sheet).toHaveCount(0);

  // The next dish in the same visit goes straight on.
  // 2026-11-03: + adds at once, with the approval kept from the first dish, so no sheet opens.
  await page.getByRole('button', { name: 'Add Water Bottle', exact: true }).click();
  await expect.poll(async () => (await api('GET', `/bills/${bill.id}`, cashier)).revisions.length).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const revised = await api('GET', `/bills/${bill.id}`, cashier);
  expect(revised.billNumber).toBe(bill.billNumber);
  expect(revised.revisions.map((revision) => revision.kind)).toEqual(['ADDED', 'ADDED']);
  for (const revision of revised.revisions) expect(revision.approvedBy).toBeTruthy();
  await page.screenshot({ path: 'e2e/screenshots/printed-bill-add.png', fullPage: true });
});
