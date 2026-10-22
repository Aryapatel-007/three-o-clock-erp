/**
 * P63. Applying the other side's changes here. Prompt section 3,
 * docs/REPLICATION.md section 13.
 *
 * Unlike P62's mirror, which replaces blindly, this side also writes, so each
 * incoming change is weighed against what is here and the version both last
 * agreed on (the base, in `syncdocs`):
 *
 *   old news       a version this side already held and moved past: ignored
 *   the same       nothing to write; it becomes the base
 *   new here       written
 *   unchanged here since the base: the incoming version is written
 *   changed on both sides: three-way merge; the result is written, and a
 *                  conflict is recorded when a field was changed both ways
 *
 * A write that is exactly the other side's version is noted first, so the
 * change stream knows it when it comes round and does not send it back. A merge
 * that differs from what came in is NOT noted: it is a change here, and goes
 * back so both sides end with it.
 */
import { CHANGE_OPERATIONS } from '../../models/ChangelogEntry.js';
import { SYNC_CONFLICT_KINDS, SYNC_NODES } from '../../models/SyncConflict.js';
import { announce } from '../live/bus.js';
import { isMirrorCollection, TENANT_COLLECTION } from '../replication/collections.js';
import { ValidationError } from '../../utils/errors.js';
import { RETRY, writeWithClashRules } from './clashes.js';
import { otherNode, recordConflict } from './conflicts.js';
import { docHash, sameDoc } from './hash.js';
import { threeWayMerge } from './merge.js';
import { syncNode } from './mode.js';
import { isListed, noteIncoming } from './recentChanges.js';
import { getSyncDoc, noteApplied, setBase } from './syncDocs.js';

/** The live channel's topics a change to each collection should wake. */
const TOPICS_OF = Object.freeze({
  orders: ['tables'],
  bills: ['tables', 'print-queue'],
  kots: ['kots'],
  tables: ['tables'],
  onlineorders: ['online'],
  reservations: ['online', 'tables'],
  conversations: ['online'],
  platformorders: ['platform-orders', 'online'],
});

export const APPLY_OUTCOMES = Object.freeze({
  STALE: 'STALE',
  SAME: 'SAME',
  APPLIED: 'APPLIED',
  MERGED: 'MERGED',
  KEPT_LOCAL: 'KEPT_LOCAL',
  DELETED: 'DELETED',
  NOT_APPLIED: 'NOT_APPLIED',
});

const sameId = (a, b) => String(a) === String(b);

function assertBelongs(restaurantId, entry) {
  if (!isMirrorCollection(entry.coll)) throw new ValidationError(`Collection ${entry.coll} does not sync.`);
  if (entry.op === CHANGE_OPERATIONS.DELETE) return;
  const owner = entry.coll === TENANT_COLLECTION ? entry.doc?._id : entry.doc?.restaurantId;
  if (!owner || !sameId(owner, restaurantId)) throw new ValidationError(`Entry ${entry.seq} belongs to another restaurant.`);
  if (!sameId(entry.doc._id, entry.documentId)) throw new ValidationError(`Entry ${entry.seq} names two different documents.`);
}

async function applyDelete(db, ref, { local, syncDoc, restaurantId }) {
  if (!local) {
    await setBase(db, ref, null);
    return APPLY_OUTCOMES.SAME;
  }
  const changedHere = !syncDoc?.baseHash || docHash(local) !== syncDoc.baseHash;
  if (changedHere) {
    // Deleted there after it changed here: this side's version stays, and goes back.
    await recordConflict(db, {
      restaurantId, coll: ref.coll, documentId: ref.documentId, kind: SYNC_CONFLICT_KINDS.DELETED_HERE,
      detail: 'Removed on one side after it was changed on the other. The changed version was kept.',
      keptFrom: syncNode(), localDoc: local,
    });
    return APPLY_OUTCOMES.KEPT_LOCAL;
  }
  await noteApplied(db, ref, null);
  await db.collection(ref.coll).deleteOne({ _id: ref.documentId });
  return APPLY_OUTCOMES.DELETED;
}

/** Applies one entry from the other side. Gives back one of APPLY_OUTCOMES. */
export async function applyPeerEntry(db, restaurantId, entry) {
  assertBelongs(restaurantId, entry);
  // A till request can change the same document between the read and the write;
  // the write is conditional, and a lost race is simply decided again.
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await applyOnce(db, restaurantId, entry);
    if (outcome !== RETRY) return outcome;
    if (attempt >= 5) throw new Error(`${entry.coll} ${String(entry.documentId)} kept changing while the sync applied it.`);
  }
}

