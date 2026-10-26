/**
 * P63. The `syncdocs` bookkeeping: per document, the version both sides last
 * agreed on, what was written here from the other side (for the echo rule),
 * and the versions this side has held (to know a stale one when it arrives).
 *
 * Through the driver, by `<coll>:<id>`: this runs inside the change-stream
 * writer and the appliers, never in a request.
 */
import { nowUtc } from '../../utils/time.js';

import { canonicalText, docHash } from './hash.js';

const COLLECTION = 'syncdocs';
const APPLIED_KEPT = 8;
const KNOWN_KEPT = 16;

export const syncDocKey = (coll, documentId) => `${coll}:${canonicalText({ v: documentId })}`;

export function getSyncDoc(db, coll, documentId) {
  return db.collection(COLLECTION).findOne({ _id: syncDocKey(coll, documentId) });
}

function upsert(db, { restaurantId, coll, documentId }, update) {
  return db.collection(COLLECTION).updateOne(
    { _id: syncDocKey(coll, documentId) },
    { ...update, $setOnInsert: { restaurantId, coll, documentId, createdAt: nowUtc() }, $currentDate: { updatedAt: true } },
    { upsert: true },
  );
}

/** Both sides now hold `doc` (null for deleted). */
export function setBase(db, ref, doc) {
  const hash = docHash(doc);
  return upsert(db, ref, {
    $set: { baseHash: hash, baseDoc: doc ?? null },
    $push: { knownHashes: { $each: [hash], $slice: -KNOWN_KEPT } },
  });
}

/**
 * About to write `doc` here because the other side has it: the base, and a
 * note so the change stream knows this write when it comes round (no echo).
 */
export function noteApplied(db, ref, doc) {
  const hash = docHash(doc);
  return upsert(db, ref, {
    $set: { baseHash: hash, baseDoc: doc ?? null },
    $push: {
      appliedHashes: { $each: [hash], $slice: -APPLIED_KEPT },
      knownHashes: { $each: [hash], $slice: -KNOWN_KEPT },
    },
  });
}

/** This side's own new version: remembered, so the same version coming back later reads as stale. */
export function noteLocalVersion(db, ref, doc) {
  return upsert(db, ref, { $push: { knownHashes: { $each: [docHash(doc)], $slice: -KNOWN_KEPT } } });
}

/** True when this change is a write made here from the other side, coming round the change stream. */
export function isEcho(syncDoc, doc) {
  return Boolean(syncDoc?.appliedHashes?.includes(docHash(doc)));
}
