/**
 * Kitchen stations, routing and the KOT ticket. M18, built in P05.
 *
 * Routing is the part that matters: one fire, one KOT per station, each with
 * only its own lines, and a restaurant with no stations firing exactly as it
 * did before.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Kot } from '../models/Kot.js';
import { StockMovement } from '../models/StockMovement.js';
import { renderKotTicket } from '../services/kotTicketService.js';
import {
  addLines,
  createCategory,
  createMenuItem,
  fireOrder,
  openOrder,
  readOrder,
  seedFloor,
  seedTeam,
} from './helpers/m2Fixtures.js';
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

const createStation = (token, body) => request('POST', '/api/v1/stations', { token, body });
const patchStation = (token, id, body) => request('PATCH', `/api/v1/stations/${id}`, { token, body });
const patchCategory = (token, id, body) => request('PATCH', `/api/v1/categories/${id}`, { token, body });

/**
 * Live Kitchen and Beverages, a Pasta category routed to the kitchen and an
 * Italian Coffees category routed to the bar, with one dish in each. The
 * golden day's own routing, from docs/TEST-DATA.md section 1.
 */
async function stationFloor() {
  const floor = await seedFloor();
  const { tokens } = floor;
  const kitchen = (await createStation(tokens.OWNER, { name: 'Live Kitchen', displayOrder: 0 })).body.data;
  const bar = (await createStation(tokens.OWNER, { name: 'Beverages', displayOrder: 1, printsTickets: true }))
    .body.data;

  const pastaCategory = (await createCategory(tokens.OWNER, { name: 'Pasta' })).body.data;
  const coffeeCategory = (await createCategory(tokens.OWNER, { name: 'Italian Coffees' })).body.data;
  assert.equal((await patchCategory(tokens.OWNER, pastaCategory.id, { stationId: kitchen.id })).status, 200);
  assert.equal((await patchCategory(tokens.OWNER, coffeeCategory.id, { stationId: bar.id })).status, 200);

  const pasta = (
    await createMenuItem(tokens.OWNER, { name: 'Creamy Pesto Pasta', priceInPaise: 43000, categoryId: pastaCategory.id })
  ).body.data;
  const latte = (
    await createMenuItem(tokens.OWNER, { name: 'Caffe Latte', priceInPaise: 22000, categoryId: coffeeCategory.id })
  ).body.data;

  /**
   * P36. These tests are about P05's routing, a ticket per station per Send,
   * so they switch one ticket per order off; tests/oneTicketPerOrder covers it on.
   */
  const off = await request('PATCH', '/api/v1/settings', {
    token: tokens.OWNER,
    body: { reason: 'A ticket per station', kitchen: { oneTicketPerOrder: false } },
  });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  return { ...floor, kitchen, bar, pastaCategory, coffeeCategory, pasta, latte };
}

async function fireLines({ tokens, table }, lines) {
  const opened = (await openOrder(tokens.WAITER, { tableId: table.id, lines })).body.data;
  const fired = await fireOrder(tokens.WAITER, opened.id, opened.version);
  assert.equal(fired.status, 200, JSON.stringify(fired.body));
  return fired.body.data;
}

// ---------------------------------------------------------------------------

