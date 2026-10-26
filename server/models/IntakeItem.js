/**
 * Intake: a request from the internet, waiting for the cafe box. P62 section 5.
 *
 * The one collection the mirror writes for a restaurant. An online order, a
 * booking, a guest's cancel or payment return, a Razorpay or partner webhook:
 * each is kept as it arrived, never turned into an order here. The box claims
 * items oldest first and applies them through the same services a till uses,
 * then reports APPLIED with what it made, or REJECTED with a reason code.
 *
 * `externalId` is unique per restaurant and source, so a webhook delivered
 * three times is one item.
 */
import mongoose from 'mongoose';

import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const INTAKE_SOURCES = Object.freeze({
  ONLINE_ORDER: 'ONLINE_ORDER',
  ONLINE_ORDER_CANCEL: 'ONLINE_ORDER_CANCEL',
  ONLINE_ORDER_PAYMENT_RETURN: 'ONLINE_ORDER_PAYMENT_RETURN',
  RESERVATION: 'RESERVATION',
  RESERVATION_CANCEL: 'RESERVATION_CANCEL',
  RESERVATION_PAYMENT_RETURN: 'RESERVATION_PAYMENT_RETURN',
  RAZORPAY_WEBHOOK: 'RAZORPAY_WEBHOOK',
  PARTNER_WEBHOOK: 'PARTNER_WEBHOOK',
});

export const INTAKE_STATUSES = Object.freeze({
  RECEIVED: 'RECEIVED',
  CLAIMED: 'CLAIMED',
  APPLIED: 'APPLIED',
  REJECTED: 'REJECTED',
});

const intakeItemSchema = new mongoose.Schema({
  source: { type: String, required: true, enum: Object.values(INTAKE_SOURCES) },
  externalId: { type: String, required: true, maxlength: 200 },
  /** What the route needs to replay the request on the box: slug, ids, provider and key. */
  params: { type: mongoose.Schema.Types.Mixed, default: {} },
  /** The validated JSON body, for a guest's request. */
  body: { type: mongoose.Schema.Types.Mixed, default: null },
  /** The raw bytes a partner signed, as text, for a webhook. */
  rawBody: { type: String, default: null },
  /** The few headers a signature check or status token needs. Never cookies. */
  headers: { type: mongoose.Schema.Types.Mixed, default: {} },
  receivedAt: { type: Date, required: true },
  status: { type: String, required: true, enum: Object.values(INTAKE_STATUSES), default: INTAKE_STATUSES.RECEIVED },
  claimedAt: { type: Date, default: null },
  claimExpiresAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  decidedAt: { type: Date, default: null },
  reasonCode: { type: String, default: null },
  reasonMessage: { type: String, default: null },
  /** What the box made: { onlineOrderId } or { reservationId }, never a secret. */
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  /**
   * The guest's status token for what the box made, held until the guest who
   * placed the request collects it once with their intake secret, then cleared.
   */
  pendingStatusToken: { type: String, default: null, select: false },
  /** sha256 of the secret handed to the guest at intake, so only they can collect. */
  guestSecretHash: { type: String, default: null },
});

intakeItemSchema.plugin(baseSchemaPlugin);
intakeItemSchema.plugin(tenantGuardPlugin);

intakeItemSchema.index({ restaurantId: 1, source: 1, externalId: 1 }, { unique: true });
intakeItemSchema.index({ restaurantId: 1, status: 1, receivedAt: 1 });

export const IntakeItem = mongoose.model('IntakeItem', intakeItemSchema, 'intake');
