/**
 * P29 Part F: the cash book. docs/API-CONTRACT.md M16 section 9, M19 R7 and
 * R2, M21 section 9.2, RECONCILIATION-RULES C9 and C14.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { AuditLog } from '../models/AuditLog.js';
import { ALL_MODELS } from '../models/index.js';
import { vouchersFromRecords } from '../services/integrations/tally/vouchers.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { GOLDEN_DATE, ist, playGoldenDay, setupGoldenRestaurant } from './helpers/goldenDay.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const DAY_BEFORE = '2026-09-25';
const NEXT_DAY = '2026-09-27';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
});

after(async () => {
  resetClockForTests();
  await stopTestServer();
  await stopTestDatabase();
});

afterEach(() => resetClockForTests());

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};
const cash = (token, body) => request('POST', '/api/v1/cash-movements', { token, body });
const cashBook = async (token, date = null) => ok(await request('GET', `/api/v1/cash-book${date ? `?date=${date}` : ''}`, { token }), 'cash book');

/** The golden restaurant with 25 September closed on ₹2,000.00 kept for tomorrow. */
async function restaurantWithKeptFloat(name) {
  const golden = await setupGoldenRestaurant({ name });
  setClockForTests(ist('10:00', DAY_BEFORE));
  ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 200000 }), 'float 25th');
  setClockForTests(ist('23:00', DAY_BEFORE));
  ok(
    await request('POST', '/api/v1/day-close', {
      token: golden.tokens.MANAGER,
      body: { businessDate: DAY_BEFORE, countedCashInPaise: 200000, keptForTomorrowInPaise: 200000 },
    }),
    'close 25th',
  );
  resetClockForTests();
  return golden;
}