describe('routing when an order fires', () => {
  it('makes one KOT with no station when the restaurant has no stations', async () => {
    const floor = await seedFloor();
    const fired = await fireLines(floor, [{ menuItemId: floor.item.id, quantity: 2 }]);

    assert.equal(fired.kots.length, 1);
    assert.equal(fired.kot.stationId, null);
    assert.equal(fired.kot.stationName, null);
    assert.equal(fired.kot.lines.length, 1);
  });

  // 2026-11-03: one KOT for the whole Send; each dish keeps its section, in station order.
  it('puts a pasta and a latte on one KOT, each dish routed to its own section', async () => {
    const floor = await stationFloor();
    const fired = await fireLines(floor, [
      { menuItemId: floor.latte.id, quantity: 1 },
      { menuItemId: floor.pasta.id, quantity: 1 },
    ]);

    assert.equal(fired.kots.length, 1);
    assert.equal(fired.kot.stationName, null);
    assert.deepEqual(
      fired.kot.lines.map((line) => [line.itemName, line.stationName]),
      [
        ['Creamy Pesto Pasta', 'Live Kitchen'],
        ['Caffe Latte', 'Beverages'],
      ],
    );
    // Every order line points at that one ticket.
    assert.deepEqual([...new Set(fired.order.lines.map((line) => line.kotId))], [fired.kot.id]);
  });

  it('sends a line whose category has no station to the first station', async () => {
    const floor = await stationFloor();
    // floor.item sits in a category created by seedFloor, with no station.
    const fired = await fireLines(floor, [{ menuItemId: floor.item.id, quantity: 1 }]);

    assert.equal(fired.kots.length, 1);
    assert.equal(fired.kot.stationName, 'Live Kitchen');
  });

  it('sends a line whose station was deactivated to the default station', async () => {
    const floor = await stationFloor();
    const response = await patchStation(floor.tokens.OWNER, floor.bar.id, { isActive: false });
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.categoriesFallingBack, 1);

    const fired = await fireLines(floor, [{ menuItemId: floor.latte.id, quantity: 1 }]);
    assert.equal(fired.kot.stationName, 'Live Kitchen');
  });

  it('routes only the new lines when the order fires again', async () => {
    const floor = await stationFloor();
    const first = await fireLines(floor, [{ menuItemId: floor.pasta.id, quantity: 1 }]);
    assert.equal(first.kots.length, 1);

    const added = (
      await addLines(floor.tokens.WAITER, first.order.id, {
        version: first.order.version,
        lines: [{ menuItemId: floor.latte.id, quantity: 2 }],
      })
    ).body.data;
    const second = (await fireOrder(floor.tokens.WAITER, added.id, added.version)).body.data;

    assert.equal(second.kots.length, 1);
    assert.equal(second.kot.stationName, 'Beverages');
    assert.deepEqual(second.kot.lines.map((line) => line.itemName), ['Caffe Latte']);
  });

  it('never changes a printed KOT when its category moves station', async () => {
    const floor = await stationFloor();
    const fired = await fireLines(floor, [{ menuItemId: floor.latte.id, quantity: 1 }]);

    await patchCategory(floor.tokens.OWNER, floor.coffeeCategory.id, { stationId: floor.kitchen.id });

    const kot = await Kot.findOne({ restaurantId: floor.restaurant._id, _id: fired.kot.id });
    assert.equal(kot.stationName, 'Beverages');
    assert.equal(String(kot.stationId), floor.bar.id);
  });

  it('deducts stock once per fired line when one fire makes two KOTs', async () => {
    const floor = await stationFloor();
    const { tokens } = floor;
    const milk = (
      await request('POST', '/api/v1/ingredients', {
        token: tokens.OWNER,
        body: { name: 'Milk', baseUnit: 'ML', unitsPerBase: 1000, purchaseUnitName: 'litre', openingQtyInBase: 10000 },
      })
    ).body.data;
    for (const item of [floor.pasta, floor.latte]) {
      const recipe = await request('PUT', '/api/v1/recipes', {
        token: tokens.OWNER,
        body: { menuItemId: item.id, items: [{ ingredientId: milk.id, qtyInBase: 100 }] },
      });
      assert.equal(recipe.status, 201, JSON.stringify(recipe.body));
    }

    await fireLines(floor, [
      { menuItemId: floor.pasta.id, quantity: 1 },
      { menuItemId: floor.latte.id, quantity: 1 },
    ]);

    assert.equal(
      await StockMovement.countDocuments({ restaurantId: floor.restaurant._id, type: 'DEDUCTION' }),
      2,
    );
  });
});

