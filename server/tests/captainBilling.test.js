/**
 * P25 Part D: captains bill, and print at the counter.
 * docs/API-CONTRACT.md M3 sections 16.2 and 16.3.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_MODELS } from '../models/index.js';
import { createMenuItem, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
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

const createBill = (token, order) =>
  request('POST', '/api/v1/bills', { token, body: { orderId: order.id, version: order.version } });
const pay = (token, bill) =>
  request('POST', `/api/v1/bills/${bill.id}/payments`, { token, body: { method: 'CASH', amountInPaise: bill.grandTotalInPaise } });
const setBilling = (floor, billing) =>
  request('PATCH', '/api/v1/settings', { token: floor.tokens.OWNER, body: { reason: 'Captains', billing } });

describe('captains bill', () => {
  it('lets a captain bill a dine-in order with the defaults, and never a delivery order', async () => {
    const floor = await seedFloor();
    const me = (await request('GET', '/api/v1/auth/me', { token: floor.tokens.WAITER })).body.data;
    // P29 added the two billing switches beside them.
    assert.deepEqual(me.billing, { captainsMayBill: true, captainsMayTakePayment: false, reviseUnpaidBills: true, printBeforePayment: true });

    const order = await readyToBillOrder(floor);
    const billed = await createBill(floor.tokens.WAITER, order);
    assert.equal(billed.status, 201, JSON.stringify(billed.body));

    const delivery = await request('POST', '/api/v1/orders', {
      token: floor.tokens.CASHIER,
      body: { orderType: 'DELIVERY', platform: { code: 'SWIGGY', orderId: '249377796192385' }, lines: [{ menuItemId: floor.item.id, quantity: 1 }] },
    });
    assert.equal(delivery.status, 201, JSON.stringify(delivery.body));
    const refused = await createBill(floor.tokens.WAITER, delivery.body.data);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error.message, /delivery/);
  });

  it('refuses a captain a payment until the owner allows it, then takes it', async () => {
    const floor = await seedFloor();
    const bill = (await createBill(floor.tokens.WAITER, await readyToBillOrder(floor))).body.data;
    assert.equal((await pay(floor.tokens.WAITER, bill)).status, 403);

    assert.equal((await setBilling(floor, { captainsMayTakePayment: true })).status, 200);
    const paid = await pay(floor.tokens.WAITER, bill);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'PAID');
  });

  it('refuses a captain exactly as before when captains may not bill', async () => {
    const floor = await seedFloor();
    await setBilling(floor, { captainsMayBill: false, captainsMayTakePayment: true });
    const order = await readyToBillOrder(floor);
    const refused = await createBill(floor.tokens.WAITER, order);
    assert.equal(refused.status, 403);

    const bill = (await createBill(floor.tokens.CASHIER, order)).body.data;
    assert.equal((await pay(floor.tokens.WAITER, bill)).status, 403);
    // Kitchen and storekeeper never bill.
    assert.equal((await createBill(floor.tokens.KITCHEN, order)).status, 403);
  });

  it('lets only the owner change the billing settings', async () => {
    const floor = await seedFloor();
    const byManager = await request('PATCH', '/api/v1/settings', {
      token: floor.tokens.MANAGER,
      body: { reason: 'x', billing: { captainsMayBill: false } },
    });
    assert.equal(byManager.status, 403);
  });
});

describe('printing at the counter', () => {
  it('puts a requested bill in the queue once, takes it out once printed, and puts it back on a second request', async () => {
    const floor = await seedFloor();
    await createMenuItem(floor.tokens.OWNER, { name: 'Bhel' });
    const bill = (await createBill(floor.tokens.WAITER, await readyToBillOrder(floor))).body.data;
    const queue = () => request('GET', '/api/v1/bills/print-queue', { token: floor.tokens.CASHIER });

    assert.deepEqual((await queue()).body.data, []);
    assert.equal((await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER })).status, 200);
    await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER });
    const waiting = (await queue()).body.data;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].billNumber, bill.billNumber);
    assert.equal(waiting[0].printRequestedByName, 'WAITER');

    const first = await request('GET', `/api/v1/bills/${bill.id}/receipt?width=48`, { token: floor.tokens.CASHIER });
    assert.doesNotMatch(first.body.data.text, /DUPLICATE/);
    const printed = await request('POST', `/api/v1/bills/${bill.id}/printed`, { token: floor.tokens.CASHIER });
    // P29: `printed` also says which revision was printed.
    assert.deepEqual(printed.body.data, { printCount: 1, isDuplicate: false, revision: 0 });
    assert.deepEqual((await queue()).body.data, []);

    await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER });
    assert.equal((await queue()).body.data.length, 1);
    const second = await request('GET', `/api/v1/bills/${bill.id}/receipt?width=48`, { token: floor.tokens.CASHIER });
    assert.match(second.body.data.text, /DUPLICATE/);
    const invoice = await request('GET', `/api/v1/bills/${bill.id}/invoice`, { token: floor.tokens.CASHIER });
    assert.equal(invoice.body.data.isDuplicate, true);
    const again = await request('POST', `/api/v1/bills/${bill.id}/printed`, { token: floor.tokens.CASHIER });
    assert.deepEqual(again.body.data, { printCount: 2, isDuplicate: true, revision: 0 });
    assert.deepEqual((await queue()).body.data, []);
  });

  it('P59: a second tap while the request waits keeps its time', async () => {
    const floor = await seedFloor();
    const bill = (await createBill(floor.tokens.WAITER, await readyToBillOrder(floor))).body.data;
    const ask = () => request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER });

    const first = (await ask()).body.data.printRequestedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await ask();
    assert.equal(second.status, 200);
    assert.equal(second.body.data.printRequestedAt, first, 'the waiting request keeps its time');

    await request('POST', `/api/v1/bills/${bill.id}/printed`, { token: floor.tokens.CASHIER, body: { forRequestAt: first } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const afterPrint = (await ask()).body.data.printRequestedAt;
    assert.notEqual(afterPrint, first, 'a request after the print is a new request');
  });

  it('P59: of two counter devices claiming one request, exactly one prints it', async () => {
    const floor = await seedFloor();
    const bill = (await createBill(floor.tokens.WAITER, await readyToBillOrder(floor))).body.data;
    await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER });
    const [waiting] = (await request('GET', '/api/v1/bills/print-queue', { token: floor.tokens.CASHIER })).body.data;

    const claim = (token) =>
      request('POST', `/api/v1/bills/${bill.id}/printed`, { token, body: { forRequestAt: waiting.printRequestedAt } });
    const results = await Promise.all([claim(floor.tokens.CASHIER), claim(floor.tokens.MANAGER)]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const lost = results.find((result) => result.status === 409);
    assert.equal(lost.body.error.code, 'DUPLICATE');
    assert.equal(lost.body.error.message, 'Another device has printed this bill.');

    const read = (await request('GET', `/api/v1/bills/${bill.id}`, { token: floor.tokens.CASHIER })).body.data;
    assert.equal(read.printCount, 1, 'one print recorded');
    assert.deepEqual((await request('GET', '/api/v1/bills/print-queue', { token: floor.tokens.CASHIER })).body.data, []);

    // A claim for a request time that is not the bill's is refused too, and changes nothing.
    const stale = await request('POST', `/api/v1/bills/${bill.id}/printed`, {
      token: floor.tokens.CASHIER,
      body: { forRequestAt: '2026-01-01T00:00:00.000Z' },
    });
    assert.equal(stale.status, 409);
    const bad = await request('POST', `/api/v1/bills/${bill.id}/printed`, { token: floor.tokens.CASHIER, body: { forRequestAt: 'soon' } });
    assert.equal(bad.status, 400);
    assert.equal((await request('GET', `/api/v1/bills/${bill.id}`, { token: floor.tokens.CASHIER })).body.data.printCount, 1);
  });

  it('keeps the queue to the till, and to its own restaurant', async () => {
    const floor = await seedFloor();
    const other = await seedFloor();
    const bill = (await createBill(floor.tokens.WAITER, await readyToBillOrder(floor))).body.data;
    await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: floor.tokens.WAITER });

    assert.equal((await request('GET', '/api/v1/bills/print-queue', { token: floor.tokens.WAITER })).status, 403);
    assert.deepEqual((await request('GET', '/api/v1/bills/print-queue', { token: other.tokens.CASHIER })).body.data, []);
    assert.equal((await request('POST', `/api/v1/bills/${bill.id}/print-request`, { token: other.tokens.WAITER })).status, 404);
    assert.equal((await request('POST', `/api/v1/bills/${bill.id}/printed`, { token: other.tokens.CASHIER })).status, 404);
    assert.equal((await request('POST', `/api/v1/bills/${bill.id}/print-request`)).status, 401);
  });
});
