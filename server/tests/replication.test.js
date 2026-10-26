/**
 * P62 sections 2, 4 and 11. The changelog, the shipper and the mirror's apply.
 *
 * The "box" is the test database; the "mirror" is a second database on the
 * same test server, reached through a stand-in for the network that calls the
 * mirror's own receiver. Every negative test breaks a rule on purpose and
 * shows the rule caught it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

import { assertReplicaSet } from '../config/database.js';
import { ChangelogEntry } from '../models/ChangelogEntry.js';
import { ALL_MODELS } from '../models/index.js';
import { ReplicaCursor } from '../models/ReplicaCursor.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../models/ReplicationState.js';
import { ChangelogWriter } from '../services/replication/changelogWriter.js';
import { mirrorCollectionNames } from '../services/replication/collections.js';
import { localSnapshotToolsMissing } from './helpers/replicationFixtures.js';
import { restoreSnapshot, takeSnapshot } from '../services/replication/localSnapshot.js';
import { compareDigests, digestRestaurant, reconcileOnce } from '../services/replication/reconcile.js';
import { applyBatch } from '../services/replication/receiver.js';
import { shipOnce, shippingLag } from '../services/replication/shipper.js';
import { fromWire } from '../services/replication/signing.js';
import { readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

let mirrorDb;

/** The network, standing in: the mirror's own receiver and digest, against the mirror database. */
function mirrorFetch({ currentEpoch = 1 } = {}) {
  return async (url, init) => {
    const where = new URL(url).pathname.replace('/api/v1/replication', '');
    const payload = fromWire(init.body);
    try {
      let data;
      if (where === '/batches') data = await applyBatch(payload, { db: mirrorDb, currentEpoch });
      else if (where === '/reconcile') data = await digestRestaurant(payload.restaurantId, { businessDate: payload.businessDate, db: mirrorDb });
      else throw Object.assign(new Error('Unknown path'), { statusCode: 404 });
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: { code: error.code, message: error.message, ...(error.details ?? {}) } }), { status: error.statusCode ?? 500 });
    }
  };
}

const network = (extra = {}) => ({ mirrorUrl: 'http://mirror.test', secret: 'test-replication-secret-0000000000000', fetchImpl: mirrorFetch(extra), ...extra });

async function drain(writer) {
  // A committed change reaches the stream within moments; read until two empty passes.
  let quiet = 0;
  while (quiet < 2) quiet = (await writer.pump()) === 0 ? quiet + 1 : 0;
}

async function shipAll(restaurantId, options = network()) {
  const outcomes = [];
  for (let i = 0; i < 100; i += 1) {
    const outcome = await shipOnce(restaurantId, options);
    outcomes.push(outcome);
    if (outcome !== 'SHIPPED' && outcome !== 'REWOUND') break;
  }
  return outcomes;
}

async function sameAsBox(restaurantId) {
  const box = await digestRestaurant(restaurantId);
  const copy = await digestRestaurant(restaurantId, { db: mirrorDb });
  return compareDigests(box, copy);
}

let world;
let writer;

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  mirrorDb = mongoose.connection.client.db('restaurant-erp-mirror-test');
  world = await seedFloor();
  writer = new ChangelogWriter();
  assert.equal(await writer.start(), 'BASELINED');
  await readyToBillOrder(world);
  await drain(writer);
});

after(async () => {
  await writer?.close();
  await stopTestServer();
  await stopTestDatabase();
});

const restaurantId = () => new mongoose.Types.ObjectId(String(world.restaurant._id));

describe('a standalone database is refused at boot (P62 section 11.1)', () => {
  it('passes the replica set the tests run on', async () => {
    assert.ok(await assertReplicaSet(mongoose.connection.db));
  });

  it('refuses a standalone mongod with the fix in plain words', async () => {
    const standalone = await MongoMemoryServer.create();
    const connection = await mongoose.createConnection(standalone.getUri()).asPromise();
    try {
      await assert.rejects(assertReplicaSet(connection.db), (error) => error.code === 'NOT_A_REPLICA_SET' && /rs\.initiate\(\)/.test(error.message));
    } finally {
      await connection.close();
      await standalone.stop();
    }
  });
});

