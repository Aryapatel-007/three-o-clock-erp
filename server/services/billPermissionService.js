/**
 * Who may do what to a bill, in one file.
 *
 * The same shape as services/userPermissionService.js, and for the same
 * reason: anyone asking "what may a cashier do" should read one file, not four
 * route handlers.
 *
 * Two kinds of rule live here, and the split is the one M0-C established.
 *
 * Permission rules are about who the caller is and fail with 403 FORBIDDEN.
 * Business rules are about the state of the bill or the order and fail with
 * 422. 403 means "not you"; 422 means "not this, by anyone".
 *
 * The route table already refuses the wrong role before a controller runs, so
 * the assertions here are the second line rather than the only one. They exist
 * because a route table is a list of strings that can be edited without anyone
 * reading the reasoning, and the reasoning is what this file holds.
 */
import { isPlatformDiscountReason } from '../config/discountReasons.js';
import { ROLES } from '../config/roles.js';
import { ORDER_STATUSES } from '../models/Order.js';
import { BusinessRuleError, EntryVoidedError, ForbiddenError } from '../utils/errors.js';

/** Discounting and voiding are manager work. Everything else a cashier can do. */
const MANAGER_ROLES = Object.freeze([ROLES.OWNER, ROLES.MANAGER]);

const isManagerOrAbove = (role) => MANAGER_ROLES.includes(role);

/** The people who work the till. P25: a captain joins them only by setting. */
const TILL_ROLES = Object.freeze([ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER]);

/**
 * Applying a discount.
 *
 * An owner or a manager may give any discount. This is the single most
 * deliberate permission in M3: BUILD-PLAN section 7 names discounts and voids as
 * the events an owner is losing money to, and the audit trail only means
 * something if the person who can trigger it is the person accountable for it.
 *
 * P08 opens exactly one narrow door. When the owner switches on
 * `discounts.cashierMayApplyPlatformDiscounts`, a CASHIER may apply a discount
 * whose reason is a platform's (Zomato Gold, Dineout, EazyDiner): the guest
 * shows the app, the platform sets the amount, and nobody at the till decides
 * it. Every other reason stays manager work. The route lets a cashier through
 * so this function can decide; it is the only gate.
 */
export function assertCanDiscount(actor, { reasonCode = null, cashierMayApplyPlatformDiscounts = false } = {}) {
  if (isManagerOrAbove(actor.role)) return;

  if (actor.role === ROLES.CASHIER && cashierMayApplyPlatformDiscounts) {
    if (reasonCode === null || isPlatformDiscountReason(reasonCode)) return;
    throw new ForbiddenError('A cashier can apply only a platform discount, like Zomato Gold.');
  }

  throw new ForbiddenError('Only an owner or a manager can discount a bill.');
}

/**
 * Making a bill. P25 Part D.
 *
 * The till always may. A captain (WAITER) may when the owner leaves
 * `billing.captainsMayBill` on, for the dine-in or takeaway order they are
 * serving; never a delivery order, which the platform integration bills (M21).
 * The route lets a WAITER through so this function can decide.
 */
export function assertCanBill(actor, order, billing = {}) {
  if (TILL_ROLES.includes(actor.role)) return;
  if (actor.role === ROLES.WAITER && billing.captainsMayBill) {
    if (order?.orderType === 'DELIVERY') {
      throw new ForbiddenError('A captain cannot bill a delivery order. The counter bills it.');
    }
    return;
  }
  throw new ForbiddenError('Only the counter can make this bill.');
}

/**
 * Taking a payment, by hand or on the card machine. P25 Part D.
 *
 * A captain may only when the owner allows both billing and taking payment,
 * and never on a delivery bill.
 */
export function assertCanTakePayment(actor, bill, billing = {}) {
  if (TILL_ROLES.includes(actor.role)) return;
  if (actor.role === ROLES.WAITER && billing.captainsMayBill && billing.captainsMayTakePayment) {
    if (bill?.orderType === 'DELIVERY') {
      throw new ForbiddenError('A captain cannot take payment on a delivery bill.');
    }
    return;
  }
  throw new ForbiddenError('Only the counter can take payment on this bill.');
}

/** P39. What a captain is told when a printed bill's items would change. */
export const PRINTED_BILL_MESSAGE = 'This bill has been printed. Only the counter or a manager can change it now.';

