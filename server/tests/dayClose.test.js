/**
 * The cash drawer and Day Close rules, on a small restaurant. P10.
 *
 * The golden day file proves the figures end to end; this one proves the
 * rules around them: one opening float a day, who may take cash out, what
 * blocks a close, and who may do what.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { AuditLog } from '../models/AuditLog.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { createTable, fireOrder, openOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
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
const cash = (token, body) => request('POST', '/api/v1/cash-movements', { token, body });
const close = (token, body) => request('POST', '/api/v1/day-close', { token, body: { businessDate: DATE, ...body } });

describe('the cash drawer', () => {
  it('takes one live opening float per day; after voiding it, another', async () => {
    const { tokens } = await seedFloor();
    const first = await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 200000 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.businessDate, DATE);

    const second = await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 150000 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'DUPLICATE');

    const voided = await request('POST', `/api/v1/cash-movements/${first.body.data.id}/void`, {
      token: tokens.MANAGER,
      body: { reason: 'Miscounted' },
    });
    assert.equal(voided.status, 200);
    assert.equal(voided.body.data.isVoided, true);

    assert.equal((await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 150000 })).status, 201);

    const listed = (await request('GET', '/api/v1/cash-movements', { token: tokens.CASHIER })).body.data;
    assert.equal(listed.businessDate, DATE);
    assert.equal(listed.movements.length, 2, 'the voided float is kept');
  });

  it('a cashier records a float and a paid in, and is refused a paid out and a void', async () => {
    const { tokens, restaurant } = await seedFloor();
    assert.equal((await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 100000 })).status, 201);
    // P28: a cashier's paid in needs a manager's PIN by default; with that approval switched off, it does not.
    assert.equal((await cash(tokens.CASHIER, { type: 'PAID_IN', amountInPaise: 5000, reason: 'Change from the bank' })).status, 403);
    await request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'No PIN for paid in', approvals: { paidIn: false } } });
    const paidIn = await cash(tokens.CASHIER, { type: 'PAID_IN', amountInPaise: 5000, reason: 'Change from the bank' });
    assert.equal(paidIn.status, 201);
    assert.equal((await cash(tokens.CASHIER, { type: 'PAID_OUT', amountInPaise: 3500, reason: 'Milk' })).status, 403);
    assert.equal(
      (await request('POST', `/api/v1/cash-movements/${paidIn.body.data.id}/void`, { token: tokens.CASHIER, body: { reason: 'x' } })).status,
      403,
    );

    const paidOut = await cash(tokens.MANAGER, { type: 'PAID_OUT', amountInPaise: 3500, reason: 'Milk from the dairy' });
    assert.equal(paidOut.status, 201);
    const [audit] = await AuditLog.find({ restaurantId: restaurant._id, action: 'CASH_PAID_OUT' });
    assert.equal(audit.entityType, 'CASH');
    assert.equal(audit.amountInPaise, 3500);
    assert.equal(audit.reason, 'Milk from the dairy');
  });

  it('needs a reason for paid in and paid out, and never takes a business date from the request', async () => {
    const { tokens } = await seedFloor();
    assert.equal((await cash(tokens.MANAGER, { type: 'PAID_OUT', amountInPaise: 100 })).status, 400);
    assert.equal(
      (await cash(tokens.MANAGER, { type: 'PAID_IN', amountInPaise: 100, reason: 'x', businessDate: '2026-09-20' })).status,
      400,
    );
  });
});

describe('Day Close', () => {
  it('lists an open order and an unpaid bill together as blockers', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const second = (await createTable(tokens.OWNER, { name: 'T2' })).body.data;
    // P61: sent to the kitchen, so it blocks; an order nothing was sent from closes itself.
    const open = (await openOrder(tokens.WAITER, { tableId: second.id, lines: [{ menuItemId: floor.item.id, quantity: 1 }] })).body.data;
    await fireOrder(tokens.WAITER, open.id, open.version);
    const ready = await readyToBillOrder(floor);
    const bill = (await request('POST', '/api/v1/bills', { token: tokens.CASHIER, body: { orderId: ready.id, version: ready.version } })).body.data;

    const response = await close(tokens.MANAGER, { countedCashInPaise: 0 });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'DAY_NOT_READY');
    const kinds = response.body.error.blockers.map((blocker) => blocker.kind).sort();
    assert.deepEqual(kinds, ['OPEN_ORDER', 'UNPAID_BILL']);
    assert.ok(response.body.error.blockers.some((blocker) => blocker.message === `Bill ${bill.billNumber} is not paid.`));
  });

  it('needs a note when the count differs, and says only that it differs', async () => {
    const { tokens } = await seedFloor();
    await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 100000 });

    const noNote = await close(tokens.MANAGER, { countedCashInPaise: 99000 });
    assert.equal(noNote.status, 422);
    assert.equal(noNote.body.error.noteRequired, true);
    assert.doesNotMatch(noNote.body.error.message, /1,000|990|100000/);

    const exact = await close(tokens.MANAGER, { countedCashInPaise: 100000 });
    assert.equal(exact.status, 201, JSON.stringify(exact.body));
  });

  it('refuses a future date, a second close, and a reopen by a manager or without a reason', async () => {
    const { tokens } = await seedFloor();
    assert.equal((await close(tokens.OWNER, { businessDate: '2026-09-27', countedCashInPaise: 0 })).status, 422);
    assert.equal((await close(tokens.OWNER, { countedCashInPaise: 0 })).status, 201);
    assert.equal((await close(tokens.OWNER, { countedCashInPaise: 0 })).status, 422);

    const reopen = (token, body) => request('POST', `/api/v1/day-close/${DATE}/reopen`, { token, body });
    assert.equal((await reopen(tokens.MANAGER, { reason: 'x' })).status, 403);
    assert.equal((await reopen(tokens.OWNER, {})).status, 400);
    assert.equal((await reopen(tokens.OWNER, { reason: 'Wrong count' })).status, 200);
    assert.equal((await reopen(tokens.OWNER, { reason: 'Again' })).status, 422, 'only a closed day reopens');

    const closedAgain = await close(tokens.MANAGER, { countedCashInPaise: 0 });
    assert.equal(closedAgain.status, 201);
    assert.equal(closedAgain.body.data.history.length, 3);
  });

  it('shows a manager the expected cash only when the owner allows it', async () => {
    const { tokens } = await seedFloor();
    await cash(tokens.CASHIER, { type: 'OPENING_FLOAT', amountInPaise: 100000 });
    const blind = (await request('GET', `/api/v1/day-close/${DATE}`, { token: tokens.MANAGER })).body.data;
    assert.equal('expectedCashInPaise' in blind, false);

    await request('PATCH', '/api/v1/settings', {
      token: tokens.OWNER,
      body: { reason: 'Manager counts openly', dayClose: { showCashDifferenceToManager: true } },
    });
    const open = (await request('GET', `/api/v1/day-close/${DATE}`, { token: tokens.MANAGER })).body.data;
    assert.equal(open.expectedCashInPaise, 100000);
  });

  it('matches the permission table', async () => {
    const { tokens } = await seedFloor();
    const cases = [
      ['GET', '/api/v1/cash-movements', undefined, ['OWNER', 'MANAGER', 'CASHIER']],
      ['GET', '/api/v1/day-close', undefined, ['OWNER', 'MANAGER']],
      // P61: the cashier reads and closes the day, blind.
      ['GET', `/api/v1/day-close/${DATE}`, undefined, ['OWNER', 'MANAGER', 'CASHIER']],
      ['GET', `/api/v1/day-close/${DATE}/print`, undefined, ['OWNER', 'MANAGER', 'CASHIER']],
      ['POST', '/api/v1/day-close', { businessDate: '2026-09-27', countedCashInPaise: 0 }, ['OWNER', 'MANAGER', 'CASHIER']],
      ['POST', `/api/v1/day-close/${DATE}/reopen`, { reason: 'x' }, ['OWNER']],
    ];
    for (const [method, path, body, allowed] of cases) {
      for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) {
        const response = await request(method, path, { token: tokens[role], body });
        if (allowed.includes(role)) assert.notEqual(response.status, 403, `${role} ${method} ${path}`);
        else assert.equal(response.status, 403, `${role} ${method} ${path}`);
      }
    }
    assert.equal((await request('GET', '/api/v1/cash-movements')).status, 401);
  });
});
