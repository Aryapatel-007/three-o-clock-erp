/**
 * Payment methods, frozen payments, method corrections, discount reasons and
 * No Charge. M10 and the No Charge part of M16, built in P08.
 *
 * The golden day pieces run at their real times on 26 September 2026 through
 * the test clock, including B14's payment at 12:02 AM that still belongs to
 * the 26th.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import * as clientDiscountReasons from '../../client/src/features/billing/discountReasons.js';
import * as clientNoChargeReasons from '../../client/src/features/orders/noChargeReasons.js';
import { DISCOUNT_REASONS } from '../config/discountReasons.js';
import { NO_CHARGE_REASONS } from '../config/noChargeReasons.js';
import { AuditLog } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { Counter } from '../models/Counter.js';
import { Order } from '../models/Order.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { createRecords } from '../scripts/provisionRestaurant.js';
import { ensureDefaultPaymentMethods } from '../services/paymentMethodService.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import {
  createMenuItem,
  createTable,
  fireOrder,
  openOrder,
  readOrder,
  readyToBillOrder,
  seedFloor,
} from './helpers/m2Fixtures.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  await Order.init();
  await Bill.init();
  await Counter.init();
  await PaymentMethod.init();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

afterEach(() => resetClockForTests());

/** India time on a date, as a UTC instant. IST is a fixed UTC+05:30. */
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);

const listMethods = (token, query = '') => request('GET', `/api/v1/payment-methods${query}`, { token });
const createMethod = (token, body) => request('POST', '/api/v1/payment-methods', { token, body });
const updateMethod = (token, id, body) =>
  request('PATCH', `/api/v1/payment-methods/${id}`, { token, body });
const pay = (token, billId, body) => request('POST', `/api/v1/bills/${billId}/payments`, { token, body });
const discount = (token, billId, body) =>
  request('POST', `/api/v1/bills/${billId}/discount`, { token, body });
const correct = (token, billId, paymentId, body) =>
  request('POST', `/api/v1/bills/${billId}/payments/${paymentId}/correct`, { token, body });
const noCharge = (token, orderId, body) =>
  request('POST', `/api/v1/orders/${orderId}/no-charge`, { token, body });
const patchSettings = (token, body) =>
  request('PATCH', '/api/v1/settings', { token, body: { reason: 'Caffeza setup', ...body } });

