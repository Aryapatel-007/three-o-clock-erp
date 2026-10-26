/**
 * The golden day, docs/TEST-DATA.md section 2b, played through the real
 * screens, each person on their own kind of device, with the server's clock
 * and every browser's clock moved together to each row's time. P21.
 *
 * Nothing here calls the API. The one exception is the e2e server's control
 * listener, which moves the clock and sets up the restaurant before the day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';

import { at, resetGolden } from './helpers/clock.js';
import { setTheme, signIn } from './helpers/people.js';
import { applyDiscount, billNumber, chargeToAccount, expectPaid, gotoBill, pay, printBill, voidBill } from './pages/bill.js';
import { newDelivery, newTakeaway, recordCash, recordCollection } from './pages/counter.js';
import { expectTable, expectWaitingToPay, gotoFloor, openTable, openTableOrder } from './pages/floor.js';
import { markReady, openStation, tickets } from './pages/kitchen.js';
import { closeDay, setInvoiceSeries } from './pages/manager.js';
import { addItems, billOrder, cancelLine, giveNoCharge, removeUnsent, sendToKitchen, serveAll } from './pages/order.js';

/** The golden manager's PIN, as MANAGER_PIN in server/tests/helpers/goldenDay.js. */
const MANAGER_PIN = '2468';

const SCREENSHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');
const DAY = '2026-09-26';
const NEXT = '2026-09-27';

test.describe.configure({ mode: 'serial' });

