/**
 * 2026-10-22. What the other side's changes did here, Undo, and the version a
 * sync conflict keeps (services/sync/recentChanges.js, API-CONTRACT P63).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { setRoleForTest } from '../config/deployment.js';
import { ALL_MODELS } from '../models/index.js';
import { applyPeerEntries } from '../services/sync/applyPeer.js';
import { setSyncModeForTest } from '../services/sync/mode.js';
import { keepConflictVersion, listIncoming, undoIncoming } from '../services/sync/recentChanges.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';

const { ObjectId } = mongoose.Types;
let db;

before(async () => {
  await startTestDatabase();
  for (const model of ALL_MODELS) await model.init();
  db = mongoose.connection.db;
});

after(async () => {
  setRoleForTest(null);
  setSyncModeForTest(null);
  await stopTestDatabase();
});

afterEach(() => {
  setRoleForTest(null);
  setSyncModeForTest(null);
});

const at = (minute) => new Date(Date.UTC(2026, 9, 22, 8, minute));
let seq = 0;
const entry = (coll, doc) => ({ seq: (seq += 1), coll, documentId: doc._id, op: 'replace', doc, capturedAt: new Date() });

function orderDoc(restaurantId, fields = {}) {
  return {
    _id: new ObjectId(),
    restaurantId,
    branchId: new ObjectId(),
    orderNumber: 225,
    tableName: 'Table 3',
    status: 'READY_TO_BILL',
    lines: [],
    version: 3,
    createdAt: at(0),
    updatedAt: at(0),
    ...fields,
  };
}

describe('what came in, and Undo', () => {
  it('lists a change from the website on the PC, and puts the PC\'s version back on Undo', async () => {
    setRoleForTest('BOX');
    setSyncModeForTest('TWO_WAY');
    const restaurantId = new ObjectId();
    const v1 = orderDoc(restaurantId);
    await applyPeerEntries(db, restaurantId, [entry('orders', v1)]);
    const cancelled = { ...v1, status: 'CANCELLED', version: 4, updatedAt: at(5) };
    await applyPeerEntries(db, restaurantId, [entry('orders', cancelled)]);

    const [newest, first] = await listIncoming(restaurantId);
    assert.equal(newest.title, 'Order 225, Table 3');
    assert.equal(newest.from, 'CLOUD');
    assert.equal(newest.canUndo, true);
    assert.equal(first.wasNew, true);
    assert.equal(first.canUndo, false, 'a new order is cancelled on its own screen, not undone');

    await undoIncoming(restaurantId, newest.id, new ObjectId());
    const here = await db.collection('orders').findOne({ _id: v1._id });
    assert.equal(here.status, 'READY_TO_BILL');
    assert.ok(here.updatedAt > cancelled.updatedAt, 'newer, so the next sync takes it back to the website');
    assert.equal((await listIncoming(restaurantId))[0].undoneAt instanceof Date, true);
    await assert.rejects(undoIncoming(restaurantId, newest.id, new ObjectId()), /cannot be undone/);
  });

  it('never lets one restaurant undo into another', async () => {
    setRoleForTest('BOX');
    setSyncModeForTest('TWO_WAY');
    const restaurantId = new ObjectId();
    const v1 = orderDoc(restaurantId);
    await applyPeerEntries(db, restaurantId, [entry('orders', v1)]);
    await applyPeerEntries(db, restaurantId, [entry('orders', { ...v1, status: 'CANCELLED', updatedAt: at(6) })]);
    const [change] = await listIncoming(restaurantId);
    await assert.rejects(undoIncoming(new ObjectId(), change.id, new ObjectId()));
  });
});

describe('the version a sync conflict keeps', () => {
  it('writes the chosen side\'s whole version back, newer', async () => {
    const restaurantId = new ObjectId();
    const base = orderDoc(restaurantId, { kitchenNote: 'Jain' });
    await db.collection('orders').insertOne(base);
    const conflict = { coll: 'orders', localDoc: base, incomingDoc: { ...base, kitchenNote: 'No onion' } };
    await keepConflictVersion(restaurantId, conflict, 'INCOMING');
    const here = await db.collection('orders').findOne({ _id: base._id });
    assert.equal(here.kitchenNote, 'No onion');
    assert.ok(here.updatedAt > base.updatedAt);
    await keepConflictVersion(restaurantId, conflict, 'RESULT');
    assert.equal((await db.collection('orders').findOne({ _id: base._id })).kitchenNote, 'No onion', 'RESULT leaves it as it is');
  });
});
