/**
 * P63. Per document, the version the cafe PC and the cloud last agreed on.
 *
 * Each side keeps its own; it never ships (config/replication.js). Read and
 * written through the driver by services/sync/, keyed by `<coll>:<id>`.
 *
 *   baseHash       sha256 of the agreed version's canonical EJSON, or DELETED
 *   baseDoc        the agreed version itself, for the three-way merge
 *   appliedHashes  the last few versions written here from the other side: a
 *                  change whose document has one of these is that write coming
 *                  back round the change stream, and is not sent back (no echo)
 *   knownHashes    the last versions this side has held; one arriving again
 *                  from the other side is old news and is not applied
 */
import mongoose from 'mongoose';

import { tenantGuardPlugin } from './plugins/tenantGuard.js';

const syncDocSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    coll: { type: String, required: true },
    documentId: { type: mongoose.Schema.Types.Mixed, required: true },
    baseHash: { type: String, default: null },
    baseDoc: { type: mongoose.Schema.Types.Mixed, default: null },
    appliedHashes: { type: [String], default: [] },
    /** The last versions this side has held, its own and applied: one of them arriving again is stale. */
    knownHashes: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false, minimize: false },
);

syncDocSchema.plugin(tenantGuardPlugin);
syncDocSchema.index({ restaurantId: 1, coll: 1 });

export const SyncDoc = mongoose.model('SyncDoc', syncDocSchema, 'syncdocs');

export default SyncDoc;
