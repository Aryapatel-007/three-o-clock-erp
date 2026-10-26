/**
 * The invoice series setting. P02.
 *
 * `FINANCIAL_YEAR` is M3's original numbering and must not move. `PREFIX` lets
 * Caffeza continue the CFA/C/ series its old system was issuing. The three
 * business rules on PATCH /settings exist to protect the two unique indexes on
 * `bills`: a settings change that broke either would not fail on the settings
 * screen, it would fail at the till on every bill.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import mongoose from 'mongoose';

import { Bill } from '../models/Bill.js';
import { Counter, COUNTER_NAMES } from '../models/Counter.js';
import { reserveBillNumber } from '../services/billNumberService.js';
import {
  createTable,
  readyToBillOrder,
  seedFloor,
} from './helpers/m2Fixtures.js';
import {
  clearTestDatabase,
  startTestDatabase,
  stopTestDatabase,
  supportsTransactions,
} from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  await Counter.init();
  await Bill.init();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

const setInvoice = (token, invoice, reason = 'CA agreed the series') =>
  request('PATCH', '/api/v1/settings', { token, body: { reason, invoice } });

const prefixSeries = (prefix, startingNumber) => ({ mode: 'PREFIX', prefix, startingNumber });
const FINANCIAL_YEAR = { mode: 'FINANCIAL_YEAR', prefix: null, startingNumber: null };
// P64, changed on purpose: the invoice group also carries the default SAC code, which is not part of the series.
const seriesOf = ({ defaultSacCode: _sac, ...series }) => series;

/** A bill for a fresh table, through the real API. */
let tableCounter = 0;
async function billOnNewTable(floor) {
  tableCounter += 1;
  const table = (await createTable(floor.tokens.OWNER, { name: `B${tableCounter}` })).body.data;
  const order = await readyToBillOrder({ ...floor, table });
  const response = await request('POST', '/api/v1/bills', {
    token: floor.tokens.CASHIER,
    body: { orderId: order.id, version: order.version },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------

describe('validating the invoice group', () => {
  const cases = [
    ['only the mode', { mode: 'PREFIX' }, 'invoice.prefix'],
    ['FINANCIAL_YEAR with a prefix', { mode: 'FINANCIAL_YEAR', prefix: 'CFA/C/', startingNumber: null }, 'invoice.prefix'],
    ['FINANCIAL_YEAR with a starting number', { mode: 'FINANCIAL_YEAR', prefix: null, startingNumber: 5 }, 'invoice.startingNumber'],
    ['PREFIX with no prefix', { mode: 'PREFIX', prefix: null, startingNumber: 5 }, 'invoice.prefix'],
    ['PREFIX with no starting number', { mode: 'PREFIX', prefix: 'CFA/C/', startingNumber: null }, 'invoice.startingNumber'],
    ['a prefix of 8 characters', prefixSeries('CFA/C/12', 5), 'invoice.prefix'],
    ['a prefix with a space', prefixSeries('CFA C', 5), 'invoice.prefix'],
    ['an empty prefix', prefixSeries('', 5), 'invoice.prefix'],
    ['a starting number of 0', prefixSeries('CFA/C/', 0), 'invoice.startingNumber'],
    ['a decimal starting number', prefixSeries('CFA/C/', 1.5), 'invoice.startingNumber'],
    ['a ten-digit starting number', prefixSeries('CFA/C/', 1_000_000_000), 'invoice.startingNumber'],
    ['an unknown mode', { mode: 'YEARLY', prefix: null, startingNumber: null }, 'invoice.mode'],
  ];

  for (const [label, invoice, field] of cases) {
    it(`refuses ${label} with 400`, async () => {
      const { tokens } = await seedFloor();
      const response = await setInvoice(tokens.OWNER, invoice);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
      assert.ok(field in response.body.error.fields, JSON.stringify(response.body.error.fields));
    });
  }

  it('explains the prefix rule in words', async () => {
    const { tokens } = await seedFloor();
    const response = await setInvoice(tokens.OWNER, prefixSeries('CFA C', 5));
    assert.equal(
      response.body.error.fields['invoice.prefix'],
      'An invoice prefix can use letters, numbers, / and -, up to 7 characters.',
    );
  });

  it('accepts a seven-character prefix and a nine-digit start', async () => {
    const { tokens } = await seedFloor();
    const response = await setInvoice(tokens.OWNER, prefixSeries('CFA/C-1', 999_999_999));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(seriesOf(response.body.data.invoice), prefixSeries('CFA/C-1', 999_999_999));
  });

  it('reads the stored series back from GET /settings', async () => {
    const { tokens } = await seedFloor();
    await setInvoice(tokens.OWNER, prefixSeries('CFA/C/', 22442));
    const response = await request('GET', '/api/v1/settings', { token: tokens.OWNER });
    assert.deepEqual(seriesOf(response.body.data.invoice), prefixSeries('CFA/C/', 22442));
  });
});

describe('numbering bills', () => {
  it('keeps the financial year format by default', async () => {
    const floor = await seedFloor();
    const bill = await billOnNewTable(floor);

    assert.match(bill.billNumber, /^\d{4}-\d{2}\/000001$/);
    assert.equal(bill.billSequence, 1);
    assert.equal(bill.invoiceSeries, bill.financialYear);
  });

  it('numbers CFA/C/22442, 22443, 22444 in prefix mode', async () => {
    const floor = await seedFloor();
    assert.equal((await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 22442))).status, 200);

    const bills = [];
    for (let i = 0; i < 3; i += 1) bills.push(await billOnNewTable(floor));

    assert.deepEqual(
      bills.map((bill) => bill.billNumber),
      ['CFA/C/22442', 'CFA/C/22443', 'CFA/C/22444'],
    );
    assert.deepEqual(
      bills.map((bill) => bill.billSequence),
      [22442, 22443, 22444],
    );
    for (const bill of bills) assert.equal(bill.invoiceSeries, 'CFA/C/');
  });

  it('keeps a voided bill on its number and gives the next bill the next one', async () => {
    const floor = await seedFloor();
    await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 22442));

    const first = await billOnNewTable(floor);
    const voided = await request('POST', `/api/v1/bills/${first.id}/void`, {
      token: floor.tokens.MANAGER,
      body: { reasonCode: 'WRONG_TABLE' },
    });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.data.billNumber, 'CFA/C/22442');

    const second = await billOnNewTable(floor);
    assert.equal(second.billNumber, 'CFA/C/22443');
  });

  it('never hands one number to two concurrent bills in prefix mode', async (t) => {
    if (!supportsTransactions()) return t.skip('needs a replica set');

    const restaurantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const invoice = prefixSeries('CFA/C/', 22442);
    const at = new Date('2026-10-01T10:00:00Z');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        inTransaction((s) => reserveBillNumber({ restaurantId, branchId, at, invoice }, s)),
      ),
    );

    assert.deepEqual(
      results.map((r) => r.billSequence).sort((a, b) => a - b),
      Array.from({ length: 10 }, (_, i) => 22442 + i),
    );
  });

  it('runs on across 31 March without resetting', async (t) => {
    if (!supportsTransactions()) return t.skip('needs a replica set');

    const restaurantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const invoice = prefixSeries('CFA/C/', 22442);

    // 23:59 IST on 31 March, and 00:01 IST on 1 April.
    const beforeMidnight = new Date('2027-03-31T18:29:00Z');
    const afterMidnight = new Date('2027-03-31T18:31:00Z');

    const last = await inTransaction((s) =>
      reserveBillNumber({ restaurantId, branchId, at: beforeMidnight, invoice }, s),
    );
    const next = await inTransaction((s) =>
      reserveBillNumber({ restaurantId, branchId, at: afterMidnight, invoice }, s),
    );

    assert.equal(last.billNumber, 'CFA/C/22442');
    assert.equal(next.billNumber, 'CFA/C/22443');
    assert.equal(last.financialYear, '2026-27');
    assert.equal(next.financialYear, '2027-28');
    assert.equal(
      await Counter.countDocuments({ restaurantId, name: COUNTER_NAMES.BILL }),
      1,
      'one prefix counter, not one per year',
    );
  });
});

