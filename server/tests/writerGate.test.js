/**
 * P62 sections 2.6, 8 and 11, tests 13 to 15. One writer, and the fence that
 * keeps it that way.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { setRoleForTest } from '../config/deployment.js';
import { MIRROR_WRITE_ALLOWLIST, mirrorAllows } from '../middleware/writerGate.js';
import { Bill } from '../models/Bill.js';
import { Counter } from '../models/Counter.js';
import { ALL_MODELS } from '../models/index.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../models/ReplicationState.js';
import { writeRefusal } from '../models/plugins/writerGuard.js';
import hookRoutes, { HOOKS_PATH } from '../routes/hookRoutes.js';
import routes from '../routes/index.js';
import replicationRoutes, { REPLICATION_ROUTES_PATH } from '../routes/replicationRoutes.js';
import tallyBridgeRoutes, { TALLY_BRIDGE_PATH } from '../routes/tallyBridgeRoutes.js';
import { checkClock, resetClockGuardForTest } from '../services/replication/clockGuard.js';
import { fenceThisBox, loadWriterState, resetWriterStateForTest } from '../services/replication/writerState.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { DEFAULT_PASSWORD } from './helpers/seed.js';
import { readOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
});

after(async () => {
  setRoleForTest(null);
  await stopTestServer();
  await stopTestDatabase();
});

afterEach(async () => {
  setRoleForTest(null);
  resetClockForTests();
  resetClockGuardForTest();
  await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.WRITER }, { $set: { fenced: false, promoted: false, epoch: 1 } }, { upsert: true });
  resetWriterStateForTest();
});

/** Every route the API answers, with its full path and a sample value for each parameter. */
function routeTable() {
  const table = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) table.push({ method: method.toUpperCase(), path: `${prefix}${layer.route.path}` });
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(routes.stack, '/api/v1');
  walk(hookRoutes.stack, `/api/v1${HOOKS_PATH}`);
  walk(tallyBridgeRoutes.stack, `/api/v1${TALLY_BRIDGE_PATH}`);
  walk(replicationRoutes.stack, `/api/v1${REPLICATION_ROUTES_PATH}`);
  return table;
}

const sample = (routePath) => routePath.replace(/:([A-Za-z]+)/g, 'x1');

describe('the read-only mirror (P62 section 11.13)', () => {
  it('lets through exactly the allowlisted writing routes, found by walking the whole route table', () => {
    const writes = routeTable().filter((route) => !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
    assert.ok(writes.length > 100, `only ${writes.length} writing routes found: the walk is broken`);
    const allowed = writes.filter((route) => mirrorAllows(route.method, sample(route.path))).map((route) => `${route.method} ${route.path}`).sort();
    const expected = MIRROR_WRITE_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`).sort();
    assert.deepEqual(allowed, expected);
  });

  it('would fail on one extra route', () => {
    const writes = [...routeTable(), { method: 'POST', path: '/api/v1/public/:slug/orders/:id/tip' }].filter((route) => route.method === 'POST');
    const tipAllowed = writes.some((route) => route.path.endsWith('/tip') && mirrorAllows('POST', sample(route.path)));
    assert.equal(tipAllowed, false, 'a new route is refused until it is added to the allowlist on purpose');
  });

  it('answers a write with 503 and plain words, and still serves reads and sign-in', async () => {
    const world = await seedFloor();
    setRoleForTest('MIRROR');
    const write = await request('PATCH', '/api/v1/settings', { token: world.tokens.OWNER, body: { reason: 'try', features: { online: true } } });
    assert.equal(write.status, 503);
    assert.equal(write.body.error.code, 'MIRROR_READ_ONLY');
    assert.match(write.body.error.message, /read-only copy/);
    const read = await request('GET', '/api/v1/tables', { token: world.tokens.OWNER });
    assert.equal(read.status, 200);
    const signIn = await request('POST', '/api/v1/auth/login', { body: { phone: world.phone, password: DEFAULT_PASSWORD } });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  });

  it('refuses the same write again at the model, for anything without a request', () => {
    setRoleForTest('MIRROR');
    assert.equal(writeRefusal('Bill')?.code, 'MIRROR_READ_ONLY');
    assert.equal(writeRefusal('RefreshToken'), null);
    assert.equal(writeRefusal('IntakeItem'), null);
  });

  it('becomes the writer when promoted', async () => {
    const world = await seedFloor();
    setRoleForTest('MIRROR');
    await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.WRITER }, { $set: { promoted: true, epoch: 2 } }, { upsert: true });
    await loadWriterState();
    const write = await request('POST', '/api/v1/tables', { token: world.tokens.OWNER, body: { name: 'Promoted' } });
    assert.equal(write.status, 201, JSON.stringify(write.body));
  });
});

describe('epoch fencing (P62 section 11.14)', () => {
  it('a box that saw a higher epoch issues no bill number, by request or by model', async () => {
    const world = await seedFloor();
    const order = await readyToBillOrder(world);
    setRoleForTest('BOX');
    await fenceThisBox(2, 'The cloud copy holds epoch 2.');

    const countersBefore = await Counter.find({ restaurantId: world.restaurant._id }).lean();
    const current = (await readOrder(world.tokens.CASHIER, order.id)).body.data;
    const refused = await request('POST', '/api/v1/bills', { token: world.tokens.CASHIER, body: { orderId: order.id, version: current.version } });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'WRITER_FENCED');
    await assert.rejects(Bill.create({ restaurantId: world.restaurant._id, branchId: world.branch._id }), { code: 'WRITER_FENCED' });

    assert.equal(await Bill.countDocuments({ restaurantId: world.restaurant._id }), 0);
    assert.deepEqual(await Counter.find({ restaurantId: world.restaurant._id }).lean(), countersBefore);
    // Signing in still works, so staff can read the message.
    const signIn = await request('POST', '/api/v1/auth/login', { body: { phone: world.phone, password: DEFAULT_PASSWORD } });
    assert.equal(signIn.status, 200);
  });
});

describe('the clock refusal (P62 sections 2.6 and 11.15)', () => {
  it('refuses writes while the clock is behind the newest bill, says why, and lifts by itself', async () => {
    const world = await seedFloor();
    const order = await readyToBillOrder(world);
    const current = (await readOrder(world.tokens.CASHIER, order.id)).body.data;
    const billed = await request('POST', '/api/v1/bills', { token: world.tokens.CASHIER, body: { orderId: order.id, version: current.version } });
    assert.equal(billed.status, 201, JSON.stringify(billed.body));

    setRoleForTest('BOX');
    // The clock battery died: the box comes back a day in the past.
    setClockForTests(new Date(Date.now() - 24 * 60 * 60_000));
    assert.equal(await checkClock(), true);
    const refused = await request('POST', '/api/v1/tables', { token: world.tokens.OWNER, body: { name: 'Late' } });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'CLOCK_BEHIND');
    assert.match(refused.body.error.message, /clock is behind the last sale/);
    assert.equal((await request('GET', '/api/v1/tables', { token: world.tokens.OWNER })).status, 200);

    resetClockForTests();
    assert.equal(await checkClock(), false);
    const allowed = await request('POST', '/api/v1/tables', { token: world.tokens.OWNER, body: { name: 'On time' } });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  });
});
