/**
 * Reconciliation. P62 section 4.3, docs/REPLICATION.md section 8.
 *
 * The continuous path can drift without anyone knowing, and a snapshot only
 * says what was true when it was taken. This proves the copy is the box,
 * today: for every MIRROR collection, the count and a SHA-256 over every
 * document of the restaurant in canonical EJSON, sorted by `_id`, computed on
 * each side, and the same for the day's bills on their own, so a mismatch in
 * money is named as money.
 *
 * Compared only when the shipper has nothing waiting: while entries are in
 * flight the two sides are meant to differ, and saying so would be noise.
 *
 * A mismatch is an alert the owner sees (`/network/status`, the dashboard's
 * Sync card, the top bar for OWNER and MANAGER), never only a log line.
 */
import { createHash } from 'node:crypto';

import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { mirrorCollectionNames, TENANT_COLLECTION } from './collections.js';
import { postToMirror, shippingLag } from './shipper.js';
import { toWire } from './signing.js';

const { ObjectId } = mongoose.Types;

export const RECONCILE_STATUSES = Object.freeze({ MATCH: 'MATCH', MISMATCH: 'MISMATCH', WAITING: 'WAITING', UNREACHABLE: 'UNREACHABLE' });

const asId = (value) => (value instanceof ObjectId ? value : new ObjectId(String(value)));

async function digest(cursor) {
  const hash = createHash('sha256');
  let count = 0;
  for await (const doc of cursor) {
    hash.update(toWire(doc));
    hash.update('\n');
    count += 1;
  }
  return { count, sha256: hash.digest('hex') };
}

/**
 * Count and digest of every MIRROR collection for one restaurant, and of one
 * business day's bills. Read through the driver, as the receiver writes.
 */
export async function digestRestaurant(restaurantId, { businessDate = null, db = mongoose.connection.db } = {}) {
  const id = asId(restaurantId);
  const collections = {};
  for (const coll of mirrorCollectionNames()) {
    const filter = coll === TENANT_COLLECTION ? { _id: id } : { restaurantId: id };
    collections[coll] = await digest(db.collection(coll).find(filter, { sort: { _id: 1 } }));
  }
  const bills = businessDate
    ? await digest(db.collection('bills').find({ restaurantId: id, businessDate }, { sort: { _id: 1 } }))
    : null;
  return { collections, bills, businessDate };
}

/** What differs between the box's digest and the mirror's, in words a person can act on. */
export function compareDigests(local, remote) {
  const mismatches = [];
  if (local.bills && remote.bills && local.bills.sha256 !== remote.bills.sha256) {
    mismatches.push({ coll: 'bills', scope: `bills of ${local.businessDate}`, boxCount: local.bills.count, mirrorCount: remote.bills.count });
  }
  for (const [coll, mine] of Object.entries(local.collections)) {
    const theirs = remote.collections?.[coll] ?? { count: 0, sha256: null };
    if (mine.sha256 !== theirs.sha256) mismatches.push({ coll, scope: 'all', boxCount: mine.count, mirrorCount: theirs.count });
  }
  return mismatches;
}

async function saveOutcome(restaurantId, status, mismatches = []) {
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.reconcile(restaurantId) },
    { $set: { status, checkedAt: nowUtc(), mismatches } },
    { upsert: true },
  );
}

/** One reconciliation for one restaurant, from the box. Gives back the status. */
export async function reconcileOnce(restaurantId, { businessDate, ...options } = {}) {
  const lag = await shippingLag(restaurantId);
  if (lag.entriesWaiting > 0) {
    await saveOutcome(restaurantId, RECONCILE_STATUSES.WAITING);
    return RECONCILE_STATUSES.WAITING;
  }
  let answer;
  try {
    answer = await postToMirror('/reconcile', { restaurantId: asId(restaurantId), businessDate }, options);
  } catch (error) {
    logger.warn({ err: error }, 'Reconciliation could not reach the mirror.');
    await saveOutcome(restaurantId, RECONCILE_STATUSES.UNREACHABLE);
    return RECONCILE_STATUSES.UNREACHABLE;
  }
  if (answer.status !== 200) {
    await saveOutcome(restaurantId, RECONCILE_STATUSES.UNREACHABLE);
    return RECONCILE_STATUSES.UNREACHABLE;
  }
  // A change may have landed while the mirror counted. Only a quiet changelog makes a mismatch real.
  const local = await digestRestaurant(restaurantId, { businessDate });
  const after = await shippingLag(restaurantId);
  if (after.newestSeq !== lag.newestSeq) {
    await saveOutcome(restaurantId, RECONCILE_STATUSES.WAITING);
    return RECONCILE_STATUSES.WAITING;
  }
  const mismatches = compareDigests(local, answer.body.data);
  const status = mismatches.length === 0 ? RECONCILE_STATUSES.MATCH : RECONCILE_STATUSES.MISMATCH;
  if (status === RECONCILE_STATUSES.MISMATCH) logger.error({ restaurantId: String(restaurantId), mismatches }, 'Reconciliation found the cloud copy differs from the box.');
  await saveOutcome(restaurantId, status, mismatches);
  return status;
}
