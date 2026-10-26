/**
 * The tenant. One document per customer restaurant.
 *
 * THIS MODEL APPLIES NEITHER baseSchema NOR tenantGuard. That is deliberate
 * and it is the exception documented in docs/DB-SCHEMA.md.
 *
 * A restaurant document does not belong to a restaurant. It IS the restaurant.
 * Its `_id` is the value every other collection stores as `restaurantId`.
 * Applying the guard here would block every legitimate query, because there is
 * no `restaurantId` field to filter on.
 *
 * The cost of that exemption: every query against this collection is
 * unguarded, so every one has to be correct by inspection. There are exactly
 * two legitimate patterns:
 *
 *   1. Lookup by `_id` taken from a verified access token.
 *   2. The provisioning script.
 *
 * Any third pattern is a bug. If you are about to write `Restaurant.find()`
 * with a filter that did not come from a token, stop.
 */
import mongoose from 'mongoose';

import { writerGuardPlugin } from './plugins/writerGuard.js';

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, trim: true },
    line2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
  },
  { _id: false },
);

const wholeNumber = {
  validator: Number.isInteger,
  message: 'Must be a whole number.',
};

/** Whether `menuitems.priceInPaise` is the price before or after GST. */
export const TAX_PRICING_MODES = Object.freeze({
  EXCLUSIVE: 'EXCLUSIVE',
  INCLUSIVE: 'INCLUSIVE',
});
export const TAX_PRICING_MODE_VALUES = Object.freeze(Object.values(TAX_PRICING_MODES));

/**
 * An 80mm thermal roll fits roughly 42 characters per line at normal font. A
 * longer line wraps and destroys the layout, which BUILD-PLAN section 12 names
 * as the printer problem. Caught here, at data entry, rather than in a kitchen
 * during Phase 2.
 */
export const RECEIPT_HEADER_MAX_LENGTH = 40;
export const RECEIPT_FOOTER_MAX_LENGTH = 200;
/** P25. The review link printed as a QR code at the foot of every bill. */
export const REVIEW_LINK_MAX_LENGTH = 300;
// P64. The terms and conditions on the full-page invoice, and the SAC for restaurant service.
export const TERMS_TEXT_MAX_LENGTH = 600;
export const DEFAULT_SAC_CODE = '996331';

/**
 * Tax configuration. Shapes from docs/DB-SCHEMA.md section 17.
 *
 * `pricingMode` and `roundOffEnabled` are STORED AND READ BY NOTHING. That is
 * deliberate, not an oversight. M3's tax arithmetic is frozen, tested to the
 * paisa, and carries a documented per-slab rounding rule, and rewiring it from
 * inside a settings module is how billing breaks quietly. Wiring them is its
 * own task with its own tests, and it must not run before a chartered
 * accountant has confirmed which pricing mode the pilot actually uses.
 *
 * `defaultTaxRateBps` is wired: POST /menu-items fills it in when the request
 * omits `taxRateBps`. It changes only the API's default. Every stored item
 * still carries its own rate, so changing this tomorrow moves nothing that
 * already exists.
 */