/** The golden day's platform methods, with the exact codes it uses. */
async function goldenMethods(token) {
  const methods = [
    { code: 'ZOMATO_GOLD', name: 'Zomato Gold', kind: 'PLATFORM', tallyLedgerCode: '869', displayOrder: 3 },
    { code: 'DINEOUT', name: 'Dineout', kind: 'PLATFORM', tallyLedgerCode: '870', displayOrder: 4 },
    { code: 'EAZYDINER', name: 'EazyDiner', kind: 'PLATFORM', tallyLedgerCode: '871', displayOrder: 5 },
    {
      code: 'ZOMATO',
      name: 'Zomato',
      kind: 'PLATFORM',
      platformCode: 'ZOMATO',
      orderTypes: ['DELIVERY'],
      tallyLedgerCode: '867',
      displayOrder: 6,
    },
    {
      code: 'SWIGGY',
      name: 'Swiggy',
      kind: 'PLATFORM',
      platformCode: 'SWIGGY',
      orderTypes: ['DELIVERY'],
      tallyLedgerCode: '868',
      commissionBps: 2000,
      displayOrder: 7,
    },
  ];
  const created = {};
  for (const body of methods) {
    const response = await createMethod(token, body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    created[body.code] = response.body.data;
  }
  return created;
}

async function billFor(floor, order) {
  const response = await request('POST', '/api/v1/bills', {
    token: floor.tokens.CASHIER,
    body: { orderId: order.id, version: order.version },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

let tableCounter = 0;
/** A billed dine-in order on a fresh table. `items` are menu item ids, one each. */
async function dineInBill(floor, items = null) {
  tableCounter += 1;
  const table = (await createTable(floor.tokens.OWNER, { name: `Pay ${tableCounter}` })).body.data;
  const lines = items ? items.map((menuItemId) => ({ menuItemId, quantity: 1 })) : null;
  const order = await readyToBillOrder({ ...floor, table }, lines);
  return billFor(floor, order);
}

/** A billed delivery order from a platform. */
async function deliveryBill(floor, platformCode, itemId, orderId = '249377796192385') {
  const opened = (
    await request('POST', '/api/v1/orders', {
      token: floor.tokens.CASHIER,
      body: {
        orderType: 'DELIVERY',
        platform: { code: platformCode, orderId },
        lines: [{ menuItemId: itemId, quantity: 1 }],
      },
    })
  ).body.data;
  const fired = (await fireOrder(floor.tokens.CASHIER, opened.id, opened.version)).body.data;
  for (const kot of fired.kots) {
    await request('PATCH', `/api/v1/kots/${kot.id}/ready`, { token: floor.tokens.KITCHEN });
  }
  let current = (await readOrder(floor.tokens.CASHIER, opened.id)).body.data;
  for (const line of current.lines) {
    current = (
      await request('PATCH', `/api/v1/orders/${opened.id}/lines/${line.id}/served`, {
        token: floor.tokens.CASHIER,
        body: { version: current.version },
      })
    ).body.data;
  }
  return billFor(floor, current);
}

const menuItem = async (token, name, priceInPaise) =>
  (await createMenuItem(token, { name, priceInPaise, taxRateBps: 500 })).body.data.id;

// ---------------------------------------------------------------------------

describe('built-in payment methods', () => {
  it('a new restaurant is provisioned with exactly Cash, Card, UPI and an inactive Other', async () => {
    const ids = await createRecords(
      { restaurantName: 'New Cafe', ownerName: 'Owner', ownerPhone: '9876500001' },
      { session: null, password: 'a generated password' },
    );
    const methods = await PaymentMethod.find({ restaurantId: ids.restaurantId }).sort({ displayOrder: 1 });
    assert.deepEqual(
      methods.map((method) => [method.code, method.kind, method.isActive]),
      [
        ['CASH', 'IN_HAND', true],
        ['CARD', 'IN_HAND', true],
        ['UPI', 'IN_HAND', true],
        ['OTHER', 'IN_HAND', false],
      ],
    );
  });

  it('a restaurant from before P08 gets them on first use', async () => {
    const floor = await seedFloor();
    assert.equal(await PaymentMethod.countDocuments({ restaurantId: floor.restaurant.id }), 0);

    const response = await listMethods(floor.tokens.CASHIER);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.data.map((method) => method.code),
      ['CASH', 'CARD', 'UPI'],
      'Other is inactive, so the till does not list it',
    );

    const all = await listMethods(floor.tokens.MANAGER, '?includeInactive=true');
    assert.deepEqual(all.body.data.map((method) => method.code), ['CASH', 'CARD', 'UPI', 'OTHER']);
  });

  it('running the ensure twice changes nothing, and never overwrites a renamed method', async () => {
    const floor = await seedFloor();
    const scope = { branchId: floor.branch._id };
    await ensureDefaultPaymentMethods(floor.restaurant.id, scope);

    const cash = await PaymentMethod.findOne({ restaurantId: floor.restaurant.id, code: 'CASH' });
    await updateMethod(floor.tokens.OWNER, cash.id, { name: 'Cash in drawer', isActive: false });

    await ensureDefaultPaymentMethods(floor.restaurant.id, scope);
    await ensureDefaultPaymentMethods(floor.restaurant.id, scope);

    assert.equal(await PaymentMethod.countDocuments({ restaurantId: floor.restaurant.id }), 4);
    const after = await PaymentMethod.findOne({ restaurantId: floor.restaurant.id, code: 'CASH' });
    assert.equal(after.name, 'Cash in drawer');
    assert.equal(after.isActive, false);
  });

  it('running it again does not even touch updatedAt, so a payment syncs no method change (P63)', async () => {
    const floor = await seedFloor();
    const scope = { branchId: floor.branch._id };
    await ensureDefaultPaymentMethods(floor.restaurant.id, scope);
    const before = await PaymentMethod.find({ restaurantId: floor.restaurant.id }).sort({ code: 1 }).lean();
    assert.ok(before.every((method) => method.createdAt instanceof Date && method.updatedAt instanceof Date));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    await ensureDefaultPaymentMethods(floor.restaurant.id, scope);
    const again = await PaymentMethod.find({ restaurantId: floor.restaurant.id }).sort({ code: 1 }).lean();
    assert.deepEqual(again.map((method) => method.updatedAt.getTime()), before.map((method) => method.updatedAt.getTime()));
  });
});

describe('configuring payment methods', () => {
  it('only an owner creates or edits one, and the list of inactive ones is for managers', async () => {
    const { tokens } = await seedFloor();
    const body = { code: 'ZOMATO_GOLD', name: 'Zomato Gold', kind: 'PLATFORM' };

    assert.equal((await createMethod(tokens.MANAGER, body)).status, 403);
    assert.equal((await listMethods(tokens.CASHIER, '?includeInactive=true')).status, 403);
    const created = await createMethod(tokens.OWNER, body);
    assert.equal(created.status, 201);
    assert.equal((await updateMethod(tokens.MANAGER, created.body.data.id, { name: 'ZG' })).status, 403);
  });

  it('refuses a duplicate code, a commission on an in-hand method, and changing code or kind', async () => {
    const { tokens } = await seedFloor();
    await listMethods(tokens.OWNER);

    const duplicate = await createMethod(tokens.OWNER, { code: 'CASH', name: 'Cash 2', kind: 'IN_HAND' });
    assert.equal(duplicate.status, 409);

    const inHandCommission = await createMethod(tokens.OWNER, {
      code: 'PAYTM',
      name: 'Paytm',
      kind: 'IN_HAND',
      commissionBps: 100,
    });
    assert.equal(inHandCommission.status, 400);

    const badCode = await createMethod(tokens.OWNER, { code: 'zomato gold', name: 'ZG', kind: 'PLATFORM' });
    assert.equal(badCode.status, 400);

    const cash = (await listMethods(tokens.OWNER)).body.data[0];
    assert.equal((await updateMethod(tokens.OWNER, cash.id, { code: 'CASHH' })).status, 400);
    assert.equal((await updateMethod(tokens.OWNER, cash.id, { kind: 'PLATFORM' })).status, 400);
    assert.equal((await updateMethod(tokens.OWNER, cash.id, { commissionBps: 100 })).status, 400);
  });
});

describe('taking a payment', () => {
  it('P43: Other needs its mode of payment, kept as the reference; Cash still needs nothing', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    await goldenMethods(tokens.OWNER);
    const other = (await listMethods(tokens.OWNER, '?includeInactive=true')).body.data.find((method) => method.code === 'OTHER');
    assert.equal((await updateMethod(tokens.OWNER, other.id, { isActive: true })).status, 200);

    const bill = await dineInBill(floor);
    const noMode = await pay(tokens.CASHIER, bill.id, { method: 'OTHER', amountInPaise: 100 });
    assert.equal(noMode.status, 422);
    assert.equal(noMode.body.error.code, 'BUSINESS_RULE_VIOLATED');
    assert.equal(noMode.body.error.message, 'Say how it was paid, for example Cheque.');
    const blank = await pay(tokens.CASHIER, bill.id, { method: 'OTHER', amountInPaise: 100, reference: '   ' });
    assert.equal(blank.status, 422);

    const unchanged = (await request('GET', `/api/v1/bills/${bill.id}`, { token: tokens.CASHIER })).body.data;
    assert.equal(unchanged.payments.length, 0);

    const cheque = await pay(tokens.CASHIER, bill.id, { method: 'OTHER', amountInPaise: 100, reference: 'Cheque' });
    assert.equal(cheque.status, 200, JSON.stringify(cheque.body));
    const recorded = cheque.body.data.payments.at(-1);
    assert.equal(recorded.method, 'OTHER');
    assert.equal(recorded.methodName, 'Other');
    assert.equal(recorded.reference, 'Cheque');

    const cash = await pay(tokens.CASHIER, bill.id, { method: 'CASH', amountInPaise: 100 });
    assert.equal(cash.status, 200, JSON.stringify(cash.body));
  });

  it('refuses an inactive method, a method not for this order type, and the wrong platform', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    await goldenMethods(tokens.OWNER);
    const pizza = await menuItem(tokens.OWNER, 'Half & Half Pizza', 38000);

    const dineIn = await dineInBill(floor);
    const amountInPaise = 100;

    const inactive = await pay(tokens.CASHIER, dineIn.id, { method: 'OTHER', amountInPaise });
    assert.equal(inactive.status, 422);
    assert.equal(inactive.body.error.code, 'PAYMENT_METHOD_NOT_ALLOWED');
    assert.match(inactive.body.error.message, /not an active payment method/);

    const swiggyOnDineIn = await pay(tokens.CASHIER, dineIn.id, { method: 'SWIGGY', amountInPaise });
    assert.equal(swiggyOnDineIn.status, 422);
    assert.equal(swiggyOnDineIn.body.error.code, 'PAYMENT_METHOD_NOT_ALLOWED');

    // A method allowed for delivery only, with no platform, on a dine-in bill.
    await createMethod(tokens.OWNER, {
      code: 'COD',
      name: 'Cash on delivery',
      kind: 'IN_HAND',
      orderTypes: ['DELIVERY'],
    });
    const wrongType = await pay(tokens.CASHIER, dineIn.id, { method: 'COD', amountInPaise });
    assert.equal(wrongType.status, 422);
    assert.match(wrongType.body.error.message, /dine-in/);

    const swiggyBill = await deliveryBill(floor, 'SWIGGY', pizza);
    const cashOnSwiggy = await pay(tokens.CASHIER, swiggyBill.id, { method: 'CASH', amountInPaise });
    assert.equal(cashOnSwiggy.status, 422);
    assert.match(cashOnSwiggy.body.error.message, /Swiggy order is paid by Swiggy only/);

    const zomatoOnSwiggy = await pay(tokens.CASHIER, swiggyBill.id, { method: 'ZOMATO', amountInPaise });
    assert.equal(zomatoOnSwiggy.status, 422);

    const swiggy = await pay(tokens.CASHIER, swiggyBill.id, {
      method: 'SWIGGY',
      amountInPaise: swiggyBill.grandTotalInPaise,
    });
    assert.equal(swiggy.status, 200, JSON.stringify(swiggy.body));
    assert.equal(swiggy.body.data.status, 'PAID');
  });

  it('freezes name, kind, Tally code, commission and business date, and a rename does not change it', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const methods = await goldenMethods(tokens.OWNER);
    const pizza = await menuItem(tokens.OWNER, 'Half & Half Pizza', 38000);

    setClockForTests(ist('2026-09-26', '17:21'));
    const swiggyBill = await deliveryBill(floor, 'SWIGGY', pizza);
    const paid = (
      await pay(tokens.CASHIER, swiggyBill.id, { method: 'SWIGGY', amountInPaise: swiggyBill.grandTotalInPaise })
    ).body.data;

    const [payment] = paid.payments;
    assert.equal(payment.method, 'SWIGGY');
    assert.equal(payment.methodName, 'Swiggy');
    assert.equal(payment.methodKind, 'PLATFORM');
    assert.equal(payment.tallyLedgerCode, '868');
    assert.equal(payment.commissionBps, 2000);
    assert.equal(payment.businessDate, '2026-09-26');

    await updateMethod(tokens.OWNER, methods.SWIGGY.id, { name: 'Swiggy Food', tallyLedgerCode: '999' });
    const reread = (await request('GET', `/api/v1/bills/${swiggyBill.id}`, { token: tokens.OWNER })).body.data;
    assert.equal(reread.payments[0].methodName, 'Swiggy');
    assert.equal(reread.payments[0].tallyLedgerCode, '868');
  });

  it('an in-hand payment freezes no commission', async () => {
    const floor = await seedFloor();
    const bill = await dineInBill(floor);
    const paid = (
      await pay(floor.tokens.CASHIER, bill.id, { method: 'CASH', amountInPaise: bill.grandTotalInPaise })
    ).body.data;
    assert.equal(paid.payments[0].methodName, 'Cash');
    assert.equal(paid.payments[0].methodKind, 'IN_HAND');
    assert.equal(paid.payments[0].commissionBps, null);
  });

  it('a commission change affects only payments taken after it', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const methods = await goldenMethods(tokens.OWNER);
    const pizza = await menuItem(tokens.OWNER, 'Half & Half Pizza', 38000);

    const first = await deliveryBill(floor, 'SWIGGY', pizza, '111111');
    await pay(tokens.CASHIER, first.id, { method: 'SWIGGY', amountInPaise: first.grandTotalInPaise });

    await updateMethod(tokens.OWNER, methods.SWIGGY.id, { commissionBps: 2200 });

    const second = await deliveryBill(floor, 'SWIGGY', pizza, '222222');
    await pay(tokens.CASHIER, second.id, { method: 'SWIGGY', amountInPaise: second.grandTotalInPaise });

    const read = async (id) =>
      (await request('GET', `/api/v1/bills/${id}`, { token: tokens.OWNER })).body.data.payments[0];
    assert.equal((await read(first.id)).commissionBps, 2000);
    assert.equal((await read(second.id)).commissionBps, 2200);
  });
});

