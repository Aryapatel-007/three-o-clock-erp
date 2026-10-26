/**
 * P63. Two-way sync end to end: the cafe PC here, in this process, and the
 * website's server as a real second process on its own database, each with its
 * own changelog, exchanging over HTTP exactly as they will in the cafe.
 *
 * Done-when items 1, 3, 4 and 5 of docs/prompts/P63-two-way-sync.md: changes
 * reach the other side, dishes added on both are all kept, a table opened on
 * both stays with the PC, nothing comes back as an echo, and both databases end
 * identical.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';

import { setRoleForTest } from '../config/deployment.js';
import { ALL_MODELS } from '../models/index.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../models/ReplicationState.js';
import { ChangelogWriter } from '../services/replication/changelogWriter.js';
import { mirrorCollectionNames } from '../services/replication/collections.js';
import { ensureDefaultPaymentMethods } from '../services/paymentMethodService.js';
import { shipOnce } from '../services/replication/shipper.js';
import { pullOnce } from '../services/sync/exchange.js';
import { docHash } from '../services/sync/hash.js';
import { setSyncModeForTest } from '../services/sync/mode.js';
import { addLines, createTable, openOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase, testDatabaseUri } from './helpers/testDatabase.js';
import { startTestServer, stopTestServer } from './helpers/testServer.js';

const SECRET = 'two-way-test-secret-0123456789abcdef0123456789';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DB = 'two-way-cloud';

let boxDb;
let cloudClient;
let cloudDb;
let cloud;
let cloudUrl;
let writer;
let floor;
let restaurantId;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function drain() {
  let quiet = 0;
  while (quiet < 2) quiet = (await writer.pump()) === 0 ? quiet + 1 : 0;
}

/** One round as the box runs it: pull the website's changes, then push its own. */
async function exchange(rounds = 3) {
  const network = { mirrorUrl: cloudUrl, secret: SECRET };
  for (let round = 0; round < rounds; round += 1) {
    // The website's change stream writer pumps every half second.
    await pause(700);
    await drain();
    for (let pulls = 0; pulls < 50; pulls += 1) {
      const outcome = await pullOnce(restaurantId, { ...network, pump: drain });
      assert.notEqual(outcome, 'FAILED', 'the pull reached the website');
      if (outcome !== 'PULLED') break;
    }
    await drain();
    for (let pushes = 0; pushes < 50; pushes += 1) {
      const outcome = await shipOnce(restaurantId, network);
      if (outcome === 'FAILED') {
        const state = await ReplicationState.findById(REPLICATION_STATE_IDS.shipper(restaurantId)).lean();
        assert.fail(`the push did not reach the website: ${state?.lastError}`);
      }
      if (outcome !== 'SHIPPED' && outcome !== 'REWOUND') break;
    }
  }
}

