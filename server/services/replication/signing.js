/**
 * How the box and the mirror trust each other. P62, docs/REPLICATION.md section 5.
 *
 * Every replication request is canonical EJSON text, so an ObjectId stays an
 * ObjectId and a Date a Date on the far side, and carries
 * `X-Replication-Signature: sha256=<hex>`, an HMAC of the exact bytes under
 * REPLICATION_SECRET. Nothing else authenticates these routes: no session, no
 * cookie, no tenant from a token. The restaurant named in the body is the one
 * the signed sender says it is.
 *
 * There is no timestamp in the signature on purpose: the box's clock may be
 * wrong (section 2.6), and every replication write is idempotent, so a
 * replayed request changes nothing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

export const SIGNATURE_HEADER = 'x-replication-signature';
export const EJSON_CONTENT_TYPE = 'application/ejson';

export function sign(secret, text) {
  return `sha256=${createHmac('sha256', secret).update(text, 'utf8').digest('hex')}`;
}

export function signatureMatches(secret, text, given) {
  if (!secret || typeof given !== 'string') return false;
  const expected = Buffer.from(sign(secret, text));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Types kept: ObjectId, Date, Decimal128, Long. */
export const toWire = (value) => EJSON.stringify(value, { relaxed: false });
export const fromWire = (text) => EJSON.parse(text, { relaxed: false });
