/**
 * The bill in one place. P57, API-CONTRACT "P57".
 *
 * POST /bills takes the discount chosen before the bill is made, and
 * `preview: true` answers the bill's figures while writing nothing, so the
 * order screen shows the guest's total before Save.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AuditLog } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { Counter } from '../models/Counter.js';
import { ALL_MODELS } from '../models/index.js';
import { readOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

const TEN_PERCENT = { kind: 'PERCENT', rateBps: 1000, reasonCode: 'REGULAR_GUEST' };

/** Two of the dish on a served table, nothing billed. */
async function servedTable() {
  const floor = await seedFloor();
  floor.tokens.KITCHEN ??= floor.tokens.MANAGER;
  const order = await readyToBillOrder(floor, [{ menuItemId: floor.item.id, quantity: 2 }]);
  return { floor, order };
}

const createBill = (token, body) => request('POST', '/api/v1/bills', { token, body });

/** Every figure a bill carries, for comparing a preview with the real thing. */
const figures = (bill) => ({
  subtotalInPaise: bill.subtotalInPaise,
  discountInPaise: bill.discount?.amountInPaise ?? 0,
  taxBreakdown: bill.taxBreakdown,
  totalTaxInPaise: bill.totalTaxInPaise,
  roundOffInPaise: bill.roundOffInPaise,
  grandTotalInPaise: bill.grandTotalInPaise,
  lineShares: bill.lines.map((line) => [line.discountShareInPaise, line.taxableInPaise, line.taxInPaise]),
});

describe('a preview of the bill', () => {
  it('answers its figures and writes nothing: no bill, no number, no order change, no audit', async () => {
    const { floor, order } = await servedTable();
    const scope = { restaurantId: floor.restaurant._id };
    const auditsBefore = await AuditLog.countDocuments(scope);

    const preview = await createBill(floor.tokens.CASHIER, { orderId: order.id, version: order.version, preview: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const shown = preview.body.data;
    assert.equal(shown.preview, true);
    assert.equal(shown.billNumber, null);
    assert.equal(shown.id, undefined);
    assert.ok(shown.grandTotalInPaise > 0);

    assert.equal(await Bill.countDocuments({ ...scope, orderId: order.id }), 0);
    assert.equal(await Counter.countDocuments({ restaurantId: floor.restaurant._id, name: 'BILL' }), 0);
    assert.equal(await AuditLog.countDocuments(scope), auditsBefore);
    const after = ok(await readOrder(floor.tokens.CASHIER, order.id), 'order');
    assert.equal(after.billId ?? null, null);
    assert.equal(after.version, order.version);

    // The first real bill still takes the first number, and matches the preview.
    const bill = ok(await createBill(floor.tokens.CASHIER, { orderId: order.id, version: order.version }), 'bill');
    assert.match(bill.billNumber, /\/000001$/);
    assert.deepEqual(figures(bill), figures(shown));
  });

  it('with a discount answers the same figures as billing and then discounting', async () => {
    const { floor, order } = await servedTable();
    const shown = ok(
      await createBill(floor.tokens.MANAGER, { orderId: order.id, version: order.version, discount: TEN_PERCENT, preview: true }),
      'preview',
    );
    assert.equal(shown.discount.amountInPaise > 0, true);

    const bill = ok(await createBill(floor.tokens.MANAGER, { orderId: order.id, version: order.version }), 'bill');
    const discounted = ok(await request('POST', `/api/v1/bills/${bill.id}/discount`, { token: floor.tokens.MANAGER, body: TEN_PERCENT }), 'discount');
    assert.deepEqual(figures(shown), figures(discounted));
  });
});

describe('billing with the discount in one step', () => {
  it('saves the discount on the new bill, names who gave it, and audits it once', async () => {
    const { floor, order } = await servedTable();
    const response = await createBill(floor.tokens.MANAGER, { orderId: order.id, version: order.version, discount: { ...TEN_PERCENT, note: 'Comes every week' } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const bill = response.body.data;
    const manager = ok(await request('GET', '/api/v1/auth/me', { token: floor.tokens.MANAGER }), 'me').user;

    assert.equal(bill.discount.kind, 'PERCENT');
    assert.equal(bill.discount.rateBps, 1000);
    assert.equal(bill.discount.reasonCode, 'REGULAR_GUEST');
    assert.equal(bill.discount.reason, 'Comes every week');
    assert.equal(String(bill.discount.appliedBy), manager.id);
    assert.equal(bill.discount.amountInPaise, Math.round(bill.subtotalInPaise / 10));

    const audits = await AuditLog.find({ restaurantId: floor.restaurant._id, action: 'DISCOUNT_APPLIED', entityId: bill.id }).lean();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].amountInPaise, bill.discount.amountInPaise);
    assert.equal(audits[0].entityLabel, bill.billNumber);

    // The same figures as billing a twin table and discounting it afterwards.
    const twin = await servedTable();
    const plain = ok(await createBill(twin.floor.tokens.MANAGER, { orderId: twin.order.id, version: twin.order.version }), 'twin');
    const later = ok(await request('POST', `/api/v1/bills/${plain.id}/discount`, { token: twin.floor.tokens.MANAGER, body: TEN_PERCENT }), 'later');
    assert.deepEqual(figures(bill), figures(later));
  });

  it('refuses whoever may not discount, a discount above the item total, a reopened order, a stale order and another restaurant', async () => {
    const { floor, order } = await servedTable();
    const body = (extra) => ({ orderId: order.id, version: order.version, ...extra });

    const cashier = await createBill(floor.tokens.CASHIER, body({ discount: TEN_PERCENT }));
    assert.equal(cashier.status, 403, JSON.stringify(cashier.body));
    const captain = await createBill(floor.tokens.WAITER, body({ discount: TEN_PERCENT, preview: true }));
    assert.equal(captain.status, 403, JSON.stringify(captain.body));
    const tooBig = await createBill(floor.tokens.MANAGER, body({ discount: { kind: 'FLAT', valueInPaise: 99_999_00, reasonCode: 'REGULAR_GUEST' } }));
    assert.equal(tooBig.status, 422, JSON.stringify(tooBig.body));
    const stale = await createBill(floor.tokens.MANAGER, { orderId: order.id, version: order.version - 1, preview: true });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const elsewhere = await servedTable();
    const foreign = await createBill(elsewhere.floor.tokens.MANAGER, body({ preview: true }));
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    assert.equal(await Bill.countDocuments({ restaurantId: floor.restaurant._id, orderId: order.id }), 0);

    // A reopened order carries its last bill's discount; a new one is refused.
    const bill = ok(await createBill(floor.tokens.MANAGER, body()), 'bill');
    ok(await request('POST', `/api/v1/bills/${bill.id}/reopen`, { token: floor.tokens.OWNER, body: {} }), 'reopen');
    const current = ok(await readOrder(floor.tokens.MANAGER, order.id), 'order');
    const reopened = await createBill(floor.tokens.MANAGER, { orderId: order.id, version: current.version, discount: TEN_PERCENT });
    assert.equal(reopened.status, 422, JSON.stringify(reopened.body));
    assert.match(reopened.body.error.message, /last bill's discount/);
  });
});
