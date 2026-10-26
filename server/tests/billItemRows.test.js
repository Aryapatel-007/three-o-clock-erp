/**
 * P35 Part A: the same dish shows once on the bill. API-CONTRACT M3 14.2, 16.1
 * and 16.8.1. `itemRows` is computed from a bill's lines when it is read, and
 * never stored; the lines themselves are unchanged.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { Bill } from '../models/Bill.js';
import { groupBillLines } from '../utils/billLines.js';
import { resetClockForTests } from '../utils/time.js';
import { buildGoldenDay, GOLDEN_DATE } from './helpers/goldenDay.js';
import { addLines, createMenuItem, fireOrder, openOrder, readOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
});

after(async () => {
  resetClockForTests();
  await stopTestServer();
  await stopTestDatabase();
});

const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

/** Fires the order's unsent lines and lets the kitchen make every ticket; the kitchen's ready serves them. */
async function sendAndMake(floor, order) {
  const fired = ok(await fireOrder(floor.tokens.WAITER, order.id, order.version), 'fire');
  for (const kot of fired.kots) ok(await request('PATCH', `/api/v1/kots/${kot.id}/ready`, { token: floor.tokens.KITCHEN }), 'ready');
  return ok(await readOrder(floor.tokens.WAITER, order.id), 'read');
}

/**
 * A table orders `first`, it goes to the kitchen and is made; then `between`
 * runs (a price change, say), the table orders `second`, and that round goes
 * to the kitchen too. Then the counter bills it.
 */
async function twoRounds(floor, first, second, between = async () => {}) {
  let order = ok(await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, guestCount: 2, lines: first }), 'open');
  order = await sendAndMake(floor, order);
  await between();
  order = ok(await addLines(floor.tokens.WAITER, order.id, { version: order.version, lines: second }), 'add the second round');
  order = await sendAndMake(floor, order);
  return ok(await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } }), 'bill');
}

const roti = (floor, overrides = {}) =>
  createMenuItem(floor.tokens.OWNER, { name: `Roti ${Math.random().toString(36).slice(2, 7)}`, priceInPaise: 4000, ...overrides });

