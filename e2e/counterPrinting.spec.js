/**
 * 2026-10-27, Three O'Clock: a captain's KOTs and bill print at the counter.
 *
 * The till is opened the way the launcher opens it (`?till=1`), with nothing
 * set on This device. A captain on a phone sends dishes from two stations:
 * the counter, sitting on the bills list, prints each KOT once. The captain
 * bills the table and taps Print at counter: the counter prints the bill once.
 * Then the counter's own KOT & Print prints its ticket once, not a second time
 * from the background printer.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { markReady } from './pages/kitchen.js';
import { addFromPanel, addItems, billOrder, sendToKitchen, serveAll, skipGuestDetails } from './pages/order.js';
import { openTable } from './pages/floor.js';

const DAY = '2026-09-26';
const kotPrints = (person) => person.prints.filter((print) => /KOT/.test(print.text) && !/TAX INVOICE/i.test(print.text));

test.describe.configure({ mode: 'serial' });

test("the till prints a captain's KOTs and bill, each once, on any screen", async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  // The till as the launcher opens it. Nothing chosen on This device.
  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto('/?till=1');
  const device = await counter.page.evaluate(() => JSON.parse(window.localStorage.getItem('caffeza.device')));
  expect(device).toMatchObject({ printCaptainBills: true, printKotsAtCounter: true, paperLength: 'ROLL', printWidth: 'STANDARD', edgeMargin: 'MORE' });
  await counter.page.goto('/bills');

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 3', 2);
  await addItems(captain.page, ['Caffe Latte', 'College Sandwich']);
  await sendToKitchen(captain.page);
  expect(captain.prints).toHaveLength(0);

  // The counter, on the bills list, prints the Send: both dishes, each once.
  await expect.poll(() => kotPrints(counter).map((print) => print.text).join('\n'), { timeout: 20_000 }).toContain('College Sandwich');
  expect(kotPrints(counter).map((print) => print.text).join('\n')).toContain('Caffe Latte');
  const kotsPrinted = kotPrints(counter).length;
  await counter.page.waitForTimeout(11_000);
  expect(kotPrints(counter)).toHaveLength(kotsPrinted);

  await markReady(station.page, 'Beverages', 'Table 3');
  await markReady(station.page, 'Live Kitchen', 'Table 3');
  await serveAll(captain.page);
  await billOrder(captain.page);
  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect(captain.page.getByText('Sent to the counter. It prints there.')).toBeVisible();

  await expect.poll(() => counter.prints.length, { timeout: 20_000 }).toBe(kotsPrinted + 1);
  expect(counter.prints.at(-1).text).toContain('Table 3');
  await counter.page.waitForTimeout(11_000);
  expect(counter.prints).toHaveLength(kotsPrinted + 1);
});

test("the counter's own KOT & Print prints once, not again from the background", async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto('/?till=1');
  await openTable(counter.page, 'Table 5', 2);
  const panel = counter.page.getByRole('complementary', { name: 'This order' });
  await expect(panel).toBeVisible();
  await counter.page.getByRole('button', { name: 'Add Caffe Latte', exact: true }).click();
  await addFromPanel(counter.page);
  await panel.getByRole('button', { name: 'KOT & Print' }).click();
  const asked = await counter.page.getByRole('dialog', { name: 'Guest details' }).waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (asked) await skipGuestDetails(counter.page);

  await expect.poll(() => kotPrints(counter).length, { timeout: 20_000 }).toBe(1);
  await counter.page.waitForTimeout(11_000);
  expect(kotPrints(counter)).toHaveLength(1);
});
