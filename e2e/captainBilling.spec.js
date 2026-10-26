/**
 * P25 Part D, through the screens: a captain on a phone makes a bill and
 * sends it to the counter; the counter computer, set to print bills sent by
 * captains, prints it once, and once only with two tabs of the till open.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { markReady } from './pages/kitchen.js';
import { addItems, billOrder, sendToKitchen, serveAll } from './pages/order.js';
import { openTable } from './pages/floor.js';

const DAY = '2026-09-26';

test.describe.configure({ mode: 'serial' });

test('a captain bills a table and it prints once at the counter', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  // The counter computer prints bills sent by captains.
  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto('/device');
  await counter.page.getByText('Print bills sent by captains').click();
  await counter.page.goto('/bills');

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 3', 2);
  await addItems(captain.page, ['Caffe Latte']);
  await sendToKitchen(captain.page);
  await markReady(station.page, 'Beverages', 'Table 3');
  await serveAll(captain.page);
  await billOrder(captain.page);

  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect(captain.page.getByText('Sent to the counter. It prints there.')).toBeVisible();
  expect(captain.prints).toHaveLength(0);

  // The counter polls every 5 seconds, prints the bill, and never again.
  await expect.poll(() => counter.prints.length, { timeout: 20_000 }).toBe(1);
  expect(counter.prints[0].text).toContain('Table 3');
  expect(counter.prints[0].text).toMatch(/Caffe Latte/);
  await counter.page.waitForTimeout(11_000);
  expect(counter.prints).toHaveLength(1);
});

test('with two tabs open at the counter, a captain bill still prints once', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await counter.page.goto('/device');
  await counter.page.getByText('Print bills sent by captains').click();
  await counter.page.goto('/bills');
  // The cashier opens a second tab of the till on the same computer.
  const secondTab = await counter.context.newPage();
  await secondTab.goto('/reports');

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 4', 2);
  await addItems(captain.page, ['Caffe Latte']);
  await sendToKitchen(captain.page);
  await markReady(station.page, 'Beverages', 'Table 4');
  await serveAll(captain.page);
  await billOrder(captain.page);
  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect(captain.page.getByText('Sent to the counter. It prints there.')).toBeVisible();

  await expect.poll(() => counter.prints.length, { timeout: 20_000 }).toBe(1);
  await counter.page.waitForTimeout(11_000);
  expect(counter.prints).toHaveLength(1);
  expect(counter.prints[0].text).toContain('Table 4');
});

test('P59: with two counter devices printing captain bills, a bill prints once', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  // Two separate browsers at the counter, as the silent-printing profile beside an everyday Chrome window.
  const counters = [];
  for (const [name, phone] of [['Counter', golden.phones.Counter], ['Manager', golden.phones.Manager]]) {
    const device = await signIn(browser, { name, phone, password: golden.password, device: 'computer' });
    await device.page.goto('/device');
    await device.page.getByText('Print bills sent by captains').click();
    await device.page.goto('/bills');
    counters.push(device);
  }

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Station', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 5', 2);
  await addItems(captain.page, ['Caffe Latte']);
  await sendToKitchen(captain.page);
  await markReady(station.page, 'Beverages', 'Table 5');
  await serveAll(captain.page);
  await billOrder(captain.page);
  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect(captain.page.getByText('Sent to the counter. It prints there.')).toBeVisible();

  const printed = () => counters.reduce((sum, device) => sum + device.prints.length, 0);
  await expect.poll(printed, { timeout: 20_000 }).toBe(1);
  await counters[0].page.waitForTimeout(11_000);
  expect(printed()).toBe(1);
});

test('with no counter printing captain bills, the captain is told why after 30 seconds', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  // A counter on a new address (the cafe PC) has "Print bills sent by captains" off.
  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 3', 2);
  await addItems(captain.page, ['Caffe Latte']);
  await sendToKitchen(captain.page);
  await markReady(station.page, 'Beverages', 'Table 3');
  await serveAll(captain.page);
  await billOrder(captain.page);

  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect(captain.page.getByText('Sent to the counter. It prints there.')).toBeVisible();
  const hint = captain.page.getByText('Not printed yet.', { exact: false });
  await expect(hint).toBeHidden();
  await expect(hint).toBeVisible({ timeout: 40_000 });
  await expect(hint).toContainText('Print bills sent by captains');
});

test('the cafe PC print window prints a captain bill by itself, with no till open', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);

  // The print window, as print-agent.ps1 opens it; its device switch was never touched.
  const printer = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  await printer.page.goto('/print-station');
  await expect(printer.page.getByRole('heading', { name: 'Dakaar printer' })).toBeVisible();

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const station = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  await openTable(captain.page, 'Table 3', 2);
  await addItems(captain.page, ['Caffe Latte']);
  await sendToKitchen(captain.page);
  await markReady(station.page, 'Beverages', 'Table 3');
  await serveAll(captain.page);
  await billOrder(captain.page);

  await captain.page.getByRole('button', { name: 'Print at counter' }).click();
  await expect.poll(() => printer.prints.length, { timeout: 20_000 }).toBe(1);
  expect(printer.prints[0].text).toContain('Table 3');
  await expect(printer.page.getByText('Table 3')).toBeVisible();
  expect(captain.prints).toHaveLength(0);
  await printer.page.waitForTimeout(11_000);
  expect(printer.prints).toHaveLength(1);
});
