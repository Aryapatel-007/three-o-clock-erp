/**
 * P58: one kitchen ticket per Send, not per station.
 * docs/prompts/P58-one-ticket-per-send.md, API-CONTRACT "P58", DB-SCHEMA section 58.
 *
 * With `kitchen.splitTicketsByStation` off and `kitchen.oneTicketPerOrder` off
 * (Z Chaat's way), each Send is one ticket with every dish on it and no station
 * of its own; the next Send from the same table is a new ticket.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Kot } from '../models/Kot.js';
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

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

/** Three stations, a dish routed to each, and the kitchen settings given. */
async function stationFloor(kitchen) {
  const floor = await seedFloor();
  const { tokens } = floor;
  const station = async (name, displayOrder) => ok(await request('POST', '/api/v1/stations', { token: tokens.OWNER, body: { name, displayOrder } }), name);
  const chaat = await station('Chaat Counter', 0);
  const tandoor = await station('Tandoor', 1);
  const bar = await station('Beverages', 2);
  const dish = async (category, name, stationId, priceInPaise) => {
    const made = ok(await createCategory(tokens.OWNER, { name: category }), category);
    ok(await request('PATCH', `/api/v1/categories/${made.id}`, { token: tokens.OWNER, body: { stationId } }), `route ${category}`);
    return ok(await createMenuItem(tokens.OWNER, { name, priceInPaise, categoryId: made.id }), name);
  };
  const pani = await dish('Chaat', 'Pani Puri', chaat.id, 8000);
  const roti = await dish('Tandoor Breads', 'Butter Roti', tandoor.id, 4000);
  const coke = await dish('Drinks', 'Coke', bar.id, 7000);
  if (kitchen) ok(await request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'Tickets by table', kitchen } }), 'settings');
  return { ...floor, chaat, tandoor, bar, pani, roti, coke };
}

const threeDishes = (floor) => [
  { menuItemId: floor.pani.id, quantity: 3 },
  { menuItemId: floor.roti.id, quantity: 2 },
  { menuItemId: floor.coke.id, quantity: 1 },
];

describe('one ticket per Send, not per station', () => {
  it('puts a Send across three stations on one ticket with no station of its own, each line keeping its station', async () => {
    const floor = await stationFloor({ oneTicketPerOrder: false, splitTicketsByStation: false });
    const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: threeDishes(floor) }), 'open');
    const sent = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'send');

    assert.equal(sent.kots.length, 1);
    assert.equal(sent.kot.stationId, null);
    assert.equal(sent.kot.stationName, null);
    assert.deepEqual(
      sent.kot.lines.map((line) => [line.itemName, line.stationName]),
      [['Pani Puri', 'Chaat Counter'], ['Butter Roti', 'Tandoor'], ['Coke', 'Beverages']],
    );
    assert.deepEqual([...new Set(sent.order.lines.map((line) => line.kotId))], [sent.kot.id]);
    assert.equal(await Kot.countDocuments({ restaurantId: floor.restaurant._id }), 1);

    // Printed whole, under KITCHEN, with every dish.
    const { text } = ok(await request('GET', `/api/v1/kots/${sent.kot.id}/ticket?width=32`, { token: floor.tokens.KITCHEN }), 'ticket');
    assert.match(text, /KITCHEN/);
    assert.doesNotMatch(text, /CHAAT COUNTER|TANDOOR|BEVERAGES/);
    assert.match(text, /3 x Pani Puri/);
    assert.match(text, /2 x Butter Roti/);
    assert.match(text, /1 x Coke/);
  });

  it('gives a later Send from the same table its own ticket with the next number', async () => {
    const floor = await stationFloor({ oneTicketPerOrder: false, splitTicketsByStation: false });
    const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: threeDishes(floor) }), 'open');
    const one = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'first send');
    const added = ok(
      await addLines(floor.tokens.WAITER, opened.id, { version: one.order.version, lines: [{ menuItemId: floor.roti.id, quantity: 1 }, { menuItemId: floor.coke.id, quantity: 1 }] }),
      'add',
    );
    const two = ok(await fireOrder(floor.tokens.WAITER, opened.id, added.version), 'second send');

    assert.notEqual(two.kot.id, one.kot.id);
    assert.ok(two.kot.kotNumber > one.kot.kotNumber, `${two.kot.kotNumber} after ${one.kot.kotNumber}`);
    assert.equal(two.kots.length, 1);
    assert.equal(two.kot.stationName, null);
    assert.deepEqual(two.kot.lines.map((line) => [line.itemName, line.quantity]), [['Butter Roti', 1], ['Coke', 1]]);
    assert.equal(await Kot.countDocuments({ restaurantId: floor.restaurant._id }), 2);
  });

  it('keeps one ticket per station per Send while the setting is on, as P05', async () => {
    const floor = await stationFloor({ oneTicketPerOrder: false });
    const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: threeDishes(floor) }), 'open');
    const sent = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'send');

    assert.deepEqual(sent.kots.map((kot) => kot.stationName), ['Chaat Counter', 'Tandoor', 'Beverages']);
    assert.equal(new Set(sent.kots.map((kot) => kot.kotNumber)).size, 3);
  });

  it('leaves the one ticket per order without a station when the setting is off', async () => {
    const floor = await stationFloor({ splitTicketsByStation: false });
    const opened = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: [{ menuItemId: floor.pani.id, quantity: 1 }] }), 'open');
    const sent = ok(await fireOrder(floor.tokens.WAITER, opened.id, opened.version), 'send');

    // One station's dish only, and still no station of its own.
    assert.equal(sent.kot.stationName, null);
    assert.equal(sent.kot.lines[0].stationName, 'Chaat Counter');
  });

  it('is on by default, carried on /auth/me, and only the owner changes it', async () => {
    const floor = await seedFloor();
    const me = ok(await request('GET', '/api/v1/auth/me', { token: floor.tokens.KITCHEN }), 'me');
    assert.equal(me.kitchen.splitTicketsByStation, true);

    const refused = await request('PATCH', '/api/v1/settings', { token: floor.tokens.MANAGER, body: { reason: 'Tickets by table', kitchen: { splitTicketsByStation: false } } });
    assert.equal(refused.status, 403);
    const bad = await request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'Tickets by table', kitchen: { splitTicketsByStation: 'no' } } });
    assert.equal(bad.status, 400);

    ok(await request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'Tickets by table', kitchen: { splitTicketsByStation: false } } }), 'off');
    const after = ok(await request('GET', '/api/v1/auth/me', { token: floor.tokens.KITCHEN }), 'me after');
    assert.equal(after.kitchen.splitTicketsByStation, false);
  });
});