const taxSettingsSchema = new mongoose.Schema(
  {
    pricingMode: {
      type: String,
      required: true,
      enum: TAX_PRICING_MODE_VALUES,
      default: TAX_PRICING_MODES.EXCLUSIVE,
    },
    defaultTaxRateBps: {
      type: Number,
      required: true,
      default: 500,
      min: 0,
      max: 10_000,
      validate: wholeNumber,
    },
    roundOffEnabled: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Receipt text and print toggles. Consumed by nothing until Phase 2 thermal
 * printing exists; stored now because these are worth collecting during
 * onboarding rather than on the morning of a pilot.
 */
const receiptSettingsSchema = new mongoose.Schema(
  {
    headerLine1: {
      type: String,
      trim: true,
      maxlength: RECEIPT_HEADER_MAX_LENGTH,
      default: null,
    },
    headerLine2: {
      type: String,
      trim: true,
      maxlength: RECEIPT_HEADER_MAX_LENGTH,
      default: null,
    },
    footerText: {
      type: String,
      trim: true,
      maxlength: RECEIPT_FOOTER_MAX_LENGTH,
      default: null,
    },
    showGstin: { type: Boolean, required: true, default: true },
    showFssai: { type: Boolean, required: true, default: true },
    showServerName: { type: Boolean, required: true, default: false },
    // P25. An https address; every printed bill ends with its QR code.
    reviewLinkUrl: { type: String, trim: true, maxlength: REVIEW_LINK_MAX_LENGTH, default: null },
    // P64. Printed at the foot of the full-page invoice when `invoiceLayout.show.terms` is on.
    termsText: { type: String, trim: true, maxlength: TERMS_TEXT_MAX_LENGTH, default: null },
  },
  { _id: false },
);

const inventorySettingsSchema = new mongoose.Schema(
  {
    /**
     * When false the low-stock reads return an empty list and the dashboard
     * returns an empty `lowStock` array. The quantities themselves are
     * untouched: this switches off the surfacing, not the data.
     */
    lowStockAlertsEnabled: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Which optional modules this restaurant uses. Added by P02.
 *
 * Both default to true so nothing changes for an existing restaurant. Switching
 * one off is enforced on the server by middleware/requireFeature.js, and
 * switching inventory off also stops firing and cancelling from writing stock
 * movements. It never deletes data that already exists.
 */
const featureSettingsSchema = new mongoose.Schema(
  {
    inventory: { type: Boolean, required: true, default: true },
    attendance: { type: Boolean, required: true, default: true },
    /**
     * P23 (M14). Off by default, unlike the two above: switching it on puts
     * a public page on the internet, and that is a choice an owner makes.
     */
    online: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/** How bill numbers are formed. Added by P02. */
export const INVOICE_MODES = Object.freeze({
  FINANCIAL_YEAR: 'FINANCIAL_YEAR',
  PREFIX: 'PREFIX',
});
export const INVOICE_MODE_VALUES = Object.freeze(Object.values(INVOICE_MODES));

/**
 * GST allows an invoice number of at most 16 characters, using only letters,
 * digits, `-` and `/`. A 7-character prefix plus a 9-digit number is 16, so no
 * number a prefix series issues can break that rule.
 */
export const INVOICE_PREFIX_MAX_LENGTH = 7;
export const INVOICE_PREFIX_PATTERN = /^[A-Za-z0-9/-]{1,7}$/;
export const INVOICE_MAX_STARTING_NUMBER = 999_999_999;

/**
 * The invoice series. `FINANCIAL_YEAR` is M3's original "2026-27/000148".
 * `PREFIX` is a prefix plus a running number that never resets, "CFA/C/22442",
 * so a restaurant can continue the series its old system was issuing.
 *
 * The rules that stop a change here from breaking the unique indexes on
 * `bills` live in settingsService, because they read the database.
 */
const invoiceSettingsSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      required: true,
      enum: INVOICE_MODE_VALUES,
      default: INVOICE_MODES.FINANCIAL_YEAR,
    },
    prefix: {
      type: String,
      trim: true,
      maxlength: INVOICE_PREFIX_MAX_LENGTH,
      default: null,
    },
    startingNumber: {
      type: Number,
      min: 1,
      max: INVOICE_MAX_STARTING_NUMBER,
      default: null,
      validate: {
        validator: (value) => value === null || value === undefined || Number.isInteger(value),
        message: 'Must be a whole number.',
      },
    },
    /**
     * P64. The SAC an order line freezes when its dish has no HSN or SAC code
     * of its own. 996331 is restaurant service. Only lines added afterwards
     * follow a change.
     */
    defaultSacCode: { type: String, required: true, trim: true, default: DEFAULT_SAC_CODE, match: /^\d{4,8}$/ },
  },
  { _id: false },
);

/**
 * P64. How the full-page tax invoice is laid out, and what it and the thermal
 * roll show. Every default prints exactly what CLASSIC and the thermal bill
 * printed before P64, so a restaurant that never opens the screen sees no
 * change. The mandatory core of a tax invoice (CGST Rule 46) is not here at
 * all: no switch can take it off.
 */
export const INVOICE_THEMES = Object.freeze(['CLASSIC', 'GST_DETAILED', 'MODERN', 'COMPACT']);
export const INVOICE_SHOW_DEFAULTS = Object.freeze({
  time: true,
  captain: true,
  cashier: false,
  covers: true,
  table: true,
  orderType: true,
  customerName: false,
  customerMobileMasked: false,
  itemNote: false,
  hsn: false,
  paymentBreakdown: true,
  onHoldOutstanding: false,
  amountInWords: false,
  declaration: false,
  signatureLine: false,
  reviewQr: true,
  pan: true,
  msme: true,
  terms: true,
  copyMarking: false,
});
export const THERMAL_SHOW_DEFAULTS = Object.freeze({
  time: true,
  cashier: true,
  covers: false,
  table: true,
  orderType: true,
  customerName: true,
  customerMobileMasked: true,
  itemNote: false,
  paymentBreakdown: true,
  onHoldOutstanding: false,
  amountInWords: false,
  reviewQr: true,
});

const switches = (defaults) =>
  new mongoose.Schema(
    Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, { type: Boolean, required: true, default: value }])),
    { _id: false },
  );

