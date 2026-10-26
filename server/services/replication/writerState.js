/**
 * Whether this machine may write right now. P62 section 8.
 *
 * One writer per restaurant, at any moment. The box writes until it sees a
 * higher epoch, then stands down (`fenced`). The mirror writes nothing for a
 * restaurant but intake until a person promotes it. A CLOUD deployment is the
 * writer it always was.
 *
 * Held in memory, read from `replicationstate.writer` at boot and every 10
 * seconds, and updated at once by the code that changes it, so a request
 * never waits on a database read to learn whether it may write.
 */
import { logger } from '../../config/logger.js';
import { currentRole, isBox, ROLES } from '../../config/deployment.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { isTwoWay } from '../sync/mode.js';

const REFRESH_MS = 10_000;

const state = { epoch: 1, fenced: false, fencedReason: null, promoted: false, loadedAt: null };
let timer = null;

export function writerSnapshot() {
  return { ...state, role: currentRole() };
}

/** Loads the writer document, creating it at epoch 1 the first time. */
export async function loadWriterState() {
  const doc = await ReplicationState.findOneAndUpdate(
    { _id: REPLICATION_STATE_IDS.WRITER },
    { $setOnInsert: { epoch: 1, fenced: false, promoted: false } },
    { upsert: true, new: true },
  ).lean();
  state.epoch = doc.epoch;
  state.fenced = Boolean(doc.fenced);
  state.fencedReason = doc.fencedReason ?? null;
  state.promoted = Boolean(doc.promoted);
  state.loadedAt = nowUtc();
  return writerSnapshot();
}

export function startWriterStateRefresh() {
  if (timer) return;
  timer = setInterval(() => {
    loadWriterState().catch((error) => logger.warn({ err: error }, 'Could not refresh the writer state.'));
  }, REFRESH_MS);
  timer.unref?.();
}

export function stopWriterStateRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** The mirror, while it is a copy and not the writer. */
export function mirrorIsReadOnly() {
  return currentRole() === ROLES.MIRROR && !state.promoted;
}

/** The box after it stood down. */
export function boxIsFenced() {
  return currentRole() === ROLES.BOX && state.fenced;
}

/**
 * Whether background work that writes operational data may run here: the
 * outbound job loop, the intake puller. Never on a read-only mirror, never on
 * a fenced box, or two machines would send the same refund.
 */
export function mayRunWriterLoops() {
  // P63. Two writers, one job runner: the cloud, which has the internet and the
  // partners. Jobs made on the box reach it through the sync and are sent there once.
  if (isBox() && isTwoWay()) return false;
  return !mirrorIsReadOnly() && !boxIsFenced();
}

/**
 * The box stands down: it saw a higher epoch. Writes stop at once; the shipper
 * still sends what it has queued, which the mirror quarantines.
 */
export async function fenceThisBox(currentEpoch, reason) {
  state.fenced = true;
  state.fencedReason = reason;
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.WRITER },
    { $set: { fenced: true, fencedAt: nowUtc(), fencedReason: reason } },
    { upsert: true },
  );
  logger.fatal({ currentEpoch, reason }, 'This box has stood down: another machine holds a higher epoch. Writes are refused.');
}

/** Tests only: put the in-memory state back. */
export function resetWriterStateForTest() {
  Object.assign(state, { epoch: 1, fenced: false, fencedReason: null, promoted: false, loadedAt: null });
}
