/**
 * Error classes.
 *
 * Anything thrown from a controller, service or middleware should be one of
 * these. The error handler maps them to a status code and the standard failure
 * envelope, and nothing else leaks to the client.
 *
 * The error codes are the fixed strings from docs/CONVENTIONS.md section 3.
 * The frontend switches on the code, never on the message text.
 */

export const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  DUPLICATE: 'DUPLICATE',
  BUSINESS_RULE_VIOLATED: 'BUSINESS_RULE_VIOLATED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Added by M0-B. docs/CONVENTIONS.md section 3 allows a module to add codes
  // in the same shape. Both are 401 and both are deliberately vague, because
  // a precise auth failure message is a free hint to whoever is guessing.
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',

  // Added by M0-C. A 422, because the request is well formed and the rule it
  // breaks is a rule of the business: a restaurant always has one active
  // owner, or nobody can administer it.
  LAST_OWNER: 'LAST_OWNER',

  // Added by M1. The two duplicates are 409 and are deliberately separate from
  // the general DUPLICATE, because the menu screen shows the clash against the
  // field the manager just typed into and needs to know which field that was.
  DUPLICATE_CATEGORY_NAME: 'DUPLICATE_CATEGORY_NAME',
  DUPLICATE_MENU_ITEM_NAME: 'DUPLICATE_MENU_ITEM_NAME',

  // Also M1. Both 404. A variant or add-on id that is not on this item is not
  // found, exactly like an item id that is not in this restaurant.
  VARIANT_NOT_FOUND: 'VARIANT_NOT_FOUND',
  ADDON_NOT_FOUND: 'ADDON_NOT_FOUND',

  // Added by M5. The two clock-state clashes are 409. The three rule breaches
  // are 422: the request is well formed and it is the state or the actor that
  // is wrong. SELF_CORRECTION_FORBIDDEN binds an owner too, which is why it is
  // 422 and not 403 (403 means not you, 422 means not this by anyone).
  ALREADY_CLOCKED_IN: 'ALREADY_CLOCKED_IN',
  NOT_CLOCKED_IN: 'NOT_CLOCKED_IN',
  CLOCK_OUT_BEFORE_CLOCK_IN: 'CLOCK_OUT_BEFORE_CLOCK_IN',
  ENTRY_VOIDED: 'ENTRY_VOIDED',
  SELF_CORRECTION_FORBIDDEN: 'SELF_CORRECTION_FORBIDDEN',

  // Added by M0-D. Raised by the M5 shared-tablet clock through
  // authService.verifyPin. INVALID_PIN is deliberately vague, like
  // INVALID_CREDENTIALS: a wrong PIN and a user with no PIN look the same.
  INVALID_PIN: 'INVALID_PIN',
  PIN_LOCKED: 'PIN_LOCKED',

  /**
   * Added by M3.
   *
   * TRANSACTION_REQUIRED is 503 rather than 500: the request was fine and the
   * server is fine, but this deployment cannot presently offer the guarantee
   * the operation needs. Retrying against a replica set works.
   */
  BILL_ALREADY_EXISTS: 'BILL_ALREADY_EXISTS',
  TRANSACTION_REQUIRED: 'TRANSACTION_REQUIRED',

  // Added by M2. Both 409, and both carry an extra field the client acts on
  // rather than just displays. See the `details` note on AppError.
  TABLE_OCCUPIED: 'TABLE_OCCUPIED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',

  /**
   * Added by M4. All three are 422: each is a well-formed request breaking a
   * business rule, not bad input.
   */
  INGREDIENT_IN_USE: 'INGREDIENT_IN_USE',
  BASE_UNIT_IMMUTABLE: 'BASE_UNIT_IMMUTABLE',
  DUPLICATE_RECIPE_INGREDIENT: 'DUPLICATE_RECIPE_INGREDIENT',

  /**
   * Added by M6. 422 rather than 400: the dates are well formed and the range
   * is a legitimate thing to ask for, it is just more than this endpoint will
   * serve in one request.
   */
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',

  /**
   * Added by P02. FEATURE_DISABLED is 403: the request is fine and the caller
   * may be an owner, but this restaurant has switched the module off. The three
   * invoice codes are 422 business rules that protect the unique indexes on
   * `bills`, so a settings change cannot make bill creation fail at the till.
   */
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INVOICE_START_TOO_LOW: 'INVOICE_START_TOO_LOW',
  INVOICE_SERIES_STARTED: 'INVOICE_SERIES_STARTED',
  INVOICE_SERIES_LOCKED: 'INVOICE_SERIES_LOCKED',

  /** Added by P08. The method is inactive, wrong for the order type, or the wrong platform. */
  PAYMENT_METHOD_NOT_ALLOWED: 'PAYMENT_METHOD_NOT_ALLOWED',

  /** Added by P09. More than an account owes, and two payouts covering one date. */
  ACCOUNT_BALANCE_EXCEEDED: 'ACCOUNT_BALANCE_EXCEEDED',
  PAYOUT_PERIOD_OVERLAP: 'PAYOUT_PERIOD_OVERLAP',

  /** Added by P10. Day Close blocked, and a write into a closed day. */
  DAY_NOT_READY: 'DAY_NOT_READY',
  DAY_CLOSED: 'DAY_CLOSED',
  // P63. Day Close on the cloud while the cafe PC and the website both write.
  CLOSE_ON_CAFE_PC: 'CLOSE_ON_CAFE_PC',

  /** Added by P13, built in P15. The Tally export refuses while an ERROR check fails. */
  CHECK_FAILED: 'CHECK_FAILED',

  /** Added by P23 (M14). Online takeaway and bookings. */
  ONLINE_CLOSED: 'ONLINE_CLOSED',
  TOO_MANY_OPEN_REQUESTS: 'TOO_MANY_OPEN_REQUESTS',
  REQUEST_ALREADY_DECIDED: 'REQUEST_ALREADY_DECIDED',
  ONLINE_ORDER_CHANGED: 'ONLINE_ORDER_CHANGED',
  RESERVATION_CLASH: 'RESERVATION_CLASH',

  /** Added by P24. Online payment. */
  PAYMENT_GATEWAY_NOT_CONNECTED: 'PAYMENT_GATEWAY_NOT_CONNECTED',
  PAYMENT_GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',
  ADVANCE_NOT_APPLIED: 'ADVANCE_NOT_APPLIED',
  // P25 Part F.
  CASH_COUNT_MISMATCH: 'CASH_COUNT_MISMATCH',
  // P25 Parts G to K, M21 Integrations.
  PARTNER_SPEC_MISSING: 'PARTNER_SPEC_MISSING',
  INTEGRATION_NOT_ACTIVE: 'INTEGRATION_NOT_ACTIVE',
  INTEGRATION_TEST_FAILED: 'INTEGRATION_TEST_FAILED',
  PARTNER_CALL_FAILED: 'PARTNER_CALL_FAILED',
  // P44.
  EMAIL_SEND_FAILED: 'EMAIL_SEND_FAILED',
  TERMINAL_REQUIRED: 'TERMINAL_REQUIRED',
  TALLY_MAPPING_INCOMPLETE: 'TALLY_MAPPING_INCOMPLETE',
  TALLY_ALREADY_EXPORTED: 'TALLY_ALREADY_EXPORTED',
  DAY_NOT_CLOSED: 'DAY_NOT_CLOSED',
  PAIRING_CODE_INVALID: 'PAIRING_CODE_INVALID',
  BRIDGE_TOKEN_INVALID: 'BRIDGE_TOKEN_INVALID',
  // P29.
  BILL_NOT_REVISABLE: 'BILL_NOT_REVISABLE',
  WAITING_FOR_KITCHEN: 'WAITING_FOR_KITCHEN',
  ORDER_ALREADY_BILLED: 'ORDER_ALREADY_BILLED',
  // P37.
  TEMPLATE_NOT_APPROVED: 'TEMPLATE_NOT_APPROVED',
  MESSAGING_NOT_CONNECTED: 'MESSAGING_NOT_CONNECTED',
  GUEST_OPTED_OUT: 'GUEST_OPTED_OUT',
  // P62. The cafe box and its cloud mirror.
  MIRROR_READ_ONLY: 'MIRROR_READ_ONLY',
  CLOCK_BEHIND: 'CLOCK_BEHIND',
  WRITER_FENCED: 'WRITER_FENCED',
  REPLICATION_SIGNATURE: 'REPLICATION_SIGNATURE',
  REPLICATION_GAP: 'REPLICATION_GAP',
  STALE_EPOCH: 'STALE_EPOCH',
  WIFI_CONTROL_OFF: 'WIFI_CONTROL_OFF',
  WIFI_CHANGE_FAILED: 'WIFI_CHANGE_FAILED',
});

