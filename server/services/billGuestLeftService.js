/**
 * Voiding a bill and closing its order. P59, for Guest left; from 2026-10-22
 * for any reason, with `closeOrder` on POST /bills/:billId/void (14.6).
 *
 * A plain void sends the order back to READY_TO_BILL, so the table stays
 * taken until a new bill is made. When there is nothing to bill again (the
 * guest left, a test bill, a table billed by mistake) this voids the bill and
 * cancels the order in one transaction, and the table is free at once.
 *
 * The food was served, so the order's kitchen lines are marked prepared and no
 * stock is returned. A bill with money on it, or On Hold, is refused: that
 * money has to be dealt with first, as cancelling an order already says.
 */
import { BILL_VOID_REASONS, ORDER_CANCEL_REASONS, reasonText } from '../config/cancelReasons.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { BILL_STATUSES } from '../models/Bill.js';
import { ORDER_LINE_STATUSES, ORDER_STATUSES, PREPARED_LINE_STATUSES } from '../models/Order.js';
import { recordAudit } from './auditService.js';
import { readBill, voidBillInSession } from './billService.js';
import { cancelKotLinesFor } from './kitchenService.js';
import { applyVersionedUpdate, computeLineTotalInPaise, loadOrderInTenant } from './orderService.js';
import { BusinessRuleError } from '../utils/errors.js';
import { sumPaise } from '../utils/money.js';
import { nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';

export const GUEST_LEFT = 'GUEST_LEFT';

/** The order list has these codes too; any other bill reason cancels the order as Other, its label the note. */
const SAME_ON_THE_ORDER = new Set(['GUEST_LEFT', 'PLATFORM_CANCELLED', 'OTHER']);

/** The order's cancel reason for a bill voided with `reasonCode` and `note`. */
function orderReasonFor(reasonCode, note) {
  if (SAME_ON_THE_ORDER.has(reasonCode)) return { code: reasonCode, note };
  const label = reasonText(BILL_VOID_REASONS, reasonCode, null);
  return { code: 'OTHER', note: note ? `${label}: ${note}` : label };
}

export async function voidBillAndCloseOrder(req, billId, { reasonCode, note = null, approvedBy = null }) {
  const bill = await readBill(req, billId);
  if (bill.amountPaidInPaise > 0 || bill.status === BILL_STATUSES.ON_ACCOUNT) {
    throw new BusinessRuleError('This bill has money on it, so the table cannot be closed with it. Take the money off first, or choose Bill this table again.');
  }
  const order = await loadOrderInTenant(req, bill.orderId);
  const at = nowUtc();
  const orderReason = orderReasonFor(reasonCode, note);

  return withOptionalTransaction(async (session) => {
    const voided = await voidBillInSession(req, billId, { reasonCode, note, at, approvedBy }, session);

    const liveLines = order.lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED);
    const stillLive = liveLines.map((line) => line._id);

    await applyVersionedUpdate(req, {
      orderId: String(order._id),
      // Voiding moved the order on by one version.
      version: order.version + 1,
      update: {
        $set: {
          status: ORDER_STATUSES.CANCELLED,
          isCancelled: true,
          cancelledAt: at,
          cancelledBy: req.user.id,
          cancelApprovedBy: approvedBy,
          cancelReasonCode: orderReason.code,
          cancelReason: orderReason.note ?? null,
          'lines.$[live].status': ORDER_LINE_STATUSES.CANCELLED,
          'lines.$[live].cancelledAt': at,
          'lines.$[live].cancelledBy': req.user.id,
          'lines.$[live].cancelReason': orderReason.note ?? null,
          // The food was served: prepared, so nothing goes back on the shelf.
          'lines.$[kitchen].wasPrepared': true,
        },
      },
      arrayFilters: [
        { 'live.status': { $ne: ORDER_LINE_STATUSES.CANCELLED } },
        { 'kitchen.status': { $in: [...PREPARED_LINE_STATUSES] } },
      ],
      session,
    });

    await cancelKotLinesFor(req, { orderId: String(order._id), orderLineIds: stillLive }, session);

    await recordAudit(
      req,
      {
        action: AUDIT_ACTIONS.ORDER_CANCELLED,
        entityType: AUDIT_ENTITY_TYPES.ORDER,
        entityId: order._id,
        entityLabel: `Order ${order.orderNumber}`,
        reason: `${reasonText(ORDER_CANCEL_REASONS, orderReason.code, orderReason.note)} (${reasonText(BILL_VOID_REASONS, reasonCode, null)}, bill ${voided.billNumber})`,
        amountInPaise: sumPaise(...liveLines.map(computeLineTotalInPaise)),
        details: {
          orderNumber: order.orderNumber,
          tableName: order.tableName ?? null,
          lineCount: stillLive.length,
          reasonCode: orderReason.code,
          wasPrepared: true,
          billId: String(voided._id),
          ...(approvedBy ? { approvedBy: String(approvedBy) } : {}),
        },
      },
      session,
    );

    return voided;
  });
}