describe('the changelog', () => {
  it('records every change with a gap-free seq per restaurant, stamped with the epoch', async () => {
    const entries = await ChangelogEntry.find({ restaurantId: restaurantId() }).sort({ seq: 1 }).lean();
    assert.ok(entries.length > 10, `only ${entries.length} entries`);
    entries.forEach((entry, index) => assert.equal(entry.seq, index + 1));
    assert.ok(entries.every((entry) => entry.epoch === 1));
    assert.ok(entries.some((entry) => entry.coll === 'orders' && entry.op !== 'baseline'));
    assert.ok(entries.some((entry) => entry.coll === 'kots'));
    assert.ok(entries.every((entry) => mirrorCollectionNames().includes(entry.coll)));
  });

  it('never records a LOCAL_ONLY collection', async () => {
    const colls = await ChangelogEntry.distinct('coll', { restaurantId: restaurantId() });
    for (const local of ['refreshtokens', 'changelog', 'replicationstate', 'intake']) assert.ok(!colls.includes(local), local);
  });

  it('is append-only: an update or a delete through the model throws', async () => {
    await assert.rejects(ChangelogEntry.updateOne({ restaurantId: restaurantId(), seq: 1 }, { $set: { op: 'insert' } }), { name: 'AuditLogImmutableError' });
    await assert.rejects(ChangelogEntry.deleteMany({ restaurantId: restaurantId() }), { name: 'AuditLogImmutableError' });
  });

  it('has no update or delete path anywhere in the server', () => {
    let hits = '';
    try {
      hits = execFileSync('grep', ['-rnE', 'ChangelogEntry\\.(update|delete|findOneAndUpdate|findOneAndDelete|replaceOne|bulkWrite)', ...['services', 'controllers', 'scripts', 'routes'].map((dir) => path.resolve(dir))], { encoding: 'utf8' }).trim();
    } catch (error) {
      // grep says 1 when it finds nothing, which is the answer wanted.
      if (error.status !== 1) throw error;
    }
    assert.equal(hits, '');
  });

  it('resumes after a restart without recording an event twice', async () => {
    const before = await ChangelogEntry.countDocuments({ restaurantId: restaurantId() });
    await writer.close();
    writer = new ChangelogWriter();
    assert.equal(await writer.start(), 'RESUMED');
    await drain(writer);
    assert.equal(await ChangelogEntry.countDocuments({ restaurantId: restaurantId() }), before);
  });

  it('takes pumps called at once in turn, so the stream stays open and nothing is missed (P63)', async () => {
    // The timer and a sync request both pump; two reads on one change stream at once close it.
    const tables = mongoose.connection.db.collection('tables');
    const table = await tables.findOne({ restaurantId: restaurantId() });
    const before = await ChangelogEntry.countDocuments({ restaurantId: restaurantId(), coll: 'tables', documentId: table._id });
    for (let round = 0; round < 3; round += 1) {
      await tables.updateOne({ _id: table._id }, { $set: { seats: 2 + round } });
      await Promise.all(Array.from({ length: 4 }, () => writer.pump()));
    }
    await drain(writer);
    assert.equal(writer.stream.closed, false);
    assert.equal(await ChangelogEntry.countDocuments({ restaurantId: restaurantId(), coll: 'tables', documentId: table._id }), before + 3);
  });

  it('opens a stream the driver closed again from its saved place (P63)', async () => {
    await drain(writer);
    await writer.stream.close();
    const tables = mongoose.connection.db.collection('tables');
    const table = await tables.findOne({ restaurantId: restaurantId() });
    await tables.updateOne({ _id: table._id }, { $set: { seats: 9 } });
    await drain(writer);
    const newest = await ChangelogEntry.findOne({ restaurantId: restaurantId(), coll: 'tables', documentId: table._id }).sort({ seq: -1 }).lean();
    assert.equal(newest.doc.seats, 9);
  });
});

