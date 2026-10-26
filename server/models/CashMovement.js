/**
 * The cash drawer's non-sale entries: the opening float, cash paid in, and cash
 * paid out. M16, built in P10. Shapes from docs/DB-SCHEMA.md section 24.
 *
 * The business date is always the business day of the moment the entry was
 * written. No request can set it, so nothing can be back-dated into a day.
 * Voided, never deleted.
 */
import mongoose from 'mongoose';

import { MAX_PAISE } from '../utils/money.js';
import { applyJsonTransform } from './plugins/jsonTransform.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const CASH_MOVEMENT_TYPES = Object.freeze({
  OPENING_FLOAT: 'OPENING_FLOAT',
  // P29 Part F. Shown as a top-up on every screen.
  PAID_IN: 'PAID_IN',
  // P29 Part F. Shown as an expense on every screen.
  PAID_OUT: 'PAID_OUT',
  // P29 Part F. Cash removed that is not an expense: a bank deposit, or given to the owner.
  CASH_TAKEN_OUT: 'CASH_TAKEN_OUT',
  // P29 Part F. A count during the day. Moves no money.
  CASH_CHECK: 'CASH_CHECK',
});

/** P29 Part F. Where a top-up came from, and where cash taken out went. */
export const TOP_UP_SOURCES = Object.freeze(['OWNER', 'BANK', 'CHANGE', 'OTHER']);
export const TAKEN_OUT_DESTINATIONS = Object.freeze(['BANK_DEPOSIT', 'OWNER', 'OTHER']);
export const CASH_MOVEMENT_TYPE_VALUES = Object.freeze(Object.values(CASH_MOVEMENT_TYPES));

/** One row of a count by notes and coins. P25 Part F. Shared with dayclosures. */
export const cashCountRowSchema = new mongoose.Schema(
  {
    valueInPaise: { type: Number, required: true, min: 1 },
    kind: { type: String, required: true, enum: ['NOTE', 'COIN'] },
    count: { type: Number, required: true, min: 0, max: 10_000, validate: { validator: Number.isInteger, message: 'Must be a whole number.' } },
  },
  { _id: false },
);

const cashMovementSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: CASH_MOVEMENT_TYPE_VALUES },
  /** P29: 0 is allowed on a cash check only, an empty drawer counted; every other entry is at least 1. */
  amountInPaise: {
    type: Number,
    required: true,
    min: 0,
    max: MAX_PAISE,
    validate: [
      { validator: Number.isInteger, message: 'Must be a whole number of paise.' },
      {
        validator(value) {
          return value >= 1 || this.type === CASH_MOVEMENT_TYPES.CASH_CHECK;
        },
        message: 'Must be more than zero.',
      },
    ],
  },
  reason: { type: String, trim: true, maxlength: 200, default: null },
  businessDate: { type: String, required: true },
  at: { type: Date, required: true },
  by: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  // P28. The owner or manager who typed their PIN for a cashier's paid in or paid out.
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  isVoided: { type: Boolean, required: true, default: false },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // 2026-10-17. The owner or manager whose PIN approved a cashier's void.
  voidApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  voidReason: { type: String, trim: true, maxlength: 200, default: null },

  /** P25 Part F. An opening float counted by notes and coins: [{ valueInPaise, kind, count }]. */
  cashCount: { type: [cashCountRowSchema], default: undefined },

  /** P29 Part F. docs/DB-SCHEMA.md section 43. */
  source: { type: String, enum: [...TOP_UP_SOURCES, null], default: null },
  category: { type: String, trim: true, maxlength: 30, default: null },
  categoryLabel: { type: String, trim: true, maxlength: 40, default: null },
  destination: { type: String, enum: [...TAKEN_OUT_DESTINATIONS, null], default: null },
  takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  broughtForwardFrom: { type: String, default: null },
  openingDifferenceInPaise: { type: Number, default: null },
  expectedCashInPaise: { type: Number, default: null },
  differenceInPaise: { type: Number, default: null },
});

cashMovementSchema.plugin(baseSchemaPlugin);
cashMovementSchema.plugin(tenantGuardPlugin);

/**
 * One live opening float per business date. Partial on equality only, as
 * MongoDB requires: a voided float leaves the filter and frees the slot.
 */
cashMovementSchema.index(
  { restaurantId: 1, branchId: 1, businessDate: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'OPENING_FLOAT', isVoided: false } },
);

/** A day's drawer. */
cashMovementSchema.index({ restaurantId: 1, branchId: 1, businessDate: 1, at: 1 });

applyJsonTransform(cashMovementSchema);

export const CashMovement = mongoose.model('CashMovement', cashMovementSchema);

export default CashMovement;