describe('itemRows on the bill', () => {
  it('shows a dish ordered in two rounds once, with both order lines behind it', async () => {
    const floor = await seedFloor();
    const dish = ok(await roti(floor), 'dish');
    const bill = await twoRounds(floor, [{ menuItemId: dish.id, quantity: 1 }], [{ menuItemId: dish.id, quantity: 1 }]);

    assert.equal(bill.lines.length, 2, 'the lines are unchanged: one per order line');
    assert.equal(bill.itemRows.length, 1);
    const [row] = bill.itemRows;
    assert.equal(row.itemName, dish.name);
    assert.equal(row.quantity, 2);
    assert.equal(row.lineTotalInPaise, 8000);
    assert.equal(row.unitPriceInPaise, 4000);
    assert.deepEqual(row.orderLineIds, bill.lines.map((line) => line.orderLineId));

    // Computed when read, never stored.
    const stored = await Bill.findOne({ restaurantId: floor.restaurant.id, _id: bill.id }).lean();
    assert.equal('itemRows' in stored, false);

    // The same rows on the bill read and on the invoice.
    const read = ok(await request('GET', `/api/v1/bills/${bill.id}`, { token: floor.tokens.CASHIER }), 'read bill');
    const invoice = ok(await request('GET', `/api/v1/bills/${bill.id}/invoice`, { token: floor.tokens.CASHIER }), 'invoice');
    assert.deepEqual(read.itemRows, bill.itemRows);
    assert.deepEqual(
      // P64, changed on purpose: the invoice's rows also carry each line's note.
      invoice.itemRows.map(({ orderLineIds, notes: _notes, ...rest }) => ({ ...rest, orderLineIds: orderLineIds.map(String) })),
      read.itemRows,
    );

    // The receipt text prints the dish once, quantity 2.
    const { text } = ok(await request('GET', `/api/v1/bills/${bill.id}/receipt?width=48`, { token: floor.tokens.CASHIER }), 'receipt');
    assert.equal(text.split('\n').filter((line) => line.startsWith(dish.name.slice(0, 20))).length, 1, text);
    assert.match(text, /\n {2}2 x 40\.00\n/);
  });

  it('keeps a round ordered at an old price on its own row', async () => {
    const floor = await seedFloor();
    const dish = ok(await roti(floor), 'dish');
    const bill = await twoRounds(floor, [{ menuItemId: dish.id, quantity: 1 }], [{ menuItemId: dish.id, quantity: 1 }], async () => {
      ok(await request('PATCH', `/api/v1/menu-items/${dish.id}`, { token: floor.tokens.OWNER, body: { priceInPaise: 4500 } }), 'price change');
    });
    assert.deepEqual(
      bill.itemRows.map((row) => [row.quantity, row.unitPriceInPaise, row.lineTotalInPaise]),
      [
        [1, 4000, 4000],
        [1, 4500, 4500],
      ],
    );
  });

  it('keeps Half and Full apart, and extras apart unless they are the same set', async () => {
    const floor = await seedFloor();
    const dish = ok(
      await roti(floor, {
        variants: [
          { name: 'Half', priceInPaise: 3000 },
          { name: 'Full', priceInPaise: 5000 },
        ],
        addOns: [
          { name: 'Butter', priceInPaise: 1000 },
          { name: 'Cheese', priceInPaise: 1000 },
        ],
      }),
      'dish',
    );
    const [half, full] = dish.variants;
    const [butter, cheese] = dish.addOns;
    const sizes = await twoRounds(floor, [{ menuItemId: dish.id, variantId: half.id, quantity: 1 }], [{ menuItemId: dish.id, variantId: full.id, quantity: 1 }]);
    assert.deepEqual(sizes.itemRows.map((row) => row.variantName), ['Half', 'Full']);

    const floor2 = await seedFloor();
    const dish2 = ok(await roti(floor2, { addOns: [{ name: 'Butter', priceInPaise: 1000 }, { name: 'Cheese', priceInPaise: 1000 }] }), 'dish 2');
    const [butter2, cheese2] = dish2.addOns;
    const different = await twoRounds(
      floor2,
      [{ menuItemId: dish2.id, quantity: 1, addOnIds: [butter2.id] }],
      [{ menuItemId: dish2.id, quantity: 1, addOnIds: [cheese2.id] }],
    );
    assert.equal(different.itemRows.length, 2, 'different extras are different rows');

    const floor3 = await seedFloor();
    const dish3 = ok(await roti(floor3, { addOns: [{ name: 'Butter', priceInPaise: 1000 }, { name: 'Cheese', priceInPaise: 1000 }] }), 'dish 3');
    const [butter3, cheese3] = dish3.addOns;
    const same = await twoRounds(
      floor3,
      [{ menuItemId: dish3.id, quantity: 1, addOnIds: [butter3.id, cheese3.id] }],
      [{ menuItemId: dish3.id, quantity: 1, addOnIds: [cheese3.id, butter3.id] }],
    );
    assert.equal(same.itemRows.length, 1, 'the same extras in another order are one row');
    assert.equal(same.itemRows[0].quantity, 2);
    void butter;
    void cheese;
  });

  it('removing one of the two rounds leaves one row, and the bill keeps its number', async () => {
    const floor = await seedFloor();
    const dish = ok(await roti(floor), 'dish');
    const keep = ok(await createMenuItem(floor.tokens.OWNER, { name: `Chai ${Math.random().toString(36).slice(2, 7)}`, priceInPaise: 2000 }), 'chai');
    const bill = await twoRounds(floor, [{ menuItemId: dish.id, quantity: 1 }, { menuItemId: keep.id, quantity: 1 }], [{ menuItemId: dish.id, quantity: 1 }]);
    const [row] = bill.itemRows.filter((entry) => entry.itemName === dish.name);
    assert.equal(row.quantity, 2);

    const removing = { lines: [{ lineId: row.orderLineIds[1], wasPrepared: false }], reasonCode: 'WRONG_ITEM' };
    const preview = ok(await request('POST', `/api/v1/bills/${bill.id}/remove-lines`, { token: floor.tokens.MANAGER, body: { ...removing, preview: true } }), 'preview');
    assert.equal(preview.removedQuantity, 1);
    assert.equal(preview.removedLineTotalInPaise, 4000);

    const revised = ok(await request('POST', `/api/v1/bills/${bill.id}/remove-lines`, { token: floor.tokens.MANAGER, body: removing }), 'remove');
    assert.equal(revised.billNumber, bill.billNumber);
    const after = revised.itemRows.find((entry) => entry.itemName === dish.name);
    assert.equal(after.quantity, 1);
    assert.deepEqual(after.orderLineIds, [row.orderLineIds[0]]);
  });

  it('adds up, on every golden day bill, to the item total and the lines\' quantities', async () => {
    const golden = await buildGoldenDay();
    const bills = ok(
      await request('GET', `/api/v1/bills?from=${GOLDEN_DATE}&to=2026-09-27&includeVoided=true&limit=200`, { token: golden.tokens.OWNER }),
      'bills',
    );
    assert.ok(bills.length >= 16);
    for (const bill of bills) {
      const rowsTotal = bill.itemRows.reduce((sum, row) => sum + row.lineTotalInPaise, 0);
      assert.equal(rowsTotal, bill.subtotalInPaise, bill.billNumber);
      assert.equal(
        bill.itemRows.reduce((sum, row) => sum + row.quantity, 0),
        bill.lines.reduce((sum, line) => sum + line.quantity, 0),
        bill.billNumber,
      );
    }
  });
});

describe('groupBillLines', () => {
  const line = (overrides = {}) => ({
    orderLineId: 'a1',
    menuItemId: 'm7',
    itemName: 'Roti',
    variantName: null,
    addOnNames: [],
    quantity: 1,
    unitPriceInPaise: 4000,
    taxRateBps: 500,
    lineTotalInPaise: 4000,
    ...overrides,
  });

  it('throws on a decimal money value, a missing order line or a quantity under 1', () => {
    assert.throws(() => groupBillLines([line({ lineTotalInPaise: 40.5 })]), /whole number of paise/);
    assert.throws(() => groupBillLines([line({ unitPriceInPaise: 40.5 })]), /whole number of paise/);
    assert.throws(() => groupBillLines([line({ orderLineId: null })]), /no orderLineId/);
    assert.throws(() => groupBillLines([line({ quantity: 0 })]), /at least 1/);
  });

  it('keeps rows in the order of their first line', () => {
    const rows = groupBillLines([
      line({ orderLineId: 'a', itemName: 'Roti' }),
      line({ orderLineId: 'b', menuItemId: 'm8', itemName: 'Chai', unitPriceInPaise: 2000, lineTotalInPaise: 2000 }),
      line({ orderLineId: 'c', itemName: 'Roti' }),
    ]);
    assert.deepEqual(rows.map((row) => [row.itemName, row.quantity, row.orderLineIds]), [
      ['Roti', 2, ['a', 'c']],
      ['Chai', 1, ['b']],
    ]);
  });
});
