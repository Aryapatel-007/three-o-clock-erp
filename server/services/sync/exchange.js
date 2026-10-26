/**
 * P63. The exchange between the cafe PC and the cloud. docs/REPLICATION.md
 * section 13.
 *
 * The box drives it; the cloud only answers. Every round, per restaurant:
 *
 *   1. pull   POST /replication/pull { afterSeq }: the cloud's entries after
 *             what the box has, oldest first, applied here by applyPeer.
 *   2. push   the P62 shipper, carrying `seenPeerSeq`, applied there the same way.
 *
 * Each side also learns which of its own versions the other now has, so the
 * base is right for the next merge: the box from the cloud's acknowledgement of
 * a push, the cloud from the box's `seenPeerSeq`.
 */
import mongoose from 'mongoose';

import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { CHANGE_OPERATIONS, ChangelogEntry } from '../../models/ChangelogEntry.js';
import { ReplicaCursor } from '../../models/ReplicaCursor.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { ReplicationGapError, ValidationError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { noteBoxSeen } from '../replication/receiver.js';
import { postToMirror } from '../replication/shipper.js';
import { fromWire, sign, signatureMatches, toWire } from '../replication/signing.js';
import { applyPeerEntries } from './applyPeer.js';
import { docHash } from './hash.js';
import { getSyncDoc, setBase, syncDocKey } from './syncDocs.js';

export const PULL_LIMIT_DEFAULT = 200;
export const PULL_LIMIT_MAX = 500;

const wireEntry = (entry) => ({
  seq: entry.seq,
  coll: entry.coll,
  documentId: entry.documentId,
  op: entry.op,
  doc: entry.doc,
  capturedAt: entry.capturedAt,
  ...(entry.superseded ? { superseded: true } : {}),
});

/**
 * Flags the entries whose document here now holds a version that came from the
 * other side. The other side already has something newer than every such
 * entry, so it skips them: applying one would put back an older version. It
 * happens after time apart, when a side recorded a change, then took the
 * other's later version of the same document before its own change went over.
 * The seq still goes over, so the receiver's cursor stays gap-free.
 */
export async function flagSuperseded(db, entries) {
  const fromPeer = new Map();
  for (const entry of entries) {
    const key = syncDocKey(entry.coll, entry.documentId);
    if (fromPeer.has(key)) continue;
    const [current, syncDoc] = await Promise.all([
      db.collection(entry.coll).findOne({ _id: entry.documentId }),
      getSyncDoc(db, entry.coll, entry.documentId),
    ]);
    fromPeer.set(key, Boolean(syncDoc?.appliedHashes?.includes(docHash(current))));
  }
  return entries.map((entry) => (fromPeer.get(syncDocKey(entry.coll, entry.documentId)) ? { ...entry, superseded: true } : entry));
}

/** This side's own entries have reached the other side: their versions are the base now. */
export async function markSeenByPeer(db, restaurantId, entries) {
  for (const entry of entries) {
    const doc = entry.op === CHANGE_OPERATIONS.DELETE ? null : entry.doc;
    await setBase(db, { restaurantId, coll: entry.coll, documentId: entry.documentId }, doc);
  }
}

// ---------------------------------------------------------------------------
// The cloud's side

/** POST /replication/pull: the cloud's own changes after `afterSeq`. */
export async function pullEntries({ restaurantId, afterSeq = 0, limit = PULL_LIMIT_DEFAULT }) {
  if (!restaurantId) throw new ValidationError('A pull needs a restaurant.');
  const after = Math.max(Number(afterSeq) || 0, 0);
  const size = Math.min(Math.max(Number(limit) || PULL_LIMIT_DEFAULT, 1), PULL_LIMIT_MAX);
  await noteBoxSeen(restaurantId);
  const entries = await flagSuperseded(
    mongoose.connection.db,
    await ChangelogEntry.find({ restaurantId, seq: { $gt: after } }).sort({ seq: 1 }).limit(size).lean(),
  );
  const newest = await ChangelogEntry.findOne({ restaurantId }).sort({ seq: -1 }).select('seq').lean();
  // Exact types (an ObjectId stays one, a date stays a date), signed like a request, so
  // the box knows the answer came from the cloud that holds the same secret.
  const ejson = toWire({ entries: entries.map(wireEntry) });
  return { ejson, signature: sign(config.REPLICATION_SECRET, ejson), count: entries.length, newestSeq: newest?.seq ?? 0 };
}

/** The box has pulled through `seenPeerSeq`: those cloud versions are the base now. */
async function noteSeenPeerSeq(db, restaurantId, seenPeerSeq) {
  const seen = Number(seenPeerSeq);
  if (!Number.isInteger(seen) || seen < 0) return;
  const id = REPLICATION_STATE_IDS.peerSeen(restaurantId);
  const state = await ReplicationState.findById(id).lean();
  const previous = state?.seenPeerSeq ?? 0;
  if (seen <= previous) return;
  const passed = await ChangelogEntry.find({ restaurantId, seq: { $gt: previous, $lte: seen } }).sort({ seq: 1 }).lean();
  // The newest of each document is what the box now holds of ours, unless ours since came from the box.
  const latest = new Map(passed.map((entry) => [syncDocKey(entry.coll, entry.documentId), entry]));
  const flagged = await flagSuperseded(db, [...latest.values()]);
  await markSeenByPeer(db, restaurantId, flagged.filter((entry) => !entry.superseded));
  await ReplicationState.updateOne({ _id: id }, { $set: { seenPeerSeq: seen } }, { upsert: true });
}

