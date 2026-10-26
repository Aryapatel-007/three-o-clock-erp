/**
 * P29 Part D: the bill is printed before payment is taken, and a payment taken
 * first is recorded. docs/API-CONTRACT.md M3 sections 16.8.3 and 16.9, M19 R15.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { businessDateFor, nowUtc, resetClockForTests } from '../utils/time.js';
import { readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

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

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

async function bill(floor) {
  const order = await readyToBillOrder(floor);
  return ok(await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } }), 'bill');
}

describe('print before payment', () => {
  it('records a payment taken on a bill never printed, and lists it in R15', async () => {
    const floor = await seedFloor();
    const unprinted = await bill(floor);
    const paid = ok(
      await request('POST', `/api/v1/bills/${unprinted.id}/payments`, { token: floor.tokens.CASHIER, body: { method: 'CASH', amountInPaise: unprinted.grandTotalInPaise } }),
      'pay',
    );
    assert.equal(paid.paymentBeforePrint, true);

    const today = businessDateFor(nowUtc(), 300);
    const r15 = ok(await request('GET', `/api/v1/reports/v2/cancellations?from=${today}&to=${today}`, { token: floor.tokens.OWNER }), 'R15');
    const section = r15.sections.find((entry) => entry.key === 'paidBeforePrint');
    assert.deepEqual(section.rows.map((row) => row.billNumber), [unprinted.billNumber]);
    assert.equal(section.totals.count, 1);
  });

  it('does not mark a bill printed before it was paid', async () => {
    const floor = await seedFloor();
    const printedFirst = await bill(floor);
    const printed = ok(await request('POST', `/api/v1/bills/${printedFirst.id}/printed`, { token: floor.tokens.CASHIER }), 'printed');
    assert.equal(printed.printCount, 1);
    const paid = ok(
      await request('POST', `/api/v1/bills/${printedFirst.id}/payments`, { token: floor.tokens.CASHIER, body: { method: 'CASH', amountInPaise: printedFirst.grandTotalInPaise } }),
      'pay',
    );
    assert.equal(paid.paymentBeforePrint, false);
  });

  it('gives a cashier the two billing switches on /auth/me', async () => {
    const floor = await seedFloor();
    const me = ok(await request('GET', '/api/v1/auth/me', { token: floor.tokens.CASHIER }), 'me');
    assert.equal(me.billing.printBeforePayment, true);
    assert.equal(me.billing.reviseUnpaidBills, true);
    assert.equal(me.approvals.revisePrintedBill, true);
    assert.deepEqual(me.kitchen, { readyMeansServed: true, splitTicketsByStation: true });
  });
});
