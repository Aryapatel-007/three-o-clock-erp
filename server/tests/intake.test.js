/**
 * P62 section 5 and section 11, tests 8 to 11. Intake: the internet's requests
 * wait on the mirror, and the box applies them through the normal services.
 *
 * One process plays both machines: the mirror while a guest's request
 * arrives, the box while it is applied. Both read the same test database,
 * which is what the box and its copy hold once the shipper has caught up.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';

import { setRoleForTest } from '../config/deployment.js';
import { INTAKE_STATUSES, IntakeItem } from '../models/IntakeItem.js';
import { IntakeApplication } from '../models/IntakeApplication.js';
import { ALL_MODELS } from '../models/index.js';
import { OnlineOrder } from '../models/OnlineOrder.js';
import { applyIntakeItem } from '../services/intake/boxIntake.js';
import { claimIntake, guestIntakeStatus, recordIntakeOutcome } from '../services/intake/cloudIntake.js';
import { noteBoxSeen } from '../services/replication/receiver.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { createMenuItem, seedTeam } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LUNCH = new Date('2026-10-08T13:00:00+05:30');

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

afterEach(() => {
  setRoleForTest(null);
  resetClockForTests();
});

let slugCounter = 0;

/** On the box: a cafe with online takeaway on and two dishes. */
async function seedOnline() {
  setClockForTests(LUNCH);
  const team = await seedTeam();
  const owner = team.tokens.OWNER;
  slugCounter += 1;
  const slug = `intake-${slugCounter}`;
  await request('PATCH', '/api/v1/settings', { token: owner, body: { reason: 'Start online orders', features: { online: true }, online: { takeawayEnabled: true, reservationsEnabled: true } } });
  await request('PATCH', '/api/v1/online/site', { token: owner, body: { publicSlug: slug } });
  const chai = (await createMenuItem(owner, { name: 'Masala Chai', priceInPaise: 24000, taxRateBps: 500 })).body.data;
  const shake = (await createMenuItem(owner, { name: 'Cold Shake', priceInPaise: 15000, taxRateBps: 1800 })).body.data;
  return { ...team, owner, slug, chai, shake, restaurantId: team.restaurant._id };
}

const orderBody = (world, overrides = {}) => ({
  idempotencyKey: randomUUID(),
  customerName: 'Guest',
  customerPhone: '9876543210',
  pickup: 'ASAP',
  lines: [{ menuItemId: world.chai.id, quantity: 2 }],
  ...overrides,
});

const placeOnMirror = (world, body) => request('POST', `/api/v1/public/${world.slug}/orders`, { body });

/** The box claims and applies everything waiting, and reports each outcome, as the puller does. */
async function boxPulls(world, { now } = {}) {
  setRoleForTest('BOX');
  const items = await claimIntake([world.restaurantId], now ? { now } : {});
  const outcomes = [];
  for (const item of items) {
    const outcome = await applyIntakeItem(item);
    await recordIntakeOutcome(item.restaurantId, item._id, outcome);
    outcomes.push(outcome);
  }
  setRoleForTest('MIRROR');
  return outcomes;
}

