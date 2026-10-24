/**
 * Settings request schemas. Shapes from docs/API-CONTRACT.md section M7.
 *
 * UNKNOWN KEYS ARE REJECTED, AT EVERY LEVEL. `.strict()` is on the body, on
 * every group inside it, and there is no level in between. A settings endpoint
 * that silently drops a typo'd field name is how somebody spends an hour
 * wondering why their change did nothing, and this is the one endpoint where
 * that hour is guaranteed to happen eventually.
 *
 * The `.strict()` calls here deliberately carry NO custom message, unlike the
 * rest of the codebase. Zod's own text for an unrecognised key names the key
 * ("Unrecognized key: \"defaultTaxRate\""), and a custom message would replace
 * it with something that does not. Naming the offending key is the entire point,
 * so Zod's message wins here.
 */
import { z } from 'zod';

import {
  ACCENT_PRESET_NAMES,
  CASH_DENOMINATION_KINDS,
  INVOICE_MAX_STARTING_NUMBER,
  INVOICE_MODE_VALUES,
  INVOICE_MODES,
  INVOICE_PREFIX_PATTERN,
  NEUTRAL_TONE_VALUES,
  ONLINE_ALERT_ROLE_VALUES,
  ONLINE_PAGE_NOTE_MAX_LENGTH,
  RESERVATION_SLOT_MINUTES_VALUES,
  RECEIPT_FOOTER_MAX_LENGTH,
  RECEIPT_HEADER_MAX_LENGTH,
  REVIEW_LINK_MAX_LENGTH,
  SECOND_LANGUAGES,
  TAX_PRICING_MODE_VALUES,
  TODAY_TILE_KEYS,
  WORDMARK_MAX_LENGTH,
  INVOICE_SHOW_DEFAULTS,
  INVOICE_THEMES,
  TERMS_TEXT_MAX_LENGTH,
  THERMAL_SHOW_DEFAULTS,
} from '../models/Restaurant.js';
import { checkAccent } from '../utils/colour.js';
import { basisPoints } from './common.js';

export const SETTINGS_REASON_MAX_LENGTH = 200;

/**
 * An optional line of receipt text, or null to clear it.
 *
 * An empty string becomes null rather than a 400. Clearing a text box is a
 * legitimate thing for an owner to do and the natural value an HTML input
 * carries when cleared is `""`; making the client translate that to null is a
 * coupling that would eventually be got wrong on one screen. `""` and null mean
 * the same thing here, so they are stored the same way rather than kept as two
 * spellings of empty.
 *
 * Trimmed before the length check, so 40 characters of text plus trailing
 * spaces is 40 characters, not 45.
 */
