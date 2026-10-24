/**
 * The one place any module reads configuration from.
 *
 * No controller reads `restaurant.settings` directly. Same discipline as no
 * controller reading the environment and no controller touching `passwordHash`:
 * when a setting moves, gains a default, or changes shape, one file changes.
 *
 * `restaurants` is the documented tenancy-root exception and carries neither
 * baseSchema nor tenantGuard, so every query here is by `_id` taken from a
 * verified token. That is legitimate unguarded pattern 1 from the note at the
 * top of models/Restaurant.js. This module needs no tenant-guard escape hatch
 * of any kind: `restaurants` has no guard to skip, and the audit writes go
 * through auditService, which is an ordinary scoped write. The production count
 * of that hatch is unchanged by M7, and there is a tripwire asserting it.
 */
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { Counter, COUNTER_NAMES } from '../models/Counter.js';
import { INVOICE_MODES, INVOICE_SHOW_DEFAULTS, Restaurant, THERMAL_SHOW_DEFAULTS } from '../models/Restaurant.js';
import { recordAudit } from './auditService.js';
import { ACCENT_PRESETS, checkAccent, checkBrandPair, nightVariant } from '../utils/colour.js';
import { BusinessRuleError, ERROR_CODES, ValidationError } from '../utils/errors.js';
import { financialYearFor, nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';

/**
 * Every setting, as the API path a client sees mapped to the path it is stored
 * at. This map is the whole reason the two shapes can differ safely.
 *
 * `business.businessDayStartsAtMinutes` is the one entry where the two differ.
 * The field is stored at the top level of `settings` because M3, M5 and M6 all
 * read it there, and the API groups it under `business` for readability. See
 * models/Restaurant.js for why it never moves. Every other entry is the same
 * path with a `settings.` prefix.
 *
 * Adding a setting means adding one line here, one field on the model, and one
 * field in the validator. Nothing else in the codebase needs to know.
 */
const SETTING_PATHS = Object.freeze({
  'business.businessDayStartsAtMinutes': 'settings.businessDayStartsAtMinutes',

  'tax.pricingMode': 'settings.tax.pricingMode',
  'tax.defaultTaxRateBps': 'settings.tax.defaultTaxRateBps',
  'tax.roundOffEnabled': 'settings.tax.roundOffEnabled',

  'receipt.headerLine1': 'settings.receipt.headerLine1',
  'receipt.headerLine2': 'settings.receipt.headerLine2',
  'receipt.footerText': 'settings.receipt.footerText',
  'receipt.showGstin': 'settings.receipt.showGstin',
  'receipt.showFssai': 'settings.receipt.showFssai',
  'receipt.showServerName': 'settings.receipt.showServerName',
  'receipt.reviewLinkUrl': 'settings.receipt.reviewLinkUrl',
  // P64.
  'receipt.termsText': 'settings.receipt.termsText',

  'inventory.lowStockAlertsEnabled': 'settings.inventory.lowStockAlertsEnabled',

  'features.inventory': 'settings.features.inventory',
  'features.attendance': 'settings.features.attendance',
  'features.online': 'settings.features.online',

  'invoice.mode': 'settings.invoice.mode',
  'invoice.prefix': 'settings.invoice.prefix',
  'invoice.startingNumber': 'settings.invoice.startingNumber',
  // P64.
  'invoice.defaultSacCode': 'settings.invoice.defaultSacCode',
  'invoiceLayout.theme': 'settings.invoiceLayout.theme',
  'invoiceLayout.useBrandAccent': 'settings.invoiceLayout.useBrandAccent',
  ...Object.fromEntries(Object.keys(INVOICE_SHOW_DEFAULTS).map((key) => [`invoiceLayout.show.${key}`, `settings.invoiceLayout.show.${key}`])),
  ...Object.fromEntries(Object.keys(THERMAL_SHOW_DEFAULTS).map((key) => [`invoiceLayout.thermalShow.${key}`, `settings.invoiceLayout.thermalShow.${key}`])),

  'delivery.platformCollectsGst': 'settings.delivery.platformCollectsGst',

  'discounts.cashierMayApplyPlatformDiscounts': 'settings.discounts.cashierMayApplyPlatformDiscounts',
  'billing.captainsMayBill': 'settings.billing.captainsMayBill',
  'billing.captainsMayTakePayment': 'settings.billing.captainsMayTakePayment',
  'billing.reviseUnpaidBills': 'settings.billing.reviseUnpaidBills',
  'billing.printBeforePayment': 'settings.billing.printBeforePayment',
  'approvals.lineCancel': 'settings.approvals.lineCancel',
  'approvals.paidIn': 'settings.approvals.paidIn',
  'approvals.managerTasks': 'settings.approvals.managerTasks',
  'approvals.revisePrintedBill': 'settings.approvals.revisePrintedBill',
  'kitchen.readyMeansServed': 'settings.kitchen.readyMeansServed',
  'kitchen.oneTicketPerOrder': 'settings.kitchen.oneTicketPerOrder',
  'kitchen.splitTicketsByStation': 'settings.kitchen.splitTicketsByStation',

  'dayClose.showCashDifferenceToManager': 'settings.dayClose.showCashDifferenceToManager',
  'cash.denominations': 'settings.cash.denominations',
  'cash.expenseCategories': 'settings.cash.expenseCategories',
  'cash.usualFloatInPaise': 'settings.cash.usualFloatInPaise',
  'cash.showDrawerTotalToStaff': 'settings.cash.showDrawerTotalToStaff',
  'payments.requireTerminalForLinkedMethods': 'settings.payments.requireTerminalForLinkedMethods',
  'payments.otherModes': 'settings.payments.otherModes',
  'reports.onHoldTallyCode': 'settings.reports.onHoldTallyCode',
  'reports.dayEndEmails': 'settings.reports.dayEndEmails',

  'floor.sectionOrder': 'settings.floor.sectionOrder',
  'floor.longOpenMinutes': 'settings.floor.longOpenMinutes',
  'floor.requireGuestCount': 'settings.floor.requireGuestCount',

  'appearance.accentPreset': 'settings.appearance.accentPreset',
  'appearance.accentHex': 'settings.appearance.accentHex',
  'appearance.wordmark': 'settings.appearance.wordmark',
  'appearance.secondLanguage': 'settings.appearance.secondLanguage',
  'appearance.todayTiles': 'settings.appearance.todayTiles',
  'appearance.neutralTone': 'settings.appearance.neutralTone',
  'appearance.brandHex': 'settings.appearance.brandHex',
  'appearance.onBrandHex': 'settings.appearance.onBrandHex',

  'online.takeawayEnabled': 'settings.online.takeawayEnabled',
  'online.reservationsEnabled': 'settings.online.reservationsEnabled',
  'online.opensAtMinutes': 'settings.online.opensAtMinutes',
  'online.closesAtMinutes': 'settings.online.closesAtMinutes',
  'online.takeawayMinLeadMinutes': 'settings.online.takeawayMinLeadMinutes',
  'online.takeawayAnswerWithinMinutes': 'settings.online.takeawayAnswerWithinMinutes',
  'online.reservationMaxPartySize': 'settings.online.reservationMaxPartySize',
  'online.reservationDaysAhead': 'settings.online.reservationDaysAhead',
  'online.reservationSlotMinutes': 'settings.online.reservationSlotMinutes',
  'online.reservationHoldMinutes': 'settings.online.reservationHoldMinutes',
  'online.pageNote': 'settings.online.pageNote',
  'online.alertRoles': 'settings.online.alertRoles',
  'online.takeawayPrepay': 'settings.online.takeawayPrepay',
  'online.depositPerPersonInPaise': 'settings.online.depositPerPersonInPaise',
  'online.depositRefundCutoffMinutes': 'settings.online.depositRefundCutoffMinutes',
  'online.paymentWindowMinutes': 'settings.online.paymentWindowMinutes',
  // P51.
  'assistant.enabled': 'settings.assistant.enabled',
  'assistant.bookingsEnabled': 'settings.assistant.bookingsEnabled',
  'assistant.greeting': 'settings.assistant.greeting',
  'assistant.handoffHours': 'settings.assistant.handoffHours',
  'assistant.dailyAiLimit': 'settings.assistant.dailyAiLimit',
});

/** The modules a restaurant can switch off. P02. */
export const FEATURE_NAMES = Object.freeze(['inventory', 'attendance', 'online']);

export const SETTING_API_PATHS = Object.freeze(Object.keys(SETTING_PATHS));

/** Walks a dotted path. Returns undefined rather than throwing on a missing branch. */
function valueAt(source, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), source);
}

