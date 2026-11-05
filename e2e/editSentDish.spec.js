/**
 * P42 through the screens, the real scenario: a table is sent, then the guest
 * changes their mind. The captain lowers a quantity, changes a note, removes
 * a drink and swaps a dish, with no PIN, because the kitchen has made none of
 * it. The kitchen login sees only its board, with each change on it.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { sendToKitchen } from './pages/order.js';
import { tickets } from './pages/kitchen.js';

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

test('a captain changes sent dishes, and the kitchen login sees only its tickets', async ({ browser }) => {
  const golden = await resetGolden();
  await at('13:10', DAY);
  const [owner, captainToken] = await Promise.all(['Owner', 'Khuman Singh'].map((name) => tokenOf(golden, name)));
  const { items, tables } = golden.ids;

  // A kitchen login, which the golden restaurant does not have.
  const kitchenPhone = '9555000101';
  await api('POST', '/users', owner, { name: 'Kitchen Tablet', phone: kitchenPhone, role: 'KITCHEN', password: golden.password });

  // Table 12, sent: 3 pasta, a pizza "less spicy", a latte.
  const order = await api('POST', '/orders', captainToken, {
    orderType: 'DINE_IN',
    tableId: tables['Table 12'],
    guestCount: 3,
    lines: [
      { menuItemId: items['Creamy Pesto Pasta'], quantity: 3 },
      { menuItemId: items['Half & Half Pizza'], quantity: 1, notes: 'Less spicy' },
      { menuItemId: items['Caffe Latte'], quantity: 1 },
    ],
  });
  await api('POST', `/orders/${order.id}/fire`, captainToken, { version: order.version });

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const page = captain.page;
  await page.goto(`/orders/${order.id}`);
  const openLines = async () => {
    // The Review button, visible on a phone, is the way to the sent dishes.
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    return page.getByRole('dialog').first();
  };
  const changeSheet = (dish) => page.getByRole('dialog', { name: `Change ${dish}` });
  const changeOn = async (dish) => {
    const lines = await openLines();
    await lines.locator('li').filter({ hasText: dish }).filter({ hasText: 'With the kitchen' }).getByRole('button', { name: 'Change', exact: true }).click();
    return changeSheet(dish);
  };

  // "Make it 2 pasta, not 3."
  let sheet = await changeOn('Creamy Pesto Pasta');
  await expect(sheet.getByLabel('Their PIN')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'One fewer' }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Creamy Pesto Pasta changed. The kitchen can see it.')).toBeVisible();
  await page.keyboard.press('Escape');

  // "No onion on the pizza too."
  sheet = await changeOn('Half & Half Pizza');
  await sheet.getByLabel('Note to chef').fill('Less spicy, no onion');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Half & Half Pizza changed. The kitchen can see it.')).toBeVisible();
  await page.keyboard.press('Escape');

  // "I don't want the latte."
  sheet = await changeOn('Caffe Latte');
  await sheet.getByRole('button', { name: 'Remove dish' }).click();
  await expect(page.getByText('Caffe Latte removed. The kitchen can see it.')).toBeVisible();
  await page.keyboard.press('Escape');

  // "Not the pizza after all: the noodle bowl."
  sheet = await changeOn('Half & Half Pizza');
  await sheet.getByRole('button', { name: 'Swap for another dish' }).click();
  await expect(page.getByText('Pick the replacement for Half & Half Pizza, then send it.')).toBeVisible();
  await page.getByRole('button', { name: 'Add Chilli Garlic Noodle Bowl', exact: true }).click();
  await page.screenshot({ path: 'e2e/screenshots/captain-review-bar-send.png' });
  await sendToKitchen(page);

  const after = await api('GET', `/orders/${order.id}`, captainToken);
  const live = after.lines.filter((line) => line.status !== 'CANCELLED').map((line) => `${line.quantity} ${line.itemName}`);
  expect(live.sort()).toEqual(['1 Chilli Garlic Noodle Bowl', '2 Creamy Pesto Pasta']);

  // The kitchen login: only the board, with every change on it.
  const kitchen = await signIn(browser, { name: 'Kitchen Tablet', phone: kitchenPhone, password: golden.password, device: 'tablet' });
  await expect(kitchen.page).toHaveURL(/\/kitchen$/);
  await expect(kitchen.page.getByRole('navigation')).toHaveCount(0);
  await kitchen.page.goto('/floor');
  await expect(kitchen.page).toHaveURL(/\/kitchen$/);
  await kitchen.page.getByRole('tab', { name: 'All stations' }).click();
  const ticket = tickets(kitchen.page, 'Table 12');
  await expect(ticket).toContainText('Chilli Garlic Noodle Bowl');
  await expect(ticket.locator('li').filter({ hasText: 'Creamy Pesto Pasta' }).filter({ hasText: 'Changed' }).first()).toBeVisible();
  await expect(ticket.locator('li').filter({ hasText: 'Caffe Latte' }).filter({ hasText: 'Cancelled, do not make' })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/captain-review-bar.png' });
  await kitchen.page.screenshot({ path: 'e2e/screenshots/kitchen-only.png', fullPage: true });
});
