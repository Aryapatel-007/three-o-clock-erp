/**
 * Batches the mirror refused because their epoch was stale. P62 section 8.
 *
 * A box that comes back after the cloud was promoted ships what it still had
 * queued. Those changes are never applied over the new writer's data, and
 * never thrown away either: they wait here for a person to read, with the seq
 * range, so the runbook's "what may be missing" question has an answer.
 * Append only.
 */
import mongoose from 'mongoose';

import { appendOnlyGuardPlugin } from './plugins/appendOnlyGuard.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

const quarantineSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sentEpoch: { type: Number, required: true },
    currentEpoch: { type: Number, required: true },
    firstSeq: { type: Number, required: true },
    lastSeq: { type: Number, required: true },
    /** The batch as it arrived, EJSON text, so types survive for a person to replay by hand. */
    entries: { type: String, required: true },
    receivedAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false },
);

quarantineSchema.plugin(tenantGuardPlugin);
quarantineSchema.plugin(appendOnlyGuardPlugin);
quarantineSchema.index({ restaurantId: 1, firstSeq: 1 });

export const ReplicationQuarantine = mongoose.model('ReplicationQuarantine', quarantineSchema, 'replicationquarantine');
