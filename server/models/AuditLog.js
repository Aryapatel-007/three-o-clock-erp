/**
 * Who did the thing that involved money or trust, when, and why.
 *
 * Shapes come from docs/DB-SCHEMA.md section 13.
 *
 * BUILD-PLAN section 7 calls the audit trail the feature that sells this
 * product to an owner losing money to a dishonest cashier. M5 decision D3
 * deferred the shared collection to M3 on the grounds that M3 would be the
 * module to need it. This is that collection.
 *
 * APPEND ONLY, by construction since M8: `appendOnlyGuardPlugin` throws on
 * every update, replace and delete, and on saving an existing document. There
 * is no update and no delete endpoint. A tamperable audit log is worse than
 * none, because it is trusted. No TTL index, ever.
 */
import mongoose from 'mongoose';

import { MAX_PAISE } from '../utils/money.js';
import { appendOnlyGuardPlugin } from './plugins/appendOnlyGuard.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

/**
 * Closed, like the role list. A new action is a deliberate addition.
 *
 * Append only, the same discipline `utils/errors.js` follows. `SETTINGS_CHANGED`
 * was appended by M7 and `LINE_CANCELLED_AFTER_PREP` by P04; nothing above
 * either was touched.
 */
export const AUDIT_ACTIONS = Object.freeze({
  BILL_VOIDED: 'BILL_VOIDED',
  DISCOUNT_APPLIED: 'DISCOUNT_APPLIED',
  STOCK_ADJUSTED: 'STOCK_ADJUSTED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  // P04. A line cancelled after the kitchen made it: food made and thrown away.
  LINE_CANCELLED_AFTER_PREP: 'LINE_CANCELLED_AFTER_PREP',
  // P08. A payment's method changed after the fact, and food given away free.
  PAYMENT_METHOD_CORRECTED: 'PAYMENT_METHOD_CORRECTED',
  NO_CHARGE_GIVEN: 'NO_CHARGE_GIVEN',
  // P09. A sale whose money arrives later, a balance written off, platform money.
  BILL_CHARGED_TO_ACCOUNT: 'BILL_CHARGED_TO_ACCOUNT',
  ACCOUNT_BALANCE_ADJUSTED: 'ACCOUNT_BALANCE_ADJUSTED',
  PLATFORM_PAYOUT_RECORDED: 'PLATFORM_PAYOUT_RECORDED',
  // P10. Cash leaving the drawer, a day locked, and a locked day opened again.
  CASH_PAID_OUT: 'CASH_PAID_OUT',
  DAY_CLOSED: 'DAY_CLOSED',
  DAY_REOPENED: 'DAY_REOPENED',
  // M8, built in P17. Quiet changes to people, prices and recipes.
  USER_DEACTIVATED: 'USER_DEACTIVATED',
  USER_REACTIVATED: 'USER_REACTIVATED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_PASSWORD_RESET: 'USER_PASSWORD_RESET',
  USER_PIN_RESET: 'USER_PIN_RESET',
  MENU_PRICE_CHANGED: 'MENU_PRICE_CHANGED',
  RECIPE_CHANGED: 'RECIPE_CHANGED',
  // P22. The restaurant's logo set or removed. Details never carry the bytes.
  BRAND_LOGO_SET: 'BRAND_LOGO_SET',
  BRAND_LOGO_REMOVED: 'BRAND_LOGO_REMOVED',
  // P24. The cafe's Razorpay account connected or disconnected. Never a secret.
  PAYMENT_GATEWAY_CONNECTED: 'PAYMENT_GATEWAY_CONNECTED',
  PAYMENT_GATEWAY_DISCONNECTED: 'PAYMENT_GATEWAY_DISCONNECTED',
  // P25 Part E. A paid bill voided and re-issued smaller; money returned outside the system.
  BILL_LINES_CANCELLED_AFTER_BILLING: 'BILL_LINES_CANCELLED_AFTER_BILLING',
  REFUND_RECORDED: 'REFUND_RECORDED',
  // P25 Part G. A partner connection saved, its credentials replaced, stopped or started.
  INTEGRATION_CONNECTED: 'INTEGRATION_CONNECTED',
  INTEGRATION_CREDENTIALS_CHANGED: 'INTEGRATION_CREDENTIALS_CHANGED',
  INTEGRATION_PAUSED: 'INTEGRATION_PAUSED',
  INTEGRATION_RESUMED: 'INTEGRATION_RESUMED',
  // P25 Part H. A platform order turned away, with the reason.
  PLATFORM_ORDER_REJECTED: 'PLATFORM_ORDER_REJECTED',
  // P25 Part I. A card-machine method recorded by hand, with the reason.
  TERMINAL_BYPASSED: 'TERMINAL_BYPASSED',
  // P26. A bill voided so the table could order more; the next bill carries its payments.
  BILL_REOPENED: 'BILL_REOPENED',
  // P27. The customers who agreed to offers, downloaded. Details carry the count, never a phone.
  CUSTOMERS_EXPORTED: 'CUSTOMERS_EXPORTED',
  // P25 Part J. A day's vouchers reached Tally, or were built again after the owner deleted them there.
  TALLY_EXPORT_POSTED: 'TALLY_EXPORT_POSTED',
  TALLY_EXPORT_REDONE: 'TALLY_EXPORT_REDONE',
  // P25 Part K. A computer given, or refused, the right to post into Tally.
  TALLY_BRIDGE_PAIRED: 'TALLY_BRIDGE_PAIRED',
  TALLY_BRIDGE_REVOKED: 'TALLY_BRIDGE_REVOKED',
  // P28. A cancel or a paid in a manager approved by PIN on someone else's screen.
  LINE_CANCELLED_APPROVED: 'LINE_CANCELLED_APPROVED',
  CASH_PAID_IN: 'CASH_PAID_IN',
  // P29. An unpaid bill's items changed under the same number; a kitchen tick taken back.
  BILL_REVISED: 'BILL_REVISED',
  KITCHEN_READY_UNDONE: 'KITCHEN_READY_UNDONE',
  // P29 Part F. Cash out of the drawer that is not an expense; a morning float that was not what was kept.
  CASH_TAKEN_OUT: 'CASH_TAKEN_OUT',
  OPENING_FLOAT_DIFFERED: 'OPENING_FLOAT_DIFFERED',
  // P41. A Send to kitchen taken back within the minute.
  KOT_SEND_UNDONE: 'KOT_SEND_UNDONE',
  // P62. The cafe box moved to another WiFi from the dashboard. Details name the networks, never a password.
  BOX_WIFI_CHANGED: 'BOX_WIFI_CHANGED',
  // P65. A month's CA pack emailed. Details name the period and the files, never the address.
  CA_PACK_SENT: 'CA_PACK_SENT',
});
export const AUDIT_ACTION_VALUES = Object.freeze(Object.values(AUDIT_ACTIONS));

