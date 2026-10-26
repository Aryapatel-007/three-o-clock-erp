/**
 * P60: Bill without KOT. docs/API-CONTRACT.md "P60", DB-SCHEMA section 59.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { Kot } from '../models/Kot.js';
import { StockMovement } from '../models/StockMovement.js';
import { fireOrder, openOrder, readOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
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

const billWithoutKot = (token, order, extra = {}) =>
  request('POST', '/api/v1/bills', { token, body: { orderId: order.id, version: order.version, withoutKot: true, ...extra } });

/** A dish with a recipe, so a Send (or a bill without one) deducts 150 g of paneer per portion. */
async function mappedFloor() {
  const floor = await seedFloor();
  const paneer = (
    await request('POST', '/api/v1/ingredients', {
      token: floor.tokens.OWNER,
      body: { name: 'Paneer', baseUnit: 'G', unitsPerBase: 1000, purchaseUnitName: 'kg', openingQtyInBase: 5000 },
    })
  ).body.data;
  const recipe = await request('PUT', '/api/v1/recipes', {
    token: floor.tokens.OWNER,
    body: { menuItemId: floor.item.id, items: [{ ingredientId: paneer.id, qtyInBase: 150 }] },
  });
  assert.equal(recipe.status, 201, JSON.stringify(recipe.body));
  return floor;
}

const deductions = (restaurantId) => StockMovement.countDocuments({ restaurantId, type: 'DEDUCTION' });

describe('Bill without KOT', () => {
  it('a cashier bills a table without a KOT: dishes served and marked, no ticket, stock deducted once', async () => {
    const floor = await mappedFloor();
    const { tokens, table, item, restaurant } = floor;
    const order = (await openOrder(tokens.CASHIER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 2 }] })).body.data;

    // A preview changes nothing.
    const preview = await billWithoutKot(tokens.CASHIER, order, { preview: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.data.billNumber, null);
    assert.equal(preview.body.data.grandTotalInPaise, 50400);
    const untouched = (await readOrder(tokens.CASHIER, order.id)).body.data;
    assert.equal(untouched.status, 'OPEN');
    assert.equal(untouched.version, order.version);
    assert.equal(untouched.lines[0].status, 'PENDING');
    assert.equal(await deductions(restaurant._id), 0);

    const billed = await billWithoutKot(tokens.CASHIER, order);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    assert.equal(billed.body.data.grandTotalInPaise, 50400, '2 × ₹240 + 5% GST');
    assert.equal(billed.body.data.lines[0].billedWithoutKot, true);

    const after = (await readOrder(tokens.CASHIER, order.id)).body.data;
    assert.equal(after.status, 'READY_TO_BILL');
    assert.equal(after.lines[0].status, 'SERVED');
    assert.equal(after.lines[0].billedWithoutKot, true);
    assert.equal(after.lines[0].firedAt, null);
    assert.ok(after.lines[0].servedAt);
    assert.equal(await Kot.countDocuments({ restaurantId: restaurant._id }), 0, 'no KOT');
    assert.equal(await deductions(restaurant._id), 1, 'stock deducted as a Send would');

    // An ordinary bill from here: paid in cash, the table is free.
    const paid = await request('POST', `/api/v1/bills/${billed.body.data.id}/payments`, {
      token: tokens.CASHIER,
      body: { method: 'CASH', amountInPaise: 50400 },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'PAID');
  });

  it('works for a takeaway, and for an order already ready to bill', async () => {
    const floor = await seedFloor();
    const { tokens, item } = floor;
    const takeaway = (await request('POST', '/api/v1/orders', {
      token: tokens.CASHIER,
      body: { orderType: 'TAKEAWAY', lines: [{ menuItemId: item.id, quantity: 1 }] },
    })).body.data;
    assert.equal((await billWithoutKot(tokens.MANAGER, takeaway)).status, 201);

    const ready = await readyToBillOrder(floor);
    const billed = await billWithoutKot(tokens.OWNER, ready);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    assert.equal(billed.body.data.lines[0].billedWithoutKot, false, 'it went through the kitchen');
  });

  it('refuses a captain, a delivery order, a dish with the kitchen, a stale version and another restaurant', async () => {
    const floor = await seedFloor();
    const other = await seedFloor();
    const { tokens, table, item } = floor;
    const order = (await openOrder(tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 1 }] })).body.data;

    const captain = await billWithoutKot(tokens.WAITER, order);
    assert.equal(captain.status, 403);
    assert.equal(captain.body.error.message, 'Only the counter can bill without sending to the kitchen.');

    assert.equal((await billWithoutKot(tokens.CASHIER, { ...order, version: order.version + 5 })).status, 409);
    assert.equal((await billWithoutKot(other.tokens.CASHIER, order)).status, 404);

    const delivery = (await request('POST', '/api/v1/orders', {
      token: tokens.CASHIER,
      body: { orderType: 'DELIVERY', platform: { code: 'SWIGGY', orderId: '249377796192385' }, lines: [{ menuItemId: item.id, quantity: 1 }] },
    })).body.data;
    const refusedDelivery = await billWithoutKot(tokens.CASHIER, delivery);
    assert.equal(refusedDelivery.status, 422);
    assert.equal(refusedDelivery.body.error.message, 'Only a table or a takeaway can be billed without a KOT.');

    // Sent to the kitchen, then another dish added: the first is still with the kitchen.
    let current = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data.order;
    current = (await request('POST', `/api/v1/orders/${order.id}/lines`, {
      token: tokens.WAITER,
      body: { version: current.version, lines: [{ menuItemId: item.id, quantity: 1 }] },
    })).body.data;
    const withKitchen = await billWithoutKot(tokens.CASHIER, current);
    assert.equal(withKitchen.status, 422);
    assert.equal(withKitchen.body.error.message, 'Some dishes are with the kitchen. Bill once they are served.');
    assert.equal((await readOrder(tokens.CASHIER, order.id)).body.data.status, 'OPEN', 'nothing changed');
  });

  it('with requireGuestCount on, a table needs its guests first', async () => {
    const floor = await seedFloor();
    const { tokens, table, item } = floor;
    await request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'Covers', floor: { requireGuestCount: true } } });
    const order = (await openOrder(tokens.CASHIER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 1 }] })).body.data;
    const refused = await billWithoutKot(tokens.CASHIER, order);
    assert.equal(refused.status, 400);
    assert.ok(refused.body.error.fields.guestCount);

    const counted = (await request('PATCH', `/api/v1/orders/${order.id}/customer`, {
      token: tokens.CASHIER,
      body: { version: order.version, guestCount: 2 },
    })).body.data;
    const billed = await billWithoutKot(tokens.CASHIER, counted);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    assert.equal(billed.body.data.guestCount, 2);
  });
});
