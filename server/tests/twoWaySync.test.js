/**
 * P63. Two-way sync, in one process: the merge, applying the other side's
 * changes (new, unchanged here, changed both ways, stale, deletes, clashes), no
 * echo, the website's number series, and the routes. The whole exchange between
 * two real servers is twoWaySyncE2e.test.js.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { setRoleForTest } from '../config/deployment.js';
import { ChangelogEntry } from '../models/ChangelogEntry.js';
import { ALL_MODELS } from '../models/index.js';
import { reserveBillNumber } from '../services/billNumberService.js';
import { nextNumber } from '../services/counterService.js';
import { numberInSeries } from '../services/dayFiguresService.js';
import { ChangelogWriter } from '../services/replication/changelogWriter.js';
import { APPLY_OUTCOMES, applyPeerEntry } from '../services/sync/applyPeer.js';
import { docHash } from '../services/sync/hash.js';
import { threeWayMerge } from '../services/sync/merge.js';
import { setSyncModeForTest } from '../services/sync/mode.js';
import { insideHours, parseSyncHours, QUIET_EVERY_MS, shouldExchange } from '../services/sync/pacing.js';
import { getSyncDoc } from '../services/sync/syncDocs.js';
import { seedTeam } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const { ObjectId } = mongoose.Types;
let db;

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  db = mongoose.connection.db;
});

after(async () => {
  setRoleForTest(null);
  setSyncModeForTest(null);
  await stopTestServer();
  await stopTestDatabase();
});

afterEach(() => {
  setRoleForTest(null);
  setSyncModeForTest(null);
});

function asBox() {
  setRoleForTest('BOX');
  setSyncModeForTest('TWO_WAY');
}
function asCloud() {
  setRoleForTest('CLOUD');
  setSyncModeForTest('TWO_WAY');
}

const at = (minute) => new Date(Date.UTC(2026, 9, 21, 12, minute));
const line = (name) => ({ _id: new ObjectId(), itemName: name, quantity: 1, status: 'PENDING' });

/** A plain order document, as the driver would hold it. */
function orderDoc(restaurantId, branchId, fields = {}) {
  return {
    _id: new ObjectId(),
    restaurantId,
    branchId,
    orderNumber: Math.floor(Math.random() * 1_000_000),
    status: 'OPEN',
    tableId: null,
    occupiesTable: false,
    lines: [],
    version: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...fields,
  };
}

let seq = 0;
const entry = (coll, doc, op = 'replace') => ({ seq: (seq += 1), coll, documentId: doc._id, op, doc: op === 'delete' ? null : doc, capturedAt: new Date() });

describe('the three-way merge', () => {
  it('keeps the dishes added on both sides, the same on both, with no conflict', () => {
    const shared = line('Pani Puri');
    const base = { _id: 1, lines: [shared], updatedAt: at(0), version: 1 };
    const onBox = { ...base, lines: [shared, line('Sev Puri')], updatedAt: at(2), version: 2 };
    const onCloud = { ...base, lines: [shared, line('Bhel')], updatedAt: at(3), version: 2 };
    const fromBox = threeWayMerge({ base, local: onBox, incoming: onCloud, localIsBox: true });
    const fromCloud = threeWayMerge({ base, local: onCloud, incoming: onBox, localIsBox: false });
    assert.deepEqual(fromBox.doc.lines.map((item) => item.itemName), ['Pani Puri', 'Sev Puri', 'Bhel']);
    assert.equal(docHash(fromBox.doc), docHash(fromCloud.doc), 'both sides reach one document');
    assert.deepEqual(fromBox.conflictFields, []);
    assert.equal(fromBox.doc.version, 2);
    assert.deepEqual(fromBox.doc.updatedAt, at(3));
  });

  it('takes the newer value of a field changed both ways, and names it', () => {
    const base = { _id: 1, kitchenNote: 'none', guestCount: 2, updatedAt: at(0) };
    const local = { ...base, kitchenNote: 'Less spicy', updatedAt: at(5) };
    const incoming = { ...base, kitchenNote: 'Jain', guestCount: 4, updatedAt: at(4) };
    const { doc, conflictFields } = threeWayMerge({ base, local, incoming, localIsBox: false });
    assert.equal(doc.kitchenNote, 'Less spicy', 'the later change wins');
    assert.equal(doc.guestCount, 4, 'a field only one side changed keeps that change');
    assert.deepEqual(conflictFields, ['kitchenNote']);
  });

  it('never calls bookkeeping a conflict, and drops a dish removed on one side only', () => {
    const keep = line('Dabeli');
    const gone = line('Vada Pav');
    const base = { _id: 1, lines: [keep, gone], lastLoginAt: at(0), updatedAt: at(0) };
    const local = { ...base, lines: [keep], lastLoginAt: at(1), updatedAt: at(1) };
    const incoming = { ...base, lastLoginAt: at(2), updatedAt: at(2) };
    const { doc, conflictFields } = threeWayMerge({ base, local, incoming, localIsBox: true });
    assert.deepEqual(doc.lines.map((item) => item.itemName), ['Dabeli']);
    assert.deepEqual(conflictFields, []);
  });
});

