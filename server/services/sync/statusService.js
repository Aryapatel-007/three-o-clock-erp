/**
 * P63. What the owner and manager read about two-way sync: how far each way
 * has got, the last error, and the conflicts waiting to be seen.
 */
import { config } from '../../config/env.js';
import { ReplicaCursor } from '../../models/ReplicaCursor.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { SYNC_NODES, SyncConflict } from '../../models/SyncConflict.js';
import { User } from '../../models/User.js';
import { NotFoundError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { shippingLag } from '../replication/shipper.js';
import { linkFor } from './conflicts.js';
import { syncMode, syncNode, isTwoWay } from './mode.js';

export function conflictsUnseen(restaurantId) {
  return SyncConflict.countDocuments({ restaurantId, seenAt: null });
}

export async function syncStatus(restaurantId) {
  const node = syncNode();
  const base = { mode: syncMode(), twoWay: isTwoWay(), node, conflictsUnseen: await conflictsUnseen(restaurantId) };
  if (!isTwoWay()) return base;
  if (node === SYNC_NODES.BOX) {
    const lag = await shippingLag(restaurantId);
    const pull = await ReplicationState.findById(REPLICATION_STATE_IDS.peerPull(restaurantId)).lean();
    const errors = [
      lag.lastErrorAt ? { message: lag.lastError, at: lag.lastErrorAt } : null,
      pull?.lastErrorAt && pull?.lastError ? { message: pull.lastError, at: pull.lastErrorAt } : null,
    ].filter(Boolean).sort((a, b) => b.at - a.at);
    return {
      ...base,
      peerUrl: config.MIRROR_URL ?? null,
      pushed: { shippedSeq: lag.shippedSeq, newestSeq: lag.newestSeq, waiting: lag.entriesWaiting, secondsBehind: lag.secondsBehind, at: lag.shippedAt },
      pulled: { seq: pull?.pulledSeq ?? 0, at: pull?.pulledAt ?? null },
      lastError: lag.lastError || pull?.lastError ? errors[0]?.message ?? null : null,
      lastErrorAt: lag.lastError || pull?.lastError ? errors[0]?.at ?? null : null,
    };
  }
  const cursor = await ReplicaCursor.findOne({ restaurantId }).lean();
  const seen = await ReplicationState.findById(REPLICATION_STATE_IDS.peerSeen(restaurantId)).lean();
  const boxSeen = await ReplicationState.findById(REPLICATION_STATE_IDS.boxSeen(restaurantId)).lean();
  return {
    ...base,
    pushed: { seenByBoxSeq: seen?.seenPeerSeq ?? 0 },
    pulled: { seq: cursor?.appliedSeq ?? 0, at: cursor?.appliedAt ?? null },
    boxLastSeenAt: boxSeen?.seenAt ?? null,
    boxSecondsAgo: boxSeen?.seenAt ? Math.round((nowUtc() - new Date(boxSeen.seenAt)) / 1000) : null,
    lastError: null,
    lastErrorAt: null,
  };
}

function present(conflict, names) {
  return {
    id: String(conflict._id),
    coll: conflict.coll,
    documentId: String(conflict.documentId),
    kind: conflict.kind,
    title: conflict.title,
    detail: conflict.detail,
    fields: conflict.fields ?? [],
    keptFrom: conflict.keptFrom,
    detectedOn: conflict.detectedOn,
    detectedAt: conflict.detectedAt,
    seenAt: conflict.seenAt,
    seenByName: conflict.seenBy ? names.get(String(conflict.seenBy)) ?? null : null,
    link: linkFor(conflict.coll, String(conflict.documentId)),
    // 2026-10-22. The versions a person can choose to keep (POST .../keep): LOCAL is the side that found it.
    versions: [
      ...(conflict.localDoc ? [{ key: 'LOCAL', from: conflict.detectedOn }] : []),
      ...(conflict.incomingDoc ? [{ key: 'INCOMING', from: conflict.detectedOn === SYNC_NODES.BOX ? SYNC_NODES.CLOUD : SYNC_NODES.BOX }] : []),
    ],
  };
}

/** One conflict with its kept versions, for choosing one. */
export async function readConflict(restaurantId, conflictId) {
  const conflict = await SyncConflict.findOne({ _id: conflictId, restaurantId }).lean();
  if (!conflict) throw new NotFoundError();
  return conflict;
}

async function namesFor(restaurantId, conflicts) {
  const ids = [...new Set(conflicts.map((conflict) => conflict.seenBy).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const users = await User.find({ restaurantId, _id: { $in: ids } }).select('name').lean();
  return new Map(users.map((user) => [String(user._id), user.name]));
}

export async function listConflicts(restaurantId, { seen = false, page = 1, limit = 50 }) {
  const filter = { restaurantId, seenAt: seen ? { $ne: null } : null };
  const [rows, total] = await Promise.all([
    SyncConflict.find(filter).sort({ detectedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    SyncConflict.countDocuments(filter),
  ]);
  const names = await namesFor(restaurantId, rows);
  return { rows: rows.map((row) => present(row, names)), total };
}

export async function markConflictSeen(restaurantId, conflictId, userId) {
  const conflict = await SyncConflict.findOneAndUpdate(
    { _id: conflictId, restaurantId },
    { $set: { seenAt: nowUtc(), seenBy: userId } },
    { new: true },
  ).lean();
  if (!conflict) throw new NotFoundError();
  return present(conflict, await namesFor(restaurantId, [conflict]));
}