/**
 * Base class for every error we raise on purpose.
 *
 * `isOperational` separates an error we predicted from a genuine crash. The
 * error handler shows an operational message to the client and hides
 * everything else behind a generic 500.
 *
 * `details` is for the handful of errors that carry a value the client acts on
 * rather than displays: the id of the order already open on a table, the
 * version an order actually has. Those are named at the top level of `error` in
 * the contract, beside `code` and `message`, so the error handler merges them
 * in there. Keep it to ids and numbers the client needs to recover. It is not a
 * second `fields`, and it is never somewhere to put internal detail: whatever
 * goes in here is sent to the browser.
 */
export class AppError extends Error {
  constructor(
    message,
    { statusCode = 500, code = ERROR_CODES.INTERNAL_ERROR, fields, details } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    if (fields) this.fields = fields;
    if (details) this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You are not signed in.') {
    super(message, { statusCode: 401, code: ERROR_CODES.UNAUTHENTICATED });
  }
}

/**
 * Deliberately separate from UnauthenticatedError even though both are 401.
 * The client needs to tell "refresh the token" apart from "send the user back
 * to the login screen". Bouncing a cashier to a login form mid-service because
 * a 15 minute access token expired is a bug, not security.
 */
export class TokenExpiredError extends AppError {
  constructor(message = 'Your session has expired.') {
    super(message, { statusCode: 401, code: ERROR_CODES.TOKEN_EXPIRED });
  }
}