/**
 * Changing a bill's items. P39, API-CONTRACT P39.
 *
 * A captain (WAITER) adds and removes items freely until the bill is first
 * printed. After that only the counter may: a printed bill is what the guest
 * has been shown, and a captain lowering it is where money goes missing. A
 * manager's PIN does not lift this. The till roles are never stopped here.
 */
export function assertCaptainMayChangeBill(actor, bill) {
  if (actor?.role === ROLES.WAITER && (bill?.printCount ?? 0) > 0) {
    throw new ForbiddenError(PRINTED_BILL_MESSAGE);
  }
}

/** Correcting a payment's method. P08. Moving money between cash and UPI after the fact. */
export function assertCanCorrectPayment(actor) {
  if (!isManagerOrAbove(actor.role)) {
    throw new ForbiddenError('Only an owner or a manager can change how a payment was made.');
  }
}

/** Voiding a bill. Same reasoning as a discount, and the same roles. */
/** Before P28 the void route's own rule; a cashier with a PIN now goes through approvalService. */
export function assertCanVoid(actor) {
  if (!isManagerOrAbove(actor.role)) {
    throw new ForbiddenError('Only an owner or a manager can void a bill.');
  }
}

/* --------------------------------------------------------------------------
 * Business rules. These bind everyone, including an owner.
 * ----------------------------------------------------------------------- */

/**
 * An order is billable only from READY_TO_BILL.
 *
 * Not from OPEN: a bill printed while the kitchen is still cooking is a bill
 * that will be wrong. Not from BILLED or CANCELLED for the obvious reasons.
 */
export function assertOrderIsBillable(order) {
  if (order.status !== ORDER_STATUSES.READY_TO_BILL) {
    throw new BusinessRuleError(
      order.status === ORDER_STATUSES.OPEN
        ? 'This order is still open. Serve everything on it before billing.'
        : 'This order cannot be billed.',
    );
  }
}

/** A bill with nothing on it is not a bill. */
export function assertBillHasLines(lines) {
  if (lines.length === 0) {
    throw new BusinessRuleError(
      'Every line on this order was cancelled, so there is nothing to bill.',
    );
  }
}

/** Nothing is changed on a voided bill, by anyone. */
export function assertNotVoided(bill) {
  if (bill.isVoided) throw new EntryVoidedError('This bill is voided and cannot be changed.');
}

/**
 * A paid bill is closed.
 *
 * Discounting after payment would mean the amount collected no longer matches
 * the bill, and the difference has to be handed back in cash, which this
 * system does not model. Void it and re-issue instead.
 */
export function assertNotPaid(bill, action = 'changed') {
  // P09: a bill charged to an On Hold account is settled, like a paid one.
  if (bill.status === 'ON_ACCOUNT') {
    throw new BusinessRuleError(
      `This bill is On Hold on ${bill.account?.accountName ?? 'an account'}, so it cannot be ${action}. ` +
        'Void it and bill again.',
    );
  }
  if (bill.amountPaidInPaise > 0) {
    throw new BusinessRuleError(
      `Money has already been collected against this bill, so it cannot be ${action}. ` +
        'Void it and bill again.',
    );
  }
}

/** A discount cannot exceed what is being discounted. */
export function assertDiscountFits(discountAmountInPaise, subtotalInPaise) {
  if (discountAmountInPaise > subtotalInPaise) {
    throw new BusinessRuleError('A discount cannot be more than the bill itself.');
  }
}

/**
 * Overpayment is refused rather than stored.
 *
 * Change given in cash is not a payment, and recording it would break the
 * reconciliation between amountPaidInPaise and grandTotalInPaise that every
 * report downstream relies on.
 */
export function assertPaymentFits(bill, amountInPaise) {
  // P09: an On Hold bill is settled by its account; money arrives as a collection.
  if (bill.status === 'ON_ACCOUNT') {
    throw new BusinessRuleError(
      'This bill is On Hold. Record the money as a collection on the account instead.',
    );
  }
  const outstanding = bill.grandTotalInPaise - bill.amountPaidInPaise;

  if (outstanding <= 0) {
    throw new BusinessRuleError('This bill is already paid in full.');
  }
  if (amountInPaise > outstanding) {
    throw new BusinessRuleError(
      'That is more than the amount outstanding. Record what was collected against the bill.',
    );
  }
}

export default {
  assertBillHasLines,
  assertCanBill,
  assertCanTakePayment,
  assertCanCorrectPayment,
  assertCanDiscount,
  assertCanVoid,
  assertDiscountFits,
  assertNotPaid,
  assertNotVoided,
  assertOrderIsBillable,
  assertPaymentFits,
};