describe('the three invoice series rules', () => {
  it('refuses a new prefix starting at or below a number already used this year', async () => {
    const floor = await seedFloor();
    const first = await billOnNewTable(floor);
    assert.equal(first.billSequence, 1);

    const refused = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 1));
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'INVOICE_START_TOO_LOW');
    assert.equal(
      refused.body.error.message,
      'The starting number must be above 1, the highest bill number already used this financial year.',
    );

    // Nothing was stored, so the next bill still numbers by financial year.
    const next = await billOnNewTable(floor);
    assert.equal(next.billSequence, 2);
    assert.equal(next.invoiceSeries, next.financialYear);

    const allowed = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 3));
    assert.equal(allowed.status, 200);
  });

  it('accepts any start from 1 when no bill exists yet this year', async () => {
    const floor = await seedFloor();
    const response = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 1));
    assert.equal(response.status, 200);
  });

  it('refuses to restart a prefix that has issued bills, or to return to one', async () => {
    const floor = await seedFloor();
    await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 100));
    await billOnNewTable(floor);

    const restart = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 200));
    assert.equal(restart.status, 422);
    assert.equal(restart.body.error.code, 'INVOICE_SERIES_STARTED');
    assert.equal(
      restart.body.error.message,
      'CFA/C/ has already issued bills up to CFA/C/100. Its starting number cannot change, and it cannot be started again.',
    );

    // Sending the stored values back unchanged is not an error.
    const same = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 100));
    assert.equal(same.status, 200);

    // A different, unused prefix is fine, above the number already used.
    const moved = await setInvoice(floor.tokens.OWNER, prefixSeries('CFB/', 500));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const back = await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 100));
    assert.equal(back.status, 422);
    assert.equal(back.body.error.code, 'INVOICE_SERIES_STARTED');
  });

  it('refuses a switch back to financial-year numbering after prefix bills this year', async () => {
    const floor = await seedFloor();
    await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 22442));
    await billOnNewTable(floor);

    const refused = await setInvoice(floor.tokens.OWNER, FINANCIAL_YEAR);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'INVOICE_SERIES_LOCKED');
    assert.equal(
      refused.body.error.message,
      'Bills have already been issued under CFA/C/ this financial year. You can switch back on or after 1 April.',
    );
  });

  it('allows a switch back to financial-year numbering before any prefix bill', async () => {
    const floor = await seedFloor();
    await setInvoice(floor.tokens.OWNER, prefixSeries('CFA/C/', 22442));

    const response = await setInvoice(floor.tokens.OWNER, FINANCIAL_YEAR);
    assert.equal(response.status, 200);
    assert.deepEqual(seriesOf(response.body.data.invoice), FINANCIAL_YEAR);
  });

  it('refuses a manager, because the series is an owner decision', async () => {
    const floor = await seedFloor();
    const response = await setInvoice(floor.tokens.MANAGER, prefixSeries('CFA/C/', 1));
    assert.equal(response.status, 403);
  });
});
