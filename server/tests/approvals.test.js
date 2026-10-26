/**
 * P28: an owner's or manager's PIN for cancels, voids and cash.
 * docs/API-CONTRACT.md "P28 Manager approval by PIN".
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { AuditLog } from '../models/AuditLog.js';
import { ALL_MODELS } from '../models/index.js';
import { createMenuItem, fireOrder, openOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request } from './helpers/testServer.js';
import { startTestServer, stopTestServer } from './helpers/testServer.js';

const PIN = '4826';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

/** A floor whose manager has a PIN. Returns the floor, the manager's approval and a wrong one. */
async function floorWithManagerPin() {
  const floor = await seedFloor();
  const approvers = (await request('GET', '/api/v1/users/approvers', { token: floor.tokens.CASHIER })).body.data;
  const manager = approvers.find((person) => person.role === 'MANAGER');
  const set = await request('PATCH', `/api/v1/users/${manager.id}/pin`, { token: floor.tokens.OWNER, body: { pin: PIN } });
  assert.equal(set.status, 200);
  return {
    ...floor,
    managerId: manager.id,
    good: { approverId: manager.id, pin: PIN },
    wrong: { approverId: manager.id, pin: '1111' },
  };
}

const setApprovals = (floor, approvals) =>
  request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'P28 test', approvals } });

/** An order on the floor's table with two of the dish: the first fired, the second not. */
async function orderWithSentAndUnsent(floor) {
  const opened = (await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: [{ menuItemId: floor.item.id, quantity: 1 }] })).body.data;
  const fired = (await fireOrder(floor.tokens.WAITER, opened.id, opened.version)).body.data;
  const added = (
    await request('POST', `/api/v1/orders/${opened.id}/lines`, {
      token: floor.tokens.WAITER,
      body: { version: fired.order.version, lines: [{ menuItemId: floor.item.id, quantity: 1 }] },
    })
  ).body.data;
  const sent = added.lines.find((line) => line.status === 'FIRED');
  const unsent = added.lines.find((line) => line.status === 'PENDING');
  return { order: added, sent, unsent };
}

const cancelLine = (token, order, line, extra = {}) =>
  request('POST', `/api/v1/orders/${order.id}/lines/${line.id}/cancel`, {
    token,
    body: { version: order.version, reasonCode: 'WRONG_ITEM', ...extra },
  });

describe('cancelling an item the kitchen has', () => {
  // P42 changed this on purpose: the PIN is for a dish that was made. One sent and not made needs none.
  it('needs the PIN from a captain for a made dish: refused without, refused with a wrong one, allowed with the right one, and audited', async () => {
    const floor = await floorWithManagerPin();
    const { order, sent } = await orderWithSentAndUnsent(floor);

    const without = await cancelLine(floor.tokens.WAITER, order, sent, { wasPrepared: true });
    assert.equal(without.status, 403);
    assert.match(without.body.error.message, /manager has to approve/);

    const wrong = await cancelLine(floor.tokens.WAITER, order, sent, { wasPrepared: true, approval: floor.wrong });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_PIN');

    const right = await cancelLine(floor.tokens.WAITER, order, sent, { wasPrepared: true, approval: floor.good });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    const cancelled = right.body.data.lines.find((line) => line.id === sent.id);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(String(cancelled.cancelApprovedBy), floor.managerId);

    const audit = await AuditLog.findOne({ restaurantId: floor.restaurant._id, action: 'LINE_CANCELLED_AFTER_PREP' }).lean();
    assert.ok(audit, 'a made dish thrown away is audited');
    assert.equal(audit.details.approvedBy, floor.managerId);
  });

  it('P42: needs no PIN from a captain for a sent dish the kitchen has not made', async () => {
    const floor = await floorWithManagerPin();
    const { order, sent } = await orderWithSentAndUnsent(floor);
    const notMade = await cancelLine(floor.tokens.WAITER, order, sent, { wasPrepared: false });
    assert.equal(notMade.status, 200, JSON.stringify(notMade.body));
    assert.equal(notMade.body.data.lines.find((line) => line.id === sent.id).cancelApprovedBy, null);
  });

  it('needs no PIN for a line never sent, for an owner, or when the owner switches it off', async () => {
    const floor = await floorWithManagerPin();
    const first = await orderWithSentAndUnsent(floor);

    const pending = await cancelLine(floor.tokens.WAITER, first.order, first.unsent);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.data.lines.find((line) => line.id === first.unsent.id).cancelApprovedBy, null);

    const byOwner = await cancelLine(floor.tokens.OWNER, pending.body.data, first.sent, { wasPrepared: true });
    assert.equal(byOwner.status, 200);

    const floor2 = await floorWithManagerPin();
    assert.equal((await setApprovals(floor2, { lineCancel: false })).status, 200);
    const second = await orderWithSentAndUnsent(floor2);
    const off = await cancelLine(floor2.tokens.WAITER, second.order, second.sent, { wasPrepared: true });
    assert.equal(off.status, 200);
  });
});

