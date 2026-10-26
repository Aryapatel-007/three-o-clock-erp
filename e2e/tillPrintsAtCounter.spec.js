/**
 * 2026-10-25, through the screens: a manager's or cashier's phone has no bill
 * printer, so its bill prints at the counter, as a captain's does (API-CONTRACT
 * M3 16.3). On the cafe PC this is automatic (billsPrintAtCounter); here the
 * phone chooses "At the counter" on This device, so the test passes whichever
 * role the test server runs as.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { markReady } from './pages/kitchen.js';
import { addItems, sendToKitchen, serveAll } from './pages/order.js';
import { openTable } from './pages/floor.js';

const DAY = '2026-09-26';

test('a manager on a phone sends Save & Print to the counter, which prints it once', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto('/device');
  await counter.page.getByText('Print bills sent by captains').click();
  await counter.page.goto('/bills');

  const manager = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'phone' });
  await manager.page.goto('/device');
  await manager.page.getByRole('group', { name: 'Bills print' }).getByText('At the counter', { exact: true }).click();

  const station = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'tablet' });

  await openTable(manager.page, 'Table 3', 2);
  await addItems(manager.page, ['Caffe Latte']);
  await sendToKitchen(manager.page);
  await markReady(station.page, 'Beverages', 'Table 3');
  await serveAll(manager.page);

  await manager.page.reload();
  const box = manager.page.getByRole('region', { name: 'Bill' });
  await box.getByRole('button', { name: 'Save & Print at counter' }).click();
  await expect(manager.page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
  await expect(manager.page.getByText('Sent to the counter. Payment opens once it has printed.')).toBeVisible();

  // The counter prints it once; the phone prints nothing, and its payment opens once it has.
  await expect.poll(() => counter.prints.length, { timeout: 20_000 }).toBe(1);
  expect(counter.prints[0].text).toContain('Table 3');
  expect(manager.prints).toHaveLength(0);
  await expect(manager.page.getByRole('region', { name: 'Take payment' })).toBeVisible({ timeout: 15_000 });
  await counter.page.waitForTimeout(6_000);
  expect(counter.prints).toHaveLength(1);
});
