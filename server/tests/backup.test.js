/**
 * P54: full copies, the change diary, restore and verify, on the in-memory
 * replica set and a fake B2. docs/prompts/P54-constant-backups.md Part I.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { BACKUP_KINDS, BACKUP_STATUSES, BackupRun } from '../models/BackupRun.js';
import { BACKUP_STATE_IDS, BackupState, FULL_COPIES } from '../models/BackupState.js';
import { ALL_MODELS } from '../models/index.js';
import { ChangeDiary } from '../services/backup/journalService.js';
import { restoreBackup, eventsToReplay, parseListing, planRestore } from '../services/backup/restoreService.js';
import { collectionsToCopy, currentFullCopies, folderFor, fullCopiesFor, isDue, maybeRunSnapshot, plainError, runSnapshot } from '../services/backup/snapshotService.js';
import { s3Client } from '../services/backup/storage.js';
import { checkCounts, checkInvoiceSeries, verifyDatabase } from '../services/backup/verifyService.js';
import { computeDayFigures } from '../services/dayFiguresService.js';
import { parseArgs } from '../scripts/backupRestore.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { FAKE_BUCKET, READ_KEY, startFakeS3, WRITE_KEY } from './helpers/fakeS3.js';
import { buildGoldenDay, GOLDEN_DATE, ist } from './helpers/goldenDay.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase, testDatabaseUri } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const { EJSON, Timestamp } = mongoose.mongo.BSON;
const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_DB = 'restaurant-erp-test';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let fake;
let key;
let ctx;
let drill;
let restoreCount = 0;

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  fake = await startFakeS3();
  key = randomBytes(32).toString('base64');
  const storageWith = (credentials) => ({ bucket: FAKE_BUCKET, client: s3Client({ endpoint: fake.endpoint, region: 'us-west-004', ...credentials }) });
  ctx = { db: mongoose.connection.db, storage: storageWith(WRITE_KEY), key, release: 'test' };
  drill = storageWith(READ_KEY);
});

after(async () => {
  await fake.stop();
  await stopTestServer();
  await stopTestDatabase();
});

async function freshStart() {
  resetClockForTests();
  await clearTestDatabase();
  // The tests' own scratch collections, which no model owns.
  for (const { name } of await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()) {
    if (!name.startsWith('system.')) await mongoose.connection.db.collection(name).deleteMany({});
  }
  await BackupRun.collection.deleteMany({});
  await BackupState.collection.deleteMany({});
  fake.state.objects.clear();
  fake.state.failUploads = 0;
}

afterEach(() => resetClockForTests());

/** A new, empty database name on the test server. */
const newTarget = () => testDatabaseUri(`restore-${(restoreCount += 1)}`);
const restore = (options) => restoreBackup({ storage: drill, keys: [key], liveUri: testDatabaseUri(MAIN_DB), indexes: false, ...options });

/** Runs `fn` with the default connection pointed at another database, then back. */
async function onDatabase(uri, fn) {
  await mongoose.disconnect();
  await mongoose.connect(uri);
  try {
    return await fn();
  } finally {
    await mongoose.disconnect();
    await mongoose.connect(testDatabaseUri(MAIN_DB));
    ctx.db = mongoose.connection.db;
  }
}

/** Every document of every copied collection, canonical, in _id order. */
async function everything(db) {
  const out = {};
  for (const name of await collectionsToCopy(db)) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = docs.map((doc) => EJSON.stringify(doc, { relaxed: false }));
  }
  return out;
}

const targetDb = (uri) => mongoose.createConnection(uri).asPromise();