/**
 * POST /replication/batches while two-way: the box's entries, applied by
 * applyPeer, one at a time, with the cursor moved after each so a batch sent
 * again changes nothing. Entries must follow on from the cursor, as in P62.
 */
export async function applyPushedBatch({ restaurantId, entries, seenPeerSeq }, { db = mongoose.connection.db, pump = null } = {}) {
  if (!restaurantId || !Array.isArray(entries)) throw new ValidationError('A batch needs a restaurant and its entries.');
  await noteBoxSeen(restaurantId);
  // This side's own latest changes are in its changelog before anything is weighed against them.
  if (pump) await pump();
  await noteSeenPeerSeq(db, restaurantId, seenPeerSeq);

  const sorted = [...entries].map((entry) => ({ ...entry, seq: Number(entry.seq) })).sort((a, b) => a.seq - b.seq);
  const cursor = await ReplicaCursor.findOneAndUpdate(
    { restaurantId },
    { $setOnInsert: { appliedSeq: 0, epoch: 1 } },
    { upsert: true, new: true },
  );
  let appliedSeq = cursor.appliedSeq;
  let applied = 0;
  let skipped = 0;
  const outcomes = {};
  for (const entry of sorted) {
    if (entry.seq <= appliedSeq) {
      skipped += 1;
      continue;
    }
    if (entry.seq !== appliedSeq + 1) {
      if (applied === 0) throw new ReplicationGapError(appliedSeq + 1, entry.seq);
      break;
    }
    if (entry.superseded) {
      outcomes.SUPERSEDED = (outcomes.SUPERSEDED ?? 0) + 1;
    } else {
      const counts = await applyPeerEntries(db, restaurantId, [entry]);
      for (const [key, value] of Object.entries(counts)) outcomes[key] = (outcomes[key] ?? 0) + value;
    }
    appliedSeq = entry.seq;
    applied += 1;
    await ReplicaCursor.updateOne(
      { restaurantId },
      { $set: { appliedSeq, appliedAt: nowUtc(), lastCapturedAt: entry.capturedAt ?? null, gap: { expectedSeq: null, gotSeq: null, at: null } } },
    );
  }
  return { appliedThrough: appliedSeq, applied, skipped, outcomes, gap: null };
}

// ---------------------------------------------------------------------------
// The box's side

async function pulledSeqOf(restaurantId) {
  const state = await ReplicationState.findById(REPLICATION_STATE_IDS.peerPull(restaurantId)).lean();
  return state?.pulledSeq ?? 0;
}

/** How far the box has pulled the cloud's changes, sent with every push. */
export const seenPeerSeqFor = pulledSeqOf;

async function notePull(restaurantId, fields) {
  await ReplicationState.updateOne({ _id: REPLICATION_STATE_IDS.peerPull(restaurantId) }, { $set: fields }, { upsert: true });
}

const notePullError = (restaurantId, message) => notePull(restaurantId, { lastError: message, lastErrorAt: nowUtc() });

/**
 * One pull for one restaurant. Gives back 'IDLE' (nothing new), 'PULLED' (and
 * there may be more), or 'FAILED'.
 */
export async function pullOnce(restaurantId, { db = mongoose.connection.db, pump = null, fetchImpl, limit = PULL_LIMIT_DEFAULT, mirrorUrl = config.MIRROR_URL, secret = config.REPLICATION_SECRET } = {}) {
  const after = await pulledSeqOf(restaurantId);
  let answer;
  try {
    answer = await postToMirror('/pull', { restaurantId, afterSeq: after, limit }, { mirrorUrl, secret, ...(fetchImpl ? { fetchImpl } : {}) });
  } catch (error) {
    await notePullError(restaurantId, `The cloud could not be reached: ${error.message}`);
    return 'FAILED';
  }
  const data = answer.body?.data;
  if (answer.status !== 200 || typeof data?.ejson !== 'string') {
    await notePullError(restaurantId, `The cloud answered ${answer.status}${answer.body?.error?.code ? ` ${answer.body.error.code}` : ''} to a pull.`);
    return 'FAILED';
  }
  if (!signatureMatches(secret, data.ejson, data.signature)) {
    await notePullError(restaurantId, "The cloud's answer was not signed with this box's REPLICATION_SECRET.");
    return 'FAILED';
  }
  const typed = fromWire(data.ejson).entries ?? [];
  if (typed.length === 0) {
    await notePull(restaurantId, { pulledAt: nowUtc(), lastError: null, lastErrorAt: null });
    return 'IDLE';
  }
  if (Number(typed[0].seq) !== after + 1) {
    await notePullError(restaurantId, `The cloud's changes jump from ${after} to ${typed[0].seq}: a gap. docs/RUNBOOK.md section 7.`);
    return 'FAILED';
  }
  // This side's own latest changes are in its changelog before anything is weighed against them.
  if (pump) await pump();
  let pulled = after;
  for (const entry of typed) {
    if (Number(entry.seq) !== pulled + 1) break;
    if (!entry.superseded) await applyPeerEntries(db, restaurantId, [entry]);
    pulled = Number(entry.seq);
    await notePull(restaurantId, { pulledSeq: pulled, pulledAt: nowUtc(), lastError: null, lastErrorAt: null });
  }
  logger.debug({ restaurantId: String(restaurantId), from: after, to: pulled }, "Pulled the cloud's changes.");
  return 'PULLED';
}