describe('applying the other side\'s changes', () => {
  const restaurantId = new ObjectId();
  const branchId = new ObjectId();

  it('writes what is new here, and remembers it as both sides\' version', async () => {
    asBox();
    const order = orderDoc(restaurantId, branchId);
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', order)), APPLY_OUTCOMES.APPLIED);
    const here = await db.collection('orders').findOne({ _id: order._id });
    assert.equal(docHash(here), docHash(order));
    const sync = await getSyncDoc(db, 'orders', order._id);
    assert.equal(sync.baseHash, docHash(order));
    assert.ok(sync.appliedHashes.includes(docHash(order)));
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', order)), APPLY_OUTCOMES.SAME);
  });

  it('takes the other side\'s version when nothing changed here, and ignores an old one arriving late', async () => {
    asBox();
    const v1 = orderDoc(restaurantId, branchId);
    await applyPeerEntry(db, restaurantId, entry('orders', v1));
    const v2 = { ...v1, kitchenNote: 'Less spicy', updatedAt: at(1), version: 1 };
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', v2)), APPLY_OUTCOMES.APPLIED);
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', v1)), APPLY_OUTCOMES.STALE);
    assert.equal((await db.collection('orders').findOne({ _id: v1._id })).kitchenNote, 'Less spicy');
  });

  it('merges dishes added on both sides, and records a conflict only for a field changed both ways', async () => {
    asBox();
    const shared = line('Pani Puri');
    const base = orderDoc(restaurantId, branchId, { lines: [shared] });
    await applyPeerEntry(db, restaurantId, entry('orders', base));
    // Changed here, by the PC.
    await db.collection('orders').replaceOne({ _id: base._id }, { ...base, lines: [shared, line('Sev Puri')], kitchenNote: 'Jain', updatedAt: at(5), version: 1 });
    // And on the website, before they could tell each other.
    const incoming = { ...base, lines: [shared, line('Bhel')], kitchenNote: 'No onion', updatedAt: at(4), version: 1 };
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', incoming)), APPLY_OUTCOMES.MERGED);
    const here = await db.collection('orders').findOne({ _id: base._id });
    assert.deepEqual(here.lines.map((item) => item.itemName), ['Pani Puri', 'Sev Puri', 'Bhel']);
    assert.equal(here.kitchenNote, 'Jain', 'the later change');
    const conflict = await db.collection('syncconflicts').findOne({ documentId: base._id });
    assert.equal(conflict.kind, 'EDITED_BOTH');
    assert.deepEqual(conflict.fields, ['kitchenNote']);
    assert.equal(conflict.keptFrom, 'BOX');
    // The merge is a change here, so it is not marked as the other side's: it goes back.
    assert.equal((await getSyncDoc(db, 'orders', base._id)).appliedHashes.includes(docHash(here)), false);
  });

  it('keeps a document deleted there that was changed here, and deletes one that was not', async () => {
    asBox();
    const changed = orderDoc(restaurantId, branchId);
    await applyPeerEntry(db, restaurantId, entry('orders', changed));
    await db.collection('orders').updateOne({ _id: changed._id }, { $set: { kitchenNote: 'changed here' } });
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', changed, 'delete')), APPLY_OUTCOMES.KEPT_LOCAL);
    assert.ok(await db.collection('orders').findOne({ _id: changed._id }));
    assert.equal((await db.collection('syncconflicts').findOne({ documentId: changed._id })).kind, 'DELETED_HERE');

    const untouched = orderDoc(restaurantId, branchId);
    await applyPeerEntry(db, restaurantId, entry('orders', untouched));
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', untouched, 'delete')), APPLY_OUTCOMES.DELETED);
    assert.equal(await db.collection('orders').findOne({ _id: untouched._id }), null);
  });

  it('on the PC, a website order on a table the PC already holds stays open without the table', async () => {
    asBox();
    const tableId = new ObjectId();
    const mine = orderDoc(restaurantId, branchId, { tableId, occupiesTable: true });
    await db.collection('orders').insertOne(mine);
    const theirs = orderDoc(restaurantId, branchId, { tableId, occupiesTable: true });
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', theirs)), APPLY_OUTCOMES.APPLIED);
    assert.equal((await db.collection('orders').findOne({ _id: mine._id })).occupiesTable, true);
    const parked = await db.collection('orders').findOne({ _id: theirs._id });
    assert.equal(parked.occupiesTable, false);
    assert.equal(parked.status, 'OPEN');
    const conflict = await db.collection('syncconflicts').findOne({ documentId: theirs._id });
    assert.equal(conflict.kind, 'SAME_SLOT');
    assert.equal(conflict.keptFrom, 'BOX');
  });

  it('on the website, its own order gives the table up to the PC\'s', async () => {
    asCloud();
    const tableId = new ObjectId();
    const websites = orderDoc(restaurantId, branchId, { tableId, occupiesTable: true });
    await db.collection('orders').insertOne(websites);
    const pcs = orderDoc(restaurantId, branchId, { tableId, occupiesTable: true });
    assert.equal(await applyPeerEntry(db, restaurantId, entry('orders', pcs)), APPLY_OUTCOMES.APPLIED);
    assert.equal((await db.collection('orders').findOne({ _id: pcs._id })).occupiesTable, true);
    assert.equal((await db.collection('orders').findOne({ _id: websites._id })).occupiesTable, false);
  });

  it('on the PC, a second live bill for one order from the website arrives voided', async () => {
    asBox();
    const orderId = new ObjectId();
    const bill = (number) => ({
      _id: new ObjectId(), restaurantId, branchId, orderId, billNumber: number, financialYear: '2026-27',
      billSequence: number.endsWith('W00001') ? 900_000_001 : 176, invoiceSeries: number.includes('/W') ? '2026-27/W' : '2026-27',
      isVoided: false, createdAt: at(0), updatedAt: at(0),
    });
    await db.collection('bills').insertOne(bill('2026-27/000176'));
    const websiteBill = bill('2026-27/W00001');
    await applyPeerEntry(db, restaurantId, entry('bills', websiteBill));
    const stored = await db.collection('bills').findOne({ _id: websiteBill._id });
    assert.equal(stored.isVoided, true);
    assert.equal(stored.voidReasonCode, 'OTHER');
    assert.match(stored.voidReason, /cafe PC/);
  });

  it('refuses a document of another restaurant', async () => {
    asBox();
    const stranger = orderDoc(new ObjectId(), branchId);
    await assert.rejects(applyPeerEntry(db, restaurantId, entry('orders', stranger)), /another restaurant/);
  });
});