/**
 * Login failed. Which of the four reasons it was is never revealed.
 *
 * The phone is unknown, the password is wrong, the user is deactivated, or
 * their restaurant is deactivated: all four produce this exact object, with
 * the same status, code and message. A different message for a deactivated
 * account confirms the account exists.
 *
 * The real reason goes to the server log. See controllers/authController.js.
 */
export class InvalidCredentialsError extends AppError {
  constructor(message = 'Phone number or password is incorrect.') {
    super(message, { statusCode: 401, code: ERROR_CODES.INVALID_CREDENTIALS });
  }
}

/**
 * A refresh token that is unknown, expired, or already revoked.
 *
 * One code for all three, for the same reason as above. An "expired" message
 * would confirm the token was real.
 */
export class InvalidRefreshTokenError extends AppError {
  constructor(message = 'Your session is no longer valid. Please sign in again.') {
    super(message, { statusCode: 401, code: ERROR_CODES.INVALID_REFRESH_TOKEN });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this.') {
    super(message, { statusCode: 403, code: ERROR_CODES.FORBIDDEN });
  }
}

/**
 * Use this when a record does not exist AND when a record exists but belongs
 * to another restaurant.
 *
 * Never return ForbiddenError for a record from another restaurant. A 403
 * confirms the record exists, which tells whoever is probing that they guessed
 * a real id. A 404 tells them nothing. This rule is in
 * docs/CONVENTIONS.md section 3 and is repeated here so it does not get
 * "tidied up" by someone who thinks 403 is more accurate. It is more accurate.
 * It is also a leak.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, { statusCode: 404, code: ERROR_CODES.NOT_FOUND });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Some of the information sent was not valid.', fields) {
    super(message, { statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, fields });
  }
}

export class DuplicateError extends AppError {
  /**
   * `details` (P06) carries extra top-level fields the client acts on, such as
   * the `existingOrderId` of a platform order entered twice.
   */
  constructor(message = 'That already exists.', fields, details) {
    super(message, { statusCode: 409, code: ERROR_CODES.DUPLICATE, fields, details });
  }
}

/** Input was well formed but breaks a rule of the business. */
export class BusinessRuleError extends AppError {
  constructor(message = 'That is not allowed right now.', code = ERROR_CODES.BUSINESS_RULE_VIOLATED) {
    super(message, { statusCode: 422, code });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many attempts. Please wait and try again.') {
    super(message, { statusCode: 429, code: ERROR_CODES.RATE_LIMITED });
  }
}

/**
 * M1. A category name already used in this branch, compared case-insensitively.
 *
 * Its own class rather than a code argument to DuplicateError, because the four
 * M1 errors below are raised from two controllers and a shared helper, and a
 * class cannot be constructed with the wrong code by accident.
 */
export class DuplicateCategoryNameError extends AppError {
  constructor(message = 'A category with that name already exists.') {
    super(message, {
      statusCode: 409,
      code: ERROR_CODES.DUPLICATE_CATEGORY_NAME,
      fields: { name: 'Already in use.' },
    });
  }
}

/** M1. A menu item name already used in this branch, case-insensitively. */
export class DuplicateMenuItemNameError extends AppError {
  constructor(message = 'A menu item with that name already exists.') {
    super(message, {
      statusCode: 409,
      code: ERROR_CODES.DUPLICATE_MENU_ITEM_NAME,
      fields: { name: 'Already in use.' },
    });
  }
}

/**
 * M1. A variant id that is not on this item.
 *
 * 404 rather than 400, for the same reason a cross-tenant record is 404: the
 * caller named something that, as far as they are concerned, does not exist.
 */
export class VariantNotFoundError extends AppError {
  constructor(message = 'That variant is not on this item.') {
    super(message, { statusCode: 404, code: ERROR_CODES.VARIANT_NOT_FOUND });
  }
}

