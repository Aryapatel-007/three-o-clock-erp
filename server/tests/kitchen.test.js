/**
 * Firing and the kitchen display.
 *
 * The cases worth having: firing twice producing two tickets rather than one
 * reprint, a ticket carrying no prices, the kitchen and the floor never
 * disagreeing about whether a dish exists, and the full lifecycle from an empty
 * table to READY_TO_BILL.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ROLES } from '../config/roles.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import {
  addLines,
  createMenuItem,
  fireOrder,
  openOrder,
  readOrder,
  seedFloor,
} from './helpers/m2Fixtures.js';
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

const listKots = (token, query = '') => request('GET', `/api/v1/kots${query}`, { token });

const markLineReady = (token, kotId, lineId) =>
  request('PATCH', `/api/v1/kots/${kotId}/lines/${lineId}/ready`, { token });

const markKotReady = (token, kotId) => request('PATCH', `/api/v1/kots/${kotId}/ready`, { token });

/**
 * P29 Part C. These tests are about the two-step flow, ready then served, so
 * they switch the kitchen's ready-means-served off; tests/readyMeansServed
 * covers it on.
 */
const twoStep = (tokens) =>
  request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'Two-step kitchen', kitchen: { readyMeansServed: false } } });

const markServed = (token, orderId, lineId, version) =>
  request('PATCH', `/api/v1/orders/${orderId}/lines/${lineId}/served`, {
    token,
    body: { version },
  });

/** An order with two pending lines on a table. */
async function orderWithTwoLines() {
  const floor = await seedFloor();
  const second = (
    await createMenuItem(floor.tokens.OWNER, { name: 'Dal Fry', priceInPaise: 18000 })
  ).body.data;

  const order = (
    await openOrder(floor.tokens.WAITER, {
      tableId: floor.table.id,
      lines: [
        { menuItemId: floor.item.id, quantity: 2, notes: 'less spicy' },
        { menuItemId: second.id, quantity: 1 },
      ],
    })
  ).body.data;

  return { ...floor, second, order };
}

// ---------------------------------------------------------------------------