describe('a full copy of the golden day', () => {
  let target;
  let original;
  let originalFigures;
  let report;

  before(async () => {
    await freshStart();
    const golden = await buildGoldenDay();
    setClockForTests(ist('09:00', '2026-09-27'));
    const closed = await request('POST', '/api/v1/day-close', {
      token: golden.tokens.MANAGER,
      body: { businessDate: GOLDEN_DATE, countedCashInPaise: 340000, note: 'Four rupees short, coins' },
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    resetClockForTests();
    const req = { restaurantId: String(golden.restaurant._id), branchId: String(golden.branch._id) };
    original = await everything(mongoose.connection.db);
    originalFigures = await computeDayFigures(req, GOLDEN_DATE);
    const copy = await runSnapshot(ctx);
    assert.equal(copy.status, 'OK');
    assert.equal(copy.folder, 'monthly', 'the first copy of a month is the monthly one');
    target = newTarget();
    report = await restore({ targetUri: target, at: null });
  });

  it('restores identical documents in every collection but sessions, ids, Dates and Timestamps included', async () => {
    const connection = await targetDb(target);
    const restored = await everything(connection.db);
    await connection.close();
    assert.ok(Object.keys(original).length > 10);
    assert.equal('refreshtokens' in restored, false, 'sessions are never backed up');
    for (const name of Object.keys(original)) assert.deepEqual(restored[name] ?? [], original[name], name);
  });

  it('gives the same day figures for 26 September, and C12, the invoice series and the counts all pass', async () => {
    const restoredFigures = await onDatabase(target, async () => {
      const req = { restaurantId: String((await mongoose.connection.db.collection('restaurants').findOne({}))._id), branchId: String((await mongoose.connection.db.collection('branches').findOne({}))._id) };
      const figures = await computeDayFigures(req, GOLDEN_DATE);
      const verified = await verifyDatabase({ expected: report.expected });
      assert.equal(verified.ok, true, JSON.stringify(verified.sections));
      return figures;
    });
    assert.deepEqual(EJSON.stringify(restoredFigures), EJSON.stringify(originalFigures));
  });

  it('verify fails when a bill number goes missing, and when a count is off by one, each broken on purpose', async () => {
    await onDatabase(target, async () => {
      const bills = mongoose.connection.db.collection('bills');
      const middle = await bills.find({}).sort({ billSequence: 1 }).skip(2).limit(1).next();
      await bills.deleteOne({ _id: middle._id });
      const series = await checkInvoiceSeries();
      assert.ok(series.some((problem) => /is missing from series/.test(problem)), series.join('; '));
      const counts = await checkCounts(report.expected);
      assert.ok(counts.some((problem) => /^bills has/.test(problem)), counts.join('; '));
    });
  });
});

describe('the change diary', () => {
  beforeEach(freshStart);

  it('rebuilds the moment between two changes exactly, and the newest moment, from a monthly copy and the diary alone', async () => {
    const diary = new ChangeDiary(ctx);
    assert.equal(await diary.start(), 'FIRST');
    const copy = await runSnapshot(ctx);
    assert.equal(copy.folder, 'monthly');
    const scratch = mongoose.connection.db.collection('scratch');
    await scratch.insertOne({ _id: 1, value: 'a' });
    await scratch.updateOne({ _id: 1 }, { $set: { value: 'b' } });
    await diary.pump();
    await sleep(30);
    const between = new Date();
    await sleep(30);
    await scratch.insertOne({ _id: 2, value: 'c' });
    await scratch.deleteOne({ _id: 1 });
    await diary.pump();
    const flushed = await diary.flush();
    assert.equal(flushed.status, 'OK');
    assert.equal(flushed.eventCount, 4);
    assert.equal([...fake.state.objects.keys()].some((name) => name.startsWith('snapshots/daily/') || name.startsWith('snapshots/6h/')), false, 'only the monthly copy and the diary');

    const atBetween = newTarget();
    await restore({ targetUri: atBetween, at: between });
    let connection = await targetDb(atBetween);
    assert.deepEqual(await connection.db.collection('scratch').find({}).toArray(), [{ _id: 1, value: 'b' }]);
    await connection.close();

    const atLatest = newTarget();
    await restore({ targetUri: atLatest, at: null });
    connection = await targetDb(atLatest);
    assert.deepEqual(await connection.db.collection('scratch').find({}).toArray(), [{ _id: 2, value: 'c' }]);
    await connection.close();

    // The same diary file twice changes nothing more.
    const [diaryKey] = [...fake.state.objects.keys()].filter((name) => name.endsWith('.jrn.gz.enc'));
    fake.state.objects.set(diaryKey.replace('journal/', 'journal/again/'), fake.state.objects.get(diaryKey));
    const twice = newTarget();
    await restore({ targetUri: twice, at: null });
    connection = await targetDb(twice);
    assert.deepEqual(await connection.db.collection('scratch').find({}).toArray(), [{ _id: 2, value: 'c' }]);
    await connection.close();
    await diary.stop();
  });

  it("puts a transaction's events in one file, and a time inside one leaves it out whole", async () => {
    const diary = new ChangeDiary(ctx);
    await diary.start();
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await mongoose.connection.db.collection('t1').insertOne({ _id: 'a' }, { session });
      await mongoose.connection.db.collection('t2').insertOne({ _id: 'b' }, { session });
    });
    await session.endSession();
    await diary.pump();
    const waiting = diary.waiting.map((event) => EJSON.parse(event.line, { relaxed: false }));
    const inTransaction = waiting.filter((event) => event.lsid);
    assert.deepEqual(inTransaction.map((event) => event.coll).sort(), ['t1', 't2']);
    // The stream starts at its own start time inclusive, so the change just before may come too: harmless.
    const run = await diary.flush();
    assert.equal(run.eventCount, waiting.length, 'every waiting change, the whole transaction with them, in one file');
    assert.equal(await BackupRun.countDocuments({ kind: BACKUP_KINDS.JOURNAL, status: BACKUP_STATUSES.OK }), 1);
    await diary.stop();

    const ts = (t, i = 1) => new Timestamp({ t, i });
    const lsid = { id: 'session-1' };
    const at = (seconds) => new Date(seconds * 1000);
    const events = [
      { op: 'insert', coll: 'x', _id: 1, doc: { _id: 1 }, clusterTime: ts(100), wallTime: at(100) },
      { op: 'insert', coll: 'x', _id: 2, doc: { _id: 2 }, clusterTime: ts(101), wallTime: at(101), lsid, txnNumber: 7 },
      { op: 'insert', coll: 'x', _id: 3, doc: { _id: 3 }, clusterTime: ts(103), wallTime: at(103), lsid, txnNumber: 7 },
    ];
    const replay = eventsToReplay(events, ts(1), at(102));
    assert.deepEqual(replay.events.map((event) => event._id), [1]);
    assert.equal(replay.transactionsLeftOut, 1);
  });

  it('a resume token that cannot be resumed sets gapSince, records the gap, and asks for a full copy', async () => {
    // A test server never trims its oplog, so an old token would still resume
    // there; a token it cannot read stands in for a place Atlas has moved past.
    await BackupState.collection.insertOne({ _id: BACKUP_STATE_IDS.JOURNAL, resumeToken: { _data: 'not-a-resume-token' }, lastEventAt: new Date(Date.now() - 3600_000), gapSince: null, pendingGapMarkers: [] });
    let asked = 0;
    const diary = new ChangeDiary(ctx, { onLostPlace: () => (asked += 1) });
    assert.equal(await diary.start(), 'LOST');
    assert.equal(asked, 1);
    const state = await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean();
    assert.ok(state.gapSince);
    const gapRun = await BackupRun.findOne({ kind: BACKUP_KINDS.JOURNAL, status: BACKUP_STATUSES.FAILED }).lean();
    assert.match(gapRun.error, /lost its place between .* and .*; a full copy was taken/);
    assert.ok([...fake.state.objects.keys()].some((name) => name.endsWith('.gap.enc')), 'the gap is in the bucket too');

    // The copy it asked for closes the gap, and the diary watches from it.
    const copy = await runSnapshot(ctx);
    await diary.recoverFrom(copy);
    assert.equal((await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean()).gapSince, null);
    await diary.stop();
  });

  it('retries a failed upload without losing the changes', async () => {
    let now = Date.now();
    const diary = new ChangeDiary(ctx, { now: () => new Date(now) });
    await diary.start();
    await mongoose.connection.db.collection('scratch').insertOne({ _id: 'kept' });
    await diary.pump();
    fake.state.failUploads = 1;
    assert.equal(await diary.flush(), null);
    assert.equal(diary.status().waiting, 1, 'the change is still waiting');
    assert.equal(await BackupRun.countDocuments({ kind: BACKUP_KINDS.JOURNAL, status: BACKUP_STATUSES.FAILED }), 1);
    assert.equal(diary.flushDue(), false, 'not before the retry time');
    now += 6 * 60_000;
    assert.equal(diary.flushDue(), true);
    const run = await diary.flush();
    assert.equal(run.status, 'OK');
    assert.equal(diary.status().waiting, 0);
    await diary.stop();
  });

  it('stops at 20 MB waiting while storage fails, sets gapSince, and never grows past it', async () => {
    let asked = 0;
    const diary = new ChangeDiary(ctx, { onLostPlace: () => (asked += 1) });
    await diary.start();
    fake.state.failUploads = 1000;
    const big = 'x'.repeat(1024 * 1024);
    let peak = 0;
    for (let index = 0; index < 24 && diary.status().watching; index += 1) {
      await mongoose.connection.db.collection('bulky').insertOne({ _id: index, big });
      await diary.pump();
      peak = Math.max(peak, diary.status().waitingBytes);
      if (index === 3) assert.equal(await diary.flush(), null, 'uploads are failing');
    }
    assert.ok(peak <= 20 * 1024 ** 2, `peak ${peak}`);
    assert.equal(diary.status().waiting, 0);
    assert.equal(diary.status().watching, false);
    assert.equal(asked, 1);
    assert.ok((await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean()).gapSince);
    await mongoose.connection.db.collection('bulky').drop();
  });
});

