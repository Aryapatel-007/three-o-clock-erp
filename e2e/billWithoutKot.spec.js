/**
 * P60, through the screens: the counter bills a table without a KOT. The
 * cashier adds dishes, taps Bill without KOT, gives the guests, and Save &
 * Print prints the bill; the kitchen never sees a ticket.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { openTable } from './pages/floor.js';
import { addItems, details } from './pages/order.js';

const DAY = '2026-09-26';

test('the counter bills a table without a KOT, and the kitchen sees nothing', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await openTable(counter.page, 'Table 3');
  await addItems(counter.page, ['Caffe Latte', 'Water Bottle']);

  const order = await details(counter.page);
  await order.getByRole('button', { name: 'Bill without KOT' }).click();

  // The golden restaurant requires covers, so the Guest details sheet comes first, worded for the bill.
  const guest = counter.page.getByRole('dialog', { name: 'Guest details' });
  await guest.getByRole('button', { name: '2', exact: true }).click();
  await guest.getByRole('button', { name: 'Save and bill' }).click();

  const bill = counter.page.getByRole('region', { name: 'Bill' });
  await expect(bill.getByRole('heading', { name: 'Bill without KOT' })).toBeVisible();
  await expect(bill.getByText('Bill total')).toBeVisible();
  await bill.getByRole('button', { name: 'Save & Print' }).click();

  await expect(counter.page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
  await expect.poll(() => counter.prints.length, { timeout: 10_000 }).toBe(1);
  expect(counter.prints[0].text).toContain('Table 3');
  expect(counter.prints[0].text).toMatch(/Caffe Latte/);
  await counter.page.screenshot({ path: 'e2e/screenshots/bill-without-kot.png', fullPage: true });

  // Nothing reached the kitchen.
  const kitchen = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });
  await kitchen.page.goto('/kitchen');
  await kitchen.page.getByRole('tab', { name: 'All stations' }).click();
  await expect(kitchen.page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
  await expect(kitchen.page.locator('article').filter({ hasText: 'Table 3' })).toHaveCount(0);
});