describe('cash in and out of the drawer', () => {
  it("needs the PIN for a cashier's paid in, never for the float, and records who approved", async () => {
    const floor = await floorWithManagerPin();
    const cash = (token, body) => request('POST', '/api/v1/cash-movements', { token, body });

    assert.equal((await cash(floor.tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 200000 })).status, 201);

    const without = await cash(floor.tokens.CASHIER, { type: 'PAID_IN', amountInPaise: 5000, reason: 'Change from the bank' });
    assert.equal(without.status, 403);

    const right = await cash(floor.tokens.CASHIER, { type: 'PAID_IN', amountInPaise: 5000, reason: 'Change from the bank', approval: floor.good });
    assert.equal(right.status, 201);
    assert.equal(String(right.body.data.approvedBy), floor.managerId);
    assert.ok(await AuditLog.findOne({ restaurantId: floor.restaurant._id, action: 'CASH_PAID_IN' }).lean());

    const byManager = await cash(floor.tokens.MANAGER, { type: 'PAID_IN', amountInPaise: 1000, reason: 'Tips box' });
    assert.equal(byManager.status, 201);
    assert.equal(byManager.body.data.approvedBy, null);
  });

  it('lets a cashier pay out only with the PIN, and not at all with manager tasks off', async () => {
    const floor = await floorWithManagerPin();
    const payOut = (extra = {}) =>
      request('POST', '/api/v1/cash-movements', {
        token: floor.tokens.CASHIER,
        body: { type: 'PAID_OUT', amountInPaise: 3500, reason: 'Milk from the dairy', ...extra },
      });

    assert.equal((await payOut()).status, 403);
    const right = await payOut({ approval: floor.good });
    assert.equal(right.status, 201);
    const audit = await AuditLog.findOne({ restaurantId: floor.restaurant._id, action: 'CASH_PAID_OUT' }).lean();
    assert.equal(audit.details.approvedBy, floor.managerId);

    await setApprovals(floor, { managerTasks: false });
    const off = await payOut({ approval: floor.good });
    assert.equal(off.status, 403);
    assert.match(off.body.error.message, /Only an owner or a manager/);
  });

  it('lets a cashier void a cash entry only with the PIN, stores who approved, and not at all with manager tasks off', async () => {
    const floor = await floorWithManagerPin();
    const record = async () =>
      (await request('POST', '/api/v1/cash-movements', { token: floor.tokens.OWNER, body: { type: 'PAID_IN', amountInPaise: 5000, source: 'OWNER' } })).body.data;
    const voidIt = (token, id, extra = {}) =>
      request('POST', `/api/v1/cash-movements/${id}/void`, { token, body: { reason: 'Typed twice', ...extra } });

    const topUp = await record();
    assert.equal((await voidIt(floor.tokens.WAITER, topUp.id, { approval: floor.good })).status, 403);
    assert.equal((await voidIt(floor.tokens.CASHIER, topUp.id)).status, 403);
    assert.equal((await voidIt(floor.tokens.CASHIER, topUp.id, { approval: floor.wrong })).status, 401);
    const right = await voidIt(floor.tokens.CASHIER, topUp.id, { approval: floor.good });
    assert.equal(right.status, 200);
    assert.equal(right.body.data.isVoided, true);
    assert.equal(right.body.data.voidApprovedBy, floor.managerId);

    const byManager = await voidIt(floor.tokens.MANAGER, (await record()).id);
    assert.equal(byManager.status, 200);
    assert.equal(byManager.body.data.voidApprovedBy, null);

    await setApprovals(floor, { managerTasks: false });
    const off = await voidIt(floor.tokens.CASHIER, (await record()).id, { approval: floor.good });
    assert.equal(off.status, 403);
  });
});