describe('no echo', () => {
  it('does not send back what came from the other side, and does send a change made here', async () => {
    asBox();
    const team = await seedTeam();
    const restaurantId = new ObjectId(team.restaurant.id);
    const branchId = new ObjectId(team.branch.id);
    const writer = new ChangelogWriter({ db });
    await writer.start();
    const drain = async () => {
      let quiet = 0;
      while (quiet < 2) quiet = (await writer.pump()) === 0 ? quiet + 1 : 0;
    };
    await drain();

    const order = orderDoc(restaurantId, branchId);
    await applyPeerEntry(db, restaurantId, entry('orders', order));
    await drain();
    assert.equal(await ChangelogEntry.countDocuments({ restaurantId, coll: 'orders', documentId: order._id }), 0, 'the other side\'s write is not sent back');

    await db.collection('orders').updateOne({ _id: order._id }, { $set: { kitchenNote: 'made here', updatedAt: new Date() } });
    await drain();
    assert.equal(await ChangelogEntry.countDocuments({ restaurantId, coll: 'orders', documentId: order._id }), 1);
    await writer.close();
  });
});

describe('a baseline taken again (P63, Render waking from its sleep)', () => {
  it('leaves out what both sides already hold, and keeps what changed here', async () => {
    asCloud();
    const team = await seedTeam();
    const restaurantId = new ObjectId(team.restaurant.id);
    const branchId = new ObjectId(team.branch.id);
    const writer = new ChangelogWriter({ db });
    await writer.start();
    const drain = async () => {
      let quiet = 0;
      while (quiet < 2) quiet = (await writer.pump()) === 0 ? quiet + 1 : 0;
    };
    const same = orderDoc(restaurantId, branchId);
    const changed = orderDoc(restaurantId, branchId);
    await applyPeerEntry(db, restaurantId, entry('orders', same));
    await applyPeerEntry(db, restaurantId, entry('orders', changed));
    await drain();
    await db.collection('orders').updateOne({ _id: changed._id }, { $set: { kitchenNote: 'made here', updatedAt: new Date() } });

    await writer.baseline();
    const baselined = async (doc) => ChangelogEntry.countDocuments({ restaurantId, documentId: doc._id, op: 'baseline' });
    assert.equal(await baselined(same), 0, 'both sides hold it: not recorded again');
    assert.equal(await baselined(changed), 1, 'changed here: recorded');
    await writer.close();
  });
});

