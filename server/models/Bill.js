/**
 * One bill for one order. The document a customer is handed and an auditor
 * asks about.
 *
 * Shapes come from docs/DB-SCHEMA.md section 12.
 *
 * Three things in this file matter more than the rest:
 *
 * 1. Every line here is a snapshot of a snapshot. The order line already copied
 *    name, price and tax rate out of `menuitems`; this copies them again and
 *    freezes them. Nothing in M3 reads `menuitems`.
 *
 * 2. `billNumber` is sequential per restaurant, branch and financial year, and
 *    is never reused. The unique indexes below are the guarantee, not a check
 *    in a controller.
 *
 * 3. A bill is never edited once money is on it. A wrong bill with a payment is
 *    voided, with a reason, and re-issued under a new number. P29: before any
 *    payment its items may change under the same number, each change kept in
 *    `revisions` (services/billRevisionService.js).
 */
import mongoose from 'mongoose';

import { cashCountRowSchema } from './CashMovement.js';

import { BILL_VOID_REASON_CODES } from '../config/cancelReasons.js';
import { DISCOUNT_FUNDERS, DISCOUNT_FUNDER_VALUES, DISCOUNT_REASON_CODES } from '../config/discountReasons.js';
import { runAfterCommit } from '../utils/afterCommit.js';
import { groupBillLines } from '../utils/billLines.js';
import { MAX_PAISE } from '../utils/money.js';
import { MAX_BASIS_POINTS } from '../validators/common.js';
import { applyJsonTransform } from './plugins/jsonTransform.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { originSchema } from './Order.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';
import { liveAnnouncePlugin } from './plugins/liveAnnounce.js';

/**
 * `PAID` is reached when the payments add up to the grand total, not when the
 * bill is created. A voided bill keeps whichever status it had and sets
 * `isVoided`, because "was it paid before it was voided" is a real question.
 */
export const BILL_STATUSES = Object.freeze({
  UNPAID: 'UNPAID',
  PAID: 'PAID',
  /**
   * P09. Charged to an On Hold account: a sale whose money arrives later. It
   * takes no payment and no discount, and frees the table like PAID.
   */
  ON_ACCOUNT: 'ON_ACCOUNT',
});
export const BILL_STATUS_VALUES = Object.freeze(Object.values(BILL_STATUSES));

export const DISCOUNT_KINDS = Object.freeze({
  FLAT: 'FLAT',
  PERCENT: 'PERCENT',
});
export const DISCOUNT_KIND_VALUES = Object.freeze(Object.values(DISCOUNT_KINDS));

/**
 * We record which method was used. We never move money. BUILD-PLAN section 4.
 *
 * From P08 a payment's `method` is a `paymentmethods.code` of the restaurant,
 * checked in services/paymentMethodService.js, not an enum here. These four are
 * the built-in codes, kept because every payment from before P08 uses one.
 */
export const PAYMENT_METHODS = Object.freeze({
  CASH: 'CASH',
  UPI: 'UPI',
  CARD: 'CARD',
  OTHER: 'OTHER',
});
export const PAYMENT_METHOD_VALUES = Object.freeze(Object.values(PAYMENT_METHODS));

export const DISCOUNT_REASON_MAX_LENGTH = 200;
export const VOID_REASON_MAX_LENGTH = 500;
export const PAYMENT_REFERENCE_MAX_LENGTH = 100;

const wholeNumber = {
  validator: Number.isInteger,
  message: 'Must be a whole number.',
};

/** The same check for a field that may be null. Mongoose still runs a validator on null. */
const wholeNumberOrEmpty = {
  validator: (value) => value === null || value === undefined || Number.isInteger(value),
  message: 'Must be a whole number.',
};

/**
 * One line, frozen.
 *
 * `_id: false` on purpose: nothing addresses a bill line individually, because
 * a bill is never edited. `orderLineId` is how a line traces back.
 */