describe('the golden day through the cash book', () => {
  let golden;

  before(async () => {
    golden = await restaurantWithKeptFloat('Cash Book Cafe');
    await playGoldenDay(golden, { broughtForward: true });
  });

  it('brings ₹2,000.00 forward, files the milk under Milk and dairy, and holds ₹3,404.00', async () => {
    setClockForTests(ist('23:30'));
    const book = await cashBook(golden.tokens.OWNER, GOLDEN_DATE);
    assert.equal(book.broughtForward.fromDate, DAY_BEFORE);
    assert.equal(book.broughtForward.keptInPaise, 200000);
    assert.equal(book.broughtForward.confirmed.broughtForwardFrom, DAY_BEFORE);
    assert.equal(book.broughtForward.confirmed.openingDifferenceInPaise, null);
    assert.equal(book.openingFloatInPaise, 200000);
    assert.equal(book.expenses.totalInPaise, 35000);
    assert.deepEqual(book.expenses.byCategory, [{ code: 'MILK', label: 'Milk and dairy', amountInPaise: 35000, count: 1 }]);
    assert.equal(book.cashSales.totalInPaise, 175400);
    assert.equal(book.cashTakenOut.totalInPaise, 0);
    assert.equal(book.cashInDrawerInPaise, 340400);
    assert.equal(book.yesterday.businessDate, DAY_BEFORE);
    assert.equal(book.yesterday.keptForTomorrowInPaise, 200000);
  });

  it('closes on a count of ₹3,400.00, −₹4.00, keeps ₹2,000.00 and takes ₹1,400.00 out to the bank', async () => {
    setClockForTests(ist('23:40'));
    const closed = ok(
      await request('POST', '/api/v1/day-close', {
        token: golden.tokens.OWNER,
        body: { businessDate: GOLDEN_DATE, countedCashInPaise: 340000, note: '₹4 short', keptForTomorrowInPaise: 200000, takenOutTo: 'BANK_DEPOSIT' },
      }),
      'close',
    );
    assert.equal(closed.expectedCashInPaise, 340400);
    assert.equal(closed.differenceInPaise, -400);
    assert.equal(closed.keptForTomorrowInPaise, 200000);
    assert.equal(closed.takenOutAtCloseInPaise, 140000);
    assert.equal(closed.takenOutTo, 'BANK_DEPOSIT');
    const c14 = closed.checks.find((check) => check.id === 'C14');
    assert.equal(c14.passed, true, c14.message);
    assert.equal(closed.checks.find((check) => check.id === 'C9').difference ?? closed.checks.find((check) => check.id === 'C9').actual - 340400, -400);
  });

  it('proposes ₹2,000.00 brought forward from 26 September the next morning', async () => {
    setClockForTests(ist('10:00', NEXT_DAY));
    const book = await cashBook(golden.tokens.CASHIER);
    assert.equal(book.businessDate, NEXT_DAY);
    assert.deepEqual({ from: book.broughtForward.fromDate, kept: book.broughtForward.keptInPaise, confirmed: book.broughtForward.confirmed }, { from: GOLDEN_DATE, kept: 200000, confirmed: null });
    assert.equal(book.yesterday.takenOutAtCloseInPaise, 140000);
    assert.equal(book.yesterday.takenOutTo, 'BANK_DEPOSIT');
  });

  it('R7 shows the cash book lines and expenses by category; R2 shows them in its cash section', async () => {
    setClockForTests(ist('10:00', NEXT_DAY));
    const r7 = ok(await request('GET', `/api/v1/reports/v2/cash-till?from=${GOLDEN_DATE}&to=${GOLDEN_DATE}`, { token: golden.tokens.OWNER }), 'R7');
    const [row] = r7.sections.find((section) => section.key === 'days').rows;
    assert.deepEqual(
      [row.broughtForwardInPaise, row.openingFloatInPaise, row.paidInInPaise, row.paidOutInPaise, row.cashTakenOutInPaise, row.expectedCashInPaise, row.countedCashInPaise, row.differenceInPaise, row.keptForTomorrowInPaise, row.takenOutAtCloseInPaise],
      [200000, 200000, 0, 35000, 0, 340400, 340000, -400, 200000, 140000],
    );
    const categories = r7.sections.find((section) => section.key === 'expensesByCategory');
    assert.deepEqual(categories.rows.map((entry) => [entry.businessDate, entry.categoryLabel, entry.amountInPaise]), [[GOLDEN_DATE, 'Milk and dairy', 35000]]);
    assert.equal(r7.checks.find((check) => check.id === 'C14').passed, true);

    const r2 = ok(await request('GET', `/api/v1/reports/v2/day-close?date=${GOLDEN_DATE}`, { token: golden.tokens.OWNER }), 'R2');
    const lines = r2.sections.find((section) => section.key === 'cash').rows.map((entry) => [entry.line, entry.amountInPaise]);
    for (const expected of [[`Brought forward from ${DAY_BEFORE}`, 200000], ['Expenses: Milk and dairy', 35000], ['Kept for tomorrow', 200000], ['Taken out at close', 140000]]) {
      assert.ok(lines.some(([line, amount]) => line === expected[0] && amount === expected[1]), `${expected[0]}: ${JSON.stringify(lines)}`);
    }
    assert.equal(r2.checks.find((check) => check.id === 'C12').passed, true);
  });
});