/** M1. An add-on id that is not on this item. */
export class AddOnNotFoundError extends AppError {
  constructor(message = 'That add-on is not on this item.') {
    super(message, { statusCode: 404, code: ERROR_CODES.ADDON_NOT_FOUND });
  }
}

/**
 * M5. A clock-in for someone who already has an open shift.
 *
 * The partial unique index on `attendanceentries` is the real guarantee; the
 * service checks first only so the caller gets this instead of a raw duplicate
 * key error, and catches the duplicate key as the backstop for the race
 * between two tablets.
 */
export class AlreadyClockedInError extends AppError {
  constructor(message = 'That shift is already open.') {
    super(message, { statusCode: 409, code: ERROR_CODES.ALREADY_CLOCKED_IN });
  }
}

/** M5. A clock-out with no open shift to close. */
export class NotClockedInError extends AppError {
  constructor(message = 'There is no open shift to close.') {
    super(message, { statusCode: 409, code: ERROR_CODES.NOT_CLOCKED_IN });
  }
}

/** M5. A clock-out at or before the clock-in it belongs to. */
export class ClockOutBeforeClockInError extends AppError {
  constructor(message = 'Clock-out cannot be at or before clock-in.') {
    super(message, { statusCode: 422, code: ERROR_CODES.CLOCK_OUT_BEFORE_CLOCK_IN });
  }
}

/** M5. A correction to, or a void of, an entry that is already voided. */
export class EntryVoidedError extends AppError {
  constructor(message = 'That entry is voided and cannot be changed.') {
    super(message, { statusCode: 422, code: ERROR_CODES.ENTRY_VOIDED });
  }
}

/**
 * M2. An order is already open on this table.
 *
 * Raised from the duplicate key error the partial unique index on `orders`
 * produces, never from a check-then-write in a controller. The existing order's
 * id travels with it so the client can open that order instead of showing the
 * second waiter a dead end. That id is not a leak: the caller is inside the
 * restaurant that owns the order, and they are about to be shown the whole
 * thing anyway.
 */
export class TableOccupiedError extends AppError {
  constructor(existingOrderId, message = 'An order is already open on this table.') {
    super(message, {
      statusCode: 409,
      code: ERROR_CODES.TABLE_OCCUPIED,
      details: existingOrderId ? { existingOrderId: String(existingOrderId) } : undefined,
    });
  }
}

/**
 * M5. Correcting, voiding or manually creating your own attendance entry.
 *
 * 422, not 403: it binds everyone including an owner. The audit trail exists to
 * catch someone inflating their own hours, and an actor who can edit their own
 * entry defeats it.
 */
export class SelfCorrectionForbiddenError extends AppError {
  constructor(message = 'You cannot change your own attendance entry. Ask someone else.') {
    super(message, { statusCode: 422, code: ERROR_CODES.SELF_CORRECTION_FORBIDDEN });
  }
}

/**
 * M0-D. A wrong PIN, or a user with no PIN.
 *
 * 401, and deliberately vague: the same object for both cases, so a caller
 * cannot learn whether a PIN is set. Raised by authService.verifyPin, which
 * M5's shared-tablet clock calls.
 */
export class InvalidPinError extends AppError {
  constructor(message = 'That PIN is not correct.') {
    super(message, { statusCode: 401, code: ERROR_CODES.INVALID_PIN });
  }
}

/**
 * M0-D. Too many wrong PINs in a row.
 *
 * 429. The PIN stays locked until an OWNER or MANAGER resets it; it does not
 * clear on its own.
 */
export class PinLockedError extends AppError {
  constructor(message = 'This PIN is locked. Ask a manager to reset it.') {
    super(message, { statusCode: 429, code: ERROR_CODES.PIN_LOCKED });
  }
}

/**
 * M2. The order changed between the client reading it and writing to it.
 *
 * Carries the version the order actually has, so the client can reload and show
 * the waiter what really happened rather than silently overwriting a
 * colleague's work. This is the expected outcome of two people working one
 * table, not an exceptional one.
 */
export class VersionConflictError extends AppError {
  constructor(currentVersion, message = 'This order was changed by someone else. Reloading.') {
    super(message, {
      statusCode: 409,
      code: ERROR_CODES.VERSION_CONFLICT,
      details: { currentVersion },
    });
  }
}

/**
 * M3. A live bill already exists for this order.
 *
 * Raised from the duplicate key error the partial unique index on `bills`
 * produces, never from a check-then-write. The existing bill's id travels with
 * it so the client opens that bill instead of making a second one, the same
 * shape TableOccupiedError uses.
 */
