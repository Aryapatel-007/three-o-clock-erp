/**
 * Fixed cancel and void reasons, the audit lines for cancellations, and the
 * variant and add-on availability check. P04.
 *
 * Free text cannot be grouped, so the cancellations report (R15) needs codes.
 * Food made and thrown away, and a whole table disappearing, are the two
 * exceptions an owner needs to see on the audit trail; before P04 neither left
 * a trace. And a size the kitchen switched off could still be ordered.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import * as clientReasons from '../../client/src/features/orders/cancelReasons.js';
import * as serverReasons from '../config/cancelReasons.js';
import { AuditLog } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { Counter } from '../models/Counter.js';
import {
  addLines,
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
  await Bill.init();
  await Counter.init();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

const cancelLine = (token, orderId, lineId, body) =>
  request('POST', `/api/v1/orders/${orderId}/lines/${lineId}/cancel`, { token, body });
const cancelOrder = (token, orderId, body) =>
  request('POST', `/api/v1/orders/${orderId}/cancel`, { token, body });
const voidBill = (token, billId, body) =>
  request('POST', `/api/v1/bills/${billId}/void`, { token, body });
const pay = (token, billId, body) => request('POST', `/api/v1/bills/${billId}/payments`, { token, body });

const noteFor = (code) => (code === 'OTHER' ? 'Something else happened' : null);

/** An open order with `count` pending lines of the floor's dish. */
async function orderWithPendingLines({ tokens, table, item }, count) {
  return (
    await openOrder(tokens.WAITER, {
      tableId: table.id,
      lines: Array.from({ length: count }, () => ({ menuItemId: item.id, quantity: 1 })),
    })
  ).body.data;
}

/** An order whose one line has been fired, so cancelling it asks wasPrepared. */
async function orderWithFiredLine({ tokens, table, item }) {
  const opened = (
    await openOrder(tokens.WAITER, { tableId: table.id, lines: [{ menuItemId: item.id, quantity: 2 }] })
  ).body.data;
  await fireOrder(tokens.WAITER, opened.id, opened.version);
  return (await readOrder(tokens.WAITER, opened.id)).body.data;
}

// ---------------------------------------------------------------------------

describe('the reason lists', () => {
  it('holds the same codes and labels, in the same order, on client and server', () => {
    for (const name of ['LINE_CANCEL_REASONS', 'ORDER_CANCEL_REASONS', 'BILL_VOID_REASONS']) {
      assert.deepEqual(
        clientReasons[name].map(({ code, label }) => ({ code, label })),
        serverReasons[name].map(({ code, label }) => ({ code, label })),
        name,
      );
    }
  });
});