describe('cash taken out during the day', () => {
  it('lowers cash in drawer by ₹1,000.00, is no expense in R7, and is a contra entry in Tally', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Bank Run Cafe' });
    setClockForTests(ist('10:00'));
    ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 500000 }), 'float');
    const before = (await cashBook(golden.tokens.OWNER)).cashInDrawerInPaise;
    const refused = await cash(golden.tokens.CASHIER, { type: 'CASH_TAKEN_OUT', amountInPaise: 100000, destination: 'BANK_DEPOSIT' });
    assert.equal(refused.status, 403);
    const taken = ok(await cash(golden.tokens.MANAGER, { type: 'CASH_TAKEN_OUT', amountInPaise: 100000, destination: 'BANK_DEPOSIT' }), 'taken out');
    assert.equal(taken.destination, 'BANK_DEPOSIT');
    const book = await cashBook(golden.tokens.OWNER);
    assert.equal(book.cashInDrawerInPaise, before - 100000);
    assert.equal(book.cashTakenOut.totalInPaise, 100000);
    assert.equal(book.expenses.totalInPaise, 0);
    assert.equal(await AuditLog.countDocuments({ restaurantId: golden.restaurant._id, action: 'CASH_TAKEN_OUT' }), 1);

    const r7 = ok(await request('GET', `/api/v1/reports/v2/cash-till?from=${GOLDEN_DATE}&to=${GOLDEN_DATE}`, { token: golden.tokens.OWNER }), 'R7');
    const [row] = r7.sections.find((section) => section.key === 'days').rows;
    assert.equal(row.paidOutInPaise, 0);
    assert.equal(row.cashTakenOutInPaise, 100000);
    assert.equal(r7.checks.find((check) => check.id === 'C9').severity, 'WARNING', 'the drawer still adds up');

    const { vouchers, missing } = (() => {
      const result = vouchersFromRecords(
        { bills: [], collections: [], cashMovements: [{ type: 'CASH_TAKEN_OUT', amountInPaise: 100000, destination: 'BANK_DEPOSIT' }], takenOutAtClose: { amountInPaise: 50000, destination: 'OWNER' } },
        { businessDate: GOLDEN_DATE, ledgers: { paymentMethods: { CASH: 'Cash' }, bank: 'HDFC Bank', ownerDrawings: 'Owner Drawings' }, voucherTypes: { sales: 'Sales', receipt: 'Receipt', payment: 'Payment', journal: 'Journal' } },
      );
      return { vouchers: result.vouchers ?? result, missing: result.missing ?? [] };
    })();
    const contra = vouchers.find((voucher) => voucher.kind === 'CONTRA');
    assert.equal(contra.voucherTypeName, 'Contra');
    assert.deepEqual(contra.entries.map((entry) => [entry.ledger, entry.side, entry.amountInPaise]), [['HDFC Bank', 'DEBIT', 100000], ['Cash', 'CREDIT', 100000]]);
    const drawings = vouchers.find((voucher) => voucher.entries.some((entry) => entry.ledger === 'Owner Drawings'));
    assert.equal(drawings.kind, 'PAYMENT');
    assert.equal(vouchers.some((voucher) => voucher.entries.some((entry) => /paid out|Petty/i.test(entry.ledger))), false, 'never an expense');
    assert.deepEqual([...(missing ?? [])], []);
  });
});

describe('a float brought forward that differs', () => {
  it('needs a note, records the difference, and raises C14', async () => {
    const golden = await restaurantWithKeptFloat('Recount Cafe');
    setClockForTests(ist('10:00'));
    const noNote = await cash(golden.tokens.CASHIER, { type: 'OPENING_FLOAT', broughtForward: true, amountInPaise: 190000 });
    assert.equal(noNote.status, 422);
    assert.match(noNote.body.error.message, /Say why the drawer is not what was kept/);
    const float = ok(await cash(golden.tokens.CASHIER, { type: 'OPENING_FLOAT', broughtForward: true, amountInPaise: 190000, reason: 'One ₹100 note short' }), 'float');
    assert.equal(float.broughtForwardFrom, DAY_BEFORE);
    assert.equal(float.openingDifferenceInPaise, -10000);
    assert.equal(await AuditLog.countDocuments({ restaurantId: golden.restaurant._id, action: 'OPENING_FLOAT_DIFFERED' }), 1);

    const day = ok(await request('GET', `/api/v1/day-close/${GOLDEN_DATE}`, { token: golden.tokens.OWNER }), 'day');
    const c14 = day.checks.find((check) => check.id === 'C14');
    assert.equal(c14.passed, false);
    assert.equal(c14.severity, 'WARNING');
    assert.match(c14.message, /opened with ₹1,900\.00, but 2026-09-25 kept ₹2,000\.00\. Note: One ₹100 note short/);
  });
});

describe('who sees the cash in the drawer', () => {
  it('leaves it and every difference out for a cashier, until the owner switches it on; the owner always sees it', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Blind Cafe' });
    setClockForTests(ist('10:00'));
    ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 200000 }), 'float');
    const check = ok(await cash(golden.tokens.CASHIER, { type: 'CASH_CHECK', amountInPaise: 199000 }), 'check');
    assert.equal(check.differenceInPaise, undefined, 'a cashier is told only that the check was saved');

    const blind = await cashBook(golden.tokens.CASHIER);
    assert.equal('cashInDrawerInPaise' in blind, false);
    assert.equal('differenceInPaise' in blind.lastCheck, false);
    assert.ok(blind.movements.every((movement) => !('differenceInPaise' in movement) && !('expectedCashInPaise' in movement)));
    const listed = ok(await request('GET', '/api/v1/cash-movements', { token: golden.tokens.CASHIER }), 'list');
    assert.ok(listed.movements.every((movement) => !('differenceInPaise' in movement)));

    const owner = await cashBook(golden.tokens.OWNER);
    assert.equal(owner.cashInDrawerInPaise, 200000);
    assert.equal(owner.lastCheck.differenceInPaise, -1000);

    ok(await request('PATCH', '/api/v1/settings', { token: golden.tokens.OWNER, body: { reason: 'Show the cashier', cash: { showDrawerTotalToStaff: true } } }), 'switch');
    const shown = await cashBook(golden.tokens.CASHIER);
    assert.equal(shown.cashInDrawerInPaise, 200000);
    assert.equal(shown.lastCheck.differenceInPaise, -1000);
  });
});