/** Writes a dotted path into a plain object, creating the branches it needs. */
function setValueAt(target, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => {
    node[key] ??= {};
    return node[key];
  }, target);
  parent[last] = value;
}

/**
 * The settings object as the API describes it, built from a restaurant document.
 *
 * A document written before M7 has no `settings.tax` at all. Mongoose fills
 * every missing path from the schema defaults when it hydrates the document, so
 * this reads a complete object without a migration and without a seeding step.
 * There is a test asserting exactly that.
 *
 * A missing restaurant returns the pure defaults rather than throwing, which is
 * what every call site did for itself before this service existed
 * (`restaurant?.settings?.x ?? DEFAULT`), and changing that here would change
 * three modules' behaviour by accident.
 */
let defaultSettings;

/** The schema's own defaults, built once. Static by definition. */
function schemaDefaults() {
  defaultSettings ??= new Restaurant().settings;
  return defaultSettings;
}

function presentSettings(restaurant) {
  const defaults = schemaDefaults();
  const source = restaurant ?? { settings: defaults };

  const presented = {};
  for (const [apiPath, storedPath] of Object.entries(SETTING_PATHS)) {
    const value = valueAt(source, storedPath) ?? valueAt({ settings: defaults }, storedPath) ?? null;
    setValueAt(presented, apiPath, value);
  }
  return presented;
}