async function onCloud(method, urlPath, { token, body } = {}) {
  const response = await fetch(`${cloudUrl}${urlPath}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** Every shared document, by collection, as its fingerprint. */
async function fingerprints(db) {
  const all = {};
  for (const coll of mirrorCollectionNames()) {
    const docs = await db.collection(coll).find({}).sort({ _id: 1 }).toArray();
    all[coll] = docs.map((doc) => `${String(doc._id)}:${docHash(doc)}`);
  }
  return all;
}

async function assertSame() {
  const [onBox, onWebsite] = await Promise.all([fingerprints(boxDb), fingerprints(cloudDb)]);
  for (const coll of Object.keys(onBox)) {
    if (process.env.TWO_WAY_DEBUG && JSON.stringify(onWebsite[coll]) !== JSON.stringify(onBox[coll])) {
      const [a] = await boxDb.collection(coll).find({}).sort({ _id: 1 }).limit(1).toArray();
      const b = await cloudDb.collection(coll).findOne({ _id: a._id });
      process.stderr.write(`DEBUG ${coll}\nPC ${JSON.stringify(a)}\nWEB ${JSON.stringify(b)}\n`);
      for (const [side, db] of [['PC', boxDb], ['WEB', cloudDb]]) {
        const log = await db.collection('changelog').find({ documentId: a._id }).sort({ seq: 1 }).toArray();
        process.stderr.write(`${side} log ${JSON.stringify(log.map((e) => [e.seq, e.op, e.doc?.updatedAt, e.capturedAt]))}\n`);
        const sd = await db.collection('syncdocs').findOne({ documentId: a._id });
        process.stderr.write(`${side} sync base ${JSON.stringify(sd?.baseDoc?.updatedAt)} known ${sd?.knownHashes?.length} applied ${sd?.appliedHashes?.length}\n`);
      }
    }
    assert.deepEqual(onWebsite[coll], onBox[coll], `${coll} is the same on both`);
  }
}

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  setRoleForTest('BOX');
  setSyncModeForTest('TWO_WAY');
  boxDb = mongoose.connection.db;

  floor = await seedFloor();
  restaurantId = new mongoose.Types.ObjectId(floor.restaurant.id);
  floor.table2 = (await createTable(floor.tokens.OWNER, { name: 'T2' })).body.data;
  // A real cafe has its payment methods before sync starts (Z Chaat's come in the copy).
  await ensureDefaultPaymentMethods(restaurantId, { branchId: new mongoose.Types.ObjectId(floor.branch.id) });

  // Both start from the same data, as after the exact copy of the cloud.
  cloudClient = await MongoClient.connect(testDatabaseUri(CLOUD_DB));
  cloudDb = cloudClient.db(CLOUD_DB);
  for (const coll of mirrorCollectionNames()) {
    const docs = await boxDb.collection(coll).find({}).toArray();
    if (docs.length) await cloudDb.collection(coll).insertMany(docs);
  }

  cloud = spawn(process.execPath, ['--env-file=.env.test', path.join(HERE, 'helpers', 'twoWayCloudProcess.js')], {
    cwd: path.join(HERE, '..'),
    env: { ...process.env, MONGO_URI: testDatabaseUri(CLOUD_DB), DEPLOYMENT_ROLE: 'CLOUD', SYNC_MODE: 'TWO_WAY', REPLICATION_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cloudUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The website server did not start in time.')), 60_000);
    cloud.stdout.on('data', (chunk) => {
      // TWO_WAY_CLOUD_LOG=error shows the website's own log while this runs.
      if (process.env.TWO_WAY_CLOUD_LOG) process.stderr.write(chunk);
      const match = /READY (\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    cloud.once('exit', (code) => reject(new Error(`The website server stopped with ${code}.`)));
  });

  writer = new ChangelogWriter({ db: boxDb });
  await writer.start();
});

after(async () => {
  await writer?.close();
  if (cloud && cloud.exitCode === null) {
    cloud.kill('SIGTERM');
    await new Promise((resolve) => { cloud.once('exit', resolve); });
  }
  await cloudClient?.close();
  setRoleForTest(null);
  setSyncModeForTest(null);
  await stopTestServer();
  await stopTestDatabase();
});

describe('two-way sync between the cafe PC and the website', () => {
  it('starts in step: both took a baseline of the same data, and nothing changes', async () => {
    await exchange();
    await assertSame();
    assert.equal(await boxDb.collection('syncconflicts').countDocuments(), 0);
    assert.equal(await cloudDb.collection('syncconflicts').countDocuments(), 0);
  });

  it('brings an order opened on the website to the PC, in the same number run (one series, 2026-10-22)', async () => {
    const opened = await onCloud('POST', '/api/v1/orders', { token: floor.tokens.WAITER, body: { orderType: 'DINE_IN', tableId: floor.table.id } });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.ok(opened.body.data.orderNumber > 0 && opened.body.data.orderNumber < 900_001, 'no separate website run');
    floor.order = opened.body.data;
    await exchange();
    const onPc = await boxDb.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(floor.order.id) });
    assert.ok(onPc, 'the PC has the website\'s order');
    assert.equal(onPc.orderNumber, opened.body.data.orderNumber);
    await assertSame();
  });

  it('keeps the dishes added to one order on both sides before they could tell each other', async () => {
    const version = floor.order.version;
    const { request } = await import('./helpers/testServer.js');
    const onPc = await addLines(floor.tokens.WAITER, floor.order.id, { version, lines: [{ menuItemId: floor.item.id, quantity: 1, notes: 'from the PC' }] });
    assert.equal(onPc.status, 200, JSON.stringify(onPc.body));
    const onWebsite = await onCloud('POST', `/api/v1/orders/${floor.order.id}/lines`, {
      token: floor.tokens.WAITER,
      body: { version, lines: [{ menuItemId: floor.item.id, quantity: 2, notes: 'from the website' }] },
    });
    assert.equal(onWebsite.status, 200, JSON.stringify(onWebsite.body));

    await exchange(4);
    const order = await boxDb.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(floor.order.id) });
    assert.deepEqual(order.lines.map((item) => item.notes).sort(), ['from the PC', 'from the website']);
    await assertSame();
    // Screens read it through the API as before.
    const read = await request('GET', `/api/v1/orders/${floor.order.id}`, { token: floor.tokens.WAITER });
    assert.equal(read.body.data.lines.length, 2);
  });

  it('gives a table opened on both to the PC, keeps the website\'s order open, and flags it on both', async () => {
    const onPc = await openOrder(floor.tokens.WAITER, { tableId: floor.table2.id });
    assert.equal(onPc.status, 201, JSON.stringify(onPc.body));
    const onWebsite = await onCloud('POST', '/api/v1/orders', { token: floor.tokens.WAITER, body: { orderType: 'DINE_IN', tableId: floor.table2.id } });
    assert.equal(onWebsite.status, 201, JSON.stringify(onWebsite.body));

    await exchange(4);
    for (const db of [boxDb, cloudDb]) {
      const pcs = await db.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(onPc.body.data.id) });
      const websites = await db.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(onWebsite.body.data.id) });
      assert.equal(pcs.occupiesTable, true, 'the PC\'s order holds the table');
      assert.equal(websites.occupiesTable, false, 'the website\'s order gave it up');
      assert.equal(websites.status, 'OPEN');
      assert.ok(await db.collection('syncconflicts').findOne({ kind: 'SAME_SLOT' }), 'listed for staff');
    }
    await assertSame();
  });

  it('sends nothing back and forth once in step', async () => {
    await exchange(2);
    const before = [await boxDb.collection('changelog').countDocuments(), await cloudDb.collection('changelog').countDocuments()];
    await exchange(3);
    const afterRounds = [await boxDb.collection('changelog').countDocuments(), await cloudDb.collection('changelog').countDocuments()];
    assert.deepEqual(afterRounds, before);
    await assertSame();
  });

  it('catches up after time apart, both sides having changed', async () => {
    // Apart: the PC adds a table, the website changes the order's note.
    const table = await createTable(floor.tokens.OWNER, { name: 'Garden 1' });
    assert.equal(table.status, 201);
    const current = await onCloud('GET', `/api/v1/orders/${floor.order.id}`, { token: floor.tokens.WAITER });
    const noted = await onCloud('PATCH', `/api/v1/orders/${floor.order.id}/kitchen-note`, {
      token: floor.tokens.WAITER,
      body: { version: current.body.data.version, kitchenNote: 'Less spicy' },
    });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    await pause(1500);

    await exchange(3);
    assert.ok(await cloudDb.collection('tables').findOne({ nameLower: 'garden 1' }));
    assert.equal((await boxDb.collection('orders').findOne({ _id: new mongoose.Types.ObjectId(floor.order.id) })).kitchenNote, 'Less spicy');
    await assertSame();
  });
  it('loses nothing when the PC went down with bills not yet sent and the website billed meanwhile', async () => {
    // Your scenario: the PC bills, goes down before its next sync, the website takes over,
    // then the PC comes back. Every bill ends up on both, each with its own number.
    const { request } = await import('./helpers/testServer.js');
    const onPc = (method, urlPath, options) => request(method, urlPath, options);
    async function billTakeaway(call) {
      const opened = await call('POST', '/api/v1/orders', {
        token: floor.tokens.CASHIER,
        body: { orderType: 'TAKEAWAY', lines: [{ menuItemId: floor.item.id, quantity: 1 }] },
      });
      assert.equal(opened.status, 201, JSON.stringify(opened.body));
      const billed = await call('POST', '/api/v1/bills', {
        token: floor.tokens.CASHIER,
        body: { orderId: opened.body.data.id, version: opened.body.data.version, withoutKot: true },
      });
      assert.equal(billed.status, 201, JSON.stringify(billed.body));
      const bill = billed.body.data;
      const paid = await call('POST', `/api/v1/bills/${bill.id}/payments`, {
        token: floor.tokens.CASHIER,
        body: { method: 'CASH', amountInPaise: bill.grandTotalInPaise },
      });
      assert.equal(paid.status, 200, JSON.stringify(paid.body));
      return bill;
    }

    await exchange(2);
    const conflictsBefore = await boxDb.collection('syncconflicts').countDocuments();
    // The PC bills; no sync runs after, as if it went down.
    const pcBills = [await billTakeaway(onPc), await billTakeaway(onPc)];
    await drain();
    // The website takes three bills while the PC is away.
    const websiteBills = [];
    for (let i = 0; i < 3; i += 1) websiteBills.push(await billTakeaway(onCloud));
    // One series (2026-10-22): the website, not knowing the PC's last two bills, used their numbers.
    const pcNumbers = new Set(pcBills.map((bill) => bill.billNumber));
    assert.ok(websiteBills.some((bill) => pcNumbers.has(bill.billNumber)), 'the website reused a number the PC had used');

    // The PC is back.
    await pause(1500);
    await exchange(4);
    // Every bill on both sides, the same on both. The PC's keep their numbers; a website
    // bill whose number the PC had used took the next free one in the same series.
    const final = [];
    for (const bill of [...pcBills, ...websiteBills]) {
      const onBox = await boxDb.collection('bills').findOne({ _id: new mongoose.Types.ObjectId(bill.id) });
      const onCloud = await cloudDb.collection('bills').findOne({ _id: new mongoose.Types.ObjectId(bill.id) });
      assert.ok(onBox, `${bill.billNumber} is on the PC`);
      assert.ok(onCloud, `${bill.billNumber} is on the website`);
      assert.equal(onBox.billNumber, onCloud.billNumber, 'the same number on both');
      assert.equal(onBox.status, 'PAID');
      final.push({ issued: bill.billNumber, now: onBox.billNumber, sequence: onBox.billSequence, fromPc: pcBills.includes(bill) });
    }
    for (const bill of final.filter((row) => row.fromPc)) assert.equal(bill.now, bill.issued, 'the PC keeps its number');
    const sequences = final.map((row) => row.sequence).sort((a, b) => a - b);
    assert.equal(new Set(final.map((row) => row.now)).size, final.length, 'no number used twice');
    assert.deepEqual(sequences, sequences.map((_, i) => sequences[0] + i), 'the series is gap-free');

    // Each renumbered bill is listed for a person, to reprint; the takeaway orders behind
    // them were renumbered too, and say so. Nothing else is listed: no counter, nothing
    // left uncopied.
    const renumbered = final.filter((row) => row.now !== row.issued);
    assert.ok(renumbered.length > 0);
    const fresh = await boxDb.collection('syncconflicts').find({}).sort({ _id: 1 }).skip(conflictsBefore).toArray();
    const listed = JSON.stringify(fresh.map((c) => ({ coll: c.coll, detail: c.detail })));
    const billNotes = fresh.filter((c) => c.coll === 'bills');
    assert.equal(billNotes.length, renumbered.length, listed);
    for (const conflict of billNotes) assert.match(conflict.detail, /Reprint the website's bill/);
    for (const conflict of fresh.filter((c) => c.coll !== 'bills')) {
      assert.equal(conflict.coll, 'orders', listed);
      assert.match(conflict.detail, /^Order \d+ was used on the cafe PC and on the website/, listed);
    }
    await assertSame();
  });
});
