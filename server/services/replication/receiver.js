/**
 * The mirror's side of shipping. P62 section 4.1, docs/REPLICATION.md section 4.
 *
 * Applies one batch of a restaurant's changelog to the copy, in one
 * transaction with the cursor that says how far it got, so the copy and its
 * cursor can never disagree.
 *
 *   - An entry at or below `appliedSeq` is skipped: a batch sent three times
 *     changes the copy once.
 *   - The first new entry must be `appliedSeq + 1`, and each next one the one
 *     after. Anything else is a gap: the copy stops there and says which seq
 *     it expects. It never skips.
 *   - A batch stamped below the mirror's epoch is from a machine that was
 *     replaced. It is quarantined, never applied (section 8).
 *
 * Writes go to the collections through the driver, by `_id`, the way the box's
 * documents were made: a replace with upsert for any change, a delete for a
 * delete. The tenant guard is a Mongoose hook and is not involved; the
 * collection is checked against the classification instead, and a document
 * from another restaurant is refused.
 */
import mongoose from 'mongoose';

import { CHANGE_OPERATIONS } from '../../models/ChangelogEntry.js';
import { ReplicaCursor } from '../../models/ReplicaCursor.js';
import { ReplicationQuarantine } from '../../models/ReplicationQuarantine.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { ReplicationGapError, StaleEpochError, ValidationError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { isMirrorCollection, TENANT_COLLECTION } from './collections.js';
import { toWire } from './signing.js';
import { writerSnapshot } from './writerState.js';

const sameId = (a, b) => String(a) === String(b);

function assertBelongs(restaurantId, entry) {
  if (!isMirrorCollection(entry.coll)) throw new ValidationError(`Collection ${entry.coll} does not ship.`);
  if (entry.op === CHANGE_OPERATIONS.DELETE) return;
  const owner = entry.coll === TENANT_COLLECTION ? entry.doc?._id : entry.doc?.restaurantId;
  if (!owner || !sameId(owner, restaurantId)) throw new ValidationError(`Entry ${entry.seq} belongs to another restaurant.`);
  if (!sameId(entry.doc._id, entry.documentId)) throw new ValidationError(`Entry ${entry.seq} names two different documents.`);
}

/** Notes that the box checked in, for the public page's "is the cafe there" rule. */
export async function noteBoxSeen(restaurantId, at = nowUtc()) {
  await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.boxSeen(restaurantId) }, { $set: { seenAt: at } }, { upsert: true });
}

/**
 * Applies a batch. Gives back { appliedThrough, applied, skipped }.
 * Throws StaleEpochError, ReplicationGapError or ValidationError.
 */
export async function applyBatch({ restaurantId, epoch, entries }, { db = mongoose.connection.db, currentEpoch = writerSnapshot().epoch } = {}) {
  if (!restaurantId || !Array.isArray(entries)) throw new ValidationError('A batch needs a restaurant and its entries.');
  const current = currentEpoch;
  const sentEpoch = Number(epoch);
  await noteBoxSeen(restaurantId);

  if (!(sentEpoch >= current)) {
    if (entries.length > 0) {
      await ReplicationQuarantine.create({
        restaurantId,
        sentEpoch,
        currentEpoch: current,
        firstSeq: Number(entries[0].seq),
        lastSeq: Number(entries.at(-1).seq),
        entries: toWire(entries),
        receivedAt: nowUtc(),
      });
    }
    throw new StaleEpochError(current, sentEpoch);
  }

  const sorted = [...entries].map((entry) => ({ ...entry, seq: Number(entry.seq) })).sort((a, b) => a.seq - b.seq);
  sorted.forEach((entry) => assertBelongs(restaurantId, entry));

  const session = await mongoose.startSession();
  try {
    let outcome = null;
    await session.withTransaction(async () => {
      const cursor = await ReplicaCursor.findOneAndUpdate(
        { restaurantId },
        { $setOnInsert: { appliedSeq: 0, epoch: current } },
        { upsert: true, new: true, session },
      );
      let appliedSeq = cursor.appliedSeq;
      let lastCapturedAt = cursor.lastCapturedAt;
      let applied = 0;
      let skipped = 0;
      for (const entry of sorted) {
        if (entry.seq <= appliedSeq) {
          skipped += 1;
          continue;
        }
        if (entry.seq !== appliedSeq + 1) {
          await ReplicaCursor.updateOne(
            { restaurantId },
            { $set: { gap: { expectedSeq: appliedSeq + 1, gotSeq: entry.seq, at: nowUtc() } } },
            { session },
          );
          outcome = { gap: { expectedSeq: appliedSeq + 1, gotSeq: entry.seq } };
          break;
        }
        const collection = db.collection(entry.coll);
        if (entry.op === CHANGE_OPERATIONS.DELETE) {
          await collection.deleteOne({ _id: entry.documentId }, { session });
        } else {
          await collection.replaceOne({ _id: entry.documentId }, entry.doc, { upsert: true, session });
        }
        appliedSeq = entry.seq;
        lastCapturedAt = entry.capturedAt ?? lastCapturedAt;
        applied += 1;
      }
      const set = { appliedSeq, appliedAt: nowUtc(), lastCapturedAt, epoch: Math.max(sentEpoch, cursor.epoch ?? 1) };
      if (!outcome?.gap) set.gap = { expectedSeq: null, gotSeq: null, at: null };
      await ReplicaCursor.updateOne({ restaurantId }, { $set: set }, { session });
      outcome = { ...outcome, appliedThrough: appliedSeq, applied, skipped };
    });
    // The changes before a gap are kept; the gap itself is the answer.
    if (outcome.gap && outcome.applied === 0) throw new ReplicationGapError(outcome.gap.expectedSeq, outcome.gap.gotSeq);
    return { appliedThrough: outcome.appliedThrough, applied: outcome.applied, skipped: outcome.skipped, gap: outcome.gap ?? null };
  } finally {
    await session.endSession();
  }
}

/** What the mirror holds for one restaurant: the owner's "figures as of". */
export async function mirrorPosition(restaurantId) {
  const cursor = await ReplicaCursor.findOne({ restaurantId }).lean();
  return {
    appliedSeq: cursor?.appliedSeq ?? 0,
    appliedAt: cursor?.appliedAt ?? null,
    figuresAsOf: cursor?.lastCapturedAt ?? null,
    gap: cursor?.gap?.expectedSeq ? cursor.gap : null,
    epoch: writerSnapshot().epoch,
  };
}