describe('a cash check', () => {
  it('records a count and a difference and moves no money', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Check Cafe' });
    setClockForTests(ist('10:00'));
    ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 200000 }), 'float');
    const check = ok(await cash(golden.tokens.OWNER, { type: 'CASH_CHECK', cashCount: [{ valueInPaise: 50000, count: 4 }] }), 'check');
    assert.deepEqual([check.amountInPaise, check.expectedCashInPaise, check.differenceInPaise], [200000, 200000, 0]);
    const empty = ok(await cash(golden.tokens.OWNER, { type: 'CASH_CHECK', amountInPaise: 0 }), 'empty');
    assert.equal(empty.differenceInPaise, -200000);
    assert.equal((await cashBook(golden.tokens.OWNER)).cashInDrawerInPaise, 200000, 'nothing moved');
  });
});

describe('voiding from the cash book', () => {
  it('gives every entry its id, so a top-up voided from the screen comes off the drawer', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Void Book Cafe' });
    setClockForTests(ist('10:00'));
    ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 200000 }), 'float');
    ok(await cash(golden.tokens.OWNER, { type: 'PAID_IN', amountInPaise: 50000, source: 'OWNER' }), 'top-up');
    const book = await cashBook(golden.tokens.MANAGER);
    assert.ok(book.movements.every((entry) => typeof entry.id === 'string' && entry._id === undefined), 'id, not _id');
    const topUp = book.movements.find((entry) => entry.type === 'PAID_IN');
    ok(await request('POST', `/api/v1/cash-movements/${topUp.id}/void`, { token: golden.tokens.MANAGER, body: { reason: 'mistake' } }), 'void');
    const after = await cashBook(golden.tokens.OWNER);
    assert.equal(after.topUps.totalInPaise, 0);
    assert.equal(after.cashInDrawerInPaise, 200000);
  });
});

describe('the rules', () => {
  it('refuses keeping more than was counted', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Keep Cafe' });
    setClockForTests(ist('10:00'));
    ok(await cash(golden.tokens.MANAGER, { type: 'OPENING_FLOAT', amountInPaise: 200000 }), 'float');
    setClockForTests(ist('23:00'));
    const refused = await request('POST', '/api/v1/day-close', { token: golden.tokens.MANAGER, body: { businessDate: GOLDEN_DATE, countedCashInPaise: 200000, keptForTomorrowInPaise: 250000 } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.message, 'You cannot keep more than you counted.');
  });

  it('refuses an expense in Other without a note, and a category that is not on the list', async () => {
    const golden = await setupGoldenRestaurant({ name: 'Other Cafe' });
    setClockForTests(ist('10:00'));
    const other = await cash(golden.tokens.MANAGER, { type: 'PAID_OUT', amountInPaise: 5000, category: 'OTHER' });
    assert.equal(other.status, 400);
    assert.ok(other.body.error.fields.reason);
    const unknown = await cash(golden.tokens.MANAGER, { type: 'PAID_OUT', amountInPaise: 5000, category: 'FLOWERS' });
    assert.equal(unknown.status, 422);
    const milk = ok(await cash(golden.tokens.MANAGER, { type: 'PAID_OUT', amountInPaise: 5000, category: 'MILK' }), 'milk');
    assert.deepEqual([milk.category, milk.categoryLabel], ['MILK', 'Milk and dairy']);
    const topUp = ok(await cash(golden.tokens.MANAGER, { type: 'PAID_IN', amountInPaise: 100000, source: 'OWNER' }), 'top-up');
    assert.equal(topUp.source, 'OWNER');
  });

  it('refuses a float brought forward when no closed day kept cash', async () => {
    const golden = await setupGoldenRestaurant({ name: 'First Day Cafe' });
    setClockForTests(ist('10:00'));
    const refused = await cash(golden.tokens.CASHIER, { type: 'OPENING_FLOAT', broughtForward: true });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, /Count the float instead/);
  });
});