/**
 * Per-request memo, so one request that reads a setting three times reads the
 * document once.
 *
 * DELIBERATELY NOT A PROCESS-LEVEL CACHE WITH A TIME TO LIVE. A stale settings
 * cache means an owner changes the business day boundary, sees nothing happen,
 * changes it again, and two server processes now disagree about which day a
 * sale belongs to. BUILD-PLAN section 12 lists that as its own named problem.
 * The cache dies with the request, every time.
 */
const CACHE_KEY = Symbol.for('restaurantErp.settingsCache');

function cached(req, restaurantId) {
  if (!req) return undefined;
  return req[CACHE_KEY]?.get(String(restaurantId));
}

function remember(req, restaurantId, settings) {
  if (!req) return settings;
  req[CACHE_KEY] ??= new Map();
  req[CACHE_KEY].set(String(restaurantId), settings);
  return settings;
}

/** Drops the memo after a write, so a read later in the same request sees the change. */
function forget(req, restaurantId) {
  req?.[CACHE_KEY]?.delete(String(restaurantId));
}

/**
 * The full settings object for one restaurant, with every default applied.
 *
 * Pass `{ req }` to get the per-request memo and, where `authenticate` already
 * loaded the restaurant onto the request, to skip the query entirely. That is
 * the common case: this service is usually reading a document the request has
 * in hand, and re-fetching it would be a query per setting read.
 */
export async function getSettings(restaurantId, { req = null, session = null } = {}) {
  /**
   * With a session the read is fresh and inside the caller's transaction, so a
   * bill is numbered from the settings as they are at that moment rather than
   * as they were when the request was authenticated. Never memoised.
   */
  if (session) {
    // Legitimate unguarded query pattern 1: by _id from a verified token.
    const restaurant = await Restaurant.findById(restaurantId).select('settings').session(session);
    return presentSettings(restaurant);
  }

  const memo = cached(req, restaurantId);
  if (memo) return memo;

  // authenticate loads the whole document, so the settings are already here.
  const loaded = req?.currentRestaurant;
  const restaurant =
    loaded && String(loaded._id) === String(restaurantId)
      ? loaded
      : // Legitimate unguarded query pattern 1: by _id from a verified token.
        await Restaurant.findById(restaurantId).select('settings');

  return remember(req, restaurantId, presentSettings(restaurant));
}

/**
 * One setting by its dotted API path, for example "tax.defaultTaxRateBps".
 *
 * An unknown path is a programming error, not a client error, so it throws
 * rather than returning undefined and letting a wrong value travel.
 */
export async function getSetting(restaurantId, path, { req = null } = {}) {
  if (!(path in SETTING_PATHS)) {
    throw new Error(`"${path}" is not a setting. See SETTING_PATHS in settingsService.js.`);
  }
  return valueAt(await getSettings(restaurantId, { req }), path);
}

/**
 * True when one of the switchable modules is on for the request's restaurant.
 * Shares the per-request memo, so the route check and a service check in the
 * same request read the document once. P02.
 */
export async function isFeatureOn(req, name) {
  if (!FEATURE_NAMES.includes(name)) {
    throw new Error(`"${name}" is not a feature switch. See FEATURE_NAMES in settingsService.js.`);
  }
  return Boolean(await getSetting(req.restaurantId, `features.${name}`, { req }));
}

/** The counter scope a prefix series is numbered under. Also used by billNumberService. */
export function prefixCounterScope(prefix) {
  return `PREFIX:${prefix}`;
}

