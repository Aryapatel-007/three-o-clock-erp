/**
 * P29 Part E, through the screens: a station ticks the wrong dish, taps Undo in
 * the bar, ticks the right one, and the captain's screen shows the right dish
 * ready and the other still with the kitchen.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { openStation, tickDish, tickets } from './pages/kitchen.js';

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

test('a wrong tick in the kitchen, undone', async ({ browser }) => {
  const golden = await resetGolden();
  await at('13:10', DAY);
  const captainToken = await tokenOf(golden, 'Khuman Singh');

  // Table 12: two dishes for Live Kitchen.
  const { items, tables } = golden.ids;
  const order = await api('POST', '/orders', captainToken, {
    orderType: 'DINE_IN',
    tableId: tables['Table 12'],
    guestCount: 2,
    lines: ['Creamy Pesto Pasta', 'Half & Half Pizza'].map((name) => ({ menuItemId: items[name], quantity: 1 })),
  });
  await api('POST', `/orders/${order.id}/fire`, captainToken, { version: order.version });

  await at('13:30', DAY);
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });
  await openStation(station.page, 'Live Kitchen');
  await expect(tickets(station.page, 'Table 12')).toHaveCount(1);

  // The wrong one, then Undo in the bar.
  await tickDish(station.page, 'Table 12', 'Creamy Pesto Pasta');
  const bar = station.page.getByRole('status').filter({ hasText: 'Creamy Pesto Pasta marked ready.' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(station.page.getByText('Back with the kitchen.')).toBeVisible();

  // The right one.
  await tickDish(station.page, 'Table 12', 'Half & Half Pizza');
  await expect(station.page.getByRole('status').filter({ hasText: 'Half & Half Pizza marked ready.' })).toBeVisible();

  // 2026-10-21. Small tiles for a rush: narrower tickets, the switch without its word, kept on this device.
  const ticket = tickets(station.page, 'Table 12');
  await expect(ticket.getByText('Cooking', { exact: true })).toBeVisible();
  await station.page.getByRole('button', { name: 'Small tiles' }).click();
  await expect(station.page.getByRole('button', { name: 'Small tiles' })).toHaveAttribute('aria-pressed', 'true');
  await expect(ticket.getByText('Cooking', { exact: true })).toHaveCount(0);
  await expect(ticket.getByText('Hold: 1 left')).toBeVisible();
  await expect(ticket.getByRole('switch', { name: 'Creamy Pesto Pasta ready' })).toHaveAttribute('aria-checked', 'false');
  await station.page.reload();
  await expect(station.page.getByRole('button', { name: 'Small tiles' })).toHaveAttribute('aria-pressed', 'true');
  await station.page.getByRole('button', { name: 'Big tiles' }).click();
  await expect(tickets(station.page, 'Table 12').getByText('Cooking', { exact: true })).toBeVisible();

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  await captain.page.goto(`/orders/${order.id}`);
  await captain.page.getByRole('button', { name: /Item total, before GST/ }).click();
  const sheet = captain.page.getByRole('dialog');
  await expect(sheet.locator('li').filter({ hasText: 'Half & Half Pizza' }).getByText('Ready', { exact: true })).toBeVisible();
  await expect(sheet.locator('li').filter({ hasText: 'Creamy Pesto Pasta' }).getByText('With the kitchen', { exact: true })).toBeVisible();
  await captain.page.screenshot({ path: 'e2e/screenshots/kitchen-undo.png', fullPage: true });
});