describe('shipping to the mirror', () => {
  it('copies the box document for document', async () => {
    const outcomes = await shipAll(restaurantId());
    assert.equal(outcomes.at(-1), 'IDLE');
    assert.deepEqual(await sameAsBox(restaurantId()), []);
    const lag = await shippingLag(restaurantId());
    assert.equal(lag.entriesWaiting, 0);
    assert.equal(lag.secondsBehind, 0);
  });

  it('applies a batch sent three times once (P62 section 11.5)', async () => {
    const entries = await ChangelogEntry.find({ restaurantId: restaurantId() }).sort({ seq: 1 }).limit(20).lean();
    const batch = { restaurantId: restaurantId(), epoch: 1, entries };
    const before = await digestRestaurant(restaurantId(), { db: mirrorDb });
    for (let i = 0; i < 3; i += 1) {
      const result = await applyBatch(batch, { db: mirrorDb });
      assert.equal(result.applied, 0);
      assert.equal(result.skipped, entries.length);
    }
    assert.deepEqual(compareDigests(before, await digestRestaurant(restaurantId(), { db: mirrorDb })), []);
  });

  it('rebuilds a wiped copy from seq 1 by itself (P62 section 11.4)', async () => {
    await mirrorDb.dropDatabase();
    await ReplicaCursor.collection.deleteMany({ restaurantId: restaurantId() });
    // A new sale: the next batch tells the shipper the copy is empty, and it starts over.
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: false } });
    await drain(writer);
    const outcomes = await shipAll(restaurantId());
    assert.ok(outcomes.includes('REWOUND'), outcomes.join(','));
    assert.deepEqual(await sameAsBox(restaurantId()), []);
  });

  it('refuses to advance past a missing entry, and says so (P62 section 11.6)', async () => {
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: true } });
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: false } });
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: true } });
    await drain(writer);
    const lag = await shippingLag(restaurantId());
    assert.ok(lag.entriesWaiting >= 3);
    const missing = lag.shippedSeq + 2;
    // Break the rule on purpose: the raw collection, below the append-only guard.
    await ChangelogEntry.collection.deleteOne({ restaurantId: restaurantId(), seq: missing });

    const outcomes = await shipAll(restaurantId());
    assert.equal(outcomes.at(-1), 'FAILED');
    const cursor = await ReplicaCursor.findOne({ restaurantId: restaurantId() }).lean();
    assert.equal(cursor.appliedSeq, missing - 1);
    const state = await ReplicationState.findById(REPLICATION_STATE_IDS.shipper(restaurantId())).lean();
    assert.match(state.lastError, /gap/);

    // Put it back as it was, through the raw collection, so the rest can run.
    const entry = await ChangelogEntry.collection.findOne({ restaurantId: restaurantId(), seq: missing - 1 });
    await ChangelogEntry.collection.insertOne({ ...entry, _id: new mongoose.Types.ObjectId(), seq: missing, eventId: `restored-${missing}` });
    assert.equal((await shipAll(restaurantId())).at(-1), 'IDLE');
  });
});

describe('reconciliation (P62 sections 4.3 and 11.7)', () => {
  it('matches when the copy is the box', async () => {
    assert.equal((await shipAll(restaurantId())).at(-1), 'IDLE');
    assert.equal(await reconcileOnce(restaurantId(), { businessDate: null, ...network() }), 'MATCH');
  });

  it('catches one document changed directly in the cloud, and keeps the alert for the owner', async () => {
    await mirrorDb.collection('menuitems').updateOne({ _id: new mongoose.Types.ObjectId(world.item.id) }, { $set: { priceInPaise: 1 } });
    assert.equal(await reconcileOnce(restaurantId(), { businessDate: null, ...network() }), 'MISMATCH');
    const state = await ReplicationState.findById(REPLICATION_STATE_IDS.reconcile(restaurantId())).lean();
    assert.equal(state.status, 'MISMATCH');
    assert.deepEqual(state.mismatches.map((entry) => entry.coll), ['menuitems']);
  });
});