describe('intake on the mirror', () => {
  it('turns a guest order into one intake item, however many times it arrives (P62 section 11.8)', async () => {
    const world = await seedOnline();
    setRoleForTest('MIRROR');
    await noteBoxSeen(world.restaurantId);
    const body = orderBody(world);
    const answers = [];
    for (let i = 0; i < 3; i += 1) answers.push(await placeOnMirror(world, body));
    for (const answer of answers) assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.equal(new Set(answers.map((answer) => answer.body.data.intake.id)).size, 1);
    assert.equal(await IntakeItem.countDocuments({ restaurantId: world.restaurantId }), 1);
    assert.equal(await OnlineOrder.countDocuments({ restaurantId: world.restaurantId }), 0, 'the mirror made no order');

    const [outcome] = await boxPulls(world);
    assert.equal(outcome.status, INTAKE_STATUSES.APPLIED);
    assert.equal(await OnlineOrder.countDocuments({ restaurantId: world.restaurantId }), 1);

    // Only the first answer carried the guest's secret; with it the guest collects the status token, once.
    const secret = answers[0].body.data.intake.secret;
    assert.ok(secret);
    assert.equal(answers[1].body.data.intake.secret, null);
    const first = await guestIntakeStatus({ restaurantId: world.restaurantId }, answers[0].body.data.intake.id, secret);
    assert.equal(first.status, INTAKE_STATUSES.APPLIED);
    assert.ok(first.statusToken);
    assert.equal(first.result.onlineOrderId, String((await OnlineOrder.findOne({ restaurantId: world.restaurantId }))._id));
    const second = await guestIntakeStatus({ restaurantId: world.restaurantId }, answers[0].body.data.intake.id, secret);
    assert.equal(second.statusToken, null);
    assert.equal(await guestIntakeStatus({ restaurantId: world.restaurantId }, answers[0].body.data.intake.id, 'wrong'), null);
  });

  it('makes one order when the box dies after applying and before saying so (P62 section 11.9)', async () => {
    const world = await seedOnline();
    setRoleForTest('MIRROR');
    await noteBoxSeen(world.restaurantId);
    await placeOnMirror(world, orderBody(world));

    setRoleForTest('BOX');
    const [item] = await claimIntake([world.restaurantId]);
    assert.equal((await applyIntakeItem(item)).status, INTAKE_STATUSES.APPLIED);
    // The crash: the outcome never reached the mirror, and the box's own note still says STARTED.
    await IntakeApplication.collection.updateOne({ restaurantId: world.restaurantId, intakeId: String(item._id) }, { $set: { status: 'STARTED' } });

    // The claim's hold runs out and the item is claimed again.
    const later = new Date(Date.now() + 3 * 60_000);
    const outcomes = await boxPulls(world, { now: later });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, INTAKE_STATUSES.APPLIED);
    assert.equal(await OnlineOrder.countDocuments({ restaurantId: world.restaurantId }), 1);
    assert.equal((await IntakeItem.findOne({ restaurantId: world.restaurantId, _id: item._id })).attempts, 2);
  });

  it('rejects an order for a dish the kitchen switched off after the mirror last heard (P62 section 11.10)', async () => {
    const world = await seedOnline();
    await request('PATCH', `/api/v1/menu-items/${world.shake.id}/availability`, { token: world.owner, body: { isAvailable: false } });
    setRoleForTest('MIRROR');
    await noteBoxSeen(world.restaurantId);
    const placed = await placeOnMirror(world, orderBody(world, { lines: [{ menuItemId: world.shake.id, quantity: 1 }] }));
    assert.equal(placed.status, 202);

    const [outcome] = await boxPulls(world);
    assert.equal(outcome.status, INTAKE_STATUSES.REJECTED);
    assert.equal(outcome.reasonCode, 'ITEM_UNAVAILABLE');
    assert.match(outcome.reasonMessage, /Cold Shake is not available/);
    assert.equal(await OnlineOrder.countDocuments({ restaurantId: world.restaurantId }), 0);
    const item = await IntakeItem.findOne({ restaurantId: world.restaurantId });
    assert.equal(item.status, INTAKE_STATUSES.REJECTED);
  });

  it('takes no new order while the box has not checked in, before any money moves', async () => {
    const world = await seedOnline();
    setRoleForTest('MIRROR');
    const refused = await placeOnMirror(world, orderBody(world));
    assert.equal(refused.body.error.code, 'ONLINE_CLOSED');
    assert.equal(await IntakeItem.countDocuments({ restaurantId: world.restaurantId }), 0);
  });

  it('keeps a Razorpay webhook only when the cafe signed it', async () => {
    const world = await seedOnline();
    setRoleForTest('MIRROR');
    const forged = await request('POST', `/api/v1/public/${world.slug}/payments/webhook`, { body: { event: 'payment_link.paid' }, headers: { 'x-razorpay-signature': 'forged' } });
    assert.equal(forged.status, 400);
    assert.equal(await IntakeItem.countDocuments({ restaurantId: world.restaurantId }), 0);
  });

  it('steps aside on the box: the same route makes the order directly, as before P62', async () => {
    const world = await seedOnline();
    setRoleForTest('BOX');
    const placed = await placeOnMirror(world, orderBody(world));
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(await IntakeItem.countDocuments({ restaurantId: world.restaurantId }), 0);
  });
});

describe('the intake handler cannot write operational data (P62 section 11.11)', () => {
  it('imports no model but IntakeItem', () => {
    const source = readFileSync(path.join(here, '..', 'services', 'intake', 'cloudIntake.js'), 'utf8');
    const models = [...source.matchAll(/from '\.\.\/\.\.\/models\/([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(models, ['IntakeItem.js']);
  });

  it('would fail if it imported one', () => {
    const tampered = "import { Order } from '../../models/Order.js';\nimport { IntakeItem } from '../../models/IntakeItem.js';";
    const models = [...tampered.matchAll(/from '\.\.\/\.\.\/models\/([^']+)'/g)].map((match) => match[1]);
    assert.notDeepEqual(models, ['IntakeItem.js']);
  });
});
