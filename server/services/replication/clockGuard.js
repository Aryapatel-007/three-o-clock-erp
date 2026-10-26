/**
 * The box's clock. P62 section 2.6, docs/RUNBOOK.md section 4.
 *
 * Which business day a sale belongs to, its bill's timestamp and its GST
 * invoice date all come from `nowUtc()`. A box that runs for days without
 * internet keeps its own time, and one whose clock battery has died comes back
 * from a power cut dated in the past.
 *
 * So, at boot and every minute, the box compares its clock with the newest
 * thing it has already recorded: the newest changelog capture and the newest
 * bill. If the clock is behind either by more than the tolerance, it refuses
 * every write with CLOCK_BEHIND, which the till shows in plain words. It never
 * silently bills on the wrong day. It starts writing again by itself once the
 * clock is right.
 *
 * The changelog's order is its `seq`, so none of this can reorder replication.
 */
import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';

/** Two minutes: more than the drift between a request and its changelog entry, less than any real error. */
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
export const CLOCK_CHECK_EVERY_MS = 60_000;

const state = { refusing: false, newestKnownAt: null, observedAt: null, checkedAt: null };

export function clockSnapshot() {
  return { ...state };
}

/** The newest instant this box has recorded, across restaurants. Read through the driver: it spans tenants. */
export async function newestRecordedAt(db = mongoose.connection.db) {
  const [entry, bill] = await Promise.all([
    db.collection('changelog').find({}, { projection: { capturedAt: 1 } }).sort({ capturedAt: -1 }).limit(1).next(),
    db.collection('bills').find({}, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).limit(1).next(),
  ]);
  const times = [entry?.capturedAt, bill?.createdAt].filter(Boolean).map((value) => new Date(value).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Checks once. Gives back true while writes are refused. */
export async function checkClock({ db, now = nowUtc() } = {}) {
  const newest = await newestRecordedAt(db);
  const refusing = Boolean(newest && now.getTime() < newest.getTime() - CLOCK_TOLERANCE_MS);
  if (refusing && !state.refusing) {
    logger.fatal({ now, newestRecordedAt: newest }, "The box's clock is behind its newest record. Writes are refused until it is set right (docs/RUNBOOK.md section 4).");
  }
  if (!refusing && state.refusing) logger.info({ now }, "The box's clock is right again. Writes are allowed.");
  Object.assign(state, { refusing, newestKnownAt: newest, observedAt: now, checkedAt: nowUtc() });
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.CLOCK },
    { $set: { refusing, newestKnownAt: newest, observedAt: now } },
    { upsert: true },
  ).catch(() => {});
  return refusing;
}

export function clockIsRefusing() {
  return state.refusing;
}

/** Tests only. */
export function resetClockGuardForTest() {
  Object.assign(state, { refusing: false, newestKnownAt: null, observedAt: null, checkedAt: null });
}