describe('station endpoints', () => {
  it('creates, renames and deactivates a station, and refuses a duplicate name', async () => {
    const { tokens } = await seedTeam();
    const created = await createStation(tokens.MANAGER, { name: 'Beverages' });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.printsTickets, false);

    const duplicate = await createStation(tokens.OWNER, { name: 'BEVERAGES' });
    assert.equal(duplicate.status, 409);

    const renamed = await patchStation(tokens.OWNER, created.body.data.id, { name: 'Coffee Bar' });
    assert.equal(renamed.body.data.name, 'Coffee Bar');

    await patchStation(tokens.OWNER, created.body.data.id, { isActive: false });
    const listed = await request('GET', '/api/v1/stations', { token: tokens.KITCHEN });
    assert.deepEqual(listed.body.data, []);

    const all = await request('GET', '/api/v1/stations?includeInactive=true', { token: tokens.MANAGER });
    assert.equal(all.body.data.length, 1);
  });

  it('applies the permission table', async () => {
    const { tokens } = await seedTeam();
    const station = (await createStation(tokens.OWNER, { name: 'Live Kitchen' })).body.data;

    for (const role of ['CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) {
      assert.equal((await createStation(tokens[role], { name: `X ${role}` })).status, 403, role);
      assert.equal((await patchStation(tokens[role], station.id, { name: 'Y' })).status, 403, role);
      assert.equal((await request('GET', '/api/v1/stations', { token: tokens[role] })).status, 200, role);
      assert.equal(
        (await request('GET', '/api/v1/stations?includeInactive=true', { token: tokens[role] })).status,
        403,
        role,
      );
    }
    assert.equal((await request('GET', '/api/v1/stations')).status, 401);
  });

  it('refuses a category station from another restaurant, or an inactive one', async () => {
    const floor = await stationFloor();
    const other = await seedTeam();
    const foreign = (await createStation(other.tokens.OWNER, { name: 'Foreign' })).body.data;

    const refusedForeign = await patchCategory(floor.tokens.OWNER, floor.pastaCategory.id, { stationId: foreign.id });
    assert.equal(refusedForeign.status, 422);

    await patchStation(floor.tokens.OWNER, floor.bar.id, { isActive: false });
    const refusedInactive = await patchCategory(floor.tokens.OWNER, floor.pastaCategory.id, { stationId: floor.bar.id });
    assert.equal(refusedInactive.status, 422);

    const cleared = await patchCategory(floor.tokens.OWNER, floor.pastaCategory.id, { stationId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.data.stationId, null);
  });

  it('filters tickets by station, and by no station', async () => {
    const floor = await stationFloor();
    await fireLines(floor, [
      { menuItemId: floor.pasta.id, quantity: 1 },
      { menuItemId: floor.latte.id, quantity: 1 },
    ]);
    // A ticket from before stations existed, with no station.
    const orphan = await Kot.findOne({ restaurantId: floor.restaurant._id });
    await Kot.collection.insertOne({
      ...orphan.toObject(),
      _id: undefined,
      kotNumber: 999,
      stationId: null,
      stationName: null,
      // P36. A ticket that old has no station on its lines either.
      lines: orphan.toObject().lines.map((line) => ({ ...line, stationId: null, stationName: null })),
    });

    // The Send's one KOT holds the bar's latte, so the bar's screen lists it.
    const bar = await request('GET', `/api/v1/kots?stationId=${floor.bar.id}`, { token: floor.tokens.KITCHEN });
    assert.equal(bar.body.data.length, 1);
    assert.ok(bar.body.data[0].lines.some((line) => line.itemName === 'Caffe Latte'));

    const none = await request('GET', '/api/v1/kots?stationId=none', { token: floor.tokens.KITCHEN });
    assert.deepEqual(none.body.data.map((kot) => kot.kotNumber), [999]);
  });

  it('gives a station only to a KITCHEN user', async () => {
    const floor = await stationFloor();
    const waiter = await request('POST', '/api/v1/users', {
      token: floor.tokens.OWNER,
      body: { name: 'Captain', phone: '9123400001', role: 'WAITER', password: 'correct horse battery', stationId: floor.bar.id },
    });
    assert.equal(waiter.status, 400);
    assert.ok('stationId' in waiter.body.error.fields);

    const cook = await request('POST', '/api/v1/users', {
      token: floor.tokens.OWNER,
      body: { name: 'Bar', phone: '9123400002', role: 'KITCHEN', password: 'correct horse battery', stationId: floor.bar.id },
    });
    assert.equal(cook.status, 201, JSON.stringify(cook.body));
    assert.equal(cook.body.data.stationId, floor.bar.id);

    const me = await request('POST', '/api/v1/auth/login', {
      body: { phone: '9123400002', password: 'correct horse battery' },
    });
    const profile = await request('GET', '/api/v1/auth/me', { token: me.body.data.accessToken });
    assert.equal(profile.body.data.user.stationId, floor.bar.id);
  });
});

describe('the KOT ticket text', () => {
  /** A dine-in KOT with a variant, two add-ons and a note, fired at 7:40 PM IST. */
  const sampleKot = {
    stationName: 'Live Kitchen',
    kotNumber: 7,
    firedAt: new Date('2026-09-26T14:10:00Z'),
    orderType: 'DINE_IN',
    tableName: 'Table 16',
    lines: [
      {
        quantity: 2,
        itemName: 'Paneer Tikka',
        variantName: 'Half',
        addOnNames: ['Extra cheese', 'Mint chutney'],
        notes: 'No onion',
        status: 'PENDING',
      },
    ],
  };
  const sampleOrder = { guestCount: 2 };

  it('lays out a dine-in KOT at width 32', () => {
    const text = renderKotTicket({ kot: sampleKot, order: sampleOrder, firedByName: 'Devendra Singh', width: 32 });
    assert.equal(
      text,
      [
        '          LIVE KITCHEN',
        '================================',
        'KOT 7                    7:40 PM',
        'Table 16  2 guests',
        'By Devendra Singh',
        '--------------------------------',
        '2 x Paneer Tikka',
        '    Half',
        '    + Extra cheese',
        '    + Mint chutney',
        '    Note: No onion',
        '--------------------------------',
        '',
      ].join('\n'),
    );
  });

  it('lays out the same KOT at width 48', () => {
    const text = renderKotTicket({ kot: sampleKot, order: sampleOrder, firedByName: 'Devendra Singh', width: 48 });
    assert.equal(
      text,
      [
        '                  LIVE KITCHEN',
        '================================================',
        'KOT 7                                    7:40 PM',
        'Table 16  2 guests',
        'By Devendra Singh',
        '------------------------------------------------',
        '2 x Paneer Tikka',
        '    Half',
        '    + Extra cheese',
        '    + Mint chutney',
        '    Note: No onion',
        '------------------------------------------------',
        '',
      ].join('\n'),
    );
  });

  it('wraps a 60-character name under itself and keeps every line within the width', () => {
    const name = 'Grand Ahmedabad Special Mixed Vegetable Thali With Papad Plus';
    assert.equal(name.length, 61);
    const kot = { ...sampleKot, lines: [{ ...sampleKot.lines[0], itemName: name }] };

    for (const width of [32, 48]) {
      const text = renderKotTicket({ kot, order: sampleOrder, firedByName: 'Devendra Singh', width });
      for (const line of text.split('\n')) assert.ok(line.length <= width, `"${line}" exceeds ${width}`);
      // Every word of the name survives: nothing is cut off.
      for (const word of name.split(' ')) assert.ok(text.includes(word), `${word} missing`);
    }
  });

  it('shows no price anywhere', () => {
    const text = renderKotTicket({ kot: sampleKot, order: sampleOrder, firedByName: 'X', width: 48 });
    assert.doesNotMatch(text, /₹|Rs|\d+\.\d{2}/);
  });

  it('adds REPRINT when asked, and refuses a width other than 32 or 48', async () => {
    const floor = await stationFloor();
    const fired = await fireLines(floor, [{ menuItemId: floor.pasta.id, quantity: 1 }]);

    const plain = await request('GET', `/api/v1/kots/${fired.kot.id}/ticket?width=48`, { token: floor.tokens.KITCHEN });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.data.width, 48);
    assert.doesNotMatch(plain.body.data.text, /REPRINT/);
    // 2026-11-03. The whole KOT says ALL SECTIONS when its dishes have sections.
    assert.match(plain.body.data.text, /ALL SECTIONS/);

    const again = await request('GET', `/api/v1/kots/${fired.kot.id}/ticket?reprint=true`, { token: floor.tokens.KITCHEN });
    assert.match(again.body.data.text, /REPRINT/);
    assert.equal(again.body.data.width, 32);

    const bad = await request('GET', `/api/v1/kots/${fired.kot.id}/ticket?width=40`, { token: floor.tokens.KITCHEN });
    assert.equal(bad.status, 400);
  });

  it('shows TAKEAWAY for a takeaway order', () => {
    const text = renderKotTicket({
      kot: { ...sampleKot, orderType: 'TAKEAWAY', tableName: null },
      order: { customerName: 'Rishi' },
      width: 32,
    });
    assert.match(text, /\nTAKEAWAY\nRishi\n/);
  });
});

describe('reading an order line still works the old way', () => {
  it('keeps kot as the first ticket for clients written before P05', async () => {
    const floor = await stationFloor();
    const fired = await fireLines(floor, [{ menuItemId: floor.pasta.id, quantity: 1 }]);
    assert.equal(fired.kot.id, fired.kots[0].id);
    const order = (await readOrder(floor.tokens.WAITER, fired.order.id)).body.data;
    assert.equal(order.lines[0].status, 'FIRED');
  });
});