describe('firing', () => {
  it('creates a ticket and moves every pending line to FIRED', async () => {
    const { tokens, order } = await orderWithTwoLines();

    const response = await fireOrder(tokens.WAITER, order.id, order.version);

    assert.equal(response.status, 200);
    const { kot, order: updated } = response.body.data;

    assert.equal(kot.kotNumber, 1);
    assert.equal(kot.orderNumber, order.orderNumber);
    assert.equal(kot.tableName, 'T1');
    assert.equal(kot.status, 'PENDING');
    assert.equal(kot.lines.length, 2);

    assert.equal(
      updated.lines.every((line) => line.status === 'FIRED'),
      true,
    );
    assert.equal(updated.lines[0].kotId, kot.id);
    assert.notEqual(updated.lines[0].firedAt, null);
    assert.equal(updated.version, order.version + 1);
  });

  it('puts no prices on the ticket', async () => {
    const { tokens, table } = await seedFloor();
    const item = (
      await createMenuItem(tokens.OWNER, {
        name: 'Pav Bhaji',
        priceInPaise: 12000,
        addOns: [{ name: 'Extra butter', priceInPaise: 3000 }],
      })
    ).body.data;

    const order = (
      await openOrder(tokens.WAITER, {
        tableId: table.id,
        lines: [{ menuItemId: item.id, quantity: 1, addOnIds: [item.addOns[0].id] }],
      })
    ).body.data;

    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    // The kitchen gets names and quantities. Money is none of its business.
    const asText = JSON.stringify(kot);
    assert.equal(asText.includes('12000'), false);
    assert.equal(asText.includes('3000'), false);
    assert.equal(asText.includes('priceInPaise'), false);
    assert.deepEqual(kot.lines[0].addOnNames, ['Extra butter']);
    assert.equal(kot.lines[0].quantity, 1);
  });

  it('carries the note through to the ticket', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    const line = kot.lines.find((entry) => entry.itemName === 'Paneer Tikka');
    assert.equal(line.notes, 'less spicy');
  });

  it('refuses to fire when nothing is pending', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const fired = await fireOrder(tokens.WAITER, order.id, order.version);

    const again = await fireOrder(tokens.WAITER, order.id, fired.body.data.order.version);

    assert.equal(again.status, 422);
    assert.equal(again.body.error.code, 'BUSINESS_RULE_VIOLATED');
  });

  // 2026-11-03. Every Send is a new KOT, even from the same table (P36's one ticket per order is gone).
  it('makes a new ticket, under a new number, for a second Send from the same order', async () => {
    const { tokens, order, second } = await orderWithTwoLines();

    const first = await fireOrder(tokens.WAITER, order.id, order.version);
    const afterFirst = first.body.data.order;

    // The mains, twenty minutes later, on the same order.
    const withMains = await addLines(tokens.WAITER, order.id, {
      version: afterFirst.version,
      lines: [{ menuItemId: second.id, quantity: 3 }],
    });

    const secondFire = await fireOrder(tokens.WAITER, order.id, withMains.body.data.version);

    assert.equal(secondFire.status, 200);
    const secondKot = secondFire.body.data.kot;

    assert.notEqual(secondKot.id, first.body.data.kot.id);
    assert.equal(secondKot.kotNumber, first.body.data.kot.kotNumber + 1);
    // The mains alone are on it. This is the starters-then-mains flow.
    assert.equal(secondKot.lines.length, 1);
    assert.equal(secondKot.lines[0].quantity, 3);

    const tickets = await listKots(tokens.KITCHEN);
    assert.equal(tickets.body.data.length, 2);
  });

  it('refuses to fire with a stale version', async () => {
    const { tokens, order, item } = await orderWithTwoLines();

    await addLines(tokens.WAITER, order.id, {
      version: order.version,
      lines: [{ menuItemId: item.id, quantity: 1 }],
    });

    const response = await fireOrder(tokens.WAITER, order.id, order.version);

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'VERSION_CONFLICT');

    // Nothing was written. No ticket exists for the fire that did not happen.
    const tickets = await listKots(tokens.KITCHEN);
    assert.equal(tickets.body.data.length, 0);
  });

  it('is refused for the kitchen and the storekeeper', async () => {
    const { tokens, order } = await orderWithTwoLines();

    for (const role of [ROLES.KITCHEN, ROLES.STOREKEEPER]) {
      const response = await fireOrder(tokens[role], order.id, order.version);
      assert.equal(response.status, 403, `${role} must not fire an order`);
    }
  });
});