const billLineSchema = new mongoose.Schema(
  {
    orderLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    menuItemId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'MenuItem' },

    itemName: { type: String, required: true, trim: true },
    variantName: { type: String, trim: true, default: null },

    /** Names only. Their prices are already inside unitPriceInPaise. */
    addOnNames: { type: [String], default: [] },

    quantity: { type: Number, required: true, min: 1, validate: wholeNumber },

    /** Per unit, add-ons included: the price actually charged for one of these. */
    unitPriceInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_PAISE,
      validate: wholeNumber,
    },

    /** The slab this line falls in. Copied from the order line. */
    taxRateBps: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_BASIS_POINTS,
      validate: wholeNumber,
    },

    /**
     * Stored, not derived, unlike the order's version of this number. An order
     * is live and recomputes on every read; a bill is frozen and must still
     * print the same figures in a year.
     */
    lineTotalInPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: wholeNumber,
    },

    /** Copied from the order line. P03. Null for orders from before P03. */
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryName: { type: String, trim: true, default: null },
    // P46. Copied from the order line: a typed name and price.
    isOpenItem: { type: Boolean, default: false },
    // P64. Copied from the order line; null on bills from before P64, never back-filled.
    hsnCode: { type: String, trim: true, default: null },
    // P60. Copied from the order line: billed without a KOT.
    billedWithoutKot: { type: Boolean, default: false },

    /**
     * This line's share of the bill discount, its net sales, and its share of
     * its rate's GST. P03. Written by allocateLineShares in utils/tax.js on
     * every bill created or re-discounted, and always adding up exactly to the
     * bill's discount and slab figures. Null on bills from before P03, which a
     * report reads as "not recorded". Old bills are not back-filled.
     */
    discountShareInPaise: { type: Number, min: 0, default: null, validate: wholeNumberOrEmpty },
    taxableInPaise: { type: Number, min: 0, default: null, validate: wholeNumberOrEmpty },
    taxInPaise: { type: Number, min: 0, default: null, validate: wholeNumberOrEmpty },
  },
  { _id: false },
);

/**
 * Bill-level only. There is no per-line discount in v1: a line-level discount
 * multiplies the per-slab apportionment by the number of lines, and that
 * arithmetic is where this module could lose a customer's money.
 */
const discountSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, enum: DISCOUNT_KIND_VALUES },

    /** Set when kind is FLAT. */
    valueInPaise: { type: Number, min: 0, max: MAX_PAISE, default: null },

    /** Set when kind is PERCENT. */
    rateBps: { type: Number, min: 1, max: MAX_BASIS_POINTS, default: null },

    /** What actually came off, whichever kind it was. The arithmetic reads this. */
    amountInPaise: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_PAISE,
      validate: wholeNumber,
    },

    /** From P08 the optional note. Before P08 the required free-text reason. */
    reason: {
      type: String,
      trim: true,
      maxlength: DISCOUNT_REASON_MAX_LENGTH,
      default: null,
    },

    /** P08. From server/config/discountReasons.js. Null on discounts from before P08. */
    reasonCode: { type: String, enum: [...DISCOUNT_REASON_CODES, null], default: null },

    /** P08. Who paid for it. PLATFORM only with a platform reason. */
    fundedBy: {
      type: String,
      enum: DISCOUNT_FUNDER_VALUES,
      default: DISCOUNT_FUNDERS.RESTAURANT,
    },

    appliedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    appliedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * One row per distinct tax rate on the bill. This is what prints: a GST invoice
 * shows CGST and SGST against each rate, not one merged figure.
 */
const taxSlabSchema = new mongoose.Schema(
  {
    taxRateBps: {
      type: Number,
      required: true,
      min: 0,
      max: MAX_BASIS_POINTS,
      validate: wholeNumber,
    },

    /** After this slab's share of any discount. */
    taxableInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    taxInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },

    /** CGST takes the extra paisa when the slab tax is odd. See utils/tax.js. */
    cgstInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    sgstInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
  },
  { _id: false },
);

