/**
 * Start fresh on the cafe PC (box/windows/start-fresh.mjs, 2026-10-28), against
 * the real two-way pair: the PC in this process, the website's server as its own
 * process on its own database, as in twoWaySyncE2e.test.js.
 *
 * It reproduces Three O'Clock on 28 October: the PC made a second restaurant
 * whose owner had the real owner's phone, so sync switched the real owner off;
 * both sides took test bills. After the run on the PC, and one more on the
 * website for what it held back, both sides hold the menu, tables and staff,
 * no trading records, no duplicate, and the moved owner signs in on both. The
 * next bill is 000001 on both.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';

import { KEEP_COLLECTIONS, WIPE_COLLECTIONS, assertLocal, parseArgs, startFresh } from '../../box/windows/start-fresh.mjs';
import { setRoleForTest } from '../config/deployment.js';
import { ALL_MODELS } from '../models/index.js';
import { REPLICATION } from '../config/replication.js';
import { ChangelogWriter } from '../services/replication/changelogWriter.js';
import { mirrorCollectionNames } from '../services/replication/collections.js';
import { ensureDefaultPaymentMethods } from '../services/paymentMethodService.js';
import { shipOnce } from '../services/replication/shipper.js';
import { pullOnce } from '../services/sync/exchange.js';
import { setSyncModeForTest } from '../services/sync/mode.js';
import { seedFloor } from './helpers/m2Fixtures.js';
import { seedFullRestaurant } from './helpers/seed.js';
import { startTestDatabase, stopTestDatabase, testDatabaseUri } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const SECRET = 'start-fresh-test-secret-0123456789abcdef0123456';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DB = 'start-fresh-cloud';
const KEEP = "Three O'Clock Cafe";
const DUPLICATE = 'Three Oclock';
const OWNER_PHONE = '9000004001';
const OWNER_PASSWORD = 'dhruv-password-1';

let boxDb;
let cloudClient;
let cloudDb;
let cloud;
let cloudUrl;
let writer;
let floor;
let keepId;
let duplicateId;
let backupRoot;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function drain() {
  let quiet = 0;
  while (quiet < 2) quiet = (await writer.pump()) === 0 ? quiet + 1 : 0;
}

/** As the box's round runs it: pull for each restaurant on the PC, then push every changelog. */
async function exchange(rounds = 3) {
  const network = { mirrorUrl: cloudUrl, secret: SECRET };
  for (let round = 0; round < rounds; round += 1) {
    await pause(700);
    await drain();
    for (const { _id } of await boxDb.collection('restaurants').find({}, { projection: { _id: 1 } }).toArray()) {
      for (let pulls = 0; pulls < 50; pulls += 1) {
        const outcome = await pullOnce(_id, { ...network, pump: drain });
        assert.notEqual(outcome, 'FAILED', 'the pull reached the website');
        if (outcome !== 'PULLED') break;
      }
    }
    await drain();
    for (const restaurantId of await boxDb.collection('changelog').distinct('restaurantId')) {
      for (let pushes = 0; pushes < 50; pushes += 1) {
        const outcome = await shipOnce(restaurantId, network);
        if (outcome === 'FAILED') {
          const state = await boxDb.collection('replicationstate').findOne({ _id: `shipper:${restaurantId}` });
          assert.fail(`the push for ${restaurantId} did not reach the website: ${state?.lastError}`);
        }
        if (outcome !== 'SHIPPED' && outcome !== 'REWOUND') break;
      }
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

async function billTakeaway(call, token) {
  const opened = await call('POST', '/api/v1/orders', {
    token, body: { orderType: 'TAKEAWAY', lines: [{ menuItemId: floor.item.id, quantity: 1 }] },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const billed = await call('POST', '/api/v1/bills', {
    token, body: { orderId: opened.body.data.id, version: opened.body.data.version, withoutKot: true },
  });
  assert.equal(billed.status, 201, JSON.stringify(billed.body));
  const paid = await call('POST', `/api/v1/bills/${billed.body.data.id}/payments`, {
    token, body: { method: 'CASH', amountInPaise: billed.body.data.grandTotalInPaise },
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  return billed.body.data;
}

const signIn = (call) => call('POST', '/api/v1/auth/login', { body: { phone: OWNER_PHONE, password: OWNER_PASSWORD } });

/** What a side holds of the kept restaurant's trading, and of the duplicate. */
async function leftovers(db) {
  const left = {};
  for (const coll of WIPE_COLLECTIONS) {
    const filter = { restaurantId: keepId };
    if (coll === 'accountentries') filter.type = { $ne: 'OPENING' };
    if (coll === 'stockmovements') filter.type = { $in: ['DEDUCTION', 'CANCELLATION_RETURN'] };
    const n = await db.collection(coll).countDocuments(filter);
    if (n) left[coll] = n;
  }
  for (const coll of [...KEEP_COLLECTIONS, ...WIPE_COLLECTIONS]) {
    const n = await db.collection(coll).countDocuments(coll === 'restaurants' ? { _id: duplicateId } : { restaurantId: duplicateId });
    if (n) left[`duplicate ${coll}`] = n;
  }
  return left;
}

const run = (db, extra = {}) => startFresh(db, parseArgs([
  '--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--remove', DUPLICATE, '--move-owner',
  '--confirm-bills', '10', '--apply', '--backup-dir', path.join(backupRoot, String(Date.now())),
  ...(extra.args ?? []),
]));

before(async () => {
  backupRoot = await mkdtemp(path.join(os.tmpdir(), 'start-fresh-'));
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  setRoleForTest('BOX');
  setSyncModeForTest('TWO_WAY');
  boxDb = mongoose.connection.db;

  floor = await seedFloor();
  keepId = new mongoose.Types.ObjectId(floor.restaurant.id);
  await boxDb.collection('restaurants').updateOne({ _id: keepId }, { $set: { name: KEEP } });
  await ensureDefaultPaymentMethods(keepId, { branchId: new mongoose.Types.ObjectId(floor.branch.id) });

  // The duplicate the PC made, its owner on the real owner's phone; sync then switched the real owner off.
  const duplicate = await seedFullRestaurant({ name: DUPLICATE, ownerName: 'Dhruv Soni', ownerPhone: OWNER_PHONE, password: OWNER_PASSWORD });
  duplicateId = duplicate.restaurant._id;
  await ensureDefaultPaymentMethods(duplicateId, { branchId: duplicate.branch._id });
  await boxDb.collection('users').updateOne(
    { restaurantId: keepId, role: 'OWNER' },
    { $set: { phone: `${OWNER_PHONE}-website`, isActive: false } },
  );

  // Test bills on the PC, before the website joined.
  await billTakeaway(request, floor.tokens.CASHIER);
  await billTakeaway(request, floor.tokens.CASHIER);

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
  if (backupRoot) await rm(backupRoot, { recursive: true, force: true });
});

describe('start fresh before go-live', () => {
  it('names every synced collection exactly once, as set-up to keep or trading to clear', () => {
    const named = [...KEEP_COLLECTIONS, ...WIPE_COLLECTIONS];
    assert.equal(new Set(named).size, named.length, 'no collection named twice');
    const synced = ALL_MODELS.filter((model) => REPLICATION[model.modelName]?.sync === 'MIRROR').map((model) => model.collection.collectionName);
    assert.deepEqual([...named].sort(), [...synced].sort(), 'a new synced model needs a decision here');
  });

  it('refuses without a count of bills, with more bills than agreed, or on a database that is not this PC', async () => {
    assert.throws(() => parseArgs(['--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--apply', '--backup-dir', 'b']), /confirm-bills/);
    assert.throws(() => parseArgs(['--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--move-owner']), /--move-owner takes the owner/);
    await assert.rejects(startFresh(boxDb, parseArgs([
      '--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--remove', DUPLICATE, '--move-owner',
      '--confirm-bills', '1', '--apply', '--backup-dir', backupRoot,
    ])), /2 bills, more than the 1/);
    await assert.rejects(startFresh(boxDb, parseArgs(['--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--remove', DUPLICATE])), /no owner login switched on/);
    assert.throws(() => assertLocal('mongodb+srv://user:pw@cluster0.example.mongodb.net/db', false), /not this PC/);
    assert.doesNotThrow(() => assertLocal('mongodb+srv://user:pw@cluster0.example.mongodb.net/db', true));
    assert.equal(await boxDb.collection('bills').countDocuments({ restaurantId: keepId }), 2, 'nothing was changed');
  });

  it('says what it would do and changes nothing without --apply', async () => {
    const summary = await startFresh(boxDb, parseArgs(['--uri', 'mongodb://127.0.0.1/x', '--keep', KEEP, '--remove', DUPLICATE, '--move-owner']));
    assert.equal(summary.applied, false);
    assert.equal(summary.bills, 2);
    assert.equal(summary.owner.name, 'Dhruv Soni');
    assert.equal(summary.remove.restaurants, 1);
    assert.equal(await boxDb.collection('restaurants').countDocuments({ _id: duplicateId }), 1);
  });

  it('runs on the PC while both sides traded, and the website ends clean too', async () => {
    await exchange();
    // The website took a bill too, and the duplicate's owner signed in there.
    assert.equal((await signIn(onCloud)).status, 200, 'the duplicate owner signs in on the website before');
    await billTakeaway(onCloud, floor.tokens.CASHIER);
    await exchange();
    assert.equal(await boxDb.collection('bills').countDocuments({ restaurantId: keepId }), 3, 'the PC has all three test bills');

    const onPc = await run(boxDb);
    assert.equal(onPc.applied, true);
    assert.equal(onPc.cleared.bills, 3);
    assert.deepEqual(await leftovers(boxDb), {}, 'nothing left on the PC');
    await exchange(4);

    // What the website held back (changed there since both last agreed) is cleared there the same way.
    const onWebsite = await run(cloudDb, { args: ['--remove-id', onPc.duplicateId] });
    assert.equal(onWebsite.applied, true);
    await exchange(4);
    assert.deepEqual(await leftovers(cloudDb), {}, 'nothing left on the website');
    assert.deepEqual(await leftovers(boxDb), {}, 'nothing came back to the PC');

    // Set-up is untouched on both.
    for (const db of [boxDb, cloudDb]) {
      assert.equal(await db.collection('menuitems').countDocuments({ restaurantId: keepId }), 1);
      assert.equal(await db.collection('tables').countDocuments({ restaurantId: keepId }), 1);
      assert.equal(await db.collection('paymentmethods').countDocuments({ restaurantId: keepId }) > 0, true);
      const owners = await db.collection('users').find({ restaurantId: keepId, role: 'OWNER' }).toArray();
      assert.equal(owners.length, 1);
      assert.equal(owners[0].phone, OWNER_PHONE);
      assert.equal(owners[0].name, 'Dhruv Soni');
      assert.equal(owners[0].isActive, true);
    }
  });

  it('lets the moved owner sign in on both, into the kept restaurant, and the next bill is 000001 on both', async () => {
    for (const call of [request, onCloud]) {
      const signed = await signIn(call);
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.equal(signed.body.data.restaurant.name, KEEP);
    }
    const bill = await billTakeaway(request, floor.tokens.CASHIER);
    assert.match(bill.billNumber, /\/000001$/);
    await exchange(3);
    const there = await cloudDb.collection('bills').findOne({ _id: new mongoose.Types.ObjectId(bill.id) });
    assert.equal(there?.billNumber, bill.billNumber);
    assert.equal(await cloudDb.collection('bills').countDocuments({ restaurantId: keepId }), 1);
  });
});