describe('restore refuses', () => {
  before(async () => {
    await freshStart();
    await mongoose.connection.db.collection('scratch').insertOne({ _id: 'one' });
    await runSnapshot(ctx);
  });

  it('a target that is not empty, the live database, and no target', async () => {
    const target = newTarget();
    const connection = await targetDb(target);
    await connection.db.collection('anything').insertOne({ x: 1 });
    await connection.close();
    await assert.rejects(restore({ targetUri: target, at: null }), /not empty: anything has documents/);
    await assert.rejects(restore({ targetUri: testDatabaseUri(MAIN_DB), at: null }), /the live database/);
    await assert.rejects(restore({ targetUri: null, at: null }), /There is no default target/);
  });

  it('an unknown argument, a missing --to and a missing --at', () => {
    assert.throws(() => parseArgs(['--at', 'latest', '--to', 'mongodb://x/y', '--force']), /Unknown argument --force/);
    assert.throws(() => parseArgs(['--at', 'latest']), /There is no default target/);
    assert.throws(() => parseArgs(['--to', 'mongodb://x/y']), /Say when to restore to/);
    assert.equal(parseArgs(['--at', '2026-10-14 15:30', '--to', 'mongodb://x/y']).at.toISOString(), '2026-10-14T10:00:00.000Z');
  });

  it('a wrong key and a changed byte, writing nothing to the target', async () => {
    const target = newTarget();
    await assert.rejects(restoreBackup({ storage: drill, keys: [randomBytes(32).toString('base64')], targetUri: target, liveUri: testDatabaseUri(MAIN_DB), indexes: false }), /made with a different key/);
    const [copyKey] = [...fake.state.objects.keys()].filter((name) => name.startsWith('snapshots/'));
    const object = fake.state.objects.get(copyKey);
    const changed = Buffer.from(object.body);
    changed[40] ^= 1;
    fake.state.objects.set(copyKey, { ...object, body: changed });
    await assert.rejects(restore({ targetUri: target, at: null }), /changed or damaged/);
    fake.state.objects.set(copyKey, object);
    const connection = await targetDb(target);
    assert.deepEqual(await connection.db.listCollections().toArray(), [], 'nothing was written');
    await connection.close();
  });

  it('a time inside a gap, naming the nearest times, until a full copy closes it', async () => {
    const diary = new ChangeDiary(ctx);
    await diary.loseYourPlace(new Date(), 'a test');
    await assert.rejects(restore({ targetUri: newTarget(), at: null }), /has a gap from .* The nearest times it can restore to: just before/);
    await sleep(1100);
    await runSnapshot(ctx);
    const report = await restore({ targetUri: newTarget(), at: null });
    assert.ok(report.counts.scratch === 1);
  });
});