/** P08. One per method correction. The amount never changes. */
const paymentCorrectionSchema = new mongoose.Schema(
  {
    fromMethod: { type: String, required: true },
    toMethod: { type: String, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    at: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, minlength: 1, maxlength: 200 },
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    /** A paymentmethods.code of this restaurant. Checked in the service, P08. */
    method: { type: String, required: true, trim: true },

    /**
     * Frozen from the method when the payment is taken, P08, so renaming a
     * method or changing its commission never rewrites money already taken.
     * Null on payments from before P08: a null kind reads as IN_HAND and a
     * null businessDate as the bill's.
     */
    methodName: { type: String, trim: true, default: null },
    methodKind: { type: String, enum: ['IN_HAND', 'PLATFORM', null], default: null },
    tallyLedgerCode: { type: String, trim: true, default: null },
    commissionBps: { type: Number, min: 0, max: MAX_BASIS_POINTS, default: null, validate: wholeNumberOrEmpty },
    businessDate: { type: String, default: null },
    corrections: { type: [paymentCorrectionSchema], default: [] },

    amountInPaise: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_PAISE,
      validate: wholeNumber,
    },

    /** A UPI reference or the last four of a card. Never a full card number. */
    reference: {
      type: String,
      trim: true,
      maxlength: PAYMENT_REFERENCE_MAX_LENGTH,
      default: null,
    },

    receivedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    receivedAt: { type: Date, required: true },

    /**
     * P25 Part E. Set when an item was cancelled after billing: the payment
     * was taken on the voided bill and carried onto this one, keeping its
     * method, frozen fields, `receivedAt` and business date.
     */
    carriedFromBillId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },

    /**
     * P25 Part F. On a cash payment: the notes handed over, the total
     * tendered and the change given back. Kept for the record; no figure reads
     * it, because `amountInPaise` is what went on the bill.
     */
    /**
     * P25 Part I. A payment taken on the card machine: what the machine said.
     * Never a card number beyond what the machine sends, masked.
     */
    terminal: {
      type: new mongoose.Schema(
        {
          provider: { type: String, required: true },
          ptrid: { type: String, required: true },
          rrn: { type: String, default: null },
          approvalCode: { type: String, default: null },
          tid: { type: String, default: null },
          paymentMode: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },

    tender: {
      type: new mongoose.Schema(
        {
          cashCount: { type: [cashCountRowSchema], default: undefined },
          tenderedInPaise: { type: Number, required: true, min: 0 },
          changeInPaise: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { _id: true },
);

applyJsonTransform(paymentSchema);

export const REVISION_KINDS = Object.freeze({ REMOVED: 'REMOVED', ADDED: 'ADDED' });

/**
 * P29. One change to the items on a bill nothing has been paid on, under the
 * same number. Append-only; frozen like the lines. docs/DB-SCHEMA.md section 43.
 */
const revisionLineSchema = new mongoose.Schema(
  {
    orderLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    itemName: { type: String, required: true, trim: true },
    variantName: { type: String, trim: true, default: null },
    quantity: { type: Number, required: true, min: 1, validate: wholeNumber },
    lineTotalInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    wasPrepared: { type: Boolean, default: null },
  },
  { _id: false },
);

const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true, min: 1, validate: wholeNumber },
    kind: { type: String, required: true, enum: Object.values(REVISION_KINDS) },
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lines: { type: [revisionLineSchema], default: [] },
    reasonCode: { type: String, default: null },
    note: { type: String, trim: true, maxlength: 200, default: null },
    previousGrandTotalInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    newGrandTotalInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },
    wasPrinted: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const billSchema = new mongoose.Schema({
  /** The printed number, "2026-27/000148". Unique per restaurant, never reused. */
  billNumber: { type: String, required: true, trim: true },

  /** Indian FY, 1 April to 31 March. The sequence resets here and nowhere else. */
  financialYear: { type: String, required: true, trim: true },

  /** The integer behind billNumber, so a gap is found by arithmetic. */
  billSequence: { type: Number, required: true, min: 1, validate: wholeNumber },

  /**
   * Which series the number belongs to. P02. The financial year, "2026-27", in
   * FINANCIAL_YEAR mode, or the prefix, "CFA/C/", in PREFIX mode. Null on bills
   * created before P02, which means the financial year series. The M19 invoice
   * register groups by it.
   */
  invoiceSeries: { type: String, trim: true, default: null },

  orderId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Order' },

  /** Snapshots, so a bill reads without a join. */
  orderNumber: { type: Number, required: true, validate: wholeNumber },
  orderType: { type: String, required: true },
  tableName: { type: String, trim: true, default: null },

  /** Derived once by businessDateFor. Never recomputed: a reported day stays stable. */
  businessDate: { type: String, required: true },

  status: {
    type: String,
    required: true,
    enum: BILL_STATUS_VALUES,
    default: BILL_STATUSES.UNPAID,
  },

  lines: { type: [billLineSchema], default: [] },

  /** Pre-tax, pre-discount. */
  subtotalInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },

  discount: { type: discountSchema, default: null },

  taxBreakdown: { type: [taxSlabSchema], default: [] },
  totalTaxInPaise: { type: Number, required: true, min: 0, default: 0, validate: wholeNumber },

  /** Signed, -49 to +50. What was added to reach a whole rupee. */
  roundOffInPaise: { type: Number, required: true, min: -49, max: 50, default: 0, validate: wholeNumber },

  /** subtotal - discount + totalTax + roundOff. Always a multiple of 100. */
  grandTotalInPaise: { type: Number, required: true, min: 0, validate: wholeNumber },

  /**
   * P09. Set when the bill is charged to an On Hold account. The name is
   * frozen. `chargedToAccountInPaise` is the bill total minus what was already
   * paid at that moment.
   */
  account: {
    type: new mongoose.Schema(
      {
        accountId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Account' },
        accountName: { type: String, required: true, trim: true },
      },
      { _id: false },
    ),
    default: null,
  },
  chargedToAccountInPaise: { type: Number, min: 1, default: null, validate: wholeNumberOrEmpty },
  chargedAt: { type: Date, default: null },
  chargedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  payments: { type: [paymentSchema], default: [] },
  amountPaidInPaise: { type: Number, required: true, min: 0, default: 0, validate: wholeNumber },

  billedBy: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  billedAt: { type: Date, required: true },
  paidAt: { type: Date, default: null },

  /** CONVENTIONS section 4 void fields. There is no delete. */
  isVoided: { type: Boolean, required: true, default: false },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // P28. The owner or manager who typed their PIN for a cashier's void.
  voidApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  /** From P04 the optional note. Older bills keep their free-text reason here. */
  voidReason: { type: String, trim: true, maxlength: VOID_REASON_MAX_LENGTH, default: null },
  /** P04. The fixed reason, from BILL_VOID_REASONS. Null before P04. */
  voidReasonCode: { type: String, enum: [...BILL_VOID_REASON_CODES, null], default: null },
  /**
   * P56. Voided only so the items could change after billing (cancel-lines,
   * reopen), and billed again. Left out of every list of voided bills; kept in
   * the invoice register and every check. False on every bill voided before P56.
   */
  isVoidedToChangeItems: { type: Boolean, default: false },

  /**
   * Frozen from the order at bill creation. P03. "Captain" is whoever opened
   * the order (GLOSSARY section 8). The name is read once, so renaming the user
   * later does not rewrite who served last month. Null on bills from before P03.
   */
  /**
   * Copied from the order. P06. `platform` is `{ code, name, orderId }` on a
   * delivery bill and null otherwise. A bill from before P06 reads as NORMAL.
   */
  platform: {
    type: new mongoose.Schema(
      {
        code: { type: String, trim: true },
        name: { type: String, trim: true },
        orderId: { type: String, trim: true },
      },
      { _id: false },
    ),
    default: null,
  },
  taxTreatment: { type: String, trim: true, default: 'NORMAL' },

  /** P23. Copied from the order: an online takeaway or a booking, or null. */
  origin: { type: originSchema, default: null },

  captainId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  captainName: { type: String, trim: true, default: null },
  guestCount: { type: Number, min: 0, default: null, validate: wholeNumberOrEmpty },
  orderOpenedAt: { type: Date, default: null },

  /**
   * P25 Part D. Printing at the counter. A captain's request sets
   * `printRequestedAt`; every print, from any device, adds 1 to `printCount`
   * and stamps `lastPrintedAt`. The counter's queue is the bills whose request
   * is newer than their last print, so no bill is in it twice. From the
   * second print on, the paper says Duplicate.
   */
  printRequestedAt: { type: Date, default: null },
  printRequestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastPrintedAt: { type: Date, default: null },
  printCount: { type: Number, min: 0, default: 0, validate: wholeNumberOrEmpty },

  /**
   * P29 Part B. A bill nothing has been paid on is revised, not voided, when
   * an item is removed or added: same number, new totals, one entry here per
   * change. `lastPrintedRevision` is `revision` at the last print, so the
   * first print after a change is not a duplicate. Null on a bill printed
   * before P29, read as 0.
   */
  revision: { type: Number, min: 0, default: 0, validate: wholeNumberOrEmpty },
  revisions: { type: [revisionSchema], default: [] },
  lastPrintedRevision: { type: Number, min: 0, default: null, validate: wholeNumberOrEmpty },

  /** P29 Part D. A payment was recorded while the bill had never been printed. */
  paymentBeforePrint: { type: Boolean, default: false },
});

billSchema.plugin(baseSchemaPlugin);
billSchema.plugin(tenantGuardPlugin);

/**
 * P35. Every bill sent back whole carries `itemRows`: its lines grouped for a
 * person to read, the same dish once (API-CONTRACT M3 14.2). Computed here,
 * each time a bill is turned into JSON, and never stored, so no handler can
 * send a bill without it. Only the bill itself gets it, never a line or a
 * payment inside it.
 */
/**
 * P37. A bill that has just become PAID queues the guest's bill on WhatsApp,
 * once the write is in: after the transaction commits, never inside one that
 * could still roll back. The receipt module never throws, and its own
 * idempotency key means a bill saved again sends nothing more.
 */
billSchema.pre('save', function noteBecamePaid() {
  this.$locals.becamePaid = this.isModified('status') && this.status === 'PAID';
});
billSchema.post('save', function queueReceiptWhenPaid(document) {
  if (!document.$locals?.becamePaid) return;
  document.$locals.becamePaid = false;
  runAfterCommit(document.$session?.() ?? null, () =>
    import('../services/integrations/messaging/whatsappService.js').then(({ queueBillReceipt }) => queueBillReceipt(document)),
  );
});

const baseBillJson = billSchema.get('toJSON');
billSchema.set('toJSON', {
  ...baseBillJson,
  transform(document, record, options) {
    const out = baseBillJson.transform(document, record, options) ?? record;
    if (!document.$isSubdocument && Array.isArray(document.lines)) out.itemRows = groupBillLines(document.lines);
    return out;
  },
});
// P33. Tells open screens that read these topics to read again, after the write commits.
billSchema.plugin(liveAnnouncePlugin, { topics: ['tables', 'print-queue'] });

/**
 * The number an auditor quotes, so it is unique per restaurant rather than per
 * branch. Two branches of one restaurant must not both issue 2026-27/000148.
 */
billSchema.index({ restaurantId: 1, billNumber: 1 }, { unique: true });

/** The same guarantee in integers, which is what a gap check reads. */
billSchema.index(
  { restaurantId: 1, branchId: 1, financialYear: 1, billSequence: 1 },
  { unique: true },
);

/**
 * One LIVE bill per order.
 *
 * Partial on isVoided:false, so voiding a bill leaves the order billable again.
 * An index rather than a check-then-write in a controller, for the same reason
 * M2's one-open-order-per-table index exists: the gap between the check and the
 * write is the race.
 */
billSchema.index(
  { restaurantId: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { isVoided: false } },
);

/** The day's bill list, and every M6 sales read. */
billSchema.index({ restaurantId: 1, branchId: 1, businessDate: 1, isVoided: 1 });

/** P14. Payments by their own business date: R5, R6 and the cash drawer. */
billSchema.index({ restaurantId: 1, branchId: 1, 'payments.businessDate': 1 });

/** P14. A series in sequence order: R10 and check C6. */
billSchema.index({ restaurantId: 1, branchId: 1, invoiceSeries: 1, billSequence: 1 });

/** P25. The counter's print queue: only bills a captain asked to print. */
billSchema.index(
  { restaurantId: 1, branchId: 1, printRequestedAt: 1 },
  { partialFilterExpression: { printRequestedAt: { $type: 'date' } } },
);

export const Bill = mongoose.model('Bill', billSchema);

export default Bill;