export class BillAlreadyExistsError extends AppError {
  constructor(existingBillId, message = 'This order has already been billed.') {
    super(message, {
      statusCode: 409,
      code: ERROR_CODES.BILL_ALREADY_EXISTS,
      details: existingBillId ? { existingBillId: String(existingBillId) } : undefined,
    });
  }
}

/**
 * M3. This connection cannot start a transaction, so a gap-free bill number
 * cannot be guaranteed.
 *
 * Every other write in this project uses withOptionalTransaction and degrades
 * gracefully on a standalone mongod. Bill creation deliberately does not. A
 * gap-free sequence has no degraded mode: without a transaction the guarantee
 * is simply absent, and silently issuing gappy bill numbers in development is
 * how the pattern reaches production and then an auditor.
 *
 * 503 rather than 500, because the request was fine and retrying against a
 * replica set works.
 */
export class TransactionRequiredError extends AppError {
  constructor(
    message = 'Billing is unavailable on this server configuration. It needs a replica set.',
  ) {
    super(message, { statusCode: 503, code: ERROR_CODES.TRANSACTION_REQUIRED });
  }
}

/**
 * Thrown by the tenant guard when a query reaches the database without a
 * restaurantId filter.
 *
 * This is a 500 because it is our bug, not the caller mistake. It is loud on
 * purpose: a crash is recoverable, a cross-restaurant data leak is not.
 */
export class TenantFilterMissingError extends AppError {
  constructor(modelName, operation) {
    super(
      `Query on ${modelName}.${operation} has no restaurantId filter. Blocked before it reached the database.`,
      { statusCode: 500, code: ERROR_CODES.INTERNAL_ERROR },
    );
    this.modelName = modelName;
    this.operation = operation;
  }
}

/**
 * M4. Deactivating an ingredient a live recipe still consumes.
 *
 * A recipe changes what every future sale deducts, so deactivating an
 * ingredient it references would silently stop deducting for every dish that
 * uses it. The message names how many recipes are affected.
 */
export class IngredientInUseError extends AppError {
  constructor(message = 'This ingredient is still used by an active recipe.') {
    super(message, { statusCode: 422, code: ERROR_CODES.INGREDIENT_IN_USE });
  }
}

/**
 * M4. Changing `baseUnit` after any stockmovements document exists for the
 * ingredient.
 *
 * Changing it would reinterpret every historical quantity in the ledger --
 * 500 g of paneer silently becoming 500 ml -- with no way to detect that
 * afterwards.
 */
export class BaseUnitImmutableError extends AppError {
  constructor(message = "This ingredient's base unit cannot change once stock has moved.") {
    super(message, { statusCode: 422, code: ERROR_CODES.BASE_UNIT_IMMUTABLE });
  }
}

/**
 * M6. A report range wider than the cap.
 *
 * Without a cap, one request scans years of bills and takes the database down
 * during service -- the report screen is opened by an owner, but the database
 * it stalls is the one the floor is taking orders against.
 *
 * 422, not 400: the dates parsed fine and the question is reasonable, it is
 * the size of the answer that is refused. The message names the cap and the
 * range actually asked for, so the caller can narrow it without guessing.
 */
export class RangeTooLargeError extends AppError {
  constructor(days, maxDays) {
    super(
      `That range is ${days} days. Reports cover at most ${maxDays} days in one request.`,
      { statusCode: 422, code: ERROR_CODES.RANGE_TOO_LARGE },
    );
  }
}

/** M4. The same ingredient listed twice in one PUT /recipes body. */
export class DuplicateRecipeIngredientError extends AppError {
  constructor(message = 'The same ingredient cannot appear twice in one recipe.') {
    super(message, { statusCode: 422, code: ERROR_CODES.DUPLICATE_RECIPE_INGREDIENT });
  }
}

/**
 * P02. The route belongs to a module this restaurant has switched off in
 * `settings.features`. Raised by middleware/requireFeature.js.
 */
export class FeatureDisabledError extends AppError {
  constructor(featureLabel) {
    super(
      `${featureLabel} is switched off for this restaurant. An owner can switch it on in Settings.`,
      { statusCode: 403, code: ERROR_CODES.FEATURE_DISABLED },
    );
  }
}

/**
 * P08. A payment method this bill may not use: inactive, not allowed for the
 * order type, or another platform's. The message names which.
 */
export class PaymentMethodNotAllowedError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.PAYMENT_METHOD_NOT_ALLOWED });
  }
}

/** P09. A collection or a downward adjustment larger than the account owes. */
export class AccountBalanceExceededError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.ACCOUNT_BALANCE_EXCEEDED });
  }
}

/** P09. Two live payouts for one method would cover the same business date. */
export class PayoutPeriodOverlapError extends AppError {
  constructor(message) {
    super(message, { statusCode: 409, code: ERROR_CODES.PAYOUT_PERIOD_OVERLAP });
  }
}

