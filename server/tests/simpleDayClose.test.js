/**
 * P61: a simple Day Close. docs/API-CONTRACT.md "P61".
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { Order } from '../models/Order.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { createTable, fireOrder, openOrder, seedFloor } from './helpers/m2Fixtures.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
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

beforeEach(async () => {
  await clearTestDatabase();
  setClockForTests(new Date('2026-09-26T08:00:00Z')); // 1:30 PM IST, business date 2026-09-26
});

afterEach(() => resetClockForTests());

const DATE = '2026-09-26';
const readDay = (token) => request('GET', `/api/v1/day-close/${DATE}`, { token });
const close = (token, body = {}) => request('POST', '/api/v1/day-close', { token, body: { businessDate: DATE, countedCashInPaise: 0, ...body } });

describe('a simple Day Close', () => {
  it('orders nothing was sent from do not block, and close themselves as opened by mistake', async () => {
    const floor = await seedFloor();
    const { tokens, table, item, restaurant } = floor;
    // A stray tap: a table opened with nothing on it.
    const empty = (await openOrder(tokens.WAITER, { tableId: table.id })).body.data;
    // Dishes added and never sent.
    const second = (await createTable(tokens.OWNER, { name: 'T2' })).body.data;
    const unsent = (await openOrder(tokens.WAITER, { tableId: second.id, lines: [{ menuItemId: item.id, quantity: 2 }] })).body.data;

    const day = (await readDay(tokens.MANAGER)).body.data;
    assert.deepEqual(day.blockers, []);
    assert.deepEqual(
      day.closesOnClose.map((entry) => [entry.orderNumber, entry.dishesNotSent]).sort(),
      [[empty.orderNumber, 0], [unsent.orderNumber, 1]].sort(),
    );

    const closed = await close(tokens.MANAGER);
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.data.isClosed, true);

    for (const order of [empty, unsent]) {
      const stored = await Order.findOne({ restaurantId: restaurant._id, _id: order.id }).lean();
      assert.equal(stored.status, 'CANCELLED');
      assert.equal(stored.cancelReasonCode, 'OPENED_BY_MISTAKE');
      assert.equal(stored.lines.length, 0, 'the not-sent dishes are removed, as Close table does');
      assert.equal(stored.occupiesTable, false);
    }
    // They count nowhere: no cancelled orders on the day.
    assert.equal(closed.body.data.figures.controls.cancelledOrders?.count ?? 0, 0);
  });

  it('an order with a dish sent still blocks, and nothing is closed', async () => {
    const { tokens, table, item, restaurant } = await seedFloor();
    const sent = (await openOrder(tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 1 }] })).body.data;
    await fireOrder(tokens.WAITER, sent.id, sent.version);
    const other = (await createTable(tokens.OWNER, { name: 'T2' })).body.data;
    const empty = (await openOrder(tokens.WAITER, { tableId: other.id })).body.data;

    const refused = await close(tokens.MANAGER);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'DAY_NOT_READY');
    assert.deepEqual(refused.body.error.blockers.map((blocker) => blocker.kind), ['OPEN_ORDER']);
    assert.equal(refused.body.error.blockers[0].ref, sent.id);
    assert.equal((await Order.findOne({ restaurantId: restaurant._id, _id: empty.id }).lean()).status, 'OPEN', 'a refused close changes nothing');
  });

  it('a cashier closes the day, blind', async () => {
    const { tokens } = await seedFloor();
    await request('POST', '/api/v1/cash-movements', { token: tokens.CASHIER, body: { type: 'OPENING_FLOAT', amountInPaise: 100000 } });

    const day = (await readDay(tokens.CASHIER)).body.data;
    assert.equal(day.expectedCashInPaise, undefined, 'a cashier never sees what the drawer should hold');

    const short = await close(tokens.CASHIER, { countedCashInPaise: 90000 });
    assert.equal(short.status, 422);
    assert.equal(short.body.error.noteRequired, true);
    assert.doesNotMatch(short.body.error.message, /100|90|₹/);

    const closed = await close(tokens.CASHIER, { countedCashInPaise: 90000, note: 'One note short', keptForTomorrowInPaise: 90000 });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.data.isClosed, true);
    assert.equal(closed.body.data.expectedCashInPaise, undefined);
    assert.equal(closed.body.data.differenceInPaise, undefined);
    assert.equal(closed.body.data.keptForTomorrowInPaise, 90000);

    // The owner sees the difference.
    const owner = (await readDay(tokens.OWNER)).body.data;
    assert.equal(owner.differenceInPaise, -10000);
    // The history stays the managers'; a waiter cannot close.
    assert.equal((await request('GET', '/api/v1/day-close', { token: tokens.CASHIER })).status, 403);
    assert.equal((await close(tokens.WAITER)).status, 403);
  });
});