/** The highest value any branch's counter for this prefix has reached, or 0. */
async function lastIssuedUnderPrefix(restaurantId, prefix) {
  const counters = await Counter.find({
    restaurantId,
    name: COUNTER_NAMES.BILL,
    scope: prefixCounterScope(prefix),
  })
    .select('value')
    .lean();
  return counters.reduce((highest, counter) => Math.max(highest, counter.value), 0);
}

/**
 * The three invoice series rules, from API-CONTRACT.md section M7 3. P02.
 *
 * They protect the two unique indexes on `bills`: { restaurantId, billNumber }
 * and { restaurantId, branchId, financialYear, billSequence }. A settings
 * change that broke either would not fail here, it would fail at the till, in
 * the middle of service, on every bill. So the change is refused now instead.
 *
 * `next` is the full invoice group the request sends; the validator has already
 * made sure all three fields are present and consistent with the mode.
 */
async function assertInvoiceChangeAllowed(restaurantId, current, next) {
  // P64. `defaultSacCode` may be sent on its own; the series rules are about the other three.
  if (['mode', 'prefix', 'startingNumber'].every((key) => next[key] === undefined)) return;
  const unchanged =
    current.mode === next.mode &&
    current.prefix === next.prefix &&
    current.startingNumber === next.startingNumber;
  if (unchanged) return;

  const financialYear = financialYearFor(nowUtc());

  if (next.mode === INVOICE_MODES.FINANCIAL_YEAR) {
    // Rule 3. A prefix bill this year already holds a sequence number the
    // financial-year counter would later hand out again.
    const prefixBill = await Bill.findOne({
      restaurantId,
      financialYear,
      invoiceSeries: { $nin: [null, financialYear] },
    })
      .select('invoiceSeries')
      .lean();

    if (prefixBill) {
      throw new BusinessRuleError(
        `Bills have already been issued under ${prefixBill.invoiceSeries} this financial year. You can switch back on or after 1 April.`,
        ERROR_CODES.INVOICE_SERIES_LOCKED,
      );
    }
    return;
  }

  const last = await lastIssuedUnderPrefix(restaurantId, next.prefix);

  if (last > 0) {
    // Rule 2. The series exists. The only acceptable request is the stored
    // one, sent back unchanged, which returned above.
    throw new BusinessRuleError(
      `${next.prefix} has already issued bills up to ${next.prefix}${last}. Its starting number cannot change, and it cannot be started again.`,
      ERROR_CODES.INVOICE_SERIES_STARTED,
    );
  }

  // Rule 1. A brand-new series must start clear of every sequence number
  // already used this financial year, in any series, voided bills included.
  const highest = await Bill.findOne({ restaurantId, financialYear })
    .sort({ billSequence: -1 })
    .select('billSequence')
    .lean();

  if (highest && next.startingNumber <= highest.billSequence) {
    throw new BusinessRuleError(
      `The starting number must be above ${highest.billSequence}, the highest bill number already used this financial year.`,
      ERROR_CODES.INVOICE_START_TOO_LOW,
    );
  }
}

/** Lists compare by their contents, so re-sending the same order is not a change. */
function sameValue(previous, next) {
  if (Array.isArray(previous) || Array.isArray(next)) {
    return JSON.stringify([...(previous ?? [])]) === JSON.stringify([...(next ?? [])]);
  }
  return previous === next;
}

/** P20A. CUSTOM needs a colour, either sent now or already stored. */
function assertAppearanceComplete(current, next) {
  const preset = next.accentPreset ?? current.accentPreset;
  const hex = next.accentHex !== undefined ? next.accentHex : current.accentHex;
  if (preset === 'CUSTOM' && !hex) {
    throw new ValidationError('Choose a colour for the custom accent.', {
      'appearance.accentHex': 'Choose a colour for the custom accent.',
    });
  }

  // P22. The brand pair is set together and must read, against the stored half
  // when only one half is sent.
  const brandHex = next.brandHex !== undefined ? next.brandHex : current.brandHex;
  const onBrandHex = next.onBrandHex !== undefined ? next.onBrandHex : current.onBrandHex;
  if (Boolean(brandHex) !== Boolean(onBrandHex)) {
    const missing = brandHex ? 'appearance.onBrandHex' : 'appearance.brandHex';
    const message = 'Set the brand colour and the colour of text on it together, or clear both.';
    throw new ValidationError(message, { [missing]: message });
  }
  if (brandHex) {
    const verdict = checkBrandPair(brandHex, onBrandHex);
    if (!verdict.ok) {
      throw new ValidationError(verdict.message, { 'appearance.onBrandHex': verdict.message });
    }
  }
}