describe('the kitchen display', () => {
  it('lists tickets oldest first', async () => {
    const { tokens, order, second } = await orderWithTwoLines();
    // P36. Two tickets for one order needs P05's ticket per Send.
    await request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'A ticket per Send', kitchen: { oneTicketPerOrder: false } } });

    const first = await fireOrder(tokens.WAITER, order.id, order.version);
    const withMore = await addLines(tokens.WAITER, order.id, {
      version: first.body.data.order.version,
      lines: [{ menuItemId: second.id, quantity: 1 }],
    });
    await fireOrder(tokens.WAITER, order.id, withMore.body.data.version);

    const tickets = await listKots(tokens.KITCHEN);

    assert.deepEqual(
      tickets.body.data.map((kot) => kot.kotNumber),
      [1, 2],
    );
  });

  it('derives a status from the lines and stores none', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    assert.equal(kot.status, 'PENDING');

    const partly = await markLineReady(tokens.KITCHEN, kot.id, kot.lines[0].id);
    assert.equal(partly.body.data.status, 'IN_PROGRESS');

    const done = await markLineReady(tokens.KITCHEN, kot.id, kot.lines[1].id);
    assert.equal(done.body.data.status, 'COMPLETED');
  });

  it('filters by a comma-separated status list', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    const pending = await listKots(tokens.KITCHEN, '?status=PENDING');
    assert.equal(pending.body.data.length, 1);

    await markKotReady(tokens.KITCHEN, kot.id);

    const stillPending = await listKots(tokens.KITCHEN, '?status=PENDING,IN_PROGRESS');
    assert.equal(stillPending.body.data.length, 0);

    const completed = await listKots(tokens.KITCHEN, '?status=COMPLETED');
    assert.equal(completed.body.data.length, 1);
  });

  it('shows a new ticket however many finished ones come before it (2 October 2026)', async () => {
    const { tokens, order } = await orderWithTwoLines();
    let current = order;
    // Three finished tickets, then one still to cook, with a page of two.
    for (let n = 0; n < 3; n += 1) {
      current = (await addLines(tokens.WAITER, current.id, { version: current.version, lines: [{ menuItemId: current.lines[0].menuItemId, quantity: 1 }] })).body.data;
      const fired = (await fireOrder(tokens.WAITER, current.id, current.version)).body.data;
      for (const ticket of fired.kots) await markKotReady(tokens.KITCHEN, ticket.id);
      current = (await readOrder(tokens.WAITER, current.id)).body.data;
    }
    current = (await addLines(tokens.WAITER, current.id, { version: current.version, lines: [{ menuItemId: current.lines[0].menuItemId, quantity: 1 }] })).body.data;
    const fresh = (await fireOrder(tokens.WAITER, current.id, current.version)).body.data.kot;

    const board = await listKots(tokens.KITCHEN, '?status=PENDING,IN_PROGRESS&limit=2');
    assert.ok(board.body.data.some((ticket) => ticket.id === fresh.id), 'the new ticket is on the first page');
    assert.ok(board.body.data.every((ticket) => ticket.status !== 'COMPLETED'));
    assert.equal(board.body.meta.total, board.body.data.length, 'the total counts open tickets only');
  });

  it('answers 404, not 403, for a ticket in another restaurant', async () => {
    const a = await orderWithTwoLines();
    const b = await seedFloor({ name: 'B' });

    const { kot } = (await fireOrder(a.tokens.WAITER, a.order.id, a.order.version)).body.data;

    const response = await request('GET', `/api/v1/kots/${kot.id}`, { token: b.tokens.OWNER });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});

describe('marking food ready', () => {
  it('moves the matching order line to READY, found by orderLineId', async () => {
    const { tokens, order } = await orderWithTwoLines();
    await twoStep(tokens);
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    const kotLine = kot.lines[0];
    await markLineReady(tokens.KITCHEN, kot.id, kotLine.id);

    const reread = await readOrder(tokens.WAITER, order.id);
    const orderLine = reread.body.data.lines.find((line) => line.id === kotLine.orderLineId);

    // The two documents must not drift. This is the assertion that catches it.
    assert.equal(orderLine.status, 'READY');
    assert.notEqual(orderLine.readyAt, null);

    // The other line is untouched.
    const other = reread.body.data.lines.find((line) => line.id !== kotLine.orderLineId);
    assert.equal(other.status, 'FIRED');
  });

  it('is open to all six roles', async () => {
    const { tokens, order } = await orderWithTwoLines();

    for (const role of Object.keys(tokens)) {
      const fresh = await orderWithTwoLines();
      const { kot } = (await fireOrder(fresh.tokens.WAITER, fresh.order.id, fresh.order.version)).body
        .data;

      const response = await markKotReady(fresh.tokens[role], kot.id);
      assert.equal(response.status, 200, `${role} should be able to mark a ticket ready`);
    }

    assert.ok(order);
  });

  it('refuses to mark the same line ready twice', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    await markLineReady(tokens.KITCHEN, kot.id, kot.lines[0].id);
    const again = await markLineReady(tokens.KITCHEN, kot.id, kot.lines[0].id);

    assert.equal(again.status, 422);
  });

  it('marks a whole ticket ready in one action', async () => {
    const { tokens, order } = await orderWithTwoLines();
    await twoStep(tokens);
    const { kot } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    const response = await markKotReady(tokens.KITCHEN, kot.id);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'COMPLETED');

    const reread = await readOrder(tokens.WAITER, order.id);
    assert.equal(
      reread.body.data.lines.every((line) => line.status === 'READY'),
      true,
    );
  });

  it('does not drag a served line back to READY', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const { kot, order: fired } = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;

    const kotLine = kot.lines[0];
    await markLineReady(tokens.KITCHEN, kot.id, kotLine.id);

    const beforeServe = await readOrder(tokens.WAITER, order.id);
    await markServed(tokens.WAITER, order.id, kotLine.orderLineId, beforeServe.body.data.version);

    // Someone tidying up the pass marks the whole ticket ready afterwards.
    await markKotReady(tokens.KITCHEN, kot.id);

    const reread = await readOrder(tokens.WAITER, order.id);
    const served = reread.body.data.lines.find((line) => line.id === kotLine.orderLineId);
    assert.equal(served.status, 'SERVED', 'a served line must not go back to READY');
    assert.ok(fired);
  });
});

