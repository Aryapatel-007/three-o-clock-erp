/**
 * How far the mirror has applied each restaurant's changelog. P62, mirror only.
 *
 * Written only by the replication receiver, in the same transaction as the
 * changes it applies, so `appliedSeq` is always exactly the last entry whose
 * change is in the copy. A batch that does not start at `appliedSeq + 1` is
 * refused with REPLICATION_GAP and the gap is kept here for the owner to see.
 */
import mongoose from 'mongoose';

import { tenantGuardPlugin } from './plugins/tenantGuard.js';

const replicaCursorSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    appliedSeq: { type: Number, required: true, default: 0, min: 0 },
    appliedAt: { type: Date, default: null },
    /** The box's capture time of the last applied entry: "figures as of". */
    lastCapturedAt: { type: Date, default: null },
    epoch: { type: Number, required: true, default: 1, min: 1 },
    gap: {
      expectedSeq: { type: Number, default: null },
      gotSeq: { type: Number, default: null },
      at: { type: Date, default: null },
    },
  },
  { timestamps: true, versionKey: false },
);

replicaCursorSchema.plugin(tenantGuardPlugin);
replicaCursorSchema.index({ restaurantId: 1 }, { unique: true });

export const ReplicaCursor = mongoose.model('ReplicaCursor', replicaCursorSchema, 'replicacursors');