describe('manager tasks a cashier may do with a PIN', () => {
  it('voids a bill: refused without, done with, stored beside the cashier, refused with the switch off, never a captain', async () => {
    const floor = await floorWithManagerPin();
    const order = await readyToBillOrder(floor);
    const bill = (await request('POST', '/api/v1/bills', { token: floor.tokens.CASHIER, body: { orderId: order.id, version: order.version } })).body.data;
    const voidIt = (token, extra = {}) =>
      request('POST', `/api/v1/bills/${bill.id}/void`, { token, body: { reasonCode: 'WRONG_TABLE', ...extra } });

    assert.equal((await voidIt(floor.tokens.WAITER, { approval: floor.good })).status, 403);
    assert.equal((await voidIt(floor.tokens.CASHIER)).status, 403);

    await setApprovals(floor, { managerTasks: false });
    assert.equal((await voidIt(floor.tokens.CASHIER, { approval: floor.good })).status, 403);
    await setApprovals(floor, { managerTasks: true });

    const right = await voidIt(floor.tokens.CASHIER, { approval: floor.good });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(right.body.data.isVoided, true);
    assert.equal(String(right.body.data.voidApprovedBy), floor.managerId);
    assert.notEqual(String(right.body.data.voidedBy), floor.managerId);
  });

  it('cancels a whole order and gives No Charge with the PIN, and the approver is who allowed it', async () => {
    const floor = await floorWithManagerPin();
    const second = (await createMenuItem(floor.tokens.OWNER, { name: 'Masala Jaljeera' })).body.data;
    const tableTwo = (await request('POST', '/api/v1/tables', { token: floor.tokens.OWNER, body: { name: 'T2' } })).body.data;

    const first = (await openOrder(floor.tokens.WAITER, { tableId: floor.table.id, lines: [{ menuItemId: floor.item.id, quantity: 1 }] })).body.data;
    const cancelOrder = (extra = {}) =>
      request('POST', `/api/v1/orders/${first.id}/cancel`, {
        token: floor.tokens.CASHIER,
        body: { version: first.version, reasonCode: 'WRONG_TABLE', ...extra },
      });
    assert.equal((await cancelOrder()).status, 403);
    const cancelled = await cancelOrder({ approval: floor.good });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(String(cancelled.body.data.cancelApprovedBy), floor.managerId);

    const opened = (await openOrder(floor.tokens.WAITER, { tableId: tableTwo.id, lines: [{ menuItemId: second.id, quantity: 1 }] })).body.data;
    const fired = (await fireOrder(floor.tokens.WAITER, opened.id, opened.version)).body.data;
    const free = await request('POST', `/api/v1/orders/${opened.id}/no-charge`, {
      token: floor.tokens.CASHIER,
      body: { version: fired.order.version, reasonCode: 'STAFF_MEAL', approval: floor.good },
    });
    assert.equal(free.status, 200, JSON.stringify(free.body));
    assert.equal(String(free.body.data.noCharge.approvedBy), floor.managerId);

    const audit = await AuditLog.findOne({ restaurantId: floor.restaurant._id, action: 'NO_CHARGE_GIVEN' }).lean();
    assert.equal(audit.details.approvedBy, floor.managerId);
  });
});

describe('the approvers list', () => {
  it('says who has a PIN, and refuses an approver without one like a wrong PIN', async () => {
    const floor = await floorWithManagerPin();
    const approvers = (await request('GET', '/api/v1/users/approvers', { token: floor.tokens.WAITER })).body.data;
    const owner = approvers.find((person) => person.role === 'OWNER');
    assert.equal(approvers.find((person) => person.role === 'MANAGER').hasPin, true);
    assert.equal(owner.hasPin, false);
    assert.ok(approvers.every((person) => Object.keys(person).sort().join() === 'hasPin,id,name,role'));

    const { order, sent } = await orderWithSentAndUnsent(floor);
    const noPin = await cancelLine(floor.tokens.WAITER, order, sent, { wasPrepared: true, approval: { approverId: owner.id, pin: PIN } });
    assert.equal(noPin.status, 401);
    assert.equal(noPin.body.error.code, 'INVALID_PIN');
  });
});