export const AUDIT_ENTITY_TYPES = Object.freeze({
  BILL: 'BILL',
  STOCK: 'STOCK',
  ORDER: 'ORDER',
  SETTINGS: 'SETTINGS',
  // P09.
  ACCOUNT: 'ACCOUNT',
  PAYOUT: 'PAYOUT',
  // P10.
  CASH: 'CASH',
  DAY: 'DAY',
  // M8.
  USER: 'USER',
  MENU_ITEM: 'MENU_ITEM',
  RECIPE: 'RECIPE',
  // P25.
  INTEGRATION: 'INTEGRATION',
  PLATFORM_ORDER: 'PLATFORM_ORDER',
  TALLY_EXPORT: 'TALLY_EXPORT',
  // P65.
  REPORT: 'REPORT',
});
export const AUDIT_ENTITY_TYPE_VALUES = Object.freeze(Object.values(AUDIT_ENTITY_TYPES));

/**
 * READ-TIME ONLY. Nothing ever writes these to this collection.
 *
 * M5 keeps attendance corrections embedded on the attendance entry (decision
 * D3), and M8 merges them into the audit feed when it is read, in
 * services/auditReadService.js. They appear in responses with these values and
 * are deliberately absent from the enums above, so the database refuses a line
 * that claims to be one.
 */
export const ATTENDANCE_CORRECTED = 'ATTENDANCE_CORRECTED';
export const ATTENDANCE_ENTITY = 'ATTENDANCE';

/**
 * What a MANAGER may read. The owner watches what managers approve, so every
 * other action is OWNER only. Kitchen waste and cancelled orders are the
 * manager's to run. docs/API-CONTRACT.md "M8", the manager restriction.
 */
export const MANAGER_VISIBLE_ACTIONS = Object.freeze([
  AUDIT_ACTIONS.ORDER_CANCELLED,
  AUDIT_ACTIONS.STOCK_ADJUSTED,
  AUDIT_ACTIONS.LINE_CANCELLED_AFTER_PREP,
  AUDIT_ACTIONS.LINE_CANCELLED_APPROVED,
  // P29. A bill changed before payment, and a kitchen tick taken back, like line cancels.
  AUDIT_ACTIONS.BILL_REVISED,
  AUDIT_ACTIONS.KITCHEN_READY_UNDONE,
  // P41. A Send taken back, like a kitchen tick taken back.
  AUDIT_ACTIONS.KOT_SEND_UNDONE,
]);

export const AUDIT_REASON_MAX_LENGTH = 500;
export const AUDIT_LABEL_MAX_LENGTH = 100;

const auditLogSchema = new mongoose.Schema({
  action: { type: String, required: true, enum: AUDIT_ACTION_VALUES },
  entityType: { type: String, required: true, enum: AUDIT_ENTITY_TYPE_VALUES },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

  /** A human handle that survives, such as the bill number, so a line reads without a join. */
  entityLabel: { type: String, trim: true, maxlength: AUDIT_LABEL_MAX_LENGTH, default: null },

  actorId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },

  /** Snapshot of the role at the time, because roles change and the log must not. */
  actorRole: { type: String, required: true },

  at: { type: Date, required: true },

  reason: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: AUDIT_REASON_MAX_LENGTH,
  },

  /** The money involved, where there is one: the discount given, the bill voided. */
  amountInPaise: {
    type: Number,
    min: -MAX_PAISE,
    max: MAX_PAISE,
    default: null,
    validate: {
      validator: (value) => value === null || Number.isInteger(value),
      message: 'Must be a whole number of paise.',
    },
  },

  /**
   * Small, flat, and free of personal data. Not a dumping ground.
   *
   * BUILD-PLAN section 7 keeps staff names and phone numbers out of logs, and
   * this collection is a log.
   */
  details: { type: mongoose.Schema.Types.Mixed, default: null },
});

auditLogSchema.plugin(baseSchemaPlugin);
auditLogSchema.plugin(tenantGuardPlugin);
auditLogSchema.plugin(appendOnlyGuardPlugin);

/** The audit read: what happened here lately. */
auditLogSchema.index({ restaurantId: 1, branchId: 1, at: -1 });

/** Everything that ever happened to this one bill. */
auditLogSchema.index({ restaurantId: 1, entityType: 1, entityId: 1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);

export default AuditLog;