describe('the PC\'s pace (P63, inside Render\'s free hours)', () => {
  const hours = parseSyncHours('08:30-02:30');
  // 2026-10-21 in India: 12:00 noon is 06:30 UTC, 4:00 AM is 22:30 UTC the day before.
  const noon = new Date(Date.UTC(2026, 9, 21, 6, 30));
  const night = new Date(Date.UTC(2026, 9, 20, 22, 30));
  const ago = (now, ms) => now.getTime() - ms;

  it('reads the hours, past midnight included', () => {
    assert.deepEqual(hours, { from: 510, to: 150 });
    assert.equal(parseSyncHours('always'), null);
    assert.equal(insideHours(600, hours), true);
    assert.equal(insideHours(60, hours), true, '1:00 AM is still open');
    assert.equal(insideHours(240, hours), false, '4:00 AM is closed');
  });

  it('syncs every minute while open, and always once when it starts', () => {
    assert.equal(shouldExchange({ now: noon, lastAt: 0, waiting: false, everyMs: 60_000, hours }), true);
    assert.equal(shouldExchange({ now: night, lastAt: 0, waiting: false, everyMs: 60_000, hours }), true);
    assert.equal(shouldExchange({ now: noon, lastAt: ago(noon, 30_000), waiting: true, everyMs: 60_000, hours }), false);
    assert.equal(shouldExchange({ now: noon, lastAt: ago(noon, 60_000), waiting: false, everyMs: 60_000, hours }), true);
  });

  it('at night sends only what is waiting, at most every 15 minutes, so Render sleeps', () => {
    assert.equal(shouldExchange({ now: night, lastAt: ago(night, 6 * 3_600_000), waiting: false, everyMs: 60_000, hours }), false);
    assert.equal(shouldExchange({ now: night, lastAt: ago(night, 5 * 60_000), waiting: true, everyMs: 60_000, hours }), false);
    assert.equal(shouldExchange({ now: night, lastAt: ago(night, QUIET_EVERY_MS), waiting: true, everyMs: 60_000, hours }), true);
    assert.equal(shouldExchange({ now: night, lastAt: ago(night, 60_000), waiting: false, everyMs: 60_000, hours: null }), true, 'always');
  });
});

