/**
 * P63. One document's fingerprint, the same on both sides.
 *
 * Canonical EJSON (keys sorted at every level, exact types), then sha256. Two
 * copies of a document hash the same whatever order their fields were written
 * in, and an Int32 never passes for a Double.
 */
import { createHash } from 'node:crypto';

import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

export const DELETED_HASH = 'DELETED';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** The canonical text of a document: EJSON with its keys in order. */
export function canonicalText(doc) {
  // Through EJSON first, so ObjectIds, Dates and Decimals become plain objects whose keys sort too.
  const plain = EJSON.serialize(doc, { relaxed: false });
  return JSON.stringify(sortKeys(plain));
}

export function docHash(doc) {
  if (doc === null || doc === undefined) return DELETED_HASH;
  return createHash('sha256').update(canonicalText(doc)).digest('hex');
}

export function sameDoc(a, b) {
  return docHash(a) === docHash(b);
}
