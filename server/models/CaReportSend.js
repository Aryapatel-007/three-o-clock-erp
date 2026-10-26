/**
 * One month's CA pack, sent or not. P65, docs/DB-SCHEMA.md section 61.
 *
 * One row per restaurant and month, by a unique index rather than a check in
 * a service: a check has a race in its middle, and two machines, a restart or
 * a retry must never email the same month twice. The row is claimed before the
 * pack is built (SENDING), and ends SENT, FAILED or REFUSED.
 *
 * Holds no figure and no address but the CA's own, kept so the owner can see
 * where each month went.
 */
import mongoose from 'mongoose';

import { applyJsonTransform } from './plugins/jsonTransform.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const CA_SEND_STATUSES = Object.freeze({ SENDING: 'SENDING', SENT: 'SENT', FAILED: 'FAILED', REFUSED: 'REFUSED' });
export const CA_SEND_STATUS_VALUES = Object.freeze(Object.values(CA_SEND_STATUSES));
export const CA_SEND_TRIGGERS = Object.freeze({ AUTO: 'AUTO', MANUAL: 'MANUAL' });

const caReportSendSchema = new mongoose.Schema({
  period: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  status: { type: String, required: true, enum: CA_SEND_STATUS_VALUES },
  trigger: { type: String, required: true, enum: Object.values(CA_SEND_TRIGGERS), default: CA_SEND_TRIGGERS.AUTO },
  refusedReason: { type: String, default: null },
  openDates: { type: [String], default: [] },
  failedChecks: { type: [String], default: [] },
  claimedAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  to: { type: [String], default: [] },
  files: { type: [String], default: [] },
  checks: {
    passed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  attempts: { type: Number, required: true, default: 0, min: 0 },
  lastError: { type: String, default: null },
  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
});

caReportSendSchema.plugin(baseSchemaPlugin);
caReportSendSchema.plugin(tenantGuardPlugin);

/** One month, one row: what makes a second send for a month impossible. */
caReportSendSchema.index({ restaurantId: 1, period: 1 }, { unique: true });

applyJsonTransform(caReportSendSchema);

export const CaReportSend = mongoose.model('CaReportSend', caReportSendSchema, 'careportsends');

export default CaReportSend;