describe('full copies', () => {
  beforeEach(freshStart);

  it('go to monthly on the first copy of a month, daily on the first of a day, and 6h otherwise', async () => {
    assert.equal(folderFor({ hasMonthlyThisMonth: false, hasDailyToday: false }), 'monthly');
    setClockForTests(new Date('2026-11-01T00:00:30Z'));
    assert.match((await runSnapshot(ctx)).objectKey, /^snapshots\/monthly\/2026\/11\/2026-11-01T00-00-30Z\.snap\.gz\.enc$/);
    setClockForTests(new Date('2026-11-02T00:00:30Z'));
    assert.match((await runSnapshot(ctx)).objectKey, /^snapshots\/daily\/2026\/11\/02\//);
    setClockForTests(new Date('2026-11-02T06:00:30Z'));
    assert.match((await runSnapshot(ctx)).objectKey, /^snapshots\/6h\/2026\/11\/02\//);
  });

  it('take one at a time, and a RUNNING one older than 30 minutes becomes FAILED', async () => {
    const holder = await BackupRun.create({ kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.RUNNING, startedAt: new Date() });
    assert.deepEqual(await runSnapshot(ctx), { skipped: 'RUNNING' });
    await BackupRun.updateOne({ _id: holder._id }, { $set: { startedAt: new Date(Date.now() - 31 * 60_000) } });
    assert.equal((await runSnapshot(ctx)).status, 'OK');
    const old = await BackupRun.findById(holder._id).lean();
    assert.equal(old.status, 'FAILED');
    assert.equal(old.error, 'Interrupted');
  });

  it('after a failed copy wait 2, 10, 30 minutes, then an hour, before reading the database again', async () => {
    fake.state.failUploads = 1000;
    const start = new Date('2026-11-03T06:40:00Z');
    const at = (minutes) => new Date(start.getTime() + minutes * 60_000);
    const tries = async (minutes) => {
      setClockForTests(at(minutes));
      const before = await BackupRun.countDocuments({ status: BACKUP_STATUSES.FAILED });
      await maybeRunSnapshot(ctx).catch(() => null);
      return (await BackupRun.countDocuments({ status: BACKUP_STATUSES.FAILED })) > before;
    };
    assert.equal(await tries(0), true, 'the first copy is tried at once');
    assert.equal(await tries(1), false);
    assert.equal(await tries(2), true, '2 minutes after the first failure');
    assert.equal(await tries(11), false);
    assert.equal(await tries(12), true, '10 minutes after the second');
    assert.equal(await tries(41), false);
    assert.equal(await tries(42), true, '30 minutes after the third');
    assert.equal(await tries(101), false);
    assert.equal(await tries(102), true, 'an hour after the fourth');
    assert.equal(await tries(161), false);
    assert.equal(await tries(162), true, 'and every hour after that');

    fake.state.failUploads = 0;
    setClockForTests(at(222));
    assert.equal((await maybeRunSnapshot(ctx)).status, 'OK', 'once storage works the next try succeeds');
    assert.equal(await maybeRunSnapshot(ctx), null, 'and copies go back to their slots');
  });

  it("keep Backblaze's key ID out of the error the owner reads", () => {
    assert.equal(plainError(new Error("The key 'made-up-key-id' is not valid")), 'The storage key is not valid');
    assert.equal(plainError(new Error('Signature validation failed')), 'Signature validation failed');
  });

  it('slow down to once a day past 4 GB a week, and speed up again under 3 GB', async () => {
    assert.equal(fullCopiesFor(FULL_COPIES.EVERY_6_HOURS, 200 * 1024 ** 2), FULL_COPIES.DAILY);
    assert.equal(fullCopiesFor(FULL_COPIES.DAILY, 120 * 1024 ** 2), FULL_COPIES.DAILY, 'between 3 and 4 GB it stays');
    assert.equal(fullCopiesFor(FULL_COPIES.DAILY, 100 * 1024 ** 2), FULL_COPIES.EVERY_6_HOURS);
    const midnight = new Date('2026-11-05T00:00:10Z');
    assert.equal(isDue(new Date('2026-11-05T06:00:10Z'), midnight, FULL_COPIES.DAILY), false, 'only the 5:30 AM copy');
    assert.equal(isDue(new Date('2026-11-05T06:00:10Z'), midnight, FULL_COPIES.EVERY_6_HOURS), true);
    assert.equal(isDue(new Date('2026-11-06T00:00:10Z'), midnight, FULL_COPIES.DAILY), true);

    await BackupRun.create({ kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.OK, startedAt: midnight, objectKey: 'snapshots/x', databaseBytes: 200 * 1024 ** 2 });
    assert.equal(await currentFullCopies(new Date('2026-11-05T06:00:10Z')), FULL_COPIES.DAILY);
    assert.match((await BackupRun.findOne({ objectKey: null, error: /once a day/ }).lean()).error, /more than 4 GB a week/);
    await BackupRun.create({ kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.OK, startedAt: new Date('2026-11-06T00:00:10Z'), objectKey: 'snapshots/y', databaseBytes: 100 * 1024 ** 2 });
    assert.equal(await currentFullCopies(new Date('2026-11-06T06:00:10Z')), FULL_COPIES.EVERY_6_HOURS);
  });

  it('plan a restore six months back from a monthly copy and the diary alone', () => {
    const listing = parseListing([
      { key: 'snapshots/monthly/2026/04/2026-04-01T00-00-12Z.snap.gz.enc', bytes: 10 },
      { key: 'journal/2026/04/01/2026-04-01T00-05-00.000Z_2026-04-01T00-09-59.000Z.jrn.gz.enc', bytes: 1 },
      { key: 'journal/2026/04/14/2026-04-14T10-00-00.000Z_2026-04-14T10-04-00.000Z.jrn.gz.enc', bytes: 1 },
      { key: 'journal/2026/04/20/2026-04-20T10-00-00.000Z_2026-04-20T10-04-00.000Z.jrn.gz.enc', bytes: 1 },
      { key: 'snapshots/monthly/2026/10/2026-10-01T00-00-12Z.snap.gz.enc', bytes: 10 },
    ]);
    const plan = planRestore(listing, new Date('2026-04-15T12:00:00Z'));
    assert.equal(plan.snapshot.key, 'snapshots/monthly/2026/04/2026-04-01T00-00-12Z.snap.gz.enc');
    assert.equal(plan.journals.length, 2);
  });
});

describe('secrets and settings', () => {
  it('env.js refuses production with backups on and a variable missing, and the placeholder key', () => {
    const run = (extra) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config/env.js')"], {
        cwd: SERVER_DIR,
        env: { ...process.env, NODE_ENV: 'production', TRUST_PROXY: '1', INTEGRATION_SECRETS_KEY: randomBytes(32).toString('base64'), BACKUP_ENABLED: 'on', ...extra },
        encoding: 'utf8',
        timeout: 20_000,
      });
    const missing = run({ BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_S3_BUCKET: '' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /BACKUP_S3_BUCKET must be set when BACKUP_ENABLED is on/);
    const placeholder = run({ BACKUP_ENCRYPTION_KEY: 'replace_me_with_npm_run_backup_key' });
    assert.equal(placeholder.status, 1);
    assert.match(placeholder.stderr, /BACKUP_ENCRYPTION_KEY is still the placeholder/);
  });

  it('no file under server/ or .github/ holds anything that looks like a real key', () => {
    const roots = [SERVER_DIR, path.join(SERVER_DIR, '..', '.github')];
    const patterns = [
      /AKIA[0-9A-Z]{16}/, // an AWS access key id
      /\bK00[0-9A-Za-z+/]{28}\b/, // a Backblaze application key
      /\b00[0-9a-f]{23}\b/, // a Backblaze key id
      /mongodb\+srv:\/\/[^:\s'"`]+:[^@\s'"`<]{6,}@/, // a connection string with a password
      /BACKUP_(?:ENCRYPTION_KEY|S3_SECRET|DRILL_SECRET)\s*[:=]\s*['"]?[A-Za-z0-9+/]{40,}={0,2}/, // a backup secret written in
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    const found = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'coverage' || entry.startsWith('.env')) continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|jsx|json|yml|yaml|md|txt)$/.test(entry)) {
          const text = readFileSync(full, 'utf8');
          for (const pattern of patterns) if (pattern.test(text)) found.push(`${path.relative(SERVER_DIR, full)} (${pattern})`);
        }
      }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(found, []);
  });
});