describe('cancelling a line takes a reason code', () => {
  it('accepts every code in the line list, and stores the code and the note', async () => {
    const floor = await seedFloor();
    const codes = serverReasons.LINE_CANCEL_REASON_CODES;
    let order = await orderWithPendingLines(floor, codes.length);

    for (const [index, code] of codes.entries()) {
      const response = await cancelLine(floor.tokens.WAITER, order.id, order.lines[index].id, {
        version: order.version,
        reasonCode: code,
        note: noteFor(code),
      });
      assert.equal(response.status, 200, `${code}: ${JSON.stringify(response.body)}`);
      order = response.body.data;
      assert.equal(order.lines[index].cancelReasonCode, code);
      assert.equal(order.lines[index].cancelReason, noteFor(code));
    }
  });

  it('refuses an unknown code, listing the allowed ones', async () => {
    const floor = await seedFloor();
    const order = await orderWithPendingLines(floor, 1);

    const response = await cancelLine(floor.tokens.WAITER, order.id, order.lines[0].id, {
      version: order.version,
      reasonCode: 'MISTAKE',
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    assert.match(response.body.error.fields.reasonCode, /MODIFICATION, WRONG_ITEM/);
  });

  it('requires a note with OTHER, and accepts one', async () => {
    const floor = await seedFloor();
    const order = await orderWithPendingLines(floor, 1);
    const lineId = order.lines[0].id;

    for (const note of [undefined, null, '', '   ']) {
      const refused = await cancelLine(floor.tokens.WAITER, order.id, lineId, {
        version: order.version,
        reasonCode: 'OTHER',
        ...(note === undefined ? {} : { note }),
      });
      assert.equal(refused.status, 400, `note ${JSON.stringify(note)}`);
      assert.ok('note' in refused.body.error.fields);
    }

    const accepted = await cancelLine(floor.tokens.WAITER, order.id, lineId, {
      version: order.version,
      reasonCode: 'OTHER',
      note: '  Spilled at the pass  ',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.lines[0].cancelReason, 'Spilled at the pass');
  });

  it('refuses a note over 200 characters', async () => {
    const floor = await seedFloor();
    const order = await orderWithPendingLines(floor, 1);
    const response = await cancelLine(floor.tokens.WAITER, order.id, order.lines[0].id, {
      version: order.version,
      reasonCode: 'WRONG_ITEM',
      note: 'x'.repeat(201),
    });
    assert.equal(response.status, 400);
  });

  it('refuses the old free-text reason field', async () => {
    const floor = await seedFloor();
    const order = await orderWithPendingLines(floor, 1);
    const response = await cancelLine(floor.tokens.WAITER, order.id, order.lines[0].id, {
      version: order.version,
      reason: 'Customer changed their mind',
    });
    assert.equal(response.status, 400);
  });
});

describe('cancelling an order takes a reason code', () => {
  it('accepts every code in the order list', async () => {
    const floor = await seedFloor();
    for (const code of serverReasons.ORDER_CANCEL_REASON_CODES) {
      const table = (await createTable(floor.tokens.OWNER, { name: `T-${code}` })).body.data;
      const order = await orderWithPendingLines({ ...floor, table }, 1);

      const response = await cancelOrder(floor.tokens.MANAGER, order.id, {
        version: order.version,
        reasonCode: code,
        note: noteFor(code),
      });
      assert.equal(response.status, 200, `${code}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.data.cancelReasonCode, code);
      assert.equal(response.body.data.cancelReason, noteFor(code));
    }
  });

  it('refuses a line code that is not an order code, an OTHER with no note, and the old field', async () => {
    const floor = await seedFloor();
    const order = await orderWithPendingLines(floor, 1);

    for (const body of [
      { reasonCode: 'WRONG_ITEM' },
      { reasonCode: 'OTHER' },
      { reason: 'Customer left' },
      { reasonCode: 'GUEST_LEFT', note: 'x'.repeat(201) },
    ]) {
      const response = await cancelOrder(floor.tokens.MANAGER, order.id, { version: order.version, ...body });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
});

describe('voiding a bill takes a reason code', () => {
  it('accepts every code in the void list, and stores the code and the note', async () => {
    const floor = await seedFloor();
    let order = await readyToBillOrder(floor);

    // Guest left closes the order, so it goes last: the others re-bill the same order.
    const codes = [...serverReasons.BILL_VOID_REASON_CODES].sort((a, b) => (a === 'GUEST_LEFT') - (b === 'GUEST_LEFT'));
    for (const code of codes) {
      const bill = (
        await request('POST', '/api/v1/bills', {
          token: floor.tokens.CASHIER,
          body: { orderId: order.id, version: order.version },
        })
      ).body.data;

      const response = await voidBill(floor.tokens.MANAGER, bill.id, {
        reasonCode: code,
        note: noteFor(code),
      });
      assert.equal(response.status, 200, `${code}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.data.voidReasonCode, code);
      assert.equal(response.body.data.voidReason, noteFor(code));

      order = (await readOrder(floor.tokens.CASHIER, order.id)).body.data;
    }
  });

  // 2026-10-22. A void that closes the table, for any reason (14.6 closeOrder).
  it('closes the order and frees the table with closeOrder, for any reason', async () => {
    const floor = await seedFloor();
    const order = await readyToBillOrder(floor);
    const bill = (
      await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } })
    ).body.data;

    const response = await voidBill(floor.tokens.MANAGER, bill.id, { reasonCode: 'OTHER', note: 'test', closeOrder: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.isVoided, true);

    const closed = (await readOrder(floor.tokens.CASHIER, order.id)).body.data;
    assert.equal(closed.status, 'CANCELLED');
    assert.equal(closed.cancelReasonCode, 'OTHER');
    const table = (await request('GET', '/api/v1/tables', { token: floor.tokens.OWNER })).body.data.find((entry) => entry.id === floor.table.id);
    assert.equal(table.occupancy.state, 'FREE');
    const [entry] = await AuditLog.find({ restaurantId: order.restaurantId, action: 'ORDER_CANCELLED' });
    assert.match(entry.reason, new RegExp(`bill ${bill.billNumber.replace('/', '\\/')}`));
  });

  it('gives a bill reason the order list lacks as Other, with its label', async () => {
    const floor = await seedFloor();
    const order = await readyToBillOrder(floor);
    const bill = (
      await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } })
    ).body.data;

    const response = await voidBill(floor.tokens.MANAGER, bill.id, { reasonCode: 'WRONG_TABLE', closeOrder: true });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const closed = (await readOrder(floor.tokens.CASHIER, order.id)).body.data;
    assert.equal(closed.cancelReasonCode, 'OTHER');
    assert.equal(closed.cancelReason, 'Billed to the wrong table');
  });

  it('keeps the order waiting with closeOrder false, or left out for a reason other than Guest left', async () => {
    const floor = await seedFloor();
    let order = await readyToBillOrder(floor);
    for (const body of [{ reasonCode: 'OTHER', note: 'x', closeOrder: false }, { reasonCode: 'DISCOUNT_CHANGED' }]) {
      const bill = (
        await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } })
      ).body.data;
      assert.equal((await voidBill(floor.tokens.MANAGER, bill.id, body)).status, 200);
      order = (await readOrder(floor.tokens.CASHIER, order.id)).body.data;
      assert.equal(order.status, 'READY_TO_BILL', JSON.stringify(body));
      assert.equal(order.billId, null);
    }
  });

  it('refuses to close the order when the bill has money on it, and voids nothing', async () => {
    const floor = await seedFloor();
    const order = await readyToBillOrder(floor);
    const bill = (
      await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } })
    ).body.data;
    const paid = await pay(floor.tokens.CASHIER, bill.id, { method: 'CASH', amountInPaise: 100 });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));

    const response = await voidBill(floor.tokens.MANAGER, bill.id, { reasonCode: 'OTHER', note: 'x', closeOrder: true });
    assert.equal(response.status, 422);
    assert.equal((await Bill.findOne({ _id: bill.id, restaurantId: order.restaurantId })).isVoided, false);
  });

  it('refuses an unknown code, OTHER with no note, a long note, and the old field', async () => {
    const floor = await seedFloor();
    const order = await readyToBillOrder(floor);
    const bill = (
      await request('POST', '/api/v1/bills', {
        token: floor.tokens.CASHIER,
        body: { orderId: order.id, version: order.version },
      })
    ).body.data;

    const unknown = await voidBill(floor.tokens.MANAGER, bill.id, { reasonCode: 'OOPS' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error.fields.reasonCode, /WRONG_TABLE/);

    for (const body of [
      { reasonCode: 'OTHER' },
      { reasonCode: 'DUPLICATE', note: 'x'.repeat(501) },
      { reason: 'Wrong table billed' },
    ]) {
      const response = await voidBill(floor.tokens.MANAGER, bill.id, body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });

  it('writes BILL_VOIDED with the code in details and the label as the reason', async () => {
    const floor = await seedFloor();
    const order = await readyToBillOrder(floor);
    const bill = (
      await request('POST', '/api/v1/bills', {
        token: floor.tokens.CASHIER,
        body: { orderId: order.id, version: order.version },
      })
    ).body.data;

    await voidBill(floor.tokens.MANAGER, bill.id, { reasonCode: 'WRONG_TABLE', note: 'T4 not T5' });

    const [entry] = await AuditLog.find({ restaurantId: bill.restaurantId, action: 'BILL_VOIDED' });
    assert.equal(entry.reason, 'Billed to the wrong table: T4 not T5');
    assert.equal(entry.details.reasonCode, 'WRONG_TABLE');
  });
});

describe('audit lines for cancellations', () => {
  it('writes LINE_CANCELLED_AFTER_PREP for a line the kitchen made', async () => {
    const floor = await seedFloor();
    const order = await orderWithFiredLine(floor);
    const line = order.lines[0];

    // P28: a captain needs a manager's PIN to cancel a sent dish, so the manager cancels here; this test is about the audit line.
    const response = await cancelLine(floor.tokens.MANAGER, order.id, line.id, {
      version: order.version,
      reasonCode: 'QUALITY',
      note: 'Too salty',
      wasPrepared: true,
    });
    assert.equal(response.status, 200);

    const entries = await AuditLog.find({ restaurantId: order.restaurantId });
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.action, 'LINE_CANCELLED_AFTER_PREP');
    assert.equal(entry.entityType, 'ORDER');
    assert.equal(String(entry.entityId), order.id);
    assert.equal(entry.entityLabel, `Order ${order.orderNumber}`);
    assert.equal(entry.reason, 'Quality complaint: Too salty');
    assert.equal(entry.amountInPaise, line.lineTotalInPaise);
    assert.deepEqual(entry.details, {
      lineId: line.id,
      itemName: line.itemName,
      variantName: null,
      quantity: 2,
      reasonCode: 'QUALITY',
      tableName: order.tableName,
    });
  });

  it('writes nothing for a line cancelled before the kitchen had it, or one not made', async () => {
    const floor = await seedFloor();
    const pending = await orderWithPendingLines(floor, 1);
    await cancelLine(floor.tokens.WAITER, pending.id, pending.lines[0].id, {
      version: pending.version,
      reasonCode: 'WRONG_ITEM',
    });

    const secondTable = (await createTable(floor.tokens.OWNER, { name: 'T2' })).body.data;
    const fired = await orderWithFiredLine({ ...floor, table: secondTable });
    await cancelLine(floor.tokens.WAITER, fired.id, fired.lines[0].id, {
      version: fired.version,
      reasonCode: 'OUT_OF_STOCK',
      wasPrepared: false,
    });

    assert.equal(await AuditLog.countDocuments({ restaurantId: pending.restaurantId }), 0);
  });

  it('writes ORDER_CANCELLED for a whole order, valuing only the lines still live', async () => {
    const floor = await seedFloor();
    let order = await orderWithPendingLines(floor, 3);

    // One line already cancelled; it must not be counted again.
    order = (
      await cancelLine(floor.tokens.WAITER, order.id, order.lines[0].id, {
        version: order.version,
        reasonCode: 'DUPLICATE',
      })
    ).body.data;

    const response = await cancelOrder(floor.tokens.MANAGER, order.id, {
      version: order.version,
      reasonCode: 'GUEST_LEFT',
    });
    assert.equal(response.status, 200);

    const entries = await AuditLog.find({ restaurantId: order.restaurantId, action: 'ORDER_CANCELLED' });
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.reason, 'Guest left');
    assert.equal(entry.amountInPaise, 2 * floor.item.priceInPaise);
    assert.deepEqual(entry.details, {
      orderNumber: order.orderNumber,
      tableName: order.tableName,
      lineCount: 2,
      reasonCode: 'GUEST_LEFT',
      wasPrepared: null,
    });
  });

  it('leaves no audit line when the cancel fails on a version conflict', async () => {
    const floor = await seedFloor();
    const order = await orderWithFiredLine(floor);

    const lineCancel = await cancelLine(floor.tokens.MANAGER, order.id, order.lines[0].id, {
      version: order.version - 1,
      reasonCode: 'QUALITY',
      wasPrepared: true,
    });
    assert.equal(lineCancel.status, 409);

    const orderCancel = await cancelOrder(floor.tokens.MANAGER, order.id, {
      version: order.version - 1,
      reasonCode: 'GUEST_LEFT',
      wasPrepared: true,
    });
    assert.equal(orderCancel.status, 409);

    assert.equal(await AuditLog.countDocuments({ restaurantId: order.restaurantId }), 0);
  });
});