/** P10. Day Close is blocked; `details.blockers` lists every reason at once. */
export class DayNotReadyError extends AppError {
  constructor(blockers) {
    super(
      blockers.length === 1
        ? `This day cannot be closed yet: ${blockers[0].message}`
        : `This day cannot be closed yet. ${blockers.length} things need sorting first.`,
      { statusCode: 422, code: ERROR_CODES.DAY_NOT_READY, details: { blockers } },
    );
  }
}

/** P10. A write would change a business date that has been closed. */
/** P63. Only the cafe PC closes the day while two-way sync is on. */
export class CloseOnCafePcError extends AppError {
  constructor() {
    super('Close the day on the cafe PC. The website and the PC share the day, and only the PC closes it.', {
      statusCode: 422,
      code: ERROR_CODES.CLOSE_ON_CAFE_PC,
    });
  }
}

export class DayClosedError extends AppError {
  constructor(businessDate) {
    super(`${businessDate} is closed. An owner can reopen it.`, {
      statusCode: 409,
      code: ERROR_CODES.DAY_CLOSED,
      details: { businessDate },
    });
  }
}

/** P15. A report that must not be built while an ERROR check fails, such as R9. */
export class CheckFailedError extends AppError {
  constructor(failed) {
    super(
      `This file is not built while a check fails: ${failed.map((check) => check.message).join(' ')}`,
      { statusCode: 422, code: ERROR_CODES.CHECK_FAILED, details: { checks: failed } },
    );
  }
}


/**
 * Thrown by the append-only guard when code tries to change or remove an
 * audit line. M8.
 *
 * A 500, like the tenant guard: it is our bug, never the caller's. Nothing
 * legitimately updates an audit line. If one is wrong, the truth is that a
 * wrong line was written, and the fix is a new line saying so.
 */
export class AuditLogImmutableError extends AppError {
  constructor(operation) {
    super(`Audit lines are append-only. ${operation} on auditlogs was blocked.`, {
      statusCode: 500,
      code: ERROR_CODES.INTERNAL_ERROR,
    });
    this.operation = operation;
  }
}

/* --------------------------------------------------------------------------
 * P23 (M14). Online takeaway and bookings.
 * ----------------------------------------------------------------------- */

/** Takeaway or bookings are off, paused, or outside hours. The message is what the page shows. */
export class OnlineClosedError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.ONLINE_CLOSED });
  }
}

/** This phone already has the most open requests allowed. */
export class TooManyOpenRequestsError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.TOO_MANY_OPEN_REQUESTS });
  }
}

/** The request is no longer waiting. `currentStatus` says what it is now. */
export class RequestAlreadyDecidedError extends AppError {
  constructor(currentStatus) {
    super(`This request has already been dealt with. It is ${String(currentStatus).toLowerCase().replace('_', ' ')}.`, {
      statusCode: 409,
      code: ERROR_CODES.REQUEST_ALREADY_DECIDED,
      details: { currentStatus },
    });
  }
}

/** A price or availability changed since the guest's quote. `changes` lists each. */
export class OnlineOrderChangedError extends AppError {
  constructor(changes) {
    super(
      changes.some((change) => change.unavailable)
        ? 'Something in this order is no longer available. Call the guest, then decline it.'
        : 'Prices changed since the guest ordered. Call the guest before accepting at the new prices.',
      { statusCode: 422, code: ERROR_CODES.ONLINE_ORDER_CHANGED, details: { changes } },
    );
  }
}

/** The table has another confirmed booking inside the hold window. */
export class ReservationClashError extends AppError {
  constructor(clashes) {
    super(`That table is already booked near that time (${clashes.map((clash) => clash.reference).join(', ')}).`, {
      statusCode: 409,
      code: ERROR_CODES.RESERVATION_CLASH,
      details: { clashes },
    });
  }
}

/* --------------------------------------------------------------------------
 * P24. Online payment.
 * ----------------------------------------------------------------------- */

/** No gateway connected, or no PAYMENT_SECRETS_KEY on this server. */
export class PaymentGatewayNotConnectedError extends AppError {
  constructor(message = 'Online payment is not set up for this restaurant.') {
    super(message, { statusCode: 422, code: ERROR_CODES.PAYMENT_GATEWAY_NOT_CONNECTED });
  }
}

/** Razorpay refused, or could not be reached. Not our fault and not the guest's. */
export class PaymentGatewayError extends AppError {
  constructor(message) {
    super(message, { statusCode: 502, code: ERROR_CODES.PAYMENT_GATEWAY_ERROR });
  }
}

