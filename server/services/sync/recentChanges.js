/**
 * What the other side's changes did here, for the Sync page. 2026-10-22, at
 * Arya's word: after a sync a person sees what came in and chooses to keep each
 * change or undo it, and picks the version a sync conflict keeps.
 *
 * The last RECENT_KEPT applied changes are kept on this side only, in one
 * `replicationstate` document per restaurant (written through the driver: the
 * model's schema knows nothing of it, and replication's own state never ships).
 * Each keeps this side's version from before it, so Undo can put that back. An
 * undo, and a conflict's chosen version, is an ordinary change here with a new
 * `updatedAt`, so the next sync takes it to the other side, where it is newer.
 */
import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { TENANT_COLLECTION } from '../replication/collections.js';
import { BusinessRuleError, NotFoundError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { describe, linkFor, otherNode } from './conflicts.js';

const RECENT_KEPT = 100;
// A version bigger than this is listed without a copy, so it cannot be undone.
const BEFORE_LIMIT_BYTES = 200_000;
// Bookkeeping, not things a person changed.
const NOT_LISTED = new Set(['syncconflicts', 'auditlogs', 'counters', 'integrationevents', 'integrationjobs']);
// A record the other side made cannot be undone here: it is voided or cancelled on its own screen.
const NEW_RECORD_WORDS = {
  bills: 'void it on the bill',
  orders: 'cancel it on the order',
  kots: 'cancel its dishes on the order',
};

const stateId = (restaurantId) => `syncrecent:${restaurantId}`;
const states = (db) => db.collection('replicationstate');

export const isListed = (coll) => !NOT_LISTED.has(coll);

function sizeOf(doc) {
  try {
    return Buffer.byteLength(JSON.stringify(doc ?? null));
  } catch {
    return Infinity;
  }
}

/** Records changes just applied from the other side. Never stops the sync. */
export async function noteIncoming(db, restaurantId, changes) {
  if (changes.length === 0) return;
  try {
    const at = nowUtc();
    const items = changes.map(({ coll, documentId, outcome, before, after }) => {
      const keepCopy = before && sizeOf(before) <= BEFORE_LIMIT_BYTES;
      return {
        id: new mongoose.Types.ObjectId().toHexString(),
        coll,
        documentId,
        outcome,
        title: describe(coll, after ?? before).slice(0, 200),
        from: otherNode(),
        at,
        wasNew: !before,
        before: keepCopy ? before : null,
        undoneAt: null,
        undoneBy: null,
      };
    });
    await states(db).updateOne(
      { _id: stateId(restaurantId) },
      { $push: { changes: { $each: items.reverse(), $position: 0, $slice: RECENT_KEPT } } },
      { upsert: true },
    );
  } catch (error) {
    logger.error({ err: error }, 'The changes a sync brought in could not be listed.');
  }
}

function present(change) {
  const newWords = NEW_RECORD_WORDS[change.coll];
  let undoBlocked = null;
  if (change.undoneAt) undoBlocked = 'Undone.';
  else if (change.wasNew) undoBlocked = newWords ? `A new record from the other side: ${newWords}.` : 'A new record from the other side.';
  else if (!change.before) undoBlocked = 'Too large to keep a copy of.';
  return {
    id: change.id,
    coll: change.coll,
    documentId: String(change.documentId),
    title: change.title,
    outcome: change.outcome,
    from: change.from,
    at: change.at,
    wasNew: change.wasNew,
    canUndo: !undoBlocked,
    undoBlocked,
    undoneAt: change.undoneAt,
    link: linkFor(change.coll, String(change.documentId)),
  };
}

export async function listIncoming(restaurantId, { db = mongoose.connection.db } = {}) {
  const state = await states(db).findOne({ _id: stateId(restaurantId) }, { projection: { changes: 1 } });
  return (state?.changes ?? []).map(present);
}

/** Writes `doc` back as this side's newest version of it. */
async function putBack(db, restaurantId, coll, doc) {
  const owner = coll === TENANT_COLLECTION ? doc._id : doc.restaurantId;
  if (String(owner) !== String(restaurantId)) throw new NotFoundError();
  try {
    await db.collection(coll).replaceOne({ _id: doc._id }, { ...doc, updatedAt: nowUtc() }, { upsert: true });
  } catch (error) {
    if (error?.code === 11000) throw new BusinessRuleError('That version clashes with another record now (a number or a name is taken). Change it on its own screen instead.');
    throw error;
  }
}

export async function undoIncoming(restaurantId, changeId, userId, { db = mongoose.connection.db } = {}) {
  const state = await states(db).findOne({ _id: stateId(restaurantId) });
  const change = (state?.changes ?? []).find((item) => item.id === changeId);
  if (!change) throw new NotFoundError();
  const shown = present(change);
  if (!shown.canUndo) throw new BusinessRuleError(`This change cannot be undone here. ${shown.undoBlocked}`);
  await putBack(db, restaurantId, change.coll, change.before);
  const at = nowUtc();
  await states(db).updateOne(
    { _id: stateId(restaurantId) },
    { $set: { 'changes.$[c].undoneAt': at, 'changes.$[c].undoneBy': userId } },
    { arrayFilters: [{ 'c.id': changeId }] },
  );
  return present({ ...change, undoneAt: at, undoneBy: userId });
}

/**
 * A sync conflict's version, chosen by a person: LOCAL (the side that found
 * it), INCOMING (the other side) or RESULT (what the merge kept, as it is).
 */
export async function keepConflictVersion(restaurantId, conflict, version, { db = mongoose.connection.db } = {}) {
  if (version === 'RESULT') return;
  const doc = version === 'LOCAL' ? conflict.localDoc : conflict.incomingDoc;
  if (!doc) throw new BusinessRuleError('That version was not kept with the conflict.');
  await putBack(db, restaurantId, conflict.coll, doc);
}