test('the golden day, through the screens', async ({ browser }) => {
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  /** The whole screen, including what scrolls inside the app's frame. */
  const shot = async (person, name) => {
    const { page } = person;
    const size = page.viewportSize();
    const inner = await page.evaluate(() =>
      Math.max(0, ...[...document.querySelectorAll('div')].filter((el) => getComputedStyle(el).overflowY === 'auto').map((el) => el.scrollHeight)),
    );
    await page.setViewportSize({ width: size.width, height: Math.max(size.height, inner + 120) });
    await page.screenshot({ path: path.join(SCREENSHOTS, `${name}-${person.device}.png`), fullPage: true });
    await page.setViewportSize(size);
  };

  const golden = await resetGolden();
  const person = (name, device) => signIn(browser, { name, phone: golden.phones[name], password: golden.password, device });

  await at('10:00');
  const owner = await person('Owner', 'phone');
  const manager = await person('Manager', 'computer');
  const counter = await person('Counter', 'computer');
  const captains = {
    'Khuman Singh': await person('Khuman Singh', 'phone'),
    'Budha Singh': await person('Budha Singh', 'phone'),
    'Devendra Singh': await person('Devendra Singh', 'phone'),
    'Ranjeet Paswan': await person('Ranjeet Paswan', 'phone'),
  };
  // The two station tablets on the wall, signed in as the manager: the golden restaurant has no kitchen login.
  const liveKitchen = await signIn(browser, { name: 'Live Kitchen', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });
  const beverages = await signIn(browser, { name: 'Beverages', phone: golden.phones.Manager, password: golden.password, device: 'tablet' });

  const orders = {};
  const bills = {};

  /** A captain opens a table, adds the dishes and sends them. */
  const dineIn = async (id, captain, table, guests, items) => {
    const { page } = captains[captain];
    await openTable(page, table, guests);
    await addItems(page, items);
    await sendToKitchen(page);
    orders[id] = { url: page.url(), table, captain };
  };

  /** Both stations mark the place's tickets ready, the captain serves, the cashier bills. */
  const readyServeBill = async (id, orderOf = id) => {
    const order = orders[orderOf];
    const place = order.place ?? order.table;
    await markReady(liveKitchen.page, 'Live Kitchen', place);
    await markReady(beverages.page, 'Beverages', place);
    if (order.table) {
      const { page } = captains[order.captain];
      await openTableOrder(page, order.table);
      await serveAll(page);
      await openTableOrder(counter.page, order.table);
    } else {
      await counter.page.goto(order.url);
      await serveAll(counter.page);
    }
    bills[id] = await billOrder(counter.page);
  };

  const payAndCheck = async (id, payments, total) => {
    await gotoBill(counter.page, bills[id]);
    await pay(counter.page, payments);
    await expectPaid(counter.page, total);
  };

  const discount = async (id, options) => {
    await gotoBill(manager.page, bills[id]);
    await applyDiscount(manager.page, options);
  };

  /** A counter order's number, for its kitchen ticket ("Order 12"). */
  const orderNumberOn = async (page) => (await page.getByText(/^#\d+$/).first().textContent()).slice(1);

  await test.step('10:30 AM the owner sets the invoice series', async () => {
    await at('10:30');
    await setInvoiceSeries(owner.page, 'CFA/C/', 22442, 'Continue the CFA/C/ series from the old system');
  });

  await test.step('11:00 AM Manager: opening float ₹2,000.00', async () => {
    await at('11:00');
    await recordCash(manager.page, 'Opening float', [[500, 4]]);
  });

  await test.step('11:40 AM Khuman Singh opens Table 5', async () => {
    await at('11:40');
    await dineIn('B01', 'Khuman Singh', 'Table 5', 2, ['Sev Poori', 'Tiramisu Brownie', 'Extra Charges']);
  });

  await test.step('12:30 PM bills B01, 10% Regular guest, and prints it', async () => {
    await at('12:30');
    await readyServeBill('B01');
    await discount('B01', { percent: 10, reason: 'Regular guest' });
    await gotoBill(counter.page, bills.B01);
    await printBill(counter.page);
    await expect.poll(() => counter.prints.length).toBe(1);
    const { text } = counter.prints[0];
    expect(text).toContain('CFA/C/22442');
    expect(text).toContain('GSTIN');
    expect(text).toContain('501.00');
  });

  await test.step('12:36 PM cash ₹501.00', async () => {
    await at('12:36');
    await payAndCheck('B01', [['Cash', '501.00']], '₹501.00');
  });

  await test.step('1:01 PM Budha Singh opens Table 7, seven lines', async () => {
    await at('13:01');
    await dineIn('B02', 'Budha Singh', 'Table 7', 3, ['Indian Platters', 'Chilli Garlic Noodle Bowl', 'Mocha Flower', 'Roasted Papad', 'Laccha Tawa Paratha', 'Roasted Papad', 'Roasted Papad']);
  });

  await test.step('1:10 PM Khuman Singh opens Table 12', async () => {
    await at('13:10');
    await dineIn('B03', 'Khuman Singh', 'Table 12', 4, ['Creamy Pesto Pasta', 'Cheesy Tornado', 'Caffe Latte']);
  });

  await test.step('1:12 PM each station sees only its own dishes', async () => {
    await at('13:12');
    await openStation(liveKitchen.page, 'Live Kitchen');
    for (const table of ['Table 7', 'Table 12']) await expect(tickets(liveKitchen.page, table).first()).toBeVisible();
    await expect(tickets(liveKitchen.page, 'Table 7').filter({ hasText: 'Mocha Flower' })).toHaveCount(0);
    await expect(tickets(liveKitchen.page, 'Table 12').filter({ hasText: 'Caffe Latte' })).toHaveCount(0);
    await openStation(beverages.page, 'Beverages');
    await expect(tickets(beverages.page, 'Table 7')).toContainText('Mocha Flower');
    await expect(tickets(beverages.page, 'Table 12')).toContainText('Caffe Latte');
  });

  await test.step('1:52 PM bills B02, flat ₹73.07 Zomato Gold', async () => {
    await at('13:52');
    await readyServeBill('B02');
    await discount('B02', { amount: '73.07', reason: 'Zomato Gold' });
  });
  await test.step('1:58 PM Zomato Gold ₹1,446.00', async () => {
    await at('13:58');
    await payAndCheck('B02', [['Zomato Gold', '1446.00']], '₹1,446.00');
  });
  await test.step('2:02 PM bills B03', async () => {
    await at('14:02');
    await readyServeBill('B03');
  });
  await test.step('2:09 PM card ₹1,061.00', async () => {
    await at('14:09');
    await payAndCheck('B03', [['Card', '1061.00']], '₹1,061.00');
  });
  await test.step('2:20 PM Devendra Singh opens Table 2', async () => {
    await at('14:20');
    await dineIn('B04', 'Devendra Singh', 'Table 2', 1, ['Chole Kulcha Platter']);
  });
  await test.step('2:55 PM bills B04', async () => {
    await at('14:55');
    await readyServeBill('B04');
  });
  await test.step('2:58 PM UPI ₹368.00', async () => {
    await at('14:58');
    await payAndCheck('B04', [['UPI', '368.00']], '₹368.00');
  });
  await test.step('3:05 PM Budha Singh opens Table 3', async () => {
    await at('15:05');
    await dineIn('B05', 'Budha Singh', 'Table 3', 2, ['Half & Half Pizza', 'Ferrero Hazelnut Shake', 'Water Bottle']);
  });
  await test.step('3:50 PM bills B05', async () => {
    await at('15:50');
    await readyServeBill('B05');
  });
  await test.step('3:54 PM cash ₹500.00 and UPI ₹295.00', async () => {
    await at('15:54');
    await payAndCheck('B05', [['Cash', '500.00'], ['UPI', '295.00']], '₹795.00');
  });
  await test.step('4:10 PM Khuman Singh opens Table 14', async () => {
    await at('16:10');
    await dineIn('B06', 'Khuman Singh', 'Table 14', 2, ['Indian Platters', 'Caffe Latte', 'Water Bottle']);
  });
  await test.step('4:58 PM bills B06', async () => {
    await at('16:58');
    await readyServeBill('B06');
  });
  await test.step('5:03 PM cash ₹753.00', async () => {
    await at('17:03');
    await payAndCheck('B06', [['Cash', '753.00']], '₹753.00');
  });

  await test.step('5:20 PM Counter: Swiggy delivery 249377796192385', async () => {
    await at('17:20');
    const url = await newDelivery(counter.page, 'Swiggy', '249377796192385', ['Half & Half Pizza', 'Ferrero Hazelnut Shake', 'Caffe Latte']);
    orders.B07 = { url, place: `Order ${await orderNumberOn(counter.page)}` };
  });
  await test.step('5:21 PM bills B07, Swiggy ₹930.00', async () => {
    await at('17:21');
    await readyServeBill('B07');
    await payAndCheck('B07', [['Swiggy', '930.00']], '₹930.00');
  });

  await test.step('5:30 PM Ranjeet Paswan opens Table 29', async () => {
    await at('17:30');
    await dineIn('N01', 'Ranjeet Paswan', 'Table 29', 1, ['College Sandwich']);
  });
  await test.step('5:55 PM Manager: No Charge on Table 29, Corporate office order', async () => {
    await at('17:55');
    await openTableOrder(manager.page, 'Table 29');
    await giveNoCharge(manager.page, 'Corporate office order');
  });

  await test.step('6:05 PM Zomato delivery 8645938999, and Table 35', async () => {
    await at('18:05');
    const url = await newDelivery(counter.page, 'Zomato', '8645938999', ['Ferrero Hazelnut Shake', 'Masala Pav Sandwich']);
    orders.B08 = { url, place: `Order ${await orderNumberOn(counter.page)}` };
    await dineIn('B09', 'Ranjeet Paswan', 'Table 35', 1, ['Masala Tea']);
  });
  await test.step('6:06 PM bills B08, flat ₹200.00 Merchant promo TAKE200, Zomato ₹305.00', async () => {
    await at('18:06');
    await readyServeBill('B08');
    await discount('B08', { amount: '200.00', reason: 'Merchant promo', note: 'TAKE200' });
    await payAndCheck('B08', [['Zomato', '305.00']], '₹305.00');
  });
  await test.step('6:18 PM Ranjeet Paswan opens Table 30', async () => {
    await at('18:18');
    await dineIn('B10', 'Ranjeet Paswan', 'Table 30', 2, ['Mexican Bowl', 'Roasted Papad']);
  });
  await test.step('6:20 PM the floor shows Table 35 and Table 30 open, with their guests', async () => {
    await at('18:20');
    const { page } = captains['Ranjeet Paswan'];
    await gotoFloor(page);
    await expectTable(page, 'Table 35', 'Open', 1);
    await expectTable(page, 'Table 30', 'Open', 2);
  });
  await test.step('6:30 PM bills B09, 50% Staff or office, charged to E-210 Office', async () => {
    await at('18:30');
    await readyServeBill('B09');
    await discount('B09', { percent: 50, reason: 'Staff or office' });
    await chargeToAccount(manager.page, 'E-210 Office');
  });
  await test.step('7:10 PM bills B10, charged to W-330 Office', async () => {
    await at('19:10');
    await readyServeBill('B10');
    await gotoBill(manager.page, bills.B10);
    await chargeToAccount(manager.page, 'W-330 Office');
  });
  await test.step('7:20 PM Devendra Singh opens Table 16', async () => {
    await at('19:20');
    await dineIn('B11', 'Devendra Singh', 'Table 16', 2, ['Piri Piri Paneer Pizza']);
  });
  await test.step('7:40 PM Devendra Singh opens Table 18', async () => {
    await at('19:40');
    await dineIn('B16', 'Devendra Singh', 'Table 18', 3, ['Mumbaiya Pav Bhaji Platter', 'Ferrero Hazelnut Shake']);
  });
  await test.step('7:45 PM the floor on a captain\'s phone', async () => {
    await at('19:45');
    await gotoFloor(captains['Devendra Singh'].page);
    await shot(captains['Devendra Singh'], 'floor-0745pm');
  });
  await test.step('8:05 PM bills B11 for Table 16', async () => {
    await at('20:05');
    await readyServeBill('B11');
  });
  await test.step('8:06 PM the billing strip shows Table 16 waiting to pay', async () => {
    await at('20:06');
    await gotoFloor(counter.page);
    await expectWaitingToPay(counter.page, 'Table 16');
  });
  await test.step('8:09 PM Manager voids B11: Billed to the wrong table', async () => {
    await at('20:09');
    await gotoBill(manager.page, bills.B11);
    await voidBill(manager.page, 'Billed to the wrong table');
  });
  await test.step('8:11 PM bills the same order again: B12', async () => {
    await at('20:11');
    await openTableOrder(counter.page, 'Table 16');
    bills.B12 = await billOrder(counter.page);
  });
  await test.step('8:15 PM UPI ₹347.00', async () => {
    await at('20:15');
    await payAndCheck('B12', [['UPI', '347.00']], '₹347.00');
  });
  await test.step('8:30 PM Khuman Singh opens Table 11', async () => {
    await at('20:30');
    await dineIn('B13', 'Khuman Singh', 'Table 11', 3, ['Thecha Paneer Chilli', 'Mexican Bowl']);
  });
  await test.step('8:35 PM the kitchen on the Live Kitchen tablet', async () => {
    await at('20:35');
    await openStation(liveKitchen.page, 'Live Kitchen');
    await shot(liveKitchen, 'kitchen-0835pm');
  });
  await test.step('8:40 PM bills B16, flat ₹39.00 Dineout', async () => {
    await at('20:40');
    await readyServeBill('B16');
    await discount('B16', { amount: '39.00', reason: 'Dineout' });
  });
  await test.step('8:41 PM B16 reads CFA/C/22454', async () => {
    await at('20:41');
    await gotoBill(counter.page, bills.B16);
    await expect(billNumber(counter.page)).toHaveText('CFA/C/22454');
  });
  await test.step('8:46 PM Dineout ₹778.00', async () => {
    await at('20:46');
    await payAndCheck('B16', [['Dineout', '778.00']], '₹778.00');
  });
  await test.step('8:50 PM Khuman Singh adds Cheesy Tornado to Table 11 and removes it before sending', async () => {
    await at('20:50');
    const { page } = captains['Khuman Singh'];
    await openTableOrder(page, 'Table 11');
    await addItems(page, ['Cheesy Tornado']);
    await removeUnsent(page, 'Cheesy Tornado');
  });
  await test.step('8:55 PM Live Kitchen makes Table 11', async () => {
    await at('20:55');
    await markReady(liveKitchen.page, 'Live Kitchen', 'Table 11');
  });
  await test.step("9:00 PM Khuman Singh cancels Thecha Paneer Chilli, made, with the manager's PIN", async () => {
    await at('21:00');
    const { page } = captains['Khuman Singh'];
    await openTableOrder(page, 'Table 11');
    // P28: the dish was made, so a captain needs the manager to type their PIN on this phone.
    await cancelLine(page, 'Thecha Paneer Chilli', 'Guest changed the order', true, { name: 'Manager', pin: MANAGER_PIN });
  });
  await test.step('9:01 PM the kitchen no longer shows Thecha Paneer Chilli', async () => {
    await at('21:01');
    await openStation(liveKitchen.page, 'Live Kitchen');
    await expect(liveKitchen.page.getByText('Thecha Paneer Chilli')).toHaveCount(0);
  });
  await test.step('9:10 PM Counter: takeaway, Caffe Latte × 2', async () => {
    await at('21:10');
    const url = await newTakeaway(counter.page, [['Caffe Latte', 2]]);
    orders.B15 = { url, place: `Order ${await orderNumberOn(counter.page)}` };
  });
  await test.step('9:12 PM bills B15', async () => {
    await at('21:12');
    await readyServeBill('B15');
  });
  await test.step('9:13 PM UPI ₹462.00', async () => {
    await at('21:13');
    await payAndCheck('B15', [['UPI', '462.00']], '₹462.00');
  });
  await test.step('9:30 PM Manager: paid out ₹350.00, milk from the dairy', async () => {
    await at('21:30');
    await recordCash(manager.page, 'Paid out', '350.00', 'Milk from the dairy');
  });
  await test.step('9:40 PM bills B13', async () => {
    await at('21:40');
    await readyServeBill('B13');
  });
  await test.step('9:44 PM card ₹420.00', async () => {
    await at('21:44');
    await payAndCheck('B13', [['Card', '420.00']], '₹420.00');
  });
  await test.step('10:51 PM Budha Singh opens Table 4', async () => {
    await at('22:51');
    await dineIn('B14', 'Budha Singh', 'Table 4', 2, ['Cheesy Tornado', 'Sev Poori']);
  });
  await test.step('11:55 PM bills B14, flat ₹13.83 Zomato Gold; it reads CFA/C/22457', async () => {
    await at('23:55');
    await readyServeBill('B14');
    await discount('B14', { amount: '13.83', reason: 'Zomato Gold' });
    await gotoBill(counter.page, bills.B14);
    await expect(billNumber(counter.page)).toHaveText('CFA/C/22457');
    await shot(counter, 'table4-bill-1155pm');
  });
  await test.step('12:02 AM, 27 Sep: Zomato Gold ₹552.00, and the bills list still shows 26 September', async () => {
    await at('00:02', NEXT);
    await payAndCheck('B14', [['Zomato Gold', '552.00']], '₹552.00');
    await counter.page.goto('/bills');
    await expect(counter.page.getByLabel('From')).toHaveValue(DAY);
  });
  await test.step('12:30 AM, 27 Sep: Manager closes 26 September, blind, ₹3,400.00 with a note', async () => {
    await at('00:30', NEXT);
    await closeDay(manager.page, DAY, [[500, 6], [200, 2]], 'Four rupees short');
    await shot(manager, 'day-close-1230am');
  });

  const report = async (pathAndQuery) => {
    await owner.page.goto(`/reports/${pathAndQuery}`);
    await expect(owner.page.getByRole('region', { name: 'Checks' })).toBeVisible();
    return owner.page;
  };
  /** The row whose first cell is exactly `label`. */
  const row = (page, label, scope = page) =>
    scope.locator('tbody tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first();
  const range = `from=${DAY}&to=${DAY}`;

  await test.step('9:00 AM, 27 Sep: the owner reads the reports on the phone', async () => {
    await at('09:00', NEXT);

    let page = await report(`day-close?date=${DAY}`);
    await expect(page.getByText('Balanced, with 1 note')).toBeVisible();
    for (const [label, value] of [
      ['Bill total', '₹9,269.00'],
      ['Net sales', '₹8,886.32'],
      ['GST', '₹382.57'],
      ['Expected cash', '₹3,404.00'],
      ['Counted cash', '₹3,400.00'],
      ['Cash difference', '-₹4.00'],
    ]) await expect(row(page, label)).toContainText(value);
    await shot(owner, 'r2-next-morning');

    page = await report(`sales-by-day?${range}`);
    const day = page.locator('tbody tr').first();
    await expect(day).toContainText('15');
    await expect(day).toContainText('27');
    await expect(day).toContainText('₹267.09');

    page = await report(`payments?${range}`);
    const payments = page.locator('tbody tr').first();
    for (const value of ['₹1,754.00', '₹1,481.00', '₹1,472.00', '₹1,998.00', '₹778.00', '₹305.00', '₹930.00', '₹551.00']) {
      await expect(payments).toContainText(value);
    }

    page = await report(`gst?${range}`);
    for (const value of ['₹7,651.32', '₹191.31', '₹191.26', '₹1,235.00']) await expect(page.locator('main')).toContainText(value);

    page = await report(`invoice-register?${range}`);
    await expect(page.locator('tbody tr').filter({ hasText: /^CFA\/C\/224/ })).toHaveCount(16);
    await expect(row(page, 'CFA/C/22442')).toBeVisible();
    await expect(row(page, 'CFA/C/22457')).toBeVisible();
    await expect(row(page, 'CFA/C/22452')).toContainText('Voided');
    await expect(page.getByText('Missing number')).toHaveCount(0);

    page = await report(`menu?${range}`);
    await expect(row(page, 'Pizza')).toContainText('₹1,800.78');
    await expect(row(page, 'Pizza')).toContainText('20.26%');
    await shot(owner, 'r11-next-morning');

    page = await report(`captains?${range}`);
    await expect(row(page, 'Khuman Singh')).toContainText('₹2,735.00');

    // P56. Whole cancellations only: B11's void is there, the two single dishes are not.
    page = await report(`cancellations?${range}`);
    await expect(page.locator('main')).toContainText('CFA/C/22452');
    await expect(page.locator('main')).not.toContainText('Thecha Paneer Chilli');

    page = await report(`no-charge?${range}`);
    await expect(page.locator('tbody tr').filter({ hasText: '₹230.00' })).toHaveCount(1);

    page = await report('accounts');
    await expect(row(page, 'E-210 Office')).toContainText('₹47.00');
    await expect(row(page, 'W-330 Office')).toContainText('₹504.00');
  });

  await test.step('9:00 AM, 27 Sep: R3 as Excel, and R11 Pizza drills to five bills', async () => {
    let page = await report(`sales-by-day?${range}`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel', exact: true }).click()]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(await download.path());
    const sheet = workbook.getWorksheet('Report');
    let netSalesColumn = null;
    let total = null;
    sheet.eachRow((sheetRow) => {
      const values = sheetRow.values;
      const index = values.findIndex((value) => value === 'Net sales');
      if (index > 0 && netSalesColumn === null) netSalesColumn = index;
      if (values[1] === 'Total' && netSalesColumn !== null) total = values[netSalesColumn];
    });
    expect(total).toBe(8886.32);

    page = await report(`menu?${range}`);
    await row(page, 'Pizza').getByRole('link', { name: '₹1,800.78' }).click();
    await expect(page).toHaveURL(/\/reports\/bills/);
    await expect(page.locator('tbody tr').filter({ hasText: /^CFA\/C\// })).toHaveCount(5);
  });

  await test.step('1:15 PM, 27 Sep: W-330 Office pays ₹504.00 in cash, and owes nothing', async () => {
    await at('13:15', NEXT);
    await recordCollection(counter.page, 'W-330 Office', 'Cash', '504.00');
    const page = await report('accounts');
    await expect(row(page, 'W-330 Office')).toContainText('₹0.00');
  });

  await test.step('the floor and R2 in Day and in Night', async () => {
    for (const theme of ['DAY', 'NIGHT']) {
      const { page } = captains['Khuman Singh'];
      await setTheme(captains['Khuman Singh'], theme);
      await gotoFloor(page);
      await shot(captains['Khuman Singh'], `floor-${theme.toLowerCase()}`);
      await setTheme(owner, theme);
      await report(`day-close?date=${DAY}`);
      await shot(owner, `r2-${theme.toLowerCase()}`);
    }
  });
});