/** A bill whose order was paid online takes the advance before anything else. */
export class AdvanceNotAppliedError extends AppError {
  constructor() {
    super('This order was paid online. Apply the online advance first.', {
      statusCode: 422,
      code: ERROR_CODES.ADVANCE_NOT_APPLIED,
    });
  }
}

/** P25 Part F. A count by notes and a total sent beside it disagree. */
export class CashCountMismatchError extends AppError {
  constructor(countedInPaise, sentInPaise) {
    super(
      `The notes and coins add up to ${(countedInPaise / 100).toFixed(2)}, not ${(sentInPaise / 100).toFixed(2)}. Count again or fix the total.`,
      { statusCode: 422, code: ERROR_CODES.CASH_COUNT_MISMATCH },
    );
  }
}

/** P25 Part G. The partner has not approved the integration, so its adapter has no document. */
export class PartnerSpecMissingError extends AppError {
  constructor(partnerName) {
    super(
      `${partnerName} has not approved this integration yet, so live orders cannot be received. Use the Sandbox platform to practise.`,
      { statusCode: 422, code: ERROR_CODES.PARTNER_SPEC_MISSING },
    );
  }
}

/** P25 Part G. The connection is missing, a draft, paused or in error. */
export class IntegrationNotActiveError extends AppError {
  constructor(message = 'This connection is not switched on. An owner can test it and switch it on in Integrations.') {
    super(message, { statusCode: 422, code: ERROR_CODES.INTEGRATION_NOT_ACTIVE });
  }
}

/** P25 Part G. Test connection failed. The message is the plain reason, with no secret in it. */
export class IntegrationTestFailedError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.INTEGRATION_TEST_FAILED });
  }
}

/** P25 Part G. A partner call failed or timed out while a person waited. */
/** P44. Resend refused the day-end email, or could not be reached. */
export class EmailSendFailedError extends AppError {
  constructor(message) {
    super(message, { statusCode: 502, code: ERROR_CODES.EMAIL_SEND_FAILED });
  }
}

export class PartnerCallFailedError extends AppError {
  constructor(message) {
    super(message, { statusCode: 502, code: ERROR_CODES.PARTNER_CALL_FAILED });
  }
}

/** P25 Part I. A method linked to a card machine, recorded by hand without a manager's reason. */
export class TerminalRequiredError extends AppError {
  constructor() {
    super('Send this payment to the card machine.', { statusCode: 422, code: ERROR_CODES.TERMINAL_REQUIRED });
  }
}

/** P25 Part J. A head with an amount on the date has no Tally ledger; `missing` lists each. */
export class TallyMappingIncompleteError extends AppError {
  constructor(missing) {
    super(`Choose a Tally ledger for: ${missing.join(', ')}.`, { statusCode: 422, code: ERROR_CODES.TALLY_MAPPING_INCOMPLETE, details: { missing } });
  }
}

/** P25 Part J. The date may already be in Tally; a redo needs the owner's confirmation. */
export class TallyAlreadyExportedError extends AppError {
  constructor(businessDates) {
    super(`Already sent to Tally or downloaded: ${businessDates.join(', ')}. An owner can redo a date after deleting its vouchers in Tally.`, {
      statusCode: 409,
      code: ERROR_CODES.TALLY_ALREADY_EXPORTED,
      details: { businessDates },
    });
  }
}

/** P25 Part J. Only closed days are exported. */
export class DayNotClosedError extends AppError {
  /** P65. `purpose` says what needs the days closed; Tally's sentence by default. */
  constructor(businessDates, purpose = 'Only closed days go to Tally.') {
    super(`Close the day first: ${businessDates.join(', ')}. ${purpose}`, {
      statusCode: 422,
      code: ERROR_CODES.DAY_NOT_CLOSED,
      details: { businessDates },
    });
  }
}

/** P25 Part K. A wrong, used or expired pairing code: the same answer for each. */
export class PairingCodeInvalidError extends AppError {
  constructor() {
    super('That pairing code is wrong, used or expired. Ask the owner for a new one.', { statusCode: 401, code: ERROR_CODES.PAIRING_CODE_INVALID });
  }
}

/** P25 Part K. An unknown or revoked bridge token, on every bridge route. */
export class BridgeTokenInvalidError extends AppError {
  constructor() {
    super('This Tally bridge is not paired, or was switched off. Pair it again.', { statusCode: 401, code: ERROR_CODES.BRIDGE_TOKEN_INVALID });
  }
}

/** P29 Part B. Removing an item from a bill that cannot be revised; `message` says why. */
export class BillNotRevisableError extends AppError {
  constructor(message) {
    super(message, { statusCode: 422, code: ERROR_CODES.BILL_NOT_REVISABLE });
  }
}

