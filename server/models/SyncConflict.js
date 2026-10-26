/**
 * P63. Something the cafe PC and the cloud both changed, or both claimed,
 * before they could tell each other. Ships both ways, so both sides list it.
 *
 * Written by services/sync/ through the driver as it applies the other side's
 * changes, and read by the owner's and manager's Sync screen. Nothing here
 * changes the records it describes: the fix is made on the ordinary screens.
 */
import mongoose from 'mongoose';

import { SYNC_CONFLICT_KINDS, SYNC_NODES } from '../config/sync.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export { SYNC_CONFLICT_KINDS, SYNC_NODES };

const syncConflictSchema = new mongoose.Schema({
  coll: { type: String, required: true },
  documentId: { type: mongoose.Schema.Types.Mixed, required: true },
  kind: { type: String, required: true, enum: Object.values(SYNC_CONFLICT_KINDS) },
  title: { type: String, required: true, maxlength: 200 },
  detail: { type: String, default: null, maxlength: 1000 },
  fields: { type: [String], default: [] },
  keptFrom: { type: String, enum: Object.values(SYNC_NODES), required: true },
  detectedOn: { type: String, enum: Object.values(SYNC_NODES), required: true },
  detectedAt: { type: Date, required: true },
  localDoc: { type: mongoose.Schema.Types.Mixed, default: null },
  incomingDoc: { type: mongoose.Schema.Types.Mixed, default: null },
  resultDoc: { type: mongoose.Schema.Types.Mixed, default: null },
  seenAt: { type: Date, default: null },
  seenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { minimize: false });

syncConflictSchema.plugin(baseSchemaPlugin);
syncConflictSchema.plugin(tenantGuardPlugin);
syncConflictSchema.index({ restaurantId: 1, seenAt: 1, detectedAt: -1 });

export const SyncConflict = mongoose.model('SyncConflict', syncConflictSchema);

export default SyncConflict;