const invoiceLayoutSettingsSchema = new mongoose.Schema(
  {
    theme: { type: String, enum: INVOICE_THEMES, required: true, default: 'CLASSIC' },
    useBrandAccent: { type: Boolean, required: true, default: false },
    show: { type: switches(INVOICE_SHOW_DEFAULTS), default: () => ({}) },
    thermalShow: { type: switches(THERMAL_SHOW_DEFAULTS), default: () => ({}) },
  },
  { _id: false },
);

/**
 * Delivery orders. P06.
 *
 * When true, a DELIVERY order from a listed platform is frozen at 0% GST when
 * it is created, because the platform pays the GST under section 9(5).
 * TO CONFIRM with each restaurant's CA. Only orders created after a change follow it.
 */
const deliverySettingsSchema = new mongoose.Schema(
  {
    platformCollectsGst: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Discounts. P08. When true, a CASHIER may apply a discount with a platform
 * reason (Zomato Gold, Dineout, EazyDiner) and no other. TO CONFIRM with
 * each restaurant.
 */
const discountSettingsSchema = new mongoose.Schema(
  {
    cashierMayApplyPlatformDiscounts: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/**
 * Billing. P25 Part D. Who besides the till may make a bill and take its
 * money: a captain serving the table, by the owner's choice.
 */
const billingSettingsSchema = new mongoose.Schema(
  {
    captainsMayBill: { type: Boolean, required: true, default: true },
    captainsMayTakePayment: { type: Boolean, required: true, default: false },
    // P29 Part B. An unpaid bill is revised under the same number, not voided, when items change.
    reviseUnpaidBills: { type: Boolean, required: true, default: true },
    // P29 Part D. The bill screen asks for the print before the payment. Read by the client.
    printBeforePayment: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * The kitchen. P29 Part C. When the kitchen marks a dish ready, it is served:
 * the floor has no served step. Off keeps the two-step flow.
 */
const kitchenSettingsSchema = new mongoose.Schema(
  {
    readyMeansServed: { type: Boolean, required: true, default: true },
    /** P36. One ticket per order, every round and station on it. Off: one per station per Send, as P05. */
    oneTicketPerOrder: { type: Boolean, required: true, default: true },
    /** P58. Off: a Send's dishes go on one ticket with no station of its own. Lines keep theirs. */
    splitTicketsByStation: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Approvals. P28. What a cashier or captain needs an owner's or manager's PIN
 * for. Every field defaults on, so a restaurant saved before P28 asks.
 */
const approvalSettingsSchema = new mongoose.Schema(
  {
    lineCancel: { type: Boolean, required: true, default: true },
    paidIn: { type: Boolean, required: true, default: true },
    managerTasks: { type: Boolean, required: true, default: true },
    // P29 Part B. A cashier or captain removing an item from a bill already printed needs a PIN.
    revisePrintedBill: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Cash. P25 Part F. The notes and coins counted for the opening float, at Day
 * Close, and on a cash payment. India by default, largest first; ₹2,000 is
 * listed and off, because it is withdrawn from circulation.
 */
export const CASH_DENOMINATION_KINDS = Object.freeze(['NOTE', 'COIN']);
export const DEFAULT_DENOMINATIONS = Object.freeze(
  [
    [200000, 'NOTE', false],
    [50000, 'NOTE', true],
    [20000, 'NOTE', true],
    [10000, 'NOTE', true],
    [5000, 'NOTE', true],
    [2000, 'NOTE', true],
    [1000, 'NOTE', true],
    [2000, 'COIN', true],
    [1000, 'COIN', true],
    [500, 'COIN', true],
    [200, 'COIN', true],
    [100, 'COIN', true],
  ].map(([valueInPaise, kind, isActive]) => Object.freeze({ valueInPaise, kind, isActive })),
);

const denominationSchema = new mongoose.Schema(
  {
    valueInPaise: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'Must be a whole number of paise.' } },
    kind: { type: String, required: true, enum: CASH_DENOMINATION_KINDS },
    isActive: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/**
 * Payments. P25 Part I. When true, a method linked to a card machine is taken
 * on the machine, never typed in, except by an owner or manager with a reason.
 */
/** P47. The modes Other offers one tap each, until the owner changes them. */
export const DEFAULT_OTHER_MODES = Object.freeze(['Swiggy Dineout', 'Zomato Dineout', 'EazyDiner', 'Cheque', 'Bank transfer', 'Coupon']);

const paymentSettingsSchema = new mongoose.Schema(
  {
    requireTerminalForLinkedMethods: { type: Boolean, required: true, default: true },
    // P47.
    otherModes: { type: [String], default: () => [...DEFAULT_OTHER_MODES] },
  },
  { _id: false },
);

/**
 * Reports. P25 Part J. The Tally code R9 prints on its On Hold row; null
 * prints "On Hold" with no code. Was the constant P03 before P25.
 */
const reportSettingsSchema = new mongoose.Schema(
  {
    onHoldTallyCode: { type: String, default: null, maxlength: 20, trim: true },
    // P44. Who gets the day-end message by email. At most 5, lowercased.
    dayEndEmails: { type: [String], default: [] },
    /**
     * P65. The restaurant's chartered accountant, sent the month's pack on the
     * 1st. Configuration, not a guest's record; its contact fields are audited
     * without their values (settingsService), and never reach /auth/me.
     */
    ca: {
      type: new mongoose.Schema(
        {
          enabled: { type: Boolean, required: true, default: false },
          name: { type: String, trim: true, maxlength: 80, default: null },
          email: { type: String, trim: true, lowercase: true, default: null },
          whatsapp: { type: String, trim: true, default: null, match: /^[6-9]\d{9}$/ },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { _id: false },
);

/**
 * P29 Part F. What an expense was for. A code is frozen onto each expense and
 * never changes; the label may. OTHER is always present and needs a note.
 */
export const OTHER_EXPENSE_CATEGORY = 'OTHER';
export const DEFAULT_EXPENSE_CATEGORIES = Object.freeze(
  [
    ['MILK', 'Milk and dairy'],
    ['VEGETABLES', 'Vegetables and fruit'],
    ['GROCERIES', 'Groceries'],
    ['GAS', 'Gas'],
    ['PACKAGING', 'Packaging'],
    ['CLEANING', 'Cleaning'],
    ['REPAIRS', 'Repairs'],
    ['STAFF_ADVANCE', 'Staff advance'],
    ['TRANSPORT', 'Transport'],
    [OTHER_EXPENSE_CATEGORY, 'Other'],
  ].map(([code, label]) => Object.freeze({ code, label, isActive: true })),
);

const expenseCategorySchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, match: /^[A-Z0-9_]{2,30}$/ },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

const cashSettingsSchema = new mongoose.Schema(
  {
    denominations: { type: [denominationSchema], default: () => DEFAULT_DENOMINATIONS.map((entry) => ({ ...entry })) },
    // P29 Part F.
    expenseCategories: { type: [expenseCategorySchema], default: () => DEFAULT_EXPENSE_CATEGORIES.map((entry) => ({ ...entry })) },
    usualFloatInPaise: {
      type: Number,
      required: true,
      default: 200000,
      min: 0,
      max: 100_000_000,
      validate: { validator: Number.isInteger, message: 'Must be a whole number of paise.' },
    },
    showDrawerTotalToStaff: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/**
 * Day Close. P10. The blind count: when false, a MANAGER never sees expected
 * cash or the difference in any Day Close response or print.
 */
const dayCloseSettingsSchema = new mongoose.Schema(
  {
    showCashDifferenceToManager: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/**
 * The floor. P19. The order sections appear in, when a table counts as running
 * long, and whether a dine-in order must say how many guests sit at it.
 */
export const FLOOR_SECTION_ORDER_MAX = 40;
const floorSettingsSchema = new mongoose.Schema(
  {
    sectionOrder: { type: [String], default: [] },
    longOpenMinutes: {
      type: Number,
      required: true,
      default: 90,
      min: 15,
      max: 600,
      validate: { validator: Number.isInteger, message: 'Must be a whole number of minutes.' },
    },
    requireGuestCount: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

/**
 * Online takeaway and table bookings. P23 (M14), docs/DB-SCHEMA.md section 28.
 * Times are minutes past midnight IST. A closing time smaller than the opening
 * time means the cafe closes after midnight.
 */
export const ONLINE_ALERT_ROLE_VALUES = Object.freeze(['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'STOREKEEPER']);
export const RESERVATION_SLOT_MINUTES_VALUES = Object.freeze([15, 30, 60]);
export const ONLINE_PAGE_NOTE_MAX_LENGTH = 200;
const minutesOfDay = { validator: Number.isInteger, message: 'Must be a whole number of minutes.' };
const onlineSettingsSchema = new mongoose.Schema(
  {
    takeawayEnabled: { type: Boolean, required: true, default: false },
    reservationsEnabled: { type: Boolean, required: true, default: false },
    opensAtMinutes: { type: Number, required: true, default: 600, min: 0, max: 1439, validate: minutesOfDay },
    closesAtMinutes: { type: Number, required: true, default: 1380, min: 0, max: 1439, validate: minutesOfDay },
    takeawayMinLeadMinutes: { type: Number, required: true, default: 20, min: 0, max: 240, validate: minutesOfDay },
    takeawayAnswerWithinMinutes: { type: Number, required: true, default: 10, min: 3, max: 60, validate: minutesOfDay },
    reservationMaxPartySize: { type: Number, required: true, default: 10, min: 1, max: 50, validate: minutesOfDay },
    reservationDaysAhead: { type: Number, required: true, default: 14, min: 1, max: 60, validate: minutesOfDay },
    reservationSlotMinutes: { type: Number, required: true, default: 30, enum: RESERVATION_SLOT_MINUTES_VALUES },
    reservationHoldMinutes: { type: Number, required: true, default: 90, min: 30, max: 240, validate: minutesOfDay },
    pageNote: {
      type: String,
      trim: true,
      maxlength: ONLINE_PAGE_NOTE_MAX_LENGTH,
      default: 'Pay at the counter when you collect.',
    },
    alertRoles: { type: [{ type: String, enum: ONLINE_ALERT_ROLE_VALUES }], default: () => ['OWNER', 'MANAGER', 'CASHIER'] },
    // P24. Advance payment. Effective only while a payment gateway is connected.
    takeawayPrepay: { type: Boolean, required: true, default: false },
    depositPerPersonInPaise: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 1_000_000,
      validate: { validator: Number.isInteger, message: 'Must be whole paise.' },
    },
    depositRefundCutoffMinutes: { type: Number, required: true, default: 120, min: 0, max: 2880, validate: minutesOfDay },
    // Razorpay requires a payment link to stay open at least 15 minutes.
    paymentWindowMinutes: { type: Number, required: true, default: 20, min: 16, max: 120, validate: minutesOfDay },
  },
  { _id: false },
);

/**
 * The look. P20A, docs/DESIGN-SYSTEM.md section 11a. Which accent, the name
 * in the top bar, the second language for fixed action words, and which Today
 * tiles show. A custom accent is checked by `utils/colour.js` in the validator;
 * the model only holds the shape.
 */
export const ACCENT_PRESET_NAMES = Object.freeze(['OCEAN', 'INDIGO', 'PLUM', 'OLIVE', 'ESPRESSO', 'GRAPHITE', 'CUSTOM']);
export const SECOND_LANGUAGES = Object.freeze(['NONE', 'GUJARATI', 'HINDI']);
export const WORDMARK_MAX_LENGTH = 30;
/** P22. Which neutral set every screen uses, DESIGN-SYSTEM section 4a. */
export const NEUTRAL_TONE_VALUES = Object.freeze(['COOL', 'WARM']);

/** R1's tile keys, in contract order. A test keeps this equal to the R1 definition. */
export const TODAY_TILE_KEYS = Object.freeze([
  'billTotalInPaise',
  'netSalesInPaise',
  'billCount',
  'covers',
  'averagePerCoverInPaise',
  'openTables',
  'openItemTotalInPaise',
  'unpaidCount',
  'unpaidInPaise',
  'lastWeekBillTotalInPaise',
]);

const appearanceSettingsSchema = new mongoose.Schema(
  {
    accentPreset: { type: String, enum: ACCENT_PRESET_NAMES, required: true, default: 'OCEAN' },
    accentHex: { type: String, default: null, match: /^#[0-9A-F]{6}$/ },
    wordmark: { type: String, trim: true, default: null, maxlength: WORDMARK_MAX_LENGTH },
    secondLanguage: { type: String, enum: SECOND_LANGUAGES, required: true, default: 'NONE' },
    todayTiles: {
      type: [{ type: String, enum: TODAY_TILE_KEYS }],
      default: () => [...TODAY_TILE_KEYS],
    },
    // P22. The tone, and the logo's own background and the text on it.
    neutralTone: { type: String, enum: NEUTRAL_TONE_VALUES, required: true, default: 'COOL' },
    brandHex: { type: String, default: null, match: /^#[0-9A-F]{6}$/ },
    onBrandHex: { type: String, default: null, match: /^#[0-9A-F]{6}$/ },
  },
  { _id: false },
);

/**
 * Restaurant-level settings. Every field has a default, which is what makes M7
 * a no-migration change: a document written before M7 reads back a complete
 * settings object because Mongoose fills missing paths on read.
 *
 * `services/settingsService.js` is the only place any module reads these from.
 * No controller reaches in here directly, the same discipline as no controller
 * reading the environment and no controller touching `passwordHash`.
 */
/** P51. The WhatsApp assistant. Off until the owner switches it on. */
const assistantSettingsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, required: true, default: false },
    bookingsEnabled: { type: Boolean, required: true, default: true },
    greeting: { type: String, trim: true, maxlength: 300, default: null },
    handoffHours: { type: String, trim: true, maxlength: 120, default: null },
    dailyAiLimit: { type: Number, required: true, default: 500, min: 0, max: 5000 },
  },
  { _id: false },
);

const settingsSchema = new mongoose.Schema(
  {
    /**
     * Minutes past midnight IST at which the business day rolls over. 300 is
     * 05:00. A restaurant that closes after midnight counts those sales and
     * shifts under the day the service started. See docs/DB-SCHEMA.md section 1
     * and the decision log, D1. M5 reads this to derive an entry's businessDate.
     *
     * DO NOT MOVE THIS FIELD, and in particular do not nest it under
     * `settings.business` to match the shape of the API response.
     *
     * M3 derives every bill's `businessDate` from it, M5 derives every
     * attendance entry's, and M6 reads it for every report. Nesting it would be
     * tidier and would break three shipped modules at once, on the one field
     * that decides which day a sale belongs to, and would need a migration to
     * do it. Tidiness is not worth that.
     *
     * The API groups it under `business` for readability. That mapping lives in
     * `services/settingsService.js` and nowhere else.
     */
    businessDayStartsAtMinutes: {
      type: Number,
      required: true,
      default: 300,
      min: 0,
      max: 1439,
      validate: { validator: Number.isInteger, message: 'Must be a whole number of minutes.' },
    },

    tax: { type: taxSettingsSchema, default: () => ({}) },
    receipt: { type: receiptSettingsSchema, default: () => ({}) },
    inventory: { type: inventorySettingsSchema, default: () => ({}) },
    features: { type: featureSettingsSchema, default: () => ({}) },
    invoice: { type: invoiceSettingsSchema, default: () => ({}) },
    // P64.
    invoiceLayout: { type: invoiceLayoutSettingsSchema, default: () => ({}) },
    delivery: { type: deliverySettingsSchema, default: () => ({}) },
    discounts: { type: discountSettingsSchema, default: () => ({}) },
    billing: { type: billingSettingsSchema, default: () => ({}) },
    approvals: { type: approvalSettingsSchema, default: () => ({}) },
    dayClose: { type: dayCloseSettingsSchema, default: () => ({}) },
    cash: { type: cashSettingsSchema, default: () => ({}) },
    kitchen: { type: kitchenSettingsSchema, default: () => ({}) },
    payments: { type: paymentSettingsSchema, default: () => ({}) },
    reports: { type: reportSettingsSchema, default: () => ({}) },
    floor: { type: floorSettingsSchema, default: () => ({}) },
    appearance: { type: appearanceSettingsSchema, default: () => ({}) },
    online: { type: onlineSettingsSchema, default: () => ({}) },
    assistant: { type: assistantSettingsSchema, default: () => ({}) },
  },
  { _id: false },
);

/**
 * The restaurant's logo, one slot per kind of ground. P22, docs/DB-SCHEMA.md
 * section 1, `brandLogos`.
 *
 * Outside `settings` on purpose: an image never travels with GET /settings and
 * never lands in a SETTINGS_CHANGED audit line. `data` is `select: false`,
 * because `authenticate` loads this document on every request and must not
 * read up to two images to do it. Only services/brandLogoService.js asks for
 * the bytes. A slot is empty when `sha256` is null; every field has a default,
 * so a restaurant written before P22 reads back two empty slots.
 */
// P64. SIGNATURE is the owner's signature for the full-page invoice, under the same rules.
export const LOGO_SLOTS = Object.freeze({ LIGHT_GROUND: 'lightGround', DARK_GROUND: 'darkGround', SIGNATURE: 'signature' });
export const LOGO_SLOT_NAMES = Object.freeze(Object.keys(LOGO_SLOTS));
export const LOGO_CONTENT_TYPES = Object.freeze(['image/png', 'image/webp', 'image/jpeg']);

const logoSlotSchema = new mongoose.Schema(
  {
    contentType: { type: String, enum: [...LOGO_CONTENT_TYPES, null], default: null },
    data: { type: Buffer, default: null, select: false },
    sha256: { type: String, default: null, match: /^[0-9a-f]{64}$/ },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    sizeBytes: { type: Number, default: null },
    setAt: { type: Date, default: null },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const brandLogosSchema = new mongoose.Schema(
  {
    lightGround: { type: logoSlotSchema, default: () => ({}) },
    darkGround: { type: logoSlotSchema, default: () => ({}) },
    signature: { type: logoSlotSchema, default: () => ({}) },
  },
  { _id: false },
);

const restaurantSchema = new mongoose.Schema(
  {
    /** Trading name. Shown on screen. */
    name: { type: String, required: true, trim: true },

    /** Registered company name. Appears on a GST invoice. */
    legalName: { type: String, trim: true },

    /** 15 characters. Optional because a small restaurant may not be registered. */
    gstin: { type: String, trim: true, uppercase: true },

    /** 14 digits. */
    fssaiLicenseNumber: { type: String, trim: true },

    /** P64. Optional, printed on the full-page invoice: the PAN and the Udyam (MSME) number. */
    panNumber: { type: String, trim: true, uppercase: true, default: null },
    msmeNumber: { type: String, trim: true, uppercase: true, default: null },

    address: { type: addressSchema, default: () => ({}) },

    contactPhone: { type: String, trim: true },
    contactEmail: { type: String, trim: true, lowercase: true },

    settings: { type: settingsSchema, default: () => ({}) },

    /** P22. Never sent in a restaurant response; see the toJSON transform below. */
    brandLogos: { type: brandLogosSchema, default: () => ({}) },

    /**
     * P24. The cafe's own Razorpay account. The two secrets are encrypted with
     * utils/secretBox.js and `select: false`, so `authenticate`, which loads
     * this document on every request, never reads them. Only
     * services/paymentGatewayService.js opens them. Never in any response.
     */
    paymentGateway: {
      type: new mongoose.Schema(
        {
          provider: { type: String, enum: ['RAZORPAY'], required: true },
          keyId: { type: String, required: true, trim: true },
          keySecretEncrypted: { type: String, required: true, select: false },
          webhookSecretEncrypted: { type: String, required: true, select: false },
          mode: { type: String, enum: ['TEST', 'LIVE'], required: true },
          connectedAt: { type: Date, required: true },
          connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    /**
     * Platform-controlled, not customer-controlled. PATCH /restaurant rejects
     * this field. Deactivating a restaurant is our operation, not theirs.
     */
    isActive: { type: Boolean, required: true, default: true },
  },
  {
    // createdAt and updatedAt as real Date objects, which Mongo stores in UTC.
    timestamps: true,

    /**
     * Written out by hand because baseSchema is not applied here. Without it
     * this collection would answer with `_id` and `__v`, and every M0 response
     * shape in docs/API-CONTRACT.md says `id`.
     */
    toJSON: {
      versionKey: false,
      transform(_document, record) {
        record.id = record._id?.toString();
        delete record._id;
        delete record.__v;
        // P22. The logo has its own endpoint, and its bytes must never ride along.
        delete record.brandLogos;
        // P24. The payment account has its own endpoint, which never shows a secret.
        delete record.paymentGateway;
        return record;
      },
    },
  },
);

/**
 * No compound index. docs/DB-SCHEMA.md is explicit that `_id` is enough: this
 * collection holds tens of documents, not millions. An index added "just in
 * case" here costs writes and buys nothing.
 */

// P62. The tenant has no tenant guard, so it takes the writer guard on its own.
restaurantSchema.plugin(writerGuardPlugin);

export const Restaurant = mongoose.model('Restaurant', restaurantSchema);

export default Restaurant;
