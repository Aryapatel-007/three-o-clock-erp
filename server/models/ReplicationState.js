/**
 * Replication's own running state. P62, docs/REPLICATION.md section 7.
 *
 * Like `backupstate`, about this server and not a restaurant: no
 * `restaurantId`, no tenant guard, listed in `SERVER_MODELS`, LOCAL_ONLY in
 * `config/replication.js`, so it never ships. Documents by `_id`:
 *
 *   writer             the epoch this machine holds, and whether it may write.
 *                      On the box `fenced` means it stood down; on the mirror
 *                      `promoted` means a person made it the writer.
 *   changestream       the change stream resume token, saved after each batch.
 *   shipper:<rid>      the highest seq the mirror acknowledged, per restaurant.
 *   boxseen:<rid>      (mirror) when the box last checked in, per restaurant.
 *   reconcile:<rid>    the last reconciliation's outcome, per restaurant.
 *   clock              the last clock check and why it refused, if it did.
 */
import mongoose from 'mongoose';

export const REPLICATION_STATE_IDS = Object.freeze({
  WRITER: 'writer',
  CHANGE_STREAM: 'changestream',
  CLOCK: 'clock',
  shipper: (restaurantId) => `shipper:${restaurantId}`,
  boxSeen: (restaurantId) => `boxseen:${restaurantId}`,
  reconcile: (restaurantId) => `reconcile:${restaurantId}`,
  // P63, on the box: how far it has pulled the cloud's changelog.
  peerPull: (restaurantId) => `peerpull:${restaurantId}`,
  // P63, on the cloud: how far the box says it has pulled.
  peerSeen: (restaurantId) => `peerseen:${restaurantId}`,
});

const replicationStateSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    // writer
    epoch: { type: Number, default: 1, min: 1 },
    fenced: { type: Boolean, default: false },
    fencedAt: { type: Date, default: null },
    fencedReason: { type: String, default: null },
    promoted: { type: Boolean, default: false },
    promotedAt: { type: Date, default: null },
    // changestream
    resumeToken: { type: mongoose.Schema.Types.Mixed, default: null },
    baselineDoneAt: { type: Date, default: null },
    // shipper:<rid>
    shippedSeq: { type: Number, default: 0, min: 0 },
    shippedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    // boxseen:<rid>
    seenAt: { type: Date, default: null },
    // reconcile:<rid>
    status: { type: String, default: null },
    checkedAt: { type: Date, default: null },
    mismatches: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // peerpull:<rid> (P63, box)
    pulledSeq: { type: Number, default: 0, min: 0 },
    pulledAt: { type: Date, default: null },
    // peerseen:<rid> (P63, cloud)
    seenPeerSeq: { type: Number, default: 0, min: 0 },
    // clock
    refusing: { type: Boolean, default: false },
    newestKnownAt: { type: Date, default: null },
    observedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

export const ReplicationState = mongoose.model('ReplicationState', replicationStateSchema, 'replicationstate');
