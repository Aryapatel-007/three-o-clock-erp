/**
 * The changelog. P62, docs/REPLICATION.md section 3.
 *
 * One entry for every change the box makes to a MIRROR collection, written by
 * the changelog writer from the local change stream, never by a service. The
 * shipper sends entries to the mirror in `seq` order, and the mirror applies
 * them as idempotent upserts by `documentId`.
 *
 * `seq` is per restaurant, reserved in the same transaction that inserts the
 * entry, so a missing number is a fault the mirror can see. Ordering is `seq`,
 * never a clock: clock trouble cannot reorder replication.
 *
 * APPEND ONLY, by construction, like `auditlogs`: no update path, no delete
 * path, and `tests/replication.test.js` fails if one appears. Never pruned.
 * docs/REPLICATION.md section 3.4 sizes the disk for keeping it.
 *
 * No `branchId`: a change to `restaurants` belongs to no branch. The tenant
 * guard still applies.
 */
import mongoose from 'mongoose';

import { appendOnlyGuardPlugin } from './plugins/appendOnlyGuard.js';
import { applyJsonTransform } from './plugins/jsonTransform.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const CHANGE_OPERATIONS = Object.freeze({
  INSERT: 'insert',
  UPDATE: 'update',
  REPLACE: 'replace',
  DELETE: 'delete',
  // The writer's first look at a document that existed before the changelog did.
  BASELINE: 'baseline',
});

const changelogEntrySchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    seq: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'Must be a whole number.' } },
    epoch: { type: Number, required: true, min: 1 },
    coll: { type: String, required: true },
    documentId: { type: mongoose.Schema.Types.Mixed, required: true },
    op: { type: String, required: true, enum: Object.values(CHANGE_OPERATIONS) },
    /** The whole document after the change; null for a delete. */
    doc: { type: mongoose.Schema.Types.Mixed, default: null },
    /** The box's clock when the writer captured it. Shown, never used for ordering. */
    capturedAt: { type: Date, required: true },
    /**
     * The change stream event's id, so an event read twice after a crash is
     * one entry: the second insert fails on the unique index and the seq it
     * reserved rolls back with it. Null for a baseline entry.
     */
    eventId: { type: String, default: null },
  },
  { timestamps: false, versionKey: false, minimize: false },
);

changelogEntrySchema.plugin(tenantGuardPlugin);
changelogEntrySchema.plugin(appendOnlyGuardPlugin);
applyJsonTransform(changelogEntrySchema);

changelogEntrySchema.index({ restaurantId: 1, seq: 1 }, { unique: true });
changelogEntrySchema.index({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });
// The clock check reads the newest capture.
changelogEntrySchema.index({ restaurantId: 1, capturedAt: -1 });
// A delete carries no document, so the writer finds its restaurant from the last entry for it.
changelogEntrySchema.index({ coll: 1, documentId: 1, seq: -1 });

export const ChangelogEntry = mongoose.model('ChangelogEntry', changelogEntrySchema, 'changelog');
