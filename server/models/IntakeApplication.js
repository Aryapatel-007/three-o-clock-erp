/**
 * The box's record of applying one intake item. P62 section 5.2.
 *
 * Written on the box before an item is applied (STARTED) and after (APPLIED
 * or REJECTED). A crash between the two leaves STARTED, and the next claim
 * applies it again: the services it calls are idempotent on the request's own
 * key (an online order's `idempotencyKey`, a webhook's event id), so the
 * second apply finds what the first made instead of making it twice.
 *
 * MIRROR: the outcome travels up the changelog like any other state.
 */
import mongoose from 'mongoose';

import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const INTAKE_APPLICATION_STATUSES = Object.freeze({
  STARTED: 'STARTED',
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
});

const intakeApplicationSchema = new mongoose.Schema({
  intakeId: { type: String, required: true },
  source: { type: String, required: true },
  status: { type: String, required: true, enum: Object.values(INTAKE_APPLICATION_STATUSES) },
  attempts: { type: Number, default: 1 },
  reasonCode: { type: String, default: null },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  reportedAt: { type: Date, default: null },
});

intakeApplicationSchema.plugin(baseSchemaPlugin);
intakeApplicationSchema.plugin(tenantGuardPlugin);
intakeApplicationSchema.index({ restaurantId: 1, intakeId: 1 }, { unique: true });

export const IntakeApplication = mongoose.model('IntakeApplication', intakeApplicationSchema, 'intakeapplications');