async function applyOnce(db, restaurantId, entry) {
  const ref = { restaurantId, coll: entry.coll, documentId: entry.documentId };
  const collection = db.collection(entry.coll);
  const [local, syncDoc] = await Promise.all([
    collection.findOne({ _id: entry.documentId }),
    getSyncDoc(db, entry.coll, entry.documentId),
  ]);

  if (entry.op === CHANGE_OPERATIONS.DELETE) return applyDelete(db, ref, { local, syncDoc, restaurantId });

  const incoming = entry.doc;
  const incomingHash = docHash(incoming);
  if (local && docHash(local) === incomingHash) {
    await setBase(db, ref, incoming);
    return APPLY_OUTCOMES.SAME;
  }
  // A version this side already had and moved past (a delayed copy, or our own coming back).
  if (local && syncDoc?.knownHashes?.includes(incomingHash)) return APPLY_OUTCOMES.STALE;

  const write = async (doc) => {
    const written = await writeWithClashRules(db, { restaurantId, coll: entry.coll, doc, incomingDoc: incoming, expected: local });
    if (written === RETRY) return RETRY;
    return written ? 'WRITTEN' : null;
  };

  const changedHere = Boolean(local) && (!syncDoc?.baseHash || docHash(local) !== syncDoc.baseHash);
  if (!changedHere) {
    await noteApplied(db, ref, incoming);
    const written = await write(incoming);
    if (written === RETRY) return RETRY;
    return written ? APPLY_OUTCOMES.APPLIED : APPLY_OUTCOMES.NOT_APPLIED;
  }

  const localIsBox = syncNode() === SYNC_NODES.BOX;
  const { doc: merged, conflictFields } = threeWayMerge({ base: syncDoc?.baseDoc ?? null, local, incoming, localIsBox });
  let outcome;
  if (sameDoc(merged, incoming)) {
    await noteApplied(db, ref, incoming);
    const written = await write(incoming);
    if (written === RETRY) return RETRY;
    outcome = written ? APPLY_OUTCOMES.APPLIED : APPLY_OUTCOMES.NOT_APPLIED;
  } else if (sameDoc(merged, local)) {
    // This side's version already holds everything; it goes back as it is.
    await setBase(db, ref, incoming);
    outcome = APPLY_OUTCOMES.KEPT_LOCAL;
  } else {
    // Neither side's: the merge is a change here, and goes back.
    const written = await write(merged);
    if (written === RETRY) return RETRY;
    await setBase(db, ref, incoming);
    outcome = written ? APPLY_OUTCOMES.MERGED : APPLY_OUTCOMES.NOT_APPLIED;
  }
  if (conflictFields.length > 0) {
    const localTime = new Date(local.updatedAt ?? 0).getTime();
    const incomingTime = new Date(incoming.updatedAt ?? 0).getTime();
    let keptFrom = localTime > incomingTime ? syncNode() : otherNode();
    if (localTime === incomingTime) keptFrom = SYNC_NODES.BOX;
    await recordConflict(db, {
      restaurantId, coll: entry.coll, documentId: entry.documentId, kind: SYNC_CONFLICT_KINDS.EDITED_BOTH,
      detail: 'Changed on the cafe PC and on the website before they could tell each other. Where both changed the same thing, the later change was kept; everything else from both was kept.',
      fields: [...new Set(conflictFields.map((field) => field.split(/[.[]/)[0]))],
      keptFrom, localDoc: local, incomingDoc: incoming, resultDoc: merged,
    });
  }
  return outcome;
}

/**
 * Applies a run of entries, oldest first, and wakes the screens that show what
 * changed. Gives back the counts per outcome.
 */
export async function applyPeerEntries(db, restaurantId, entries) {
  const counts = Object.fromEntries(Object.values(APPLY_OUTCOMES).map((outcome) => [outcome, 0]));
  const topics = new Set();
  const changed = [];
  for (const entry of entries) {
    // 2026-10-22. This side's version before the change, so the Sync page can undo it.
    const listed = isListed(entry.coll);
    const before = listed ? await db.collection(entry.coll).findOne({ _id: entry.documentId }) : null;
    const outcome = await applyPeerEntry(db, restaurantId, entry);
    counts[outcome] += 1;
    if (outcome !== APPLY_OUTCOMES.SAME && outcome !== APPLY_OUTCOMES.STALE) {
      for (const topic of TOPICS_OF[entry.coll] ?? []) topics.add(topic);
    }
    if (listed && CHANGED_HERE.has(outcome)) {
      changed.push({ coll: entry.coll, documentId: entry.documentId, outcome, before, after: entry.doc ?? null });
    }
  }
  for (const topic of topics) announce(topic, String(restaurantId));
  await noteIncoming(db, restaurantId, changed);
  return counts;
}

const CHANGED_HERE = new Set([APPLY_OUTCOMES.APPLIED, APPLY_OUTCOMES.MERGED, APPLY_OUTCOMES.DELETED]);
