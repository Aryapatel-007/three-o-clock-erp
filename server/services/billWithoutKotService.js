/**
 * P60. Bill without KOT: the counter bills dishes that never go to the
 * kitchen. API-CONTRACT "P60", DB-SCHEMA section 59.
 *
 * Runs inside the bill's own transaction, before the bill is made: the dishes
 * not yet sent become served, marked `billedWithoutKot`, and the order becomes
 * ready to bill in one versioned write. No KOT is made, so nothing reaches the
 * kitchen screen, a kitchen printer, or R13's kitchen times. Stock is deducted
 * exactly as a Send would, keyed on the line, so it can never be taken twice.
 */
import { ORDER_LINE_STATUSES, ORDER_STATUSES, ORDER_TYPES } from '../models/Order.js';
import { ROLES } from '../config/roles.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { Order } from '../models/Order.js';
import { applyVersionedUpdate, readyToBillChange } from './orderService.js';
import { getSetting, isFeatureOn } from './settingsService.js';
import { deductForFiredLines } from './stockMovementService.js';

const COUNTER = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];

/** A captain takes orders to the kitchen; only the counter may skip it. Checked before the transaction. */
export function assertMayBillWithoutKot(user) {
  if (!COUNTER.includes(user?.role)) {
    throw new ForbiddenError('Only the counter can bill without sending to the kitchen.');
  }
}

/**
 * Serves the order's not-sent dishes without a KOT. Returns the order's
 * version after the write, which the bill then uses; an order already ready to
 * bill is left as it is and its version returned unchanged.
 */
export async function serveWithoutKotInSession(req, { orderId, version }, session) {
  const order = await Order.findOne({ ...scoped(req), _id: orderId }).session(session);
  if (!order) throw new NotFoundError('Order not found.');

  const counterOrder = [ORDER_TYPES.DINE_IN, ORDER_TYPES.TAKEAWAY].includes(order.orderType) && !order.platform?.code;
  if (!counterOrder) throw new BusinessRuleError('Only a table or a takeaway can be billed without a KOT.');

  if (order.status === ORDER_STATUSES.READY_TO_BILL) return version;
  if (order.status !== ORDER_STATUSES.OPEN || order.billId) throw new BusinessRuleError('This order cannot be billed.');

  const live = order.lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED);
  const withKitchen = live.some((line) => [ORDER_LINE_STATUSES.FIRED, ORDER_LINE_STATUSES.READY].includes(line.status));
  if (withKitchen) throw new BusinessRuleError('Some dishes are with the kitchen. Bill once they are served.');
  const notSent = live.filter((line) => line.status === ORDER_LINE_STATUSES.PENDING);
  if (notSent.length === 0) throw new BusinessRuleError('There is nothing on this order to bill.');

  // P59. Covers are required at the first Send when the restaurant asks; this is that moment too.
  if (
    order.orderType === ORDER_TYPES.DINE_IN &&
    order.guestCount == null &&
    (await getSetting(req.restaurantId, 'floor.requireGuestCount', { req }))
  ) {
    throw new ValidationError('How many guests? Enter the number before billing.', { guestCount: 'How many guests?' });
  }

  const at = nowUtc();
  const updated = await applyVersionedUpdate(req, {
    orderId: order._id,
    version,
    update: {
      $set: {
        'lines.$[notSent].status': ORDER_LINE_STATUSES.SERVED,
        'lines.$[notSent].servedAt': at,
        'lines.$[notSent].billedWithoutKot': true,
        ...readyToBillChange(at),
      },
    },
    arrayFilters: [{ 'notSent.status': ORDER_LINE_STATUSES.PENDING }],
    session,
  });

  if (await isFeatureOn(req, 'inventory')) {
    await deductForFiredLines(req, { lines: notSent, orderId: order._id, at }, session);
  }

  return updated.version;
}

export default { assertMayBillWithoutKot, serveWithoutKotInSession };