describe('cancelling something the kitchen already has', () => {
  it('requires wasPrepared, and takes the line off the ticket', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const fired = await fireOrder(tokens.WAITER, order.id, order.version);
    const { kot, order: afterFire } = fired.body.data;

    const lineId = afterFire.lines[0].id;

    const without = await request('POST', `/api/v1/orders/${order.id}/lines/${lineId}/cancel`, {
      token: tokens.WAITER,
      body: { version: afterFire.version, reasonCode: 'OTHER', note: 'Customer changed their mind' },
    });

    assert.equal(without.status, 422, 'a fired line cannot be cancelled without an answer');
    assert.equal(without.body.error.code, 'BUSINESS_RULE_VIOLATED');

    // P28: with the answer, a captain would also need a manager's PIN; the manager cancels here.
    const withAnswer = await request('POST', `/api/v1/orders/${order.id}/lines/${lineId}/cancel`, {
      token: tokens.MANAGER,
      body: { version: afterFire.version, reasonCode: 'OTHER', note: 'Customer changed their mind', wasPrepared: true },
    });

    assert.equal(withAnswer.status, 200);
    const cancelled = withAnswer.body.data.lines.find((line) => line.id === lineId);
    assert.equal(cancelled.status, 'CANCELLED');
    // M4 reads this to decide whether the ingredients are gone.
    assert.equal(cancelled.wasPrepared, true);

    // The kitchen stops cooking it.
    const ticket = await request('GET', `/api/v1/kots/${kot.id}`, { token: tokens.KITCHEN });
    const ticketLine = ticket.body.data.lines.find((line) => line.orderLineId === lineId);
    assert.equal(ticketLine.status, 'CANCELLED');
  });

  it('takes every line off the ticket when the whole order is cancelled', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const fired = await fireOrder(tokens.WAITER, order.id, order.version);
    const { kot, order: afterFire } = fired.body.data;

    const response = await request('POST', `/api/v1/orders/${order.id}/cancel`, {
      token: tokens.OWNER,
      body: { version: afterFire.version, reasonCode: 'OTHER', note: 'Customer left', wasPrepared: false },
    });

    assert.equal(response.status, 200);

    const ticket = await request('GET', `/api/v1/kots/${kot.id}`, { token: tokens.KITCHEN });
    assert.equal(
      ticket.body.data.lines.every((line) => line.status === 'CANCELLED'),
      true,
    );
    // Nothing left to cook, so it leaves the kitchen screen.
    assert.equal(ticket.body.data.status, 'COMPLETED');
  });

  it('refuses to edit a line the kitchen already has', async () => {
    const { tokens, order } = await orderWithTwoLines();
    const fired = await fireOrder(tokens.WAITER, order.id, order.version);
    const afterFire = fired.body.data.order;

    const response = await request(
      'PATCH',
      `/api/v1/orders/${order.id}/lines/${afterFire.lines[0].id}`,
      { token: tokens.WAITER, body: { version: afterFire.version, quantity: 9 } },
    );

    assert.equal(response.status, 422);
  });
});