/** P29 Part B. Money taken on a bill whose order has items not yet ready. */
export class WaitingForKitchenError extends AppError {
  constructor() {
    super('The new items are not ready yet. Take payment once the kitchen has them ready.', {
      statusCode: 422,
      code: ERROR_CODES.WAITING_FOR_KITCHEN,
    });
  }
}

/** P29 Part E. Undoing ready in the kitchen on an order that has a live bill. */
export class OrderAlreadyBilledError extends AppError {
  constructor() {
    super('This table has been billed. Ask the cashier to change the bill.', {
      statusCode: 422,
      code: ERROR_CODES.ORDER_ALREADY_BILLED,
    });
  }
}

/** P37. A WhatsApp send against a template Meta has not approved: refused, never queued. */
export class TemplateNotApprovedError extends AppError {
  constructor(message = 'Meta has not approved this template yet, so it cannot be sent.') {
    super(message, { statusCode: 422, code: ERROR_CODES.TEMPLATE_NOT_APPROVED });
  }
}

/** P37. The restaurant's WhatsApp is not connected, or not switched on. */
export class MessagingNotConnectedError extends AppError {
  constructor(message = 'WhatsApp is not connected. An owner connects it in Integrations.') {
    super(message, { statusCode: 422, code: ERROR_CODES.MESSAGING_NOT_CONNECTED });
  }
}

/** P37. A marketing message to a guest without live offers consent. */
export class GuestOptedOutError extends AppError {
  constructor(message = 'This guest has not agreed to offers, so no marketing message goes to them.') {
    super(message, { statusCode: 422, code: ERROR_CODES.GUEST_OPTED_OUT });
  }
}

/**
 * P62. The cloud mirror refuses a write: it is a read-only copy until a person
 * promotes it (docs/RUNBOOK.md). 503, because the request is fine and the
 * place that can take it is the cafe box.
 */
export class MirrorReadOnlyError extends AppError {
  constructor(message = 'This is the read-only copy in the cloud. Changes are made on the cafe\'s own server.') {
    super(message, { statusCode: 503, code: ERROR_CODES.MIRROR_READ_ONLY });
  }
}

/**
 * P62 section 2.6. The box's clock has gone behind the newest sale it holds,
 * so any write would be dated on the wrong day. Refused until it is fixed.
 */
export class ClockBehindError extends AppError {
  constructor(message = "The cafe server's clock is behind the last sale, so nothing can be saved until it is set right. Ask the manager: the fix is in the runbook, section 4.") {
    super(message, { statusCode: 503, code: ERROR_CODES.CLOCK_BEHIND });
  }
}

/**
 * P62 section 8. Authority moved to another machine (a higher epoch), so this
 * one has stood down and writes nothing.
 */
export class WriterFencedError extends AppError {
  constructor(message = 'This server has handed over to the cloud copy. Sign in at the cloud address the manager gives you.') {
    super(message, { statusCode: 503, code: ERROR_CODES.WRITER_FENCED });
  }
}

/** P62. A replication request whose signature does not match the shared secret. */
export class ReplicationSignatureError extends AppError {
  constructor() {
    super('The replication signature did not match.', { statusCode: 401, code: ERROR_CODES.REPLICATION_SIGNATURE });
  }
}

/** P62. A batch that does not start where the copy left off. Carries the seq the copy expects. */
export class ReplicationGapError extends AppError {
  constructor(expectedSeq, gotSeq) {
    super(`The copy expects entry ${expectedSeq} next and was sent ${gotSeq}. It will not skip.`, {
      statusCode: 409,
      code: ERROR_CODES.REPLICATION_GAP,
      details: { expectedSeq, gotSeq },
    });
  }
}

/** P62. A batch stamped with an epoch below the current writer's: the sender was replaced. */
export class StaleEpochError extends AppError {
  constructor(currentEpoch, sentEpoch) {
    super(`Authority has moved to epoch ${currentEpoch}; this batch is from epoch ${sentEpoch}.`, {
      statusCode: 409,
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch, sentEpoch },
    });
  }
}

/** P62. Changing the box's WiFi from the dashboard is switched off on this box. */
export class WifiControlOffError extends AppError {
  constructor(message = 'Changing WiFi from here is switched off on this server. docs/STAFF-SETUP.md section 5 says how to switch it on.') {
    super(message, { statusCode: 422, code: ERROR_CODES.WIFI_CONTROL_OFF });
  }
}

/** P62. The box could not join the WiFi asked for, and stayed on the one it had. */
export class WifiChangeFailedError extends AppError {
  constructor(message = 'The server could not join that WiFi and stayed on the one it had. Check the name and password.') {
    super(message, { statusCode: 422, code: ERROR_CODES.WIFI_CHANGE_FAILED });
  }
}
