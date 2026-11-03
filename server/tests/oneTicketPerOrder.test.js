/**
 * P36 made one kitchen ticket per table, with later Sends as rounds on it.
 * 2026-11-03, at Arya's word: every Send to the kitchen is a new KOT, with its own
 * number, whatever `kitchen.oneTicketPerOrder` says. These tests hold that rule,
 * and that a ticket written as rounds before it still reads.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { Kot } from '../models/Kot.js';
import { resetClockForTests } from '../utils/time.js';
import { addLines, createCategory, createMenuItem, fireOrder, openOrder, seedFloor } from './helpers/m2Fixtures.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

afterEach(() => resetClockForTests());

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

/** Live Kitchen and Beverages, a pasta routed to the kitchen and a latte to the bar. */
async function stationFloor() {
  const floor = await seedFloor();
  const { tokens } = floor;
  const kitchen = ok(await request('POST', '/api/v1/stations', { token: tokens.OWNER, body: { name: 'Live Kitchen', displayOrder: 0 } }), 'kitchen');
  const bar = ok(await request('POST', '/api/v1/stations', { token: tokens.OWNER, body: { name: 'Beverages', displayOrder: 1 } }), 'bar');
  const pastaCategory = ok(await createCategory(tokens.OWNER, { name: 'Pasta' }), 'pasta category');
  const coffeeCategory = ok(await createCategory(tokens.OWNER, { name: 'Italian Coffees' }), 'coffee category');
  ok(await request('PATCH', `/api/v1/categories/${pastaCategory.id}`, { token: tokens.OWNER, body: { stationId: kitchen.id } }), 'route pasta');
  ok(await request('PATCH', `/api/v1/categories/${coffeeCategory.id}`, { token: tokens.OWNER, body: { stationId: bar.id } }), 'route coffee');
  const pasta = ok(await createMenuItem(tokens.OWNER, { name: 'Creamy Pesto Pasta', priceInPaise: 43000, categoryId: pastaCategory.id }), 'pasta');
  const latte = ok(await createMenuItem(tokens.OWNER, { name: 'Caffe Latte', priceInPaise: 22000, categoryId: coffeeCategory.id }), 'latte');
  return { ...floor, kitchen, bar, pasta, latte };
}

/** Opens the table with `first` and sends it, then adds `second` and sends that too. */
async function twoSends(floor, first, second) {
  const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: first }), 'open');
  const one = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'first send');
  const added = ok(await addLines(floor.tokens.WAITER, opened.id, { version: one.order.version, lines: second }), 'add');
  const two = ok(await fireOrder(floor.tokens.WAITER, opened.id, added.version), 'second send');
  return { orderId: opened.id, one, two };
}

const kotsOf = (token, query = '') => request('GET', `/api/v1/kots${query}`, { token });


describe('a new ticket on every Send', () => {
  it('makes a new ticket, with its own number, on a second Send from the same table, even with the old setting on', async () => {
    const floor = await seedFloor();
    ok(await request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'Old setting', kitchen: { oneTicketPerOrder: true } } }), 'on');
    const { one, two } = await twoSends(floor, [{ menuItemId: floor.item.id, quantity: 1 }], [{ menuItemId: floor.item.id, quantity: 2 }]);

    assert.notEqual(two.kot.id, one.kot.id);
    assert.ok(two.kot.kotNumber > one.kot.kotNumber);
    assert.deepEqual(two.kot.lines.map((line) => line.quantity), [2]);
    const tickets = ok(await kotsOf(floor.tokens.KITCHEN), 'list');
    assert.equal(tickets.length, 2);
    assert.equal(await Kot.countDocuments({ restaurantId: floor.restaurant._id }), 2);
  });

  it('with the setting off, still makes one ticket per Send, whatever the sections', async () => {
    const floor = await stationFloor();
    ok(await request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'A ticket per station', kitchen: { oneTicketPerOrder: false } } }), 'off');
    const { one, two } = await twoSends(floor, [{ menuItemId: floor.pasta.id, quantity: 1 }, { menuItemId: floor.latte.id, quantity: 1 }], [{ menuItemId: floor.pasta.id, quantity: 1 }]);
    assert.equal(one.kots.length, 1);
    assert.notEqual(two.kot.id, one.kot.id);
    assert.equal(await Kot.countDocuments({ restaurantId: floor.restaurant._id }), 2);
  });

  it('still lists a ticket from before P36, whose lines have no station, by its own station', async () => {
    const floor = await stationFloor();
    const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: [{ menuItemId: floor.latte.id, quantity: 1 }] }), 'open');
    const fired = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'send');
    // As a ticket written before P36: the station on the ticket, none on the lines.
    await Kot.collection.updateOne(
      { _id: (await Kot.findOne({ restaurantId: floor.restaurant._id }))._id },
      { $unset: { 'lines.$[].stationId': '', 'lines.$[].stationName': '', 'lines.$[].firedAt': '', 'lines.$[].round': '', rounds: '', lastFiredAt: '' } },
    );
    const list = ok(await kotsOf(floor.tokens.KITCHEN, `?stationId=${floor.bar.id}`), 'bar');
    assert.deepEqual(list.map((entry) => entry.id), [fired.kot.id]);
    assert.equal(list[0].lines[0].stationName, 'Beverages', "a line goes by the ticket's station");
    assert.equal(list[0].rounds, 1);
    assert.equal(ok(await kotsOf(floor.tokens.KITCHEN, `?stationId=${floor.kitchen.id}`), 'kitchen').length, 0);
  });

});