const receiptText = (maxLength, label) =>
  z
    .union([z.string(), z.null()])
    .transform((value) => {
      if (value === null) return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine(
      (value) => value === null || value.length <= maxLength,
      `${label} cannot be longer than ${maxLength} characters.`,
    );

/**
 * The business day boundary.
 *
 * Presented under `business` and stored at the top level of `settings`. That
 * mapping lives in settingsService; this schema only describes what the client
 * sends. See models/Restaurant.js for why the field never moves.
 */
const business = z
  .object({
    businessDayStartsAtMinutes: z
      .number({ error: 'Must be a whole number of minutes.' })
      .int('Must be a whole number of minutes past midnight.')
      .min(0, 'Cannot be negative.')
      .max(1439, 'Cannot be more than 1439, which is 23:59.')
      .optional(),
  })
  .strict();

const tax = z
  .object({
    pricingMode: z
      .enum(TAX_PRICING_MODE_VALUES, { error: 'Must be EXCLUSIVE or INCLUSIVE.' })
      .optional(),
    defaultTaxRateBps: basisPoints.optional(),
    roundOffEnabled: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/**
 * P25. The address a guest's phone opens from the QR code on the bill: https
 * only, a real web address, at most 300 characters. "" or null clears it.
 */
const reviewLinkUrl = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null || value.trim() === '' ? null : value.trim()))
  .refine((value) => value === null || value.length <= REVIEW_LINK_MAX_LENGTH, `Cannot be longer than ${REVIEW_LINK_MAX_LENGTH} characters.`)
  .refine((value) => {
    if (value === null) return true;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname.includes('.') && !/\s/.test(value);
    } catch {
      return false;
    }
  }, 'Must be a web address starting with https://.');

const receipt = z
  .object({
    headerLine1: receiptText(RECEIPT_HEADER_MAX_LENGTH, 'The first header line').optional(),
    headerLine2: receiptText(RECEIPT_HEADER_MAX_LENGTH, 'The second header line').optional(),
    footerText: receiptText(RECEIPT_FOOTER_MAX_LENGTH, 'The footer').optional(),
    showGstin: z.boolean({ error: 'Must be true or false.' }).optional(),
    showFssai: z.boolean({ error: 'Must be true or false.' }).optional(),
    showServerName: z.boolean({ error: 'Must be true or false.' }).optional(),
    reviewLinkUrl: reviewLinkUrl.optional(),
    // P64.
    termsText: receiptText(TERMS_TEXT_MAX_LENGTH, 'The terms and conditions').optional(),
  })
  .strict();

const inventory = z
  .object({
    lowStockAlertsEnabled: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** Which optional modules are in use. P02. Booleans and nothing else. */
const features = z
  .object({
    inventory: z.boolean({ error: 'Must be true or false.' }).optional(),
    attendance: z.boolean({ error: 'Must be true or false.' }).optional(),
    online: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

export const INVOICE_PREFIX_MESSAGE =
  'An invoice prefix can use letters, numbers, / and -, up to 7 characters.';

/**
 * The invoice series. P02.
 *
 * Validated as a whole group: if any of its three fields is sent, all three
 * must be, so the stored group is never half-changed. A prefix with the old
 * starting number, or a starting number for a prefix nobody sent, is how a
 * legal number series quietly ends up somewhere nobody chose.
 *
 * The rules that need the database (a series already started, a start below a
 * number already used this year) are in settingsService, not here.
 */
const invoice = z
  .object({
    // P64. Sent on its own or with the other three; the together rule is about those three.
    defaultSacCode: z
      .string({ error: 'A SAC code is 4 to 8 digits.' })
      .trim()
      .regex(/^\d{4,8}$/, 'A SAC code is 4 to 8 digits.')
      .optional(),
    mode: z.enum(INVOICE_MODE_VALUES, { error: 'Must be FINANCIAL_YEAR or PREFIX.' }).optional(),
    prefix: z
      .union([z.string().trim().regex(INVOICE_PREFIX_PATTERN, INVOICE_PREFIX_MESSAGE), z.null()], {
        error: INVOICE_PREFIX_MESSAGE,
      })
      .optional(),
    startingNumber: z
      .union(
        [
          z
            .number({ error: 'Must be a whole number.' })
            .int('Must be a whole number.')
            .min(1, 'Must be 1 or more.')
            .max(INVOICE_MAX_STARTING_NUMBER, 'Cannot be more than 999,999,999.'),
          z.null(),
        ],
        { error: 'Must be a whole number from 1 to 999,999,999, or null.' },
      )
      .optional(),
  })
  .strict()
  .superRefine((group, context) => {
    const sent = ['mode', 'prefix', 'startingNumber'].filter((key) => group[key] !== undefined);
    if (sent.length === 0) return;

    if (sent.length < 3) {
      for (const key of ['mode', 'prefix', 'startingNumber']) {
        if (group[key] === undefined) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'Send mode, prefix and startingNumber together.',
          });
        }
      }
      return;
    }

    if (group.mode === INVOICE_MODES.FINANCIAL_YEAR) {
      if (group.prefix !== null) {
        context.addIssue({
          code: 'custom',
          path: ['prefix'],
          message: 'Must be null when numbering by financial year.',
        });
      }
      if (group.startingNumber !== null) {
        context.addIssue({
          code: 'custom',
          path: ['startingNumber'],
          message: 'Must be null when numbering by financial year.',
        });
      }
      return;
    }

    if (group.prefix === null) {
      context.addIssue({ code: 'custom', path: ['prefix'], message: 'A prefix is required.' });
    }
    if (group.startingNumber === null) {
      context.addIssue({
        code: 'custom',
        path: ['startingNumber'],
        message: 'A starting number is required.',
      });
    }
  });

/** Delivery orders. P06. */
const delivery = z
  .object({
    platformCollectsGst: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** Discounts. P08. */
const discounts = z
  .object({
    cashierMayApplyPlatformDiscounts: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** Billing. P25 Part D. */
const billing = z
  .object({
    captainsMayBill: z.boolean({ error: 'Must be true or false.' }).optional(),
    captainsMayTakePayment: z.boolean({ error: 'Must be true or false.' }).optional(),
    // P29.
    reviseUnpaidBills: z.boolean({ error: 'Must be true or false.' }).optional(),
    printBeforePayment: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** The WhatsApp assistant. P51. An empty text clears it. */
const assistant = z
  .object({
    enabled: z.boolean({ error: 'Must be true or false.' }).optional(),
    bookingsEnabled: z.boolean({ error: 'Must be true or false.' }).optional(),
    greeting: z.string().trim().max(300, 'Up to 300 characters.').nullable().transform((value) => (value === '' ? null : value)).optional(),
    handoffHours: z.string().trim().max(120, 'Up to 120 characters.').nullable().transform((value) => (value === '' ? null : value)).optional(),
    dailyAiLimit: z.number({ error: 'Must be a number.' }).int('A whole number.').min(0).max(5000, 'At most 5,000.').optional(),
  })
  .strict();

/** The kitchen. P29 Part C. */
const kitchen = z
  .object({
    readyMeansServed: z.boolean({ error: 'Must be true or false.' }).optional(),
    oneTicketPerOrder: z.boolean({ error: 'Must be true or false.' }).optional(),
    // P58.
    splitTicketsByStation: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** Approvals. P28. What needs an owner's or manager's PIN. */
const approvals = z
  .object({
    lineCancel: z.boolean({ error: 'Must be true or false.' }).optional(),
    paidIn: z.boolean({ error: 'Must be true or false.' }).optional(),
    managerTasks: z.boolean({ error: 'Must be true or false.' }).optional(),
    // P29.
    revisePrintedBill: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/**
 * Cash. P25 Part F. The whole list is sent and replaces the stored one. Values
 * are whole paise above 0, unique within a kind (₹20 may be a note and a
 * coin), and at least one is active.
 */
const cash = z
  .object({
    denominations: z
      .array(
        z
          .object({
            valueInPaise: z.number({ error: 'Must be a whole number of paise.' }).int('Must be a whole number of paise.').min(1, 'Must be more than zero.').max(1_000_000),
            kind: z.enum(CASH_DENOMINATION_KINDS, { error: 'Must be NOTE or COIN.' }),
            isActive: z.boolean({ error: 'Must be true or false.' }).default(true),
          })
          .strict('Is not a field you can set here.'),
      )
      .min(1, 'List at least one note or coin.')
      .max(30)
      .superRefine((list, context) => {
        const keys = list.map((entry) => `${entry.kind}:${entry.valueInPaise}`);
        if (new Set(keys).size !== keys.length) {
          context.addIssue({ code: 'custom', message: 'A note or coin is listed twice.' });
        }
        if (!list.some((entry) => entry.isActive)) {
          context.addIssue({ code: 'custom', message: 'Switch on at least one note or coin.' });
        }
      })
      .optional(),
    /**
     * P29 Part F. The whole list is sent and replaces the stored one. A code
     * is 2 to 30 capital letters, digits or `_`, unique; OTHER is always there
     * and on, because an expense that fits nothing else still needs a home.
     */
    expenseCategories: z
      .array(
        z
          .object({
            code: z.string({ error: 'Must be text.' }).trim().regex(/^[A-Z0-9_]{2,30}$/, 'Use 2 to 30 capital letters, digits or _.'),
            label: z.string({ error: 'Must be text.' }).trim().min(1, 'A category needs a name.').max(40, 'Cannot be longer than 40 characters.'),
            isActive: z.boolean({ error: 'Must be true or false.' }).default(true),
          })
          .strict('Is not a field you can set here.'),
      )
      .min(1, 'List at least one category.')
      .max(30, 'At most 30 categories.')
      .superRefine((list, context) => {
        const codes = list.map((entry) => entry.code);
        if (new Set(codes).size !== codes.length) context.addIssue({ code: 'custom', message: 'A category code is listed twice.' });
        const other = list.find((entry) => entry.code === 'OTHER');
        if (!other || !other.isActive) context.addIssue({ code: 'custom', message: 'Keep Other in the list, switched on.' });
      })
      .optional(),
    usualFloatInPaise: z
      .number({ error: 'Must be a whole number of paise.' })
      .int('Must be a whole number of paise.')
      .min(0, 'Cannot be below zero.')
      .max(100_000_000, 'Cannot be more than ₹10,00,000.')
      .optional(),
    showDrawerTotalToStaff: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** Payments. P25 Part I. */
const payments = z
  .object({
    requireTerminalForLinkedMethods: z.boolean({ error: 'Must be true or false.' }).optional(),
    // P47. The modes Other offers one tap each. A PATCH replaces the list.
    otherModes: z
      .array(z.string().trim().min(1, 'A mode needs a name.').max(40, 'Cannot be longer than 40 characters.'), { error: 'Must be a list of modes.' })
      .max(12, 'At most 12 modes.')
      .refine((list) => new Set(list.map((mode) => mode.toLowerCase())).size === list.length, 'The same mode is listed twice.')
      .optional(),
  })
  .strict();

/** Reports. P25 Part J. "" or null clears the On Hold Tally code. */
const reports = z
  .object({
    onHoldTallyCode: z
      .union([z.string(), z.null()])
      .transform((value) => (value === null || value.trim() === '' ? null : value.trim()))
      .refine((value) => value === null || value.length <= 20, 'Cannot be longer than 20 characters.')
      .optional(),
    // P44. Who gets the day-end message. A PATCH replaces the list.
    dayEndEmails: z
      .array(z.string().trim().toLowerCase().email('Is not an email address.'), { error: 'Must be a list of email addresses.' })
      .max(5, 'At most 5 addresses.')
      .refine((list) => new Set(list).size === list.length, 'The same address is listed twice.')
      .optional(),
  })
  .strict();

/** Day Close. P10. */
const dayClose = z
  .object({
    showCashDifferenceToManager: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

/** The floor. P19. */
const floor = z
  .object({
    sectionOrder: z
      .array(z.string().trim().min(1, 'A section name cannot be empty.').max(40, 'Cannot be longer than 40 characters.'), { error: 'Must be a list of section names.' })
      .max(40, 'At most 40 sections.')
      .refine((names) => new Set(names.map((name) => name.toLowerCase())).size === names.length, 'Each section appears once.')
      .optional(),
    longOpenMinutes: z
      .number({ error: 'Must be a number.' })
      .int('Must be a whole number of minutes.')
      .min(15, 'Must be at least 15 minutes.')
      .max(600, 'Cannot be more than 600 minutes.')
      .optional(),
    requireGuestCount: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict();

const wholeMinutes = (min, max) =>
  z
    .number({ error: 'Must be a number.' })
    .int('Must be a whole number.')
    .min(min, `Must be at least ${min}.`)
    .max(max, `Cannot be more than ${max}.`)
    .optional();

/** Online takeaway and bookings. P23, DB-SCHEMA section 28. */
const online = z
  .object({
    takeawayEnabled: z.boolean({ error: 'Must be true or false.' }).optional(),
    reservationsEnabled: z.boolean({ error: 'Must be true or false.' }).optional(),
    opensAtMinutes: wholeMinutes(0, 1439),
    closesAtMinutes: wholeMinutes(0, 1439),
    takeawayMinLeadMinutes: wholeMinutes(0, 240),
    takeawayAnswerWithinMinutes: wholeMinutes(3, 60),
    reservationMaxPartySize: wholeMinutes(1, 50),
    reservationDaysAhead: wholeMinutes(1, 60),
    reservationSlotMinutes: z
      .union(RESERVATION_SLOT_MINUTES_VALUES.map((value) => z.literal(value)), { error: 'Must be 15, 30 or 60.' })
      .optional(),
    reservationHoldMinutes: wholeMinutes(30, 240),
    // "" is stored as null, the same rule as the receipt text fields.
    pageNote: z
      .union([z.string().trim().max(ONLINE_PAGE_NOTE_MAX_LENGTH, `Cannot be longer than ${ONLINE_PAGE_NOTE_MAX_LENGTH} characters.`), z.null()])
      .transform((value) => (value === '' ? null : value))
      .optional(),
    alertRoles: z
      .array(z.enum(ONLINE_ALERT_ROLE_VALUES, { error: `Each must be one of ${ONLINE_ALERT_ROLE_VALUES.join(', ')}.` }))
      .max(ONLINE_ALERT_ROLE_VALUES.length)
      .refine((roles) => new Set(roles).size === roles.length, 'Each role appears once.')
      .optional(),
    // P24. Advance payment.
    takeawayPrepay: z.boolean({ error: 'Must be true or false.' }).optional(),
    depositPerPersonInPaise: wholeMinutes(0, 1_000_000),
    depositRefundCutoffMinutes: wholeMinutes(0, 2880),
    paymentWindowMinutes: wholeMinutes(16, 120),
  })
  .strict()
  .refine(
    (group) =>
      group.opensAtMinutes === undefined ||
      group.closesAtMinutes === undefined ||
      group.opensAtMinutes !== group.closesAtMinutes,
    { message: 'Opening and closing times cannot be the same.', path: ['closesAtMinutes'] },
  );

/**
 * The look. P20A, DESIGN-SYSTEM sections 4c and 11a.
 *
 * A custom accent is checked here by `utils/colour.js`, so a refused colour is
 * a 400 on `appearance.accentHex` naming the rule it broke and the nearest
 * preset. "CUSTOM with no colour stored" needs the stored value, so the
 * settings service checks that one.
 */
const accentHex = z
  .string({ error: 'Must be a colour like #2D5DA8.' })
  .trim()
  .transform((value) => value.toUpperCase())
  .superRefine((value, ctx) => {
    const verdict = checkAccent(value);
    if (!verdict.ok) ctx.addIssue({ code: 'custom', message: verdict.message });
  });

/**
 * P22. The brand pair, the logo's own background and the text on it. Only the
 * format is checked here; that the two are set together and read at 4.5 to 1
 * needs the stored values, so the settings service checks it.
 */
const brandColour = z
  .string({ error: 'Must be a colour like #4A2E2A.' })
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a six-digit colour, like #4A2E2A.')
  .transform((value) => value.toUpperCase());

const appearance = z
  .object({
    accentPreset: z.enum(ACCENT_PRESET_NAMES, { error: `Must be one of ${ACCENT_PRESET_NAMES.join(', ')}.` }).optional(),
    accentHex: z.union([accentHex, z.null()]).optional(),
    // A cleared text box sends "", which means the restaurant's own name.
    wordmark: z
      .union([
        z.string({ error: 'Must be text.' }).trim().max(WORDMARK_MAX_LENGTH, `Cannot be longer than ${WORDMARK_MAX_LENGTH} characters.`),
        z.null(),
      ])
      .transform((value) => (value === '' ? null : value))
      .optional(),
    secondLanguage: z.enum(SECOND_LANGUAGES, { error: `Must be one of ${SECOND_LANGUAGES.join(', ')}.` }).optional(),
    todayTiles: z
      .array(z.enum(TODAY_TILE_KEYS, { error: `Is not a Today tile. Use ${TODAY_TILE_KEYS.join(', ')}.` }), {
        error: 'Must be a list of Today tiles.',
      })
      .refine((keys) => new Set(keys).size === keys.length, 'Each tile appears once.')
      .optional(),
    neutralTone: z.enum(NEUTRAL_TONE_VALUES, { error: `Must be one of ${NEUTRAL_TONE_VALUES.join(', ')}.` }).optional(),
    brandHex: z.union([brandColour, z.null()]).optional(),
    onBrandHex: z.union([brandColour, z.null()]).optional(),
  })
  .strict();

/** P64. A group of booleans, each optional, nothing else. */
const switchGroup = (defaults) =>
  z
    .object(Object.fromEntries(Object.keys(defaults).map((key) => [key, z.boolean({ error: 'Must be true or false.' }).optional()])))
    .strict('Is not something the invoice can show.');

const invoiceLayout = z
  .object({
    theme: z.enum(INVOICE_THEMES, { error: `Must be one of ${INVOICE_THEMES.join(', ')}.` }).optional(),
    useBrandAccent: z.boolean({ error: 'Must be true or false.' }).optional(),
    show: switchGroup(INVOICE_SHOW_DEFAULTS).optional(),
    thermalShow: switchGroup(THERMAL_SHOW_DEFAULTS).optional(),
  })
  .strict();

/** Everything except `reason`. Used to tell "a group was sent" from "only a reason was sent". */
export const SETTINGS_GROUPS = Object.freeze([
  'business',
  'tax',
  'receipt',
  'inventory',
  'features',
  'invoice',
  'invoiceLayout',
  'delivery',
  'discounts',
  'billing',
  'approvals',
  'dayClose',
  'cash',
  'kitchen',
  'payments',
  'reports',
  'floor',
  'appearance',
  'online',
]);

/**
 * GET /settings takes no parameters.
 *
 * `.strict()` on an empty object, the same shape M6's dashboard uses, so a
 * query string is a 400 rather than something quietly ignored.
 */
export const getSettingsSchema = z.object({
  query: z.object({}).strict('Settings take no parameters.'),
});

/**
 * PATCH /settings.
 *
 * Every group optional, every field within a group optional, at least one
 * actual setting present. `reason` on its own is not a change.
 *
 * `reason` is required and is never defaulted to `""`. An owner changing the
 * GST pricing mode with nothing recorded about why is exactly the gap the audit
 * log exists to close, and a default would close it with a lie.
 */
export const updateSettingsSchema = z.object({
  body: z
    .object({
      reason: z
        .string({ error: 'A reason is required.' })
        .trim()
        .min(1, 'A reason is required.')
        .max(
          SETTINGS_REASON_MAX_LENGTH,
          `Cannot be longer than ${SETTINGS_REASON_MAX_LENGTH} characters.`,
        ),
      business: business.optional(),
      tax: tax.optional(),
      receipt: receipt.optional(),
      inventory: inventory.optional(),
      features: features.optional(),
      invoice: invoice.optional(),
      invoiceLayout: invoiceLayout.optional(),
      delivery: delivery.optional(),
      discounts: discounts.optional(),
      billing: billing.optional(),
      approvals: approvals.optional(),
      dayClose: dayClose.optional(),
      cash: cash.optional(),
      kitchen: kitchen.optional(),
      assistant: assistant.optional(),
      payments: payments.optional(),
      reports: reports.optional(),
      floor: floor.optional(),
      appearance: appearance.optional(),
      online: online.optional(),
    })
    .strict()
    .refine(
      (body) => SETTINGS_GROUPS.some((group) => Object.keys(body[group] ?? {}).length > 0),
      'Send at least one setting to change.',
    ),
});