/**
 * P64. The accent a full-page invoice is drawn in, checked again by
 * utils/colour.js before it is put on a tax document. A preset always passes;
 * a custom colour stored before a rule tightened might not, and is refused.
 */
function assertPrintableAccent(appearance) {
  const accent = resolvedAccent(appearance);
  const verdict = checkAccent(accent);
  if (!verdict.ok) throw new BusinessRuleError(verdict.message);
}

/** The accent colour the restaurant chose, worked out once for every reader. */
export function resolvedAccent(appearance) {
  return appearance.accentPreset === 'CUSTOM' && appearance.accentHex
    ? appearance.accentHex
    : (ACCENT_PRESETS[appearance.accentPreset] ?? ACCENT_PRESETS.OCEAN);
}

/**
 * The look as `GET /auth/me` gives it to every role, P20A: the accent's day and
 * night colours already worked out, and the wordmark already resolved, so the
 * client does no colour arithmetic on load.
 */
export function presentAppearance(appearance, restaurantName) {
  const accent = resolvedAccent(appearance);
  return {
    accentPreset: appearance.accentPreset,
    accent,
    accentNight: nightVariant(accent),
    wordmark: appearance.wordmark ?? restaurantName ?? null,
    secondLanguage: appearance.secondLanguage,
    todayTiles: [...appearance.todayTiles],
    neutralTone: appearance.neutralTone ?? 'COOL',
    brandHex: appearance.brandHex ?? null,
    onBrandHex: appearance.onBrandHex ?? null,
  };
}

/**
 * Applies a patch, writes one audit line per field that actually changed, and
 * returns the full updated object.
 *
 * Only changed fields are written and only changed fields are audited. A field
 * sent with the value it already has is not an error and not a change; auditing
 * it would fill the log with noise and make the real changes harder to find.
 *
 * The settings write and every audit line commit together. A settings change
 * that persists without its audit line is worse than one that fails outright,
 * because the log is the thing that is trusted.
 */
export async function updateSettings(
  restaurantId,
  patch,
  { actorId, actorRole, branchId, reason, req = null } = {},
) {
  const before = await getSettings(restaurantId, { req: null });

  if (patch.invoice !== undefined) {
    await assertInvoiceChangeAllowed(restaurantId, before.invoice, patch.invoice);
  }

  if (patch.appearance !== undefined) assertAppearanceComplete(before.appearance, patch.appearance);

  // P64. Drawing the accent on an invoice: the accent must still pass the accent rules.
  if (patch.invoiceLayout?.useBrandAccent === true) {
    assertPrintableAccent({ ...before.appearance, ...(patch.appearance ?? {}) });
  }

  const changes = [];
  for (const apiPath of SETTING_API_PATHS) {
    const next = valueAt(patch, apiPath);
    if (next === undefined) continue;

    const previous = valueAt(before, apiPath);
    if (sameValue(previous, next)) continue;

    changes.push({ apiPath, storedPath: SETTING_PATHS[apiPath], previous, next });
  }

  if (changes.length === 0) {
    forget(req, restaurantId);
    return before;
  }

  const $set = Object.fromEntries(changes.map((change) => [change.storedPath, change.next]));

  /**
   * auditService takes the request because every other caller has one. This one
   * does not, so it is handed the same three things the function actually reads:
   * the tenant, the actor, and the actor's role at the time. Reshaping
   * auditService for one caller would touch M3 code this module has no business
   * touching.
   */
  const auditContext = {
    restaurantId,
    branchId,
    user: { id: actorId, role: actorRole },
  };

  const updated = await withOptionalTransaction(async (session) => {
    // Legitimate unguarded query pattern 1: by _id from a verified token.
    const restaurant = await Restaurant.findOneAndUpdate({ _id: restaurantId }, { $set }, {
      new: true,
      runValidators: true,
      ...(session ? { session } : {}),
    });

    for (const change of changes) {
      await recordAudit(
        auditContext,
        {
          action: AUDIT_ACTIONS.SETTINGS_CHANGED,
          entityType: AUDIT_ENTITY_TYPES.SETTINGS,
          entityId: restaurantId,
          entityLabel: change.apiPath,
          reason,
          amountInPaise: null,
          // A field path and two scalars. No personal data goes in here, for
          // the reason DB-SCHEMA section 13 gives.
          details: {
            field: change.apiPath,
            previousValue: String(change.previous),
            newValue: String(change.next),
          },
        },
        session,
      );
    }

    return restaurant;
  });

  forget(req, restaurantId);
  return presentSettings(updated);
}

export default { getSettings, getSetting, isFeatureOn, prefixCounterScope, updateSettings };
