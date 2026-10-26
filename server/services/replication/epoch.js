/**
 * Moving authority, by a person, never by a timer. P62 section 8,
 * docs/RUNBOOK.md sections 6 and 7.
 *
 *   promote     on the mirror, when the box is dead: the epoch goes up by one,
 *               the read-only flag clears, and the mirror is the writer. It
 *               processes intake itself, through the same services.
 *   demote      on the mirror, once a box is the writer again: read-only.
 *   adoptEpoch  on a box rebuilt from the mirror's data: it takes the mirror's
 *               epoch and may write again.
 *
 * The operator is shown, per restaurant, the last applied seq and the box's
 * time for it, so they know exactly what may be missing.
 */
import mongoose from 'mongoose';

import { ChangelogCounter } from '../../models/ChangelogCounter.js';
import { ReplicaCursor } from '../../models/ReplicaCursor.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { loadWriterState } from './writerState.js';

/** Per restaurant: name, last applied seq, and the box's time of it. Read through the driver: it spans restaurants. */
export async function appliedPositions(db = mongoose.connection.db) {
  const restaurants = await db.collection('restaurants').find({}, { projection: { name: 1 } }).toArray();
  const rows = [];
  for (const restaurant of restaurants) {
    const cursor = await ReplicaCursor.findOne({ restaurantId: restaurant._id }).lean();
    rows.push({
      restaurantId: String(restaurant._id),
      name: restaurant.name,
      appliedSeq: cursor?.appliedSeq ?? 0,
      lastCapturedAt: cursor?.lastCapturedAt ?? null,
      appliedAt: cursor?.appliedAt ?? null,
      gap: cursor?.gap?.expectedSeq ? cursor.gap : null,
    });
  }
  return rows;
}

export async function promoteMirror() {
  const before = await loadWriterState();
  if (before.promoted) return { already: true, epoch: before.epoch };
  const doc = await ReplicationState.findOneAndUpdate(
    { _id: REPLICATION_STATE_IDS.WRITER },
    { $inc: { epoch: 1 }, $set: { promoted: true, promotedAt: nowUtc(), fenced: false } },
    { upsert: true, new: true },
  ).lean();
  await loadWriterState();
  return { already: false, epoch: doc.epoch };
}

export async function demoteMirror() {
  await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.WRITER }, { $set: { promoted: false } }, { upsert: true });
  return loadWriterState();
}

/**
 * On a box rebuilt from the cloud's data: take the cloud's epoch, and mark
 * every changelog entry made before the rebuild as superseded, so the shipper
 * starts after them. Those entries describe the box before it died; the
 * restore replaced that state, and the baseline that follows captures what is
 * there now. Gives back, per restaurant, the seq the cloud must be set to
 * with `reset-cursor`.
 */
export async function adoptEpoch(epoch, db = mongoose.connection.db) {
  const value = Number(epoch);
  if (!Number.isInteger(value) || value < 1) throw new Error('The epoch must be a whole number, 1 or more.');
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.WRITER },
    { $set: { epoch: value, fenced: false, fencedAt: null, fencedReason: null } },
    { upsert: true },
  );
  const writer = await loadWriterState();
  const restaurants = await db.collection('restaurants').find({}, { projection: { _id: 1, name: 1 } }).toArray();
  const resume = [];
  for (const restaurant of restaurants) {
    const counter = await ChangelogCounter.findOne({ restaurantId: restaurant._id }).lean();
    const seq = counter?.value ?? 0;
    await ReplicationState.updateOne(
      { _id: REPLICATION_STATE_IDS.shipper(restaurant._id) },
      { $set: { shippedSeq: seq, shippedAt: nowUtc(), lastError: null, lastErrorAt: null } },
      { upsert: true },
    );
    resume.push({ restaurantId: String(restaurant._id), name: restaurant.name, seq });
  }
  return { ...writer, resume };
}

/** On the cloud, after a demotion: the box's changelog continues after `seq` for this restaurant. */
export async function resetCursor(restaurantId, seq) {
  const value = Number(seq);
  if (!mongoose.isValidObjectId(restaurantId)) throw new Error('Give the restaurant id.');
  if (!Number.isInteger(value) || value < 0) throw new Error('The seq must be a whole number, 0 or more.');
  await ReplicaCursor.updateOne(
    { restaurantId: new mongoose.Types.ObjectId(String(restaurantId)) },
    { $set: { appliedSeq: value, appliedAt: nowUtc(), gap: { expectedSeq: null, gotSeq: null, at: null } } },
    { upsert: true },
  );
  return { restaurantId: String(restaurantId), appliedSeq: value };
}