describe('correcting a payment method', () => {
  it('keeps the amount and business date, records the history, and writes the audit line', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    await goldenMethods(tokens.OWNER);
    const bill = await dineInBill(floor);
    const paid = (
      await pay(tokens.CASHIER, bill.id, { method: 'ZOMATO_GOLD', amountInPaise: bill.grandTotalInPaise })
    ).body.data;
    const paymentId = paid.payments[0].id;

    const response = await correct(tokens.MANAGER, bill.id, paymentId, {
      method: 'UPI',
      reason: 'Guest paid by UPI, not the app',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const [payment] = response.body.data.payments;
    assert.equal(payment.amountInPaise, bill.grandTotalInPaise);
    assert.equal(payment.method, 'UPI');
    assert.equal(payment.methodName, 'UPI');
    assert.equal(payment.methodKind, 'IN_HAND');
    assert.equal(payment.commissionBps, null);
    assert.equal(payment.businessDate, paid.payments[0].businessDate);
    assert.equal(payment.corrections.length, 1);
    assert.equal(payment.corrections[0].fromMethod, 'ZOMATO_GOLD');
    assert.equal(payment.corrections[0].toMethod, 'UPI');
    assert.equal(payment.corrections[0].reason, 'Guest paid by UPI, not the app');
    assert.equal(response.body.data.amountPaidInPaise, bill.grandTotalInPaise);

    const audit = await AuditLog.find({
      restaurantId: floor.restaurant.id,
      action: 'PAYMENT_METHOD_CORRECTED',
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entityType, 'BILL');
    assert.equal(audit[0].amountInPaise, bill.grandTotalInPaise);
    assert.deepEqual(
      { ...audit[0].details },
      { paymentId, fromMethod: 'ZOMATO_GOLD', toMethod: 'UPI' },
    );
  });

  it('refuses a method the bill may not use, the same method, a cashier, and an unknown payment', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    await goldenMethods(tokens.OWNER);
    const bill = await dineInBill(floor);
    const paid = (
      await pay(tokens.CASHIER, bill.id, { method: 'CASH', amountInPaise: bill.grandTotalInPaise })
    ).body.data;
    const paymentId = paid.payments[0].id;

    const swiggy = await correct(tokens.MANAGER, bill.id, paymentId, { method: 'SWIGGY', reason: 'x' });
    assert.equal(swiggy.status, 422);
    assert.equal(swiggy.body.error.code, 'PAYMENT_METHOD_NOT_ALLOWED');

    const same = await correct(tokens.MANAGER, bill.id, paymentId, { method: 'CASH', reason: 'x' });
    assert.equal(same.status, 422);

    const cashier = await correct(tokens.CASHIER, bill.id, paymentId, { method: 'UPI', reason: 'x' });
    assert.equal(cashier.status, 403);

    const noReason = await correct(tokens.MANAGER, bill.id, paymentId, { method: 'UPI' });
    assert.equal(noReason.status, 400);

    const amount = await correct(tokens.MANAGER, bill.id, paymentId, {
      method: 'UPI',
      reason: 'x',
      amountInPaise: 1,
    });
    assert.equal(amount.status, 400, 'only the method of a payment can change');

    const unknown = await correct(tokens.MANAGER, bill.id, bill.id, { method: 'UPI', reason: 'x' });
    assert.equal(unknown.status, 404);
  });
});

describe('discount reasons', () => {
  it('accepts every reason code, and refuses Other without a note and the old reason field', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;

    for (const { code } of DISCOUNT_REASONS) {
      const bill = await dineInBill(floor);
      const body = { kind: 'FLAT', valueInPaise: 100, reasonCode: code };
      if (code === 'OTHER') body.note = 'Birthday';
      const response = await discount(tokens.MANAGER, bill.id, body);
      assert.equal(response.status, 200, `${code}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.data.discount.reasonCode, code);
      assert.equal(response.body.data.discount.fundedBy, 'RESTAURANT');
    }

    const bill = await dineInBill(floor);
    const other = await discount(tokens.MANAGER, bill.id, { kind: 'FLAT', valueInPaise: 100, reasonCode: 'OTHER' });
    assert.equal(other.status, 400);
    assert.ok(other.body.error.fields.note);

    const old = await discount(tokens.MANAGER, bill.id, { kind: 'FLAT', valueInPaise: 100, reason: 'Regular' });
    assert.equal(old.status, 400);
  });

  it('a note is stored as the reason text, and the audit line carries the code and who paid', async () => {
    const floor = await seedFloor();
    const bill = await dineInBill(floor);
    const response = await discount(floor.tokens.MANAGER, bill.id, {
      kind: 'FLAT',
      valueInPaise: 500,
      reasonCode: 'ZOMATO_GOLD',
      note: 'Gold member',
      fundedBy: 'PLATFORM',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.discount.reason, 'Gold member');
    assert.equal(response.body.data.discount.fundedBy, 'PLATFORM');

    const [audit] = await AuditLog.find({ restaurantId: floor.restaurant.id, action: 'DISCOUNT_APPLIED' });
    assert.equal(audit.reason, 'Zomato Gold: Gold member');
    assert.equal(audit.details.reasonCode, 'ZOMATO_GOLD');
    assert.equal(audit.details.fundedBy, 'PLATFORM');
  });

  it('refuses fundedBy PLATFORM with a reason that is not a platform reason', async () => {
    const floor = await seedFloor();
    const bill = await dineInBill(floor);
    const response = await discount(floor.tokens.MANAGER, bill.id, {
      kind: 'FLAT',
      valueInPaise: 500,
      reasonCode: 'REGULAR_GUEST',
      fundedBy: 'PLATFORM',
    });
    assert.equal(response.status, 400);
    assert.ok(response.body.error.fields.fundedBy);
  });

  it('a cashier is refused every discount with the setting off, and only platform reasons with it on', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const bill = await dineInBill(floor);
    const gold = { kind: 'FLAT', valueInPaise: 500, reasonCode: 'ZOMATO_GOLD' };
    const regular = { kind: 'FLAT', valueInPaise: 500, reasonCode: 'REGULAR_GUEST' };

    assert.equal((await discount(tokens.CASHIER, bill.id, gold)).status, 403);
    assert.equal((await discount(tokens.CASHIER, bill.id, regular)).status, 403);

    const on = await patchSettings(tokens.OWNER, { discounts: { cashierMayApplyPlatformDiscounts: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));

    assert.equal((await discount(tokens.CASHIER, bill.id, gold)).status, 200);
    assert.equal((await discount(tokens.CASHIER, bill.id, regular)).status, 403);
    assert.equal((await discount(tokens.WAITER, bill.id, gold)).status, 403);
  });

  it('the client and server reason lists match', () => {
    assert.deepEqual(
      clientDiscountReasons.DISCOUNT_REASONS,
      DISCOUNT_REASONS.map(({ code, label, isPlatform }) => ({ code, label, isPlatform })),
    );
    assert.deepEqual(
      clientNoChargeReasons.NO_CHARGE_REASONS,
      NO_CHARGE_REASONS.map(({ code, label }) => ({ code, label })),
    );
  });
});

describe('No Charge', () => {
  /** An order on a fresh table with every line fired, still OPEN. */
  async function firedOrder(floor, itemId = floor.item.id) {
    tableCounter += 1;
    const table = (await createTable(floor.tokens.OWNER, { name: `N${tableCounter}` })).body.data;
    const opened = (
      await openOrder(floor.tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: itemId, quantity: 1 }] })
    ).body.data;
    const fired = (await fireOrder(floor.tokens.WAITER, opened.id, opened.version)).body.data;
    return { table, order: fired.order };
  }

  it('refuses each of the four rules with its own message', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const body = (order) => ({ version: order.version, reasonCode: 'STAFF_MEAL' });

    // 3. An unsent line.
    tableCounter += 1;
    const table = (await createTable(tokens.OWNER, { name: `U${tableCounter}` })).body.data;
    const unsent = (
      await openOrder(tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: floor.item.id, quantity: 1 }] })
    ).body.data;
    const pending = await noCharge(tokens.MANAGER, unsent.id, body(unsent));
    assert.equal(pending.status, 422);
    assert.equal(pending.body.error.message, 'Send or cancel the unsent items first.');

    // 4. No live line.
    const lineId = unsent.lines[0].id;
    const emptied = (
      await request('POST', `/api/v1/orders/${unsent.id}/lines/${lineId}/cancel`, {
        token: tokens.WAITER,
        body: { version: unsent.version, reasonCode: 'WRONG_ITEM' },
      })
    ).body.data;
    const empty = await noCharge(tokens.MANAGER, unsent.id, body(emptied));
    assert.equal(empty.status, 422);
    assert.match(empty.body.error.message, /nothing to give/);

    // 2. A live bill.
    const billed = await dineInBill(floor);
    const order = (await readOrder(tokens.MANAGER, billed.orderId)).body.data;
    const withBill = await noCharge(tokens.MANAGER, order.id, body(order));
    assert.equal(withBill.status, 422);
    assert.equal(withBill.body.error.message, 'This order has a bill. Void the bill first.');

    // 1. Not open: pay the bill, so the order is BILLED.
    await pay(tokens.CASHIER, billed.id, { method: 'CASH', amountInPaise: billed.grandTotalInPaise });
    const closed = (await readOrder(tokens.MANAGER, billed.orderId)).body.data;
    const notOpen = await noCharge(tokens.MANAGER, closed.id, body(closed));
    assert.equal(notOpen.status, 422);
    assert.equal(notOpen.body.error.message, 'Only an open order can be given No Charge.');
  });

  it('is manager work, and Other needs a note', async () => {
    const floor = await seedFloor();
    const { order } = await firedOrder(floor);
    const asCashier = await noCharge(floor.tokens.CASHIER, order.id, {
      version: order.version,
      reasonCode: 'STAFF_MEAL',
    });
    assert.equal(asCashier.status, 403);

    const other = await noCharge(floor.tokens.MANAGER, order.id, { version: order.version, reasonCode: 'OTHER' });
    assert.equal(other.status, 400);
  });

  it('frees the table, freezes the value, writes the audit line, and creates no bill', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const { table, order } = await firedOrder(floor);

    const response = await noCharge(tokens.MANAGER, order.id, {
      version: order.version,
      reasonCode: 'STAFF_MEAL',
      note: 'Chef tasting',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const given = response.body.data;
    assert.equal(given.status, 'NO_CHARGE');
    assert.equal(given.noCharge.reasonCode, 'STAFF_MEAL');
    assert.equal(given.noCharge.note, 'Chef tasting');
    assert.equal(given.noCharge.valueInPaise, floor.item.priceInPaise);
    assert.ok(given.noCharge.approvedBy);
    assert.match(given.noCharge.businessDate, /^\d{4}-\d{2}-\d{2}$/);

    const tables = (await request('GET', '/api/v1/tables', { token: tokens.WAITER })).body.data;
    const freed = tables.find((row) => row.id === table.id);
    assert.equal(freed.occupancy.isOccupied, false, JSON.stringify(freed));

    // The table takes a new order straight away.
    const next = await openOrder(tokens.WAITER, {
      tableId: table.id,
      lines: [{ menuItemId: floor.item.id, quantity: 1 }],
    });
    assert.equal(next.status, 201);

    assert.equal(await Bill.countDocuments({ restaurantId: floor.restaurant.id }), 0);

    const audit = await AuditLog.find({ restaurantId: floor.restaurant.id, action: 'NO_CHARGE_GIVEN' });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entityType, 'ORDER');
    assert.equal(audit[0].amountInPaise, floor.item.priceInPaise);
    assert.equal(audit[0].reason, 'Staff meal: Chef tasting');
    assert.equal(audit[0].actorRole, 'MANAGER');

    // Closed for good: it cannot be cancelled, billed, or given No Charge again.
    const reread = (await readOrder(tokens.MANAGER, order.id)).body.data;
    const again = await noCharge(tokens.MANAGER, order.id, { version: reread.version, reasonCode: 'STAFF_MEAL' });
    assert.equal(again.status, 422);
    const billIt = await request('POST', '/api/v1/bills', {
      token: tokens.CASHIER,
      body: { orderId: order.id, version: reread.version },
    });
    assert.equal(billIt.status, 422);
    const cancel = await request('POST', `/api/v1/orders/${order.id}/cancel`, {
      token: tokens.MANAGER,
      body: { version: reread.version, reasonCode: 'GUEST_LEFT', wasPrepared: true },
    });
    assert.equal(cancel.status, 422);
  });

  it('golden N01: College Sandwich on Table 29, Corporate office, 23000, and the next bill has no gap', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const series = await patchSettings(tokens.OWNER, {
      invoice: { mode: 'PREFIX', prefix: 'CFA/C/', startingNumber: 22442 },
    });
    assert.equal(series.status, 200, JSON.stringify(series.body));

    const sandwich = await menuItem(tokens.OWNER, 'College Sandwich', 23000);
    const first = await dineInBill(floor);
    assert.equal(first.billNumber, 'CFA/C/22442');

    const table29 = (await createTable(tokens.OWNER, { name: 'Table 29' })).body.data;
    const opened = (
      await openOrder(tokens.WAITER, { tableId: table29.id, lines: [{ menuItemId: sandwich, quantity: 1 }] })
    ).body.data;
    const fired = (await fireOrder(tokens.WAITER, opened.id, opened.version)).body.data;
    const n01 = await noCharge(tokens.MANAGER, opened.id, {
      version: fired.order.version,
      reasonCode: 'CORPORATE_OFFICE',
    });
    assert.equal(n01.status, 200, JSON.stringify(n01.body));
    assert.equal(n01.body.data.noCharge.valueInPaise, 23000);
    assert.equal(n01.body.data.billId ?? null, null);

    const next = await dineInBill(floor);
    assert.equal(next.billNumber, 'CFA/C/22443', 'No Charge takes no invoice number');
  });

  it('never appears in the open orders, the bill list, or any M6 sales figure', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const { order } = await firedOrder(floor);
    const given = (
      await noCharge(tokens.MANAGER, order.id, { version: order.version, reasonCode: 'STAFF_MEAL' })
    ).body.data;
    const today = given.noCharge.businessDate;

    const open = (
      await request('GET', '/api/v1/orders?status=OPEN,READY_TO_BILL', { token: tokens.MANAGER })
    ).body.data;
    assert.equal(open.length, 0);

    const bills = await request('GET', '/api/v1/bills', { token: tokens.CASHIER });
    assert.equal(bills.body.data.length, 0);
    assert.equal(bills.body.meta.totals.grandTotalInPaise, 0);

    const summary = (
      await request('GET', `/api/v1/reports/sales-summary?from=${today}&to=${today}`, { token: tokens.OWNER })
    ).body.data;
    assert.equal(summary.billCount, 0, JSON.stringify(summary));

    const dashboard = (await request('GET', '/api/v1/reports/dashboard', { token: tokens.OWNER })).body.data;
    assert.equal(dashboard.openOrders.count, 0);
  });
});

describe('golden day pieces at their real times', () => {
  async function goldenFloor() {
    const floor = await seedFloor();
    await goldenMethods(floor.tokens.OWNER);
    return floor;
  }

  it('B05 is paid Cash 50000 and UPI 29500, both on business date 2026-09-26', async () => {
    const floor = await goldenFloor();
    const { tokens } = floor;
    const pizza = await menuItem(tokens.OWNER, 'Half & Half Pizza', 38000);
    const shake = await menuItem(tokens.OWNER, 'Ferrero Hazelnut Shake', 33000);
    const water = await menuItem(tokens.OWNER, 'Water Bottle', 4761);

    setClockForTests(ist('2026-09-26', '15:50'));
    const b05 = await dineInBill(floor, [pizza, shake, water]);
    assert.equal(b05.grandTotalInPaise, 79500);
    assert.equal(b05.businessDate, '2026-09-26');

    setClockForTests(ist('2026-09-26', '15:54'));
    await pay(tokens.CASHIER, b05.id, { method: 'CASH', amountInPaise: 50000 });
    const paid = (await pay(tokens.CASHIER, b05.id, { method: 'UPI', amountInPaise: 29500 })).body.data;

    assert.equal(paid.status, 'PAID');
    assert.deepEqual(
      paid.payments.map((payment) => [payment.method, payment.amountInPaise, payment.businessDate]),
      [
        ['CASH', 50000, '2026-09-26'],
        ['UPI', 29500, '2026-09-26'],
      ],
    );
  });

  it('B02 is discounted 7307 with ZOMATO_GOLD and paid by ZOMATO_GOLD 144600', async () => {
    const floor = await goldenFloor();
    const { tokens } = floor;
    const make = (name, price) => menuItem(tokens.OWNER, name, price);
    const platter = await make('Indian Platters', 45000);
    const noodles = await make('Chilli Garlic Noodle Bowl', 40000);
    const mocha = await make('Mocha Flower', 28000);
    const papad = await make('Roasted Papad', 8000);
    const paratha = await make('Laccha Tawa Paratha', 8000);

    setClockForTests(ist('2026-09-26', '13:52'));
    const b02 = await dineInBill(floor, [platter, noodles, mocha, papad, paratha, papad, papad]);
    const discounted = await discount(tokens.MANAGER, b02.id, {
      kind: 'FLAT',
      valueInPaise: 7307,
      reasonCode: 'ZOMATO_GOLD',
      fundedBy: 'PLATFORM',
    });
    assert.equal(discounted.status, 200, JSON.stringify(discounted.body));
    assert.equal(discounted.body.data.grandTotalInPaise, 144600);

    setClockForTests(ist('2026-09-26', '13:58'));
    const paid = await pay(tokens.CASHIER, b02.id, { method: 'ZOMATO_GOLD', amountInPaise: 144600 });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'PAID');
    assert.equal(paid.body.data.payments[0].methodKind, 'PLATFORM');
    assert.equal(paid.body.data.payments[0].businessDate, '2026-09-26');
  });

  it('B14 is billed at 11:55 PM and paid by ZOMATO_GOLD at 12:02 AM, and both belong to 26 September', async () => {
    const floor = await goldenFloor();
    const { tokens } = floor;
    const tornado = await menuItem(tokens.OWNER, 'Cheesy Tornado', 36000);
    const sevPoori = await menuItem(tokens.OWNER, 'Sev Poori', 18000);

    setClockForTests(ist('2026-09-26', '23:55'));
    const b14 = await dineInBill(floor, [tornado, sevPoori]);
    assert.equal(b14.businessDate, '2026-09-26');
    const discounted = (
      await discount(tokens.MANAGER, b14.id, { kind: 'FLAT', valueInPaise: 1383, reasonCode: 'ZOMATO_GOLD' })
    ).body.data;
    assert.equal(discounted.grandTotalInPaise, 55200);

    setClockForTests(ist('2026-09-27', '00:02'));
    const paid = (await pay(tokens.CASHIER, b14.id, { method: 'ZOMATO_GOLD', amountInPaise: 55200 })).body.data;
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.payments[0].businessDate, '2026-09-26');
    assert.equal(new Date(paid.payments[0].receivedAt).toISOString(), '2026-09-26T18:32:00.000Z');
  });
});

describe('P47 Other modes', () => {
  it('starts with Swiggy Dineout, Zomato Dineout and EazyDiner, and a cashier reads the owner\'s list', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const me = (token) => request('GET', '/api/v1/auth/me', { token });
    assert.deepEqual((await me(tokens.CASHIER)).body.data.payments.otherModes, ['Swiggy Dineout', 'Zomato Dineout', 'EazyDiner', 'Cheque', 'Bank transfer', 'Coupon']);

    const set = (token, otherModes) => patchSettings(token, { reason: 'P47 test', payments: { otherModes } });
    assert.equal((await set(tokens.OWNER, ['Swiggy Dineout', 'Paytm'])).status, 200);
    assert.deepEqual((await me(tokens.CASHIER)).body.data.payments.otherModes, ['Swiggy Dineout', 'Paytm']);

    assert.equal((await set(tokens.OWNER, Array.from({ length: 13 }, (_, index) => `Mode ${index}`))).status, 400, 'too many');
    assert.equal((await set(tokens.OWNER, ['x'.repeat(41)])).status, 400, 'too long');
    assert.equal((await set(tokens.OWNER, ['  '])).status, 400, 'empty');
    assert.equal((await set(tokens.OWNER, ['Paytm', 'paytm'])).status, 400, 'the same mode twice');
    assert.equal((await set(tokens.MANAGER, ['Paytm'])).status, 403, 'settings are the owner\'s');
  });
});
