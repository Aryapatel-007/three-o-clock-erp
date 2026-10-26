/**
 * P58 through the screens: with "A separate ticket for each station" off, the
 * kitchen screen has no station chips, a Send across two stations is one
 * ticket with both dishes, and a later Send from the same table is a second
 * ticket.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
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
const lines = (golden, dishes) => dishes.map((dish) => ({ menuItemId: golden.ids.items[dish], quantity: 1 }));

test.describe.configure({ mode: 'serial' });

test('one ticket per Send, whole, with no station chips', async ({ browser }) => {
  const golden = await resetGolden();
  await at('13:10', DAY);
  const owner = await tokenOf(golden, 'Owner');
  await api('PATCH', '/settings', owner, { reason: 'Tickets by table', kitchen: { oneTicketPerOrder: false, splitTicketsByStation: false } });

  // A pasta (Live Kitchen) and a latte (Beverages) in one Send.
  const captain = await tokenOf(golden, 'Khuman Singh');
  const order = await api('POST', '/orders', captain, {
    orderType: 'DINE_IN',
    tableId: golden.ids.tables['Table 12'],
    guestCount: 2,
    lines: lines(golden, ['Creamy Pesto Pasta', 'Caffe Latte']),
  });
  const first = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  expect(first.kots).toHaveLength(1);

  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });
  const page = station.page;
  await page.goto('/kitchen');
  await expect(tickets(page, 'Table 12')).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Station' })).toHaveCount(0);
  const ticket = tickets(page, 'Table 12').first();
  await expect(ticket.getByText('Creamy Pesto Pasta')).toBeVisible();
  await expect(ticket.getByText('Caffe Latte')).toBeVisible();

  // The same table orders again later: a second ticket, not a round on the first.
  await at('13:25', DAY);
  const added = await api('POST', `/orders/${order.id}/lines`, captain, { version: first.order.version, lines: lines(golden, ['Caffe Latte']) });
  const second = await api('POST', `/orders/${order.id}/fire`, captain, { version: added.version });
  expect(second.kot.kotNumber).toBeGreaterThan(first.kot.kotNumber);
  await page.reload();
  await expect(tickets(page, 'Table 12')).toHaveCount(2);
  await expect(page.getByText(`KOT ${second.kot.kotNumber}`, { exact: false }).first()).toBeVisible();

  await station.context.close();
});
