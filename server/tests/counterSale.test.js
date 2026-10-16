/**
 * Counter Sale: a takeaway billed and paid once it is sent, before the kitchen
 * has made it, with `billing.payFirstTakeaway` on (the default).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { seedFloor } from './helpers/m2Fixtures.js';
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

const createBill = (token, order) => request('POST', '/api/v1/bills', { token, body: { orderId: order.id, version: order.version } });
const readOrder = async (token, orderId) => (await request('GET', `/api/v1/orders/${orderId}`, { token })).body.data;
const setBilling = (floor, billing) => request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'Counter Sale', billing } });

/** A takeaway with one dish on it, sent to the kitchen unless `send` is false. */
async function takeaway(floor, { send = true } = {}) {
  const opened = await request('POST', '/api/v1/orders', {
    token: floor.tokens.CASHIER,
    body: { orderType: 'TAKEAWAY', lines: [{ menuItemId: floor.item.id, quantity: 2 }] },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  if (!send) return { order: opened.body.data, kot: null };
  const fired = await request('POST', `/api/v1/orders/${opened.body.data.id}/fire`, {
    token: floor.tokens.CASHIER,
    body: { version: opened.body.data.version },
  });
  assert.equal(fired.status, 200, JSON.stringify(fired.body));
  return { order: await readOrder(floor.tokens.CASHIER, opened.body.data.id), kot: fired.body.data.kot };
}

describe('Counter Sale: pay first on a takeaway', () => {
  it('is on by default, and /auth/me says so', async () => {
    const floor = await seedFloor();
    const me = (await request('GET', '/api/v1/auth/me', { token: floor.tokens.CASHIER })).body.data;
    assert.equal(me.billing.payFirstTakeaway, true);
  });

  it('bills and takes payment on a sent takeaway while the kitchen is still making it, and the kitchen still marks it ready', async () => {
    const floor = await seedFloor();
    const { order, kot } = await takeaway(floor);
    assert.equal(order.status, 'OPEN');

    const billed = await createBill(floor.tokens.CASHIER, order);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));
    const bill = billed.body.data;

    const paid = await request('POST', `/api/v1/bills/${bill.id}/payments`, {
      token: floor.tokens.CASHIER,
      body: { method: 'UPI', amountInPaise: bill.grandTotalInPaise },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'PAID');
    assert.equal((await readOrder(floor.tokens.CASHIER, order.id)).status, 'BILLED');

    // The ticket is still on the kitchen's screen, and ready works as always.
    const ready = await request('PATCH', `/api/v1/kots/${kot.id}/ready`, { token: floor.tokens.KITCHEN });
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    const after = await readOrder(floor.tokens.CASHIER, order.id);
    assert.equal(after.status, 'BILLED');
    assert.ok(after.lines.every((line) => line.status === 'SERVED'));
  });

  it('never bills a dish that has not been sent', async () => {
    const floor = await seedFloor();
    const { order } = await takeaway(floor, { send: false });
    const refused = await createBill(floor.tokens.CASHIER, order);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /still open/);
  });

  it('leaves a dine-in table as before: billed only once everything is served', async () => {
    const floor = await seedFloor();
    const opened = (await request('POST', '/api/v1/orders', {
      token: floor.tokens.WAITER,
      body: { orderType: 'DINE_IN', tableId: floor.table.id, guestCount: 2, lines: [{ menuItemId: floor.item.id, quantity: 1 }] },
    })).body.data;
    await request('POST', `/api/v1/orders/${opened.id}/fire`, { token: floor.tokens.WAITER, body: { version: opened.version } });
    const refused = await createBill(floor.tokens.CASHIER, await readOrder(floor.tokens.CASHIER, opened.id));
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, /still open/);
  });

  it('waits for the kitchen again when the owner turns it off', async () => {
    const floor = await seedFloor();
    assert.equal((await setBilling(floor, { payFirstTakeaway: false })).status, 200);
    const { order } = await takeaway(floor);
    const refused = await createBill(floor.tokens.CASHIER, order);
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, /still open/);
  });
});