describe('unavailable sizes and extras cannot be ordered', () => {
  async function itemWithOptions(tokens, { halfAvailable = true, cheeseAvailable = true } = {}) {
    return (
      await createMenuItem(tokens.OWNER, {
        name: 'Paneer Tikka Platter',
        variants: [
          { name: 'Half', priceInPaise: 14000, isAvailable: halfAvailable },
          { name: 'Full', priceInPaise: 24000 },
        ],
        addOns: [{ name: 'Extra cheese', priceInPaise: 3000, isAvailable: cheeseAvailable }],
      })
    ).body.data;
  }

  it('refuses an unavailable size and leaves the order unchanged', async () => {
    const floor = await seedFloor();
    const dish = await itemWithOptions(floor.tokens, { halfAvailable: false });
    const half = dish.variants.find((variant) => variant.name === 'Half');
    const order = (await openOrder(floor.tokens.WAITER, { tableId: floor.table.id })).body.data;

    const response = await addLines(floor.tokens.WAITER, order.id, {
      version: order.version,
      lines: [{ menuItemId: dish.id, variantId: half.id, quantity: 1 }],
    });
    assert.equal(response.status, 422);
    assert.equal(
      response.body.error.message,
      'The Half size of "Paneer Tikka Platter" is out of stock right now.',
    );

    const after = (await readOrder(floor.tokens.WAITER, order.id)).body.data;
    assert.equal(after.lines.length, 0);
    assert.equal(after.version, order.version);
  });

  it('refuses an unavailable extra', async () => {
    const floor = await seedFloor();
    const dish = await itemWithOptions(floor.tokens, { cheeseAvailable: false });
    const full = dish.variants.find((variant) => variant.name === 'Full');

    const response = await openOrder(floor.tokens.WAITER, {
      tableId: floor.table.id,
      lines: [{ menuItemId: dish.id, variantId: full.id, addOnIds: [dish.addOns[0].id], quantity: 1 }],
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.message, '"Extra cheese" is out of stock right now.');
  });

  it('still adds the same dish with an available size and extras', async () => {
    const floor = await seedFloor();
    const dish = await itemWithOptions(floor.tokens, { halfAvailable: false });
    const full = dish.variants.find((variant) => variant.name === 'Full');

    const response = await openOrder(floor.tokens.WAITER, {
      tableId: floor.table.id,
      lines: [{ menuItemId: dish.id, variantId: full.id, addOnIds: [dish.addOns[0].id], quantity: 1 }],
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.data.lines[0].variantName, 'Full');
  });

  it('carries isAvailable on every size and extra in the menu the ordering screen reads', async () => {
    const floor = await seedFloor();
    await itemWithOptions(floor.tokens, { halfAvailable: false });

    const menu = (await request('GET', '/api/v1/menu', { token: floor.tokens.WAITER })).body.data;
    const items = menu.flatMap((category) => category.items);
    const dish = items.find((item) => item.name === 'Paneer Tikka Platter');
    assert.deepEqual(
      dish.variants.map((variant) => [variant.name, variant.isAvailable]),
      [
        ['Half', false],
        ['Full', true],
      ],
    );
    assert.equal(dish.addOns[0].isAvailable, true);
  });
});

describe('golden day B13 and check C7', () => {
  /**
   * docs/TEST-DATA.md: B13 is a Mexican Bowl billed at Rs 420, from an order
   * that also had Thecha Paneer Chilli cancelled after preparation
   * (MODIFICATION) and Cheesy Tornado cancelled before it (WRONG_ITEM).
   * Neither cancelled line reaches the bill, which is C7.
   */
  it('bills Rs 420 and writes exactly one after-prep audit line for Rs 390', async () => {
    const floor = await seedFloor();
    const { tokens, table } = floor;
    const make = async (name, priceInPaise) =>
      (await createMenuItem(tokens.OWNER, { name, priceInPaise, taxRateBps: 500 })).body.data.id;

    const bowl = await make('Mexican Bowl', 40000);
    const thecha = await make('Thecha Paneer Chilli', 39000);
    const tornado = await make('Cheesy Tornado', 36000);

    let order = (
      await openOrder(tokens.WAITER, {
        tableId: table.id,
        lines: [
          { menuItemId: bowl, quantity: 1 },
          { menuItemId: thecha, quantity: 1 },
        ],
      })
    ).body.data;
    const fired = (await fireOrder(tokens.WAITER, order.id, order.version)).body.data;
    order = fired.order;

    const thechaLine = order.lines.find((line) => line.itemName === 'Thecha Paneer Chilli');
    // P28: a dish the kitchen made is cancelled by the manager, or by a captain with the manager's PIN.
    order = (
      await cancelLine(tokens.MANAGER, order.id, thechaLine.id, {
        version: order.version,
        reasonCode: 'MODIFICATION',
        wasPrepared: true,
      })
    ).body.data;

    order = (
      await addLines(tokens.WAITER, order.id, {
        version: order.version,
        lines: [{ menuItemId: tornado, quantity: 1 }],
      })
    ).body.data;
    const tornadoLine = order.lines.find((line) => line.itemName === 'Cheesy Tornado');
    order = (
      await cancelLine(tokens.WAITER, order.id, tornadoLine.id, {
        version: order.version,
        reasonCode: 'WRONG_ITEM',
      })
    ).body.data;

    await request('PATCH', `/api/v1/kots/${fired.kot.id}/ready`, { token: tokens.KITCHEN });
    order = (await readOrder(tokens.WAITER, order.id)).body.data;
    const bowlLine = order.lines.find((line) => line.itemName === 'Mexican Bowl');
    order = (
      await request('PATCH', `/api/v1/orders/${order.id}/lines/${bowlLine.id}/served`, {
        token: tokens.WAITER,
        body: { version: order.version },
      })
    ).body.data;
    assert.equal(order.status, 'READY_TO_BILL');

    const bill = (
      await request('POST', '/api/v1/bills', {
        token: tokens.CASHIER,
        body: { orderId: order.id, version: order.version },
      })
    ).body.data;

    assert.equal(bill.grandTotalInPaise, 42000);
    // C7: a cancelled line never appears on a bill.
    assert.deepEqual(
      bill.lines.map((line) => line.itemName),
      ['Mexican Bowl'],
    );

    const afterPrep = await AuditLog.find({
      restaurantId: bill.restaurantId,
      action: 'LINE_CANCELLED_AFTER_PREP',
    });
    assert.equal(afterPrep.length, 1);
    assert.equal(afterPrep[0].amountInPaise, 39000);
    assert.equal(afterPrep[0].details.itemName, 'Thecha Paneer Chilli');
    assert.equal(afterPrep[0].details.reasonCode, 'MODIFICATION');
  });
});