describe('a batch from a replaced writer (P62 section 8)', () => {
  it('is quarantined, never applied, and the box stands down', async () => {
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: false } });
    await drain(writer);
    const before = await digestRestaurant(restaurantId(), { db: mirrorDb });
    const outcome = await shipOnce(restaurantId(), network({ currentEpoch: 2 }));
    assert.equal(outcome, 'FENCED');
    assert.deepEqual(compareDigests(before, await digestRestaurant(restaurantId(), { db: mirrorDb })), []);
    const quarantined = await mongoose.connection.db.collection('replicationquarantine').countDocuments({ restaurantId: restaurantId() });
    assert.equal(quarantined, 1);
    const writerState = await ReplicationState.findById(REPLICATION_STATE_IDS.WRITER).lean();
    assert.equal(writerState.fenced, true);
    // Leave the rest of the suite a writer again.
    await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.WRITER }, { $set: { fenced: false } });
    const { resetWriterStateForTest } = await import('../services/replication/writerState.js');
    resetWriterStateForTest();
  });
});

describe('back to the box after a promotion (docs/RUNBOOK.md section 7)', () => {
  it('ships only what the rebuilt box makes, at the new epoch, with nothing stale reaching the copy', async () => {
    const { adoptEpoch, resetCursor } = await import('../services/replication/epoch.js');
    const { resetWriterStateForTest } = await import('../services/replication/writerState.js');
    // Unshipped changes made before the box "died".
    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: true } });
    await drain(writer);
    const adopted = await adoptEpoch(2);
    const row = adopted.resume.find((entry) => entry.restaurantId === String(restaurantId()));
    assert.ok(row.seq > 0);
    await resetCursor(restaurantId(), row.seq);
    assert.equal((await shippingLag(restaurantId())).entriesWaiting, 0, 'the old changes are superseded, not sent');

    await request('PATCH', `/api/v1/menu-items/${world.item.id}/availability`, { token: world.tokens.OWNER, body: { isAvailable: false } });
    await drain(writer);
    const outcomes = await shipAll(restaurantId(), network({ currentEpoch: 2 }));
    assert.equal(outcomes.at(-1), 'IDLE', outcomes.join(','));
    assert.ok(!outcomes.includes('FENCED'));
    const cursor = await ReplicaCursor.findOne({ restaurantId: restaurantId() }).lean();
    assert.ok(cursor.appliedSeq > row.seq);

    await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.WRITER }, { $set: { epoch: 1 } });
    resetWriterStateForTest();
  });
});

describe('the local snapshot (P62 sections 4.2 and 11.3)', { skip: localSnapshotToolsMissing() }, () => {
  it('dumps a live database with --oplog and restores it with --oplogReplay, every collection matching', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cafezza-snapshot-'));
    const target = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    try {
      const uri = mongoose.connection.client.options.hosts.map((host) => `${host.host}:${host.port}`).join(',');
      const [archive] = await takeSnapshot({ uri: `mongodb://${uri}/?replicaSet=${mongoose.connection.client.options.replicaSet}`, dir });
      await restoreSnapshot({ uri: target.getUri(), archive });
      const restored = await mongoose.createConnection(target.getUri('restaurant-erp-test')).asPromise();
      try {
        for (const coll of mirrorCollectionNames()) {
          const mine = await mongoose.connection.db.collection(coll).countDocuments();
          const theirs = await restored.db.collection(coll).countDocuments();
          assert.equal(theirs, mine, coll);
        }
      } finally {
        await restored.close();
      }
    } finally {
      await target.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