describe('the whole lifecycle', () => {
  it('runs an order from an empty table to READY_TO_BILL', async () => {
    const { tokens, table, item } = await seedFloor();
    await twoStep(tokens);
    const mains = (await createMenuItem(tokens.OWNER, { name: 'Dal Fry', priceInPaise: 18000 })).body
      .data;

    // 1. A waiter seats a table.
    let order = (await openOrder(tokens.WAITER, { tableId: table.id, guestCount: 2 })).body.data;
    assert.equal(order.status, 'OPEN');

    // 2. Three starters go on.
    order = (
      await addLines(tokens.WAITER, order.id, {
        version: order.version,
        lines: [
          { menuItemId: item.id, quantity: 1 },
          { menuItemId: item.id, quantity: 2, notes: 'no chilli' },
          { menuItemId: mains.id, quantity: 1 },
        ],
      })
    ).body.data;
    assert.equal(order.lines.length, 3);
    assert.equal(order.totals.subtotalInPaise, 24000 + 48000 + 18000);

    // 3. Fired to the kitchen.
    let fired = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;
    order = fired.order;
    assert.equal(fired.kot.lines.length, 3);

    // 4. The kitchen marks one ready.
    const firstKotLine = fired.kot.lines[0];
    await markLineReady(tokens.KITCHEN, fired.kot.id, firstKotLine.id);

    order = (await readOrder(tokens.WAITER, order.id)).body.data;
    assert.equal(
      order.lines.find((line) => line.id === firstKotLine.orderLineId).status,
      'READY',
    );

    // 5. And the waiter serves it.
    order = (
      await markServed(tokens.WAITER, order.id, firstKotLine.orderLineId, order.version)
    ).body.data;
    assert.equal(order.lines.find((line) => line.id === firstKotLine.orderLineId).status, 'SERVED');
    // Not everything is served, so the order is still open.
    assert.equal(order.status, 'OPEN');

    // 6. Two more go on, twenty minutes later, and are fired on a new ticket.
    order = (
      await addLines(tokens.WAITER, order.id, {
        version: order.version,
        lines: [{ menuItemId: mains.id, quantity: 2 }],
      })
    ).body.data;

    fired = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;
    order = fired.order;
    assert.equal(fired.kot.kotNumber, 2);
    assert.equal(fired.kot.lines.length, 1);

    // 7. Everything else comes up and goes out.
    const tickets = await listKots(tokens.KITCHEN);
    for (const kot of tickets.body.data) {
      await markKotReady(tokens.KITCHEN, kot.id);
    }

    order = (await readOrder(tokens.WAITER, order.id)).body.data;
    for (const line of order.lines.filter((entry) => entry.status === 'READY')) {
      const current = (await readOrder(tokens.WAITER, order.id)).body.data;
      const served = await markServed(tokens.WAITER, order.id, line.id, current.version);
      assert.equal(served.status, 200);
    }

    // 8. The last one served closes it, with no separate call.
    order = (await readOrder(tokens.WAITER, order.id)).body.data;
    assert.equal(
      order.lines.every((line) => line.status === 'SERVED'),
      true,
    );
    assert.equal(order.status, 'READY_TO_BILL');
    assert.notEqual(order.readyToBillAt, null);
    assert.equal(order.totals.subtotalInPaise, 24000 + 48000 + 18000 + 36000);

    // 9. Not free yet: the party is still sitting there unbilled, and a
    // READY_TO_BILL table stays occupied until M3 bills or cancels it.
    const floor = await request('GET', '/api/v1/tables', { token: tokens.OWNER });
    assert.equal(floor.body.data[0].occupancy.isOccupied, true);
  });
});
