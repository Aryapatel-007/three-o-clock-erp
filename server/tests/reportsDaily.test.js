/**
 * The daily, money and GST reports, R2 to R10, against the golden day. P15.
 *
 * Built once, with Swiggy at 2000 basis points so its payment freezes a rate,
 * and 26 September closed as the Manager with ₹3,400.00 counted, as in P10.
 * Every expected number comes from docs/TEST-DATA.md; none is adjusted to fit.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import { Bill } from '../models/Bill.js';
import { ALL_MODELS } from '../models/index.js';
import { REPORTS } from '../services/reports/registry.js';
import { splitBillAcrossPayments } from '../utils/tax.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { addNextDay, buildGoldenDay, GOLDEN_DATE, GOLDEN_EXPECTED, ist } from './helpers/goldenDay.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

let golden;
let baseUrl;

before(async () => {
  await startTestDatabase();
  baseUrl = await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  golden = await buildGoldenDay({ name: 'Cafezza', commissions: { SWIGGY: 2000 } });

  setClockForTests(ist('09:00', '2026-09-27'));
  const close = await request('POST', '/api/v1/day-close', {
    token: golden.tokens.MANAGER,
    body: { businessDate: GOLDEN_DATE, countedCashInPaise: 340000, note: 'Four rupees short' },
  });
  assert.equal(close.status, 201, JSON.stringify(close.body));
  resetClockForTests();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

afterEach(() => resetClockForTests());

const report = (name, query, token = golden.tokens.OWNER) =>
  request('GET', `/api/v1/reports/v2/${name}?${query}`, { token });
const day = `from=${GOLDEN_DATE}&to=${GOLDEN_DATE}`;
const section = (data, key) => data.sections.find((entry) => entry.key === key);
const line = (rows, name) => rows.find((row) => row.line === name);

async function withBroken(number, change, run) {
  const original = (await Bill.findOne({ restaurantId: golden.restaurant._id, billNumber: number })).toObject();
  await Bill.collection.updateOne({ _id: original._id }, change);
  try {
    return await run();
  } finally {
    await Bill.collection.replaceOne({ _id: original._id }, original);
  }
}

async function workbook(name, query, token = golden.tokens.OWNER) {
  const response = await fetch(`${baseUrl}/api/v1/reports/v2/${name}?${query}&format=xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `${name} ${response.status}`);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
  return book;
}

const sheetRows = (sheet) => {
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1)));
  return rows;
};

// ---------------------------------------------------------------------------

describe('R2 Day Close', () => {
  it('matches every section of TEST-DATA section 4 for 26 September, to the paisa', async () => {
    const response = await report('day-close', `date=${GOLDEN_DATE}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;
    assert.equal(data.report, 'R2');
    assert.equal(data.isClosed, true);
    assert.deepEqual(data.openDays, []);
    const expected = GOLDEN_EXPECTED;

    const sales = section(data, 'sales').rows;
    assert.equal(line(sales, 'Bills').count, expected.sales.billCount);
    assert.equal(line(sales, 'Covers').count, expected.sales.covers);
    const salesMoney = {
      'Item total': 'itemTotalInPaise', Discount: 'discountInPaise', 'Net sales': 'netSalesInPaise', CGST: 'cgstInPaise',
      SGST: 'sgstInPaise', GST: 'gstInPaise', 'Round-off': 'roundOffInPaise', 'Bill total': 'billTotalInPaise',
      'Average bill': 'averageBillInPaise', 'Average per cover': 'averagePerCoverInPaise',
    };
    for (const [name, key] of Object.entries(salesMoney)) assert.equal(line(sales, name).amountInPaise, expected.sales[key], name);

    const moneyRows = section(data, 'money').rows;
    const methodNames = { CASH: 'Cash', CARD: 'Card', UPI: 'UPI', ZOMATO_GOLD: 'Zomato Gold', DINEOUT: 'Dineout', EAZYDINER: 'EazyDiner', ZOMATO: 'Zomato', SWIGGY: 'Swiggy' };
    for (const [code, amount] of Object.entries(expected.methods)) assert.equal(line(moneyRows, methodNames[code]).amountInPaise, amount, code);
    assert.equal(line(moneyRows, 'Money in hand').amountInPaise, 470700);
    assert.equal(line(moneyRows, 'Platform money').amountInPaise, 401100);
    assert.equal(line(moneyRows, 'On Hold: E-210 Office').amountInPaise, 4700);
    assert.equal(line(moneyRows, 'On Hold: W-330 Office').amountInPaise, 50400);
    assert.equal(line(moneyRows, 'Unpaid').amountInPaise, 0);
    assert.equal(line(moneyRows, 'Total').amountInPaise, 926900);

    const cash = section(data, 'cash').rows;
    assert.equal(line(cash, 'Opening float').amountInPaise, 200000);
    assert.equal(line(cash, 'Cash from bills').amountInPaise, 175400);
    assert.equal(line(cash, 'Cash collections').amountInPaise, 0);
    // P29: paid in reads Top-ups and paid out Expenses, the same figures.
    assert.equal(line(cash, 'Top-ups').amountInPaise, 0);
    assert.equal(line(cash, 'Expenses').amountInPaise, 35000);
    assert.equal(line(cash, 'Expected cash').amountInPaise, 340400);
    assert.equal(line(cash, 'Counted cash').amountInPaise, 340000);
    assert.equal(line(cash, 'Cash difference').amountInPaise, -400);

    const orderTypes = section(data, 'orderTypes').rows;
    assert.deepEqual(
      orderTypes.map((row) => [row.line, row.count, row.covers, row.netSalesInPaise, row.amountInPaise]),
      [
        ['Dine-in', 12, 27, 721132, 757200],
        ['Takeaway', 1, 0, 44000, 46200],
        ['Delivery, Swiggy', 1, 0, 93000, 93000],
        ['Delivery, Zomato', 1, 0, 30500, 30500],
      ],
    );

    const gst = section(data, 'gst').rows;
    assert.deepEqual(gst.map((row) => [row.line, row.amountInPaise, row.cgstInPaise, row.sgstInPaise, row.gstInPaise]), [
      ['5%', 765132, 19131, 19126, 38257],
      ['GST paid by platform, section 9(5)', 123500, 0, 0, 0],
    ]);

    const controls = section(data, 'controls').rows;
    assert.deepEqual([line(controls, 'Discounts').count, line(controls, 'Discounts').amountInPaise], [6, 42390]);
    assert.deepEqual([line(controls, 'No Charge').count, line(controls, 'No Charge').amountInPaise], [1, 23000]);
    // P56. Single dishes cancelled are off the list, and still in the stored figures.
    assert.equal(line(controls, 'Items cancelled'), undefined);
    assert.equal(line(controls, 'Wasted value'), undefined);
    assert.deepEqual([line(controls, 'Orders cancelled').count, line(controls, 'Orders cancelled').amountInPaise], [0, 0]);
    assert.deepEqual([line(controls, 'Voided bills').count, line(controls, 'Voided bills').amountInPaise], [1, 34700]);

    const [invoices] = section(data, 'invoices').rows;
    assert.deepEqual(invoices, { line: 'CFA/C/', first: 'CFA/C/22442', last: 'CFA/C/22457', issued: 16, voided: 1, gaps: [] });
  });

  it('is the stored snapshot for a closed day, C12 passes, and fails once B06\'s stored total changes', async () => {
    const data = (await report('day-close', `date=${GOLDEN_DATE}`)).body.data;
    assert.equal(data.checks.find((check) => check.id === 'C12').passed, true);
    assert.equal(data.checks.find((check) => check.id === 'C9').difference, -400);

    const broken = await withBroken('CFA/C/22447', { $inc: { grandTotalInPaise: 100 } }, async () =>
      (await report('day-close', `date=${GOLDEN_DATE}`)).body.data,
    );
    const c12 = broken.checks.find((check) => check.id === 'C12');
    assert.equal(c12.passed, false);
    assert.deepEqual(c12.refs, ['2026-09-26']);
    assert.equal(line(section(broken, 'sales').rows, 'Bill total').amountInPaise, 926900, 'the stored snapshot, not a recount');
  });

  it('hides the expected cash from a manager', async () => {
    const data = (await report('day-close', `date=${GOLDEN_DATE}`, golden.tokens.MANAGER)).body.data;
    const cash = section(data, 'cash').rows;
    assert.equal(line(cash, 'Expected cash'), undefined);
    assert.equal(line(cash, 'Cash difference'), undefined);
    assert.equal(line(cash, 'Counted cash').amountInPaise, 340000);
  });
});

describe('R3 Sales by Day', () => {
  it('one row for 26 September with every TEST-DATA figure', async () => {
    const data = (await report('sales-by-day', day)).body.data;
    assert.equal(data.filterSentence, '26 Sep 2026. Business day starts 5:00 AM. All order types. Voided bills left out.');
    assert.equal(data.rows.length, 1);
    const [row] = data.rows;
    assert.deepEqual(
      [row.billCount, row.covers, row.itemTotalInPaise, row.discountInPaise, row.netSalesInPaise, row.gstInPaise, row.roundOffInPaise, row.billTotalInPaise, row.averageBillInPaise, row.averagePerCoverInPaise],
      [15, 27, 931022, 42390, 888632, 38257, 11, 926900, 59242, 26709],
    );
    assert.equal(data.totals.billTotalInPaise, 926900);
    assert.deepEqual(data.checks.map((check) => [check.id, check.passed]), [['C1', true], ['C5.6', true], ['C8', true]]);
    assert.deepEqual(row.drill.billCount, { report: 'R19', query: { from: GOLDEN_DATE, to: GOLDEN_DATE } });
  });

  it('with the next day added, 26 to 28 September has three rows, 28 September all zeros, and 27 and 28 open', async () => {
    await addNextDay(golden);
    const data = (await report('sales-by-day', `from=${GOLDEN_DATE}&to=2026-09-28`)).body.data;
    assert.deepEqual(data.rows.map((row) => row.businessDate), ['2026-09-26', '2026-09-27', '2026-09-28']);
    const last = data.rows[2];
    assert.equal(last.billCount, 0);
    assert.equal(last.billTotalInPaise, 0);
    assert.equal(last.averageBillInPaise, 0);
    assert.equal(data.rows[1].billTotalInPaise, 42000);
    assert.deepEqual(data.openDays, ['2026-09-27', '2026-09-28']);
    assert.equal(data.totals.billTotalInPaise, 926900 + 42000);
  });

  it('compares with the previous range of the same length', async () => {
    const data = (await report('sales-by-day', 'from=2026-09-27&to=2026-09-27&compare=previous')).body.data;
    assert.deepEqual(data.previous.filter, { from: GOLDEN_DATE, to: GOLDEN_DATE });
    assert.equal(data.previous.totals.billTotalInPaise, 926900);
  });
});

describe('R4 Hours and Weekdays', () => {
  it('puts net sales in the hour each bill was issued, and every hour adds up', async () => {
    const data = (await report('hours', day)).body.data;
    const byHour = section(data, 'byHour');
    assert.equal(byHour.rows.length, 24);
    const expected = { 12: [1, 47700], 13: [1, 137693], 14: [2, 136000], 15: [1, 75761], 16: [1, 71761], 17: [1, 93000], 18: [2, 35000], 19: [1, 48000], 20: [2, 107100], 21: [2, 84000], 23: [1, 52617] };
    for (const row of byHour.rows) {
      const [bills, net] = expected[row.hour] ?? [0, 0];
      assert.deepEqual([row.billCount, row.netSalesInPaise], [bills, net], `hour ${row.hour}`);
    }
    assert.equal(byHour.totals.netSalesInPaise, 888632);
    const grid = section(data, 'weekdayByHour');
    assert.equal(grid.rows.length, 7);
    assert.equal(grid.rows[0].weekday, 'Monday');
    assert.equal(grid.rows[5].weekday, 'Saturday');
    assert.equal(grid.rows[5].h20InPaise, 107100);
    assert.equal(data.checks[0].id, 'C5.5');
    assert.equal(data.checks[0].passed, true);
  });
});

describe('R5 Payments', () => {
  it('26 September by method, On Hold and unpaid, adding up to the bill total', async () => {
    const data = (await report('payments', day)).body.data;
    const [row] = section(data, 'days').rows;
    assert.deepEqual(
      [row.CASH, row.CARD, row.UPI, row.inHandInPaise, row.ZOMATO_GOLD, row.DINEOUT, row.EAZYDINER, row.ZOMATO, row.SWIGGY, row.platformInPaise, row.onHoldInPaise, row.unpaidInPaise, row.billTotalInPaise],
      [175400, 148100, 147200, 470700, 199800, 77800, 0, 30500, 93000, 401100, 55100, 0, 926900],
    );
    const labels = section(data, 'days').columns.map((column) => column.label);
    assert.ok(labels.includes('EazyDiner'), 'an unused method still has its column');
    assert.deepEqual(data.checks.map((check) => [check.id, check.passed]), [['C3', true], ['C4', true]]);
  });

  it('counts B14\'s payment at 12:02 AM on 27 September on 26 September', async () => {
    const b14 = await Bill.findOne({ restaurantId: golden.restaurant._id, billNumber: 'CFA/C/22457' });
    assert.equal(b14.payments[0].receivedAt.toISOString(), '2026-09-26T18:32:00.000Z');
    const data = (await report('payments', 'from=2026-09-27&to=2026-09-27')).body.data;
    assert.equal(section(data, 'days').rows[0].ZOMATO_GOLD, 0);
  });

  it('shows W-330 Office\'s cash collection on 27 September, which is not a sale', async () => {
    const data = (await report('payments', `from=${GOLDEN_DATE}&to=2026-09-27`)).body.data;
    const collections = section(data, 'collections').rows;
    assert.deepEqual(collections.map((row) => [row.businessDate, row.accountName, row.methodName, row.amountInPaise]), [
      ['2026-09-27', 'W-330 Office', 'Cash', 50400],
    ]);
    const next = section(data, 'days').rows[1];
    assert.equal(next.CASH, 0, 'a collection is not a payment on a bill');
    assert.equal(next.billTotalInPaise, 42000);
    assert.equal(next.unpaidInPaise, 42000, '27 September is open, so its unpaid bill shows');
  });

  it('refuses a manager', async () => {
    assert.equal((await report('payments', day, golden.tokens.MANAGER)).status, 403);
  });
});

describe('R6 Platform Money', () => {
  it('a Swiggy payout of ₹744.00 for 26 September is exactly as expected, and Zomato Gold has no rate set', async () => {
    setClockForTests(ist('12:00', '2026-10-02'));
    const payout = await request('POST', '/api/v1/platform-payouts', {
      token: golden.tokens.MANAGER,
      body: { method: 'SWIGGY', periodFrom: GOLDEN_DATE, periodTo: GOLDEN_DATE, amountReceivedInPaise: 74400, receivedOn: '2026-10-02' },
    });
    assert.equal(payout.status, 201, JSON.stringify(payout.body));
    resetClockForTests();

    const data = (await report('platform-money', day)).body.data;
    const [swiggy] = section(data, 'payouts').rows;
    assert.deepEqual([swiggy.methodName, swiggy.expectedInPaise, swiggy.amountReceivedInPaise, swiggy.differenceInPaise], ['Swiggy', 74400, 74400, 0]);
    const uncovered = section(data, 'uncovered').rows;
    const gold = uncovered.filter((row) => row.method === 'ZOMATO_GOLD');
    assert.equal(gold.length, 2);
    for (const row of gold) {
      assert.equal(row.commission, 'Rate not set');
      assert.equal(row.expectedInPaise, null);
    }
    assert.ok(!uncovered.some((row) => row.method === 'SWIGGY'), 'the Swiggy payment is covered by the payout');
    assert.equal(data.checks[0].id, 'C11');
    assert.equal(data.checks[0].passed, true);
  });
});

describe('R7 Cash Till', () => {
  it('26 September from the stored close', async () => {
    const data = (await report('cash-till', day)).body.data;
    // P29: R7 is two sections, the days and expenses by category.
    const [row] = data.sections.find((section) => section.key === 'days').rows;
    assert.deepEqual(
      [row.openingFloatInPaise, row.cashFromBillsInPaise, row.cashCollectionsInPaise, row.paidInInPaise, row.paidOutInPaise, row.expectedCashInPaise, row.countedCashInPaise, row.differenceInPaise, row.closedByName],
      [200000, 175400, 0, 0, 35000, 340400, 340000, -400, 'Manager'],
    );
    assert.equal(data.checks[0].id, 'C9');
    assert.equal(data.checks[0].passed, false);
    assert.equal(data.checks[0].severity, 'WARNING');
    assert.equal((await report('cash-till', day, golden.tokens.MANAGER)).status, 403);
  });
});

describe('R8 GST', () => {
  it('sections A to E for 26 September', async () => {
    const data = (await report('gst', day)).body.data;
    const byRate = section(data, 'byRate').rows;
    assert.deepEqual(byRate.map((row) => [row.taxRate, row.netSalesInPaise, row.cgstInPaise, row.sgstInPaise]), [['5%', 765132, 19131, 19126]]);
    const platform = section(data, 'platform');
    assert.deepEqual(platform.rows.map((row) => [row.platform, row.netSalesInPaise]), [['Swiggy', 93000], ['Zomato', 30500]]);
    assert.equal(platform.totals.netSalesInPaise, 123500);
    const notSales = section(data, 'notSales').rows;
    assert.equal(notSales[0].amountInPaise, 23000);
    assert.equal(notSales[1].amountInPaise, 34700);
    assert.deepEqual(section(data, 'documents').rows, [{ series: 'CFA/C/', first: 'CFA/C/22442', last: 'CFA/C/22457', issued: 16, voided: 1 }]);
    assert.equal(section(data, 'roundOff').rows[0].amountInPaise, 11);
    assert.deepEqual(data.checks.map((check) => [check.id, check.passed]), [['C1', true], ['C5.7', true], ['C6', true]]);
  });
});

describe('R9 Tally Export', () => {
  it('splitBillAcrossPayments: one payment, a split, a part-paid account charge, a 0% bill', () => {
    const bill = (payments, extra = {}) => ({
      billNumber: 'T',
      grandTotalInPaise: 79500,
      taxBreakdown: [{ taxRateBps: 500, taxableInPaise: 75761, taxInPaise: 3788, cgstInPaise: 1894, sgstInPaise: 1894 }],
      payments,
      ...extra,
    });
    const one = splitBillAcrossPayments(bill([{ method: 'CASH', amountInPaise: 79500 }]));
    assert.deepEqual(one.map((part) => [part.netSalesInPaise, part.cgstInPaise, part.sgstInPaise]), [[75761, 1894, 1894]]);

    const split = splitBillAcrossPayments(bill([{ method: 'CASH', amountInPaise: 50000 }, { method: 'UPI', amountInPaise: 29500 }]));
    assert.equal(split[0].netSalesInPaise + split[1].netSalesInPaise, 75761);
    assert.equal(split[0].cgstInPaise + split[1].cgstInPaise + split[0].sgstInPaise + split[1].sgstInPaise, 3788);

    const charged = splitBillAcrossPayments(bill([{ method: 'CASH', amountInPaise: 20000 }], { chargedToAccountInPaise: 59500 }));
    assert.deepEqual(charged.map((part) => part.kind), ['PAYMENT', 'ON_HOLD']);
    assert.equal(charged[0].netSalesInPaise + charged[1].netSalesInPaise, 75761);

    const zero = splitBillAcrossPayments({ billNumber: 'Z', grandTotalInPaise: 93000, taxBreakdown: [{ taxRateBps: 0, taxableInPaise: 93000, taxInPaise: 0, cgstInPaise: 0, sgstInPaise: 0 }], payments: [{ method: 'SWIGGY', amountInPaise: 93000 }] });
    assert.deepEqual(zero.map((part) => [part.netSalesInPaise, part.cgstInPaise]), [[93000, 0]]);

    const unpaid = splitBillAcrossPayments(bill([{ method: 'CASH', amountInPaise: 30000 }]));
    assert.deepEqual(unpaid.map((part) => [part.kind, part.amountInPaise]), [['PAYMENT', 30000], ['UNPAID', 49500]]);
  });

  it('splits 1,000 seeded random bills so every part adds back exactly', () => {
    let seed = 20261015;
    const random = (max) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let index = 0; index < 1000; index += 1) {
      const slabs = Array.from({ length: 1 + random(3) }, () => {
        const taxable = random(500000);
        const tax = random(30000);
        const cgst = Math.ceil(tax / 2);
        return { taxRateBps: 500, taxableInPaise: taxable, taxInPaise: tax, cgstInPaise: cgst, sgstInPaise: tax - cgst };
      });
      const grand = slabs.reduce((total, slab) => total + slab.taxableInPaise + slab.taxInPaise, 0) + random(100);
      const paymentCount = random(4);
      let left = grand;
      const payments = [];
      for (let p = 0; p < paymentCount && left > 0; p += 1) {
        const amount = p === paymentCount - 1 ? left : 1 + random(left);
        payments.push({ method: ['CASH', 'UPI', 'CARD'][p % 3], amountInPaise: amount });
        left -= amount;
      }
      const bill = { billNumber: `R${index}`, grandTotalInPaise: grand, taxBreakdown: slabs, payments, chargedToAccountInPaise: left > 0 && random(2) ? left : null };
      const parts = splitBillAcrossPayments(bill);
      const sum = (key) => parts.reduce((total, part) => total + part[key], 0);
      assert.equal(sum('netSalesInPaise'), slabs.reduce((total, slab) => total + slab.taxableInPaise, 0));
      assert.equal(sum('cgstInPaise'), slabs.reduce((total, slab) => total + slab.cgstInPaise, 0));
      assert.equal(sum('sgstInPaise'), slabs.reduce((total, slab) => total + slab.sgstInPaise, 0));
      assert.equal(sum('amountInPaise'), grand);
    }
  });

  it('B05\'s Cash and UPI parts add back exactly to ₹757.61 and ₹37.88', async () => {
    const b05 = await Bill.findOne({ restaurantId: golden.restaurant._id, billNumber: 'CFA/C/22446' }).lean();
    const parts = splitBillAcrossPayments(b05);
    assert.deepEqual(parts.map((part) => [part.method, part.amountInPaise]), [['CASH', 50000], ['UPI', 29500]]);
    assert.equal(parts[0].netSalesInPaise + parts[1].netSalesInPaise, 75761);
    assert.equal(parts[0].cgstInPaise + parts[0].sgstInPaise + parts[1].cgstInPaise + parts[1].sgstInPaise, 3788);
  });

  it('the file: both blocks for 26 September, totalling the same, with the Tally codes', async () => {
    assert.equal((await report('tally-export', day)).status, 400, 'a file only');
    const book = await workbook('tally-export', day);
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['Sales by rate', 'Sales by payment method', 'Filter', 'Definitions', 'Checks']);

    const byRate = sheetRows(book.getWorksheet('Sales by rate'));
    const rate = (name) => byRate.find((row) => row[0] === name);
    assert.deepEqual(rate('Sales 0%').slice(1), [1235, 0, 0, 1235]);
    assert.deepEqual(rate('5%').slice(1), [7651.32, 191.31, 191.26, 8033.89]);
    assert.equal(rate('Round-off')[4], 0.11);
    assert.deepEqual(rate('Total').slice(1), [8886.32, 191.31, 191.26, 9269]);

    const byMethod = sheetRows(book.getWorksheet('Sales by payment method'));
    const methodTotal = byMethod.find((row) => row[0] === 'Total');
    assert.deepEqual(methodTotal.slice(2, 5), [8886.32, 191.31, 191.26], 'the two blocks total the same');
    assert.equal(methodTotal[5], 9269);
    const onHold = byMethod.find((row) => row[1] === 'On Hold');
    assert.equal(onHold[0], 'P03');
    assert.equal(onHold[5], 551);
    assert.equal(byMethod.find((row) => row[1] === 'Swiggy')[0], '868');
  });

  it('refuses to build while an ERROR check fails, and names it', async () => {
    const response = await withBroken('CFA/C/22444', { $set: { roundOffInPaise: 60 } }, () =>
      fetch(`${baseUrl}/api/v1/reports/v2/tally-export?${day}&format=xlsx`, { headers: { Authorization: `Bearer ${golden.tokens.OWNER}` } }),
    );
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, 'CHECK_FAILED');
    assert.match(body.error.message, /C1 Bill arithmetic: bill CFA\/C\/22444/);
  });
});

describe('R10 Invoice Register', () => {
  it('16 rows, B11 voided with its reason, B09 and B10 On Hold, the rest Paid, nothing missing', async () => {
    const data = (await report('invoice-register', day)).body.data;
    assert.equal(data.filterSentence, '26 Sep 2026. Business day starts 5:00 AM. Voided bills included.');
    assert.equal(data.rows.length, 16);
    assert.deepEqual(data.rows.map((row) => row.billNumber), Array.from({ length: 16 }, (_, index) => `CFA/C/${22442 + index}`));
    const status = Object.fromEntries(data.rows.map((row) => [row.billNumber, row.status]));
    assert.equal(status['CFA/C/22452'], 'Voided');
    assert.equal(data.rows.find((row) => row.billNumber === 'CFA/C/22452').voidReason, 'Billed to the wrong table');
    assert.equal(status['CFA/C/22450'], 'On Hold');
    assert.equal(status['CFA/C/22451'], 'On Hold');
    assert.equal(Object.values(status).filter((value) => value === 'Paid').length, 13);
    assert.equal(data.totals.missing, 0);
    assert.equal(data.checks[0].passed, true);
  });

  it('shows a "Missing number" row for CFA/C/22452 when B11 is deleted, and C6 fails', async () => {
    const b11 = (await Bill.findOne({ restaurantId: golden.restaurant._id, billNumber: 'CFA/C/22452' })).toObject();
    await Bill.collection.deleteOne({ _id: b11._id });
    try {
      const data = (await report('invoice-register', day)).body.data;
      const row = data.rows.find((entry) => entry.billNumber === 'CFA/C/22452');
      assert.equal(row.status, 'Missing number');
      assert.equal(data.checks[0].id, 'C6');
      assert.equal(data.checks[0].passed, false);
    } finally {
      await Bill.collection.insertOne(b11);
    }
  });
});

describe('every report', () => {
  const QUERIES = {
    today: '',
    'day-close': `date=${GOLDEN_DATE}`,
    'sales-by-day': day,
    hours: day,
    payments: day,
    'platform-money': day,
    'cash-till': day,
    gst: day,
    'tally-export': day,
    'invoice-register': day,
    menu: day,
    captains: day,
    tables: day,
    discounts: day,
    cancellations: day,
    'no-charge': day,
    accounts: `asOf=${GOLDEN_DATE}`,
    bills: day,
  };

  it('exports a workbook that opens, with its sheets, and its totals equal the JSON', async () => {
    for (const [name, query] of Object.entries(QUERIES)) {
      const book = await workbook(name, query);
      const names = book.worksheets.map((sheet) => sheet.name);
      for (const sheet of ['Filter', 'Definitions', 'Checks']) assert.ok(names.includes(sheet), `${name}: ${sheet}`);
      if (name === 'tally-export') continue;
      const json = (await report(name, query)).body.data;
      const rows = sheetRows(book.getWorksheet('Report'));
      assert.equal(rows[0][0], json.title, name);
      assert.equal(rows[1][0], json.filterSentence, name);
    }
    const r3 = sheetRows((await workbook('sales-by-day', day)).getWorksheet('Report'));
    const header = r3.find((row) => row[0] === 'Business date');
    assert.equal(r3.at(-1)[header.indexOf('Bill total')], 9269);
  });

  it('answers each role as the contract\'s permission table says', async () => {
    // P65, changed on purpose: R20 is the owner's, and takes a month. This golden world has
    // September's other days open, so the owner gets past the role check to DAY_NOT_CLOSED.
    const ownerOnly = new Set(['payments', 'cash-till', 'ca-pack']);
    const ownerStatus = { 'ca-pack': 422 };
    for (const definition of REPORTS) {
      const query =
        definition.name === 'ca-pack' ? 'month=2026-09' : QUERIES[definition.name] + (definition.name === 'tally-export' ? '&format=xlsx' : '');
      for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER']) {
        const token = role === 'WAITER' ? golden.people['Khuman Singh'] : golden.tokens[role];
        const response = await fetch(`${baseUrl}/api/v1/reports/v2/${definition.name}?${query}`, { headers: { Authorization: `Bearer ${token}` } });
        const allowed = role === 'OWNER' || (role === 'MANAGER' && !ownerOnly.has(definition.name));
        if (allowed) assert.equal(response.status, role === 'OWNER' ? (ownerStatus[definition.name] ?? 200) : 200, `${role} ${definition.name}`);
        else assert.equal(response.status, 403, `${role} ${definition.name}`);
      }
    }
  });
});