// 2026-10-22, Arya: one series for both, the website billing only while the PC is off.
describe('one series for the PC and the website', () => {
  const restaurantId = new ObjectId();
  const branchId = new ObjectId();

  it('numbers orders and tickets in the same run on the website and the PC', async () => {
    asCloud();
    assert.equal(await nextNumber({ restaurantId, branchId, name: 'ORDER' }), 1);
    asBox();
    assert.equal(await nextNumber({ restaurantId, branchId, name: 'ORDER' }), 2);
  });

  it('bills on the website in the same series as the PC, gap-free', async () => {
    const reserve = async (invoice = null) => {
      const session = await mongoose.startSession();
      try {
        let result;
        await session.withTransaction(async () => {
          result = await reserveBillNumber({ restaurantId, branchId, at: at(0), invoice }, session);
        });
        return result;
      } finally {
        await session.endSession();
      }
    };
    asCloud();
    assert.equal((await reserve()).billNumber, '2026-27/000001');
    asBox();
    assert.equal((await reserve()).billNumber, '2026-27/000002');
    // A W number from before still reads as it was printed.
    assert.equal(numberInSeries('2026-27/W', 900_000_007), '2026-27/W00007');
  });
});

describe('the routes', () => {
  it('answers a pull only on a two-way cloud, and only signed', async () => {
    setRoleForTest('CLOUD');
    const oneWay = await request('POST', '/api/v1/replication/pull', { headers: { 'Content-Type': 'application/ejson' } });
    assert.equal(oneWay.status, 404);
    asCloud();
    const unsigned = await request('POST', '/api/v1/replication/pull', { headers: { 'Content-Type': 'application/ejson' } });
    assert.equal(unsigned.status, 401);
    asBox();
    assert.equal((await request('POST', '/api/v1/replication/pull', { headers: { 'Content-Type': 'application/ejson' } })).status, 404);
  });

  it('closes the day only on the PC, and shows sync to owners and managers only', async () => {
    const team = await seedTeam();
    asCloud();
    const refused = await request('POST', '/api/v1/day-close', { token: team.tokens.OWNER, body: { businessDate: '2026-10-21' } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.code, 'CLOSE_ON_CAFE_PC');

    assert.equal((await request('GET', '/api/v1/sync/status', { token: team.tokens.WAITER })).status, 403);
    const status = await request('GET', '/api/v1/sync/status', { token: team.tokens.OWNER });
    assert.equal(status.status, 200);
    assert.equal(status.body.data.mode, 'TWO_WAY');
    assert.equal(status.body.data.node, 'CLOUD');
    const me = await request('GET', '/api/v1/auth/me', { token: team.tokens.MANAGER });
    assert.equal(me.body.data.sync.mode, 'TWO_WAY');
    assert.equal(me.body.data.sync.conflictsUnseen, 0);
    const waiterMe = await request('GET', '/api/v1/auth/me', { token: team.tokens.WAITER });
    assert.equal(waiterMe.body.data.sync.conflictsUnseen, null);
  });

  it('lists conflicts and marks one seen, within the restaurant', async () => {
    asBox();
    const team = await seedTeam();
    const restaurantId = new ObjectId(team.restaurant.id);
    const branchId = new ObjectId(team.branch.id);
    const tableId = new ObjectId();
    await db.collection('orders').insertOne(orderDoc(restaurantId, branchId, { tableId, occupiesTable: true }));
    await applyPeerEntry(db, restaurantId, entry('orders', orderDoc(restaurantId, branchId, { tableId, occupiesTable: true })));

    const list = await request('GET', '/api/v1/sync/conflicts', { token: team.tokens.MANAGER });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    const [conflict] = list.body.data;
    assert.equal(conflict.kind, 'SAME_SLOT');
    assert.match(conflict.link, /^\/orders\//);

    const other = await seedTeam();
    assert.equal((await request('POST', `/api/v1/sync/conflicts/${conflict.id}/seen`, { token: other.tokens.OWNER, body: {} })).status, 404);
    const seen = await request('POST', `/api/v1/sync/conflicts/${conflict.id}/seen`, { token: team.tokens.OWNER, body: {} });
    assert.equal(seen.status, 200);
    assert.ok(seen.body.data.seenAt);
    assert.equal((await request('GET', '/api/v1/sync/conflicts', { token: team.tokens.MANAGER })).body.data.length, 0);
  });
});
