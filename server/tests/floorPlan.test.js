/**
 * M20 floor plan, built in P19: table layouts, the floor states, and the
 * guest count rule. docs/API-CONTRACT.md M2 sections 11.2, 11.5 and 12.1.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { ALL_MODELS } from '../models/index.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { createMenuItem, createTable, fireOrder, openOrder, readyToBillOrder, seedTeam } from './helpers/m2Fixtures.js';
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

afterEach(() => resetClockForTests());

const tablesOf = async (token) => (await request('GET', '/api/v1/tables', { token })).body.data;
const saveLayout = (token, body) => request('PATCH', '/api/v1/tables/layout', { token, body });
const at = (x, y, w = 1, h = 1, shape = 'SQUARE') => ({ x, y, w, h, shape });

/** A team with tables in "Cafe" and one in "Garden". */
async function seedSections() {
  const team = await seedTeam();
  const owner = team.tokens.OWNER;
  const cafe = [];
  for (const name of ['C1', 'C2', 'C3']) cafe.push((await createTable(owner, { name, section: 'Cafe', seats: 4 })).body.data);
  const garden = (await createTable(owner, { name: 'G1', section: 'Garden' })).body.data;
  return { ...team, owner, cafe, garden };
}

describe('PATCH /tables/layout', () => {
  it('stores every table\'s place, and saving again with one moved changes only that one', async () => {
    const { owner, cafe } = await seedSections();
    const first = await saveLayout(owner, {
      section: 'Cafe',
      tables: [
        { tableId: cafe[0].id, ...at(0, 0, 2, 2) },
        { tableId: cafe[1].id, ...at(4, 0, 2, 1, 'LONG') },
        { tableId: cafe[2].id, ...at(8, 0, 1, 1, 'ROUND') },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.length, 3);

    const second = await saveLayout(owner, { section: 'Cafe', tables: [{ tableId: cafe[2].id, ...at(10, 5, 1, 1, 'ROUND') }] });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const byName = Object.fromEntries((await tablesOf(owner)).map((table) => [table.name, table.layout]));
    assert.deepEqual(byName.C1, at(0, 0, 2, 2));
    assert.deepEqual(byName.C2, at(4, 0, 2, 1, 'LONG'));
    assert.deepEqual(byName.C3, at(10, 5, 1, 1, 'ROUND'));
    assert.equal(byName.G1, null);
  });

  it('refuses out-of-grid values, a LONG table with equal sides, another section\'s table and another restaurant\'s', async () => {
    const { owner, cafe, garden } = await seedSections();
    const other = await seedSections();
    for (const entry of [
      { tableId: cafe[0].id, ...at(23, 0, 2, 1) },
      { tableId: cafe[0].id, ...at(0, 15, 1, 2) },
      { tableId: cafe[0].id, ...at(24, 0) },
      { tableId: cafe[0].id, ...at(0, 0, 5, 1) },
      { tableId: cafe[0].id, ...at(0, 0, 2, 2, 'LONG') },
      { tableId: garden.id, ...at(0, 0) },
      { tableId: other.cafe[0].id, ...at(0, 0) },
    ]) {
      const response = await saveLayout(owner, { section: 'Cafe', tables: [entry] });
      assert.equal(response.status, 400, JSON.stringify(entry));
    }
    assert.ok((await tablesOf(owner)).every((table) => table.layout === null));
  });

  it('refuses two overlapping tables, naming both, and saves nothing', async () => {
    const { owner, cafe } = await seedSections();
    const response = await saveLayout(owner, {
      section: 'Cafe',
      tables: [
        { tableId: cafe[0].id, ...at(0, 0, 2, 2) },
        { tableId: cafe[1].id, ...at(1, 1, 2, 2) },
        { tableId: cafe[2].id, ...at(10, 10) },
      ],
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'BUSINESS_RULE_VIOLATED');
    assert.match(response.body.error.message, /C1 and C2/);
    assert.ok((await tablesOf(owner)).every((table) => table.layout === null));

    // Against a table that keeps its place, too.
    await saveLayout(owner, { section: 'Cafe', tables: [{ tableId: cafe[0].id, ...at(0, 0, 2, 2) }] });
    const clash = await saveLayout(owner, { section: 'Cafe', tables: [{ tableId: cafe[1].id, ...at(1, 0) }] });
    assert.equal(clash.status, 422);
    assert.match(clash.body.error.message, /C1 and C2/);
  });

  it('takes a table off the plan with layout: null', async () => {
    const { owner, cafe } = await seedSections();
    await saveLayout(owner, { section: 'Cafe', tables: [{ tableId: cafe[0].id, ...at(0, 0) }] });
    const response = await saveLayout(owner, { section: 'Cafe', tables: [{ tableId: cafe[0].id, layout: null }] });
    assert.equal(response.status, 200);
    assert.equal((await tablesOf(owner)).find((table) => table.name === 'C1').layout, null);
  });

  it('is for OWNER and MANAGER only', async () => {
    const team = await seedSections();
    const body = { section: 'Cafe', tables: [{ tableId: team.cafe[0].id, ...at(0, 0) }] };
    assert.equal((await saveLayout(team.tokens.MANAGER, body)).status, 200);
    for (const role of ['CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) assert.equal((await saveLayout(team.tokens[role], body)).status, 403, role);
    assert.equal((await request('PATCH', '/api/v1/tables/layout', { body })).status, 401);
    for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) {
      assert.equal((await request('GET', '/api/v1/tables', { token: team.tokens[role] })).status, 200, role);
    }
  });
});

describe('GET /tables, the floor states', () => {
  it('FREE, OPEN with guests, captain and item total, SERVED, BILL_PRINTED with the bill total, then FREE once paid', async () => {
    const team = await seedTeam();
    const owner = team.tokens.OWNER;
    const table = (await createTable(owner, { name: 'T9' })).body.data;
    const item = (await createMenuItem(owner, { priceInPaise: 24000, taxRateBps: 500 })).body.data;
    const state = async () => (await tablesOf(owner)).find((entry) => entry.id === table.id).occupancy;

    assert.equal((await state()).state, 'FREE');

    const opened = (await openOrder(team.tokens.WAITER, { tableId: table.id, guestCount: 3, lines: [{ menuItemId: item.id, quantity: 2 }] })).body.data;
    const open = await state();
    assert.deepEqual(
      [open.state, open.guestCount, open.captainName, open.itemTotalInPaise, open.billTotalInPaise, open.isLong],
      ['OPEN', 3, 'WAITER', 48000, null, false],
    );
    await request('POST', `/api/v1/orders/${opened.id}/cancel`, { token: owner, body: { version: opened.version, reasonCode: 'GUEST_LEFT' } });

    const served = await readyToBillOrder({ tokens: team.tokens, table, item });
    assert.equal((await state()).state, 'SERVED');

    const bill = (await request('POST', '/api/v1/bills', { token: team.tokens.CASHIER, body: { orderId: served.id, version: served.version } })).body.data;
    const printed = await state();
    assert.deepEqual([printed.state, printed.billId, printed.billNumber, printed.billTotalInPaise], ['BILL_PRINTED', bill.id, bill.billNumber, 25200]);

    const paid = await request('POST', `/api/v1/bills/${bill.id}/payments`, { token: team.tokens.CASHIER, body: { method: 'CASH', amountInPaise: 25200 } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal((await state()).state, 'FREE');
  });

  it('marks a table open longer than longOpenMinutes as long', async () => {
    const team = await seedTeam();
    const owner = team.tokens.OWNER;
    const table = (await createTable(owner, { name: 'L1' })).body.data;
    setClockForTests(new Date('2026-09-26T08:00:00Z'));
    await openOrder(team.tokens.WAITER, { tableId: table.id, guestCount: 2 });
    setClockForTests(new Date('2026-09-26T09:30:00Z'));
    assert.equal((await tablesOf(owner)).find((entry) => entry.id === table.id).occupancy.isLong, false);
    setClockForTests(new Date('2026-09-26T09:31:00Z'));
    assert.equal((await tablesOf(owner)).find((entry) => entry.id === table.id).occupancy.isLong, true);
  });

  it('shows the frozen line totals: a later menu price change does not move the floor', async () => {
    const team = await seedTeam();
    const owner = team.tokens.OWNER;
    const table = (await createTable(owner, { name: 'F1' })).body.data;
    const item = (await createMenuItem(owner, { priceInPaise: 30000 })).body.data;
    await openOrder(team.tokens.WAITER, { tableId: table.id, guestCount: 2, lines: [{ menuItemId: item.id, quantity: 1 }] });
    assert.equal((await request('PATCH', `/api/v1/menu-items/${item.id}`, { token: owner, body: { priceInPaise: 99900 } })).status, 200);
    assert.equal((await tablesOf(owner)).find((entry) => entry.id === table.id).occupancy.itemTotalInPaise, 30000);
  });

  it('reads the floor in the same number of queries for 5 tables and for 40', async (t) => {
    const countFor = async (tableCount) => {
      const team = await seedTeam();
      const owner = team.tokens.OWNER;
      const item = (await createMenuItem(owner)).body.data;
      for (let index = 0; index < tableCount; index += 1) {
        const table = (await createTable(owner, { name: `Q${index}` })).body.data;
        // Every other table occupied, half with a fired order, so the orders grow too.
        if (index % 2 === 0) {
          const opened = (await openOrder(team.tokens.WAITER, { tableId: table.id, guestCount: 2, lines: [{ menuItemId: item.id, quantity: 1 }] })).body.data;
          if (index % 4 === 0) await fireOrder(team.tokens.WAITER, opened.id, opened.version);
        }
      }
      let queries = 0;
      mongoose.set('debug', () => {
        queries += 1;
      });
      try {
        const response = await request('GET', '/api/v1/tables', { token: owner });
        assert.equal(response.body.data.length, tableCount);
      } finally {
        mongoose.set('debug', false);
      }
      return queries;
    };
    const five = await countFor(5);
    const forty = await countFor(40);
    t.diagnostic(`GET /tables took ${five} queries with 5 tables and ${forty} with 40`);
    assert.equal(forty, five, `5 tables took ${five} queries, 40 took ${forty}`);
  });
});

describe('The guest count rule', () => {
  it('P59: with requireGuestCount on, a table opens without guests and the first Send asks for them', async () => {
    const team = await seedTeam();
    const owner = team.tokens.OWNER;
    const table = (await createTable(owner, { name: 'R1' })).body.data;
    const item = (await createMenuItem(owner, { name: 'Pani Puri' })).body.data;

    const on = await request('PATCH', '/api/v1/settings', { token: owner, body: { reason: 'Covers on every table', floor: { requireGuestCount: true } } });
    assert.equal(on.status, 200, JSON.stringify(on.body));

    const opened = await openOrder(team.tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    assert.equal(opened.status, 201, 'P59: opening no longer needs guests');
    let order = opened.body.data;

    const refused = await request('POST', `/api/v1/orders/${order.id}/fire`, { token: team.tokens.WAITER, body: { version: order.version } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'VALIDATION_FAILED');
    assert.equal(refused.body.error.message, 'How many guests? Enter the number before sending to the kitchen.');
    assert.ok(refused.body.error.fields.guestCount);

    const counted = await request('PATCH', `/api/v1/orders/${order.id}/customer`, { token: team.tokens.WAITER, body: { version: order.version, guestCount: 3 } });
    assert.equal(counted.status, 200, JSON.stringify(counted.body));
    assert.equal(counted.body.data.guestCount, 3);
    order = counted.body.data;
    const fired = await request('POST', `/api/v1/orders/${order.id}/fire`, { token: team.tokens.WAITER, body: { version: order.version } });
    assert.equal(fired.status, 200, JSON.stringify(fired.body));

    // A table opened before, sent once without guests while the rule was off, is never refused a later Send.
    const other = (await createTable(owner, { name: 'R2' })).body.data;
    await request('PATCH', '/api/v1/settings', { token: owner, body: { reason: 'Off', floor: { requireGuestCount: false } } });
    let late = (await openOrder(team.tokens.WAITER, { tableId: other.id, lines: [{ menuItemId: item.id, quantity: 1 }] })).body.data;
    late = (await request('POST', `/api/v1/orders/${late.id}/fire`, { token: team.tokens.WAITER, body: { version: late.version } })).body.data.order;
    await request('PATCH', '/api/v1/settings', { token: owner, body: { reason: 'On', floor: { requireGuestCount: true } } });
    late = (await request('POST', `/api/v1/orders/${late.id}/lines`, { token: team.tokens.WAITER, body: { version: late.version, lines: [{ menuItemId: item.id, quantity: 1 }] } })).body.data;
    const again = await request('POST', `/api/v1/orders/${late.id}/fire`, { token: team.tokens.WAITER, body: { version: late.version } });
    assert.equal(again.status, 200, JSON.stringify(again.body));

    // Takeaway and delivery never take a count.
    const takeaway = (await request('POST', '/api/v1/orders', { token: team.tokens.CASHIER, body: { orderType: 'TAKEAWAY' } })).body.data;
    const noCount = await request('PATCH', `/api/v1/orders/${takeaway.id}/customer`, { token: team.tokens.CASHIER, body: { version: takeaway.version, guestCount: 2 } });
    assert.equal(noCount.status, 400);
    assert.equal(
      (await request('POST', '/api/v1/orders', { token: team.tokens.CASHIER, body: { orderType: 'DELIVERY', platform: { code: 'SWIGGY', orderId: '12345678' } } })).status,
      201,
    );

    const me = await request('GET', '/api/v1/auth/me', { token: team.tokens.WAITER });
    assert.deepEqual(me.body.data.floor, { sectionOrder: [], longOpenMinutes: 90, requireGuestCount: true });
  });

  it('settings.floor validates its values', async () => {
    const team = await seedTeam();
    for (const floor of [{ longOpenMinutes: 10 }, { longOpenMinutes: 601 }, { sectionOrder: ['Cafe', 'cafe'] }, { requireGuestCount: 'yes' }]) {
      const response = await request('PATCH', '/api/v1/settings', { token: team.tokens.OWNER, body: { reason: 'Try', floor } });
      assert.equal(response.status, 400, JSON.stringify(floor));
    }
    const ok = await request('PATCH', '/api/v1/settings', { token: team.tokens.OWNER, body: { reason: 'Order', floor: { sectionOrder: ['Garden', 'Cafe'], longOpenMinutes: 120 } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const settings = await request('GET', '/api/v1/settings', { token: team.tokens.OWNER });
    assert.deepEqual(settings.body.data.floor, { sectionOrder: ['Garden', 'Cafe'], longOpenMinutes: 120, requireGuestCount: false });
  });
});
