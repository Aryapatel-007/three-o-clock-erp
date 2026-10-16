/**
 * Revising a bill nothing has been paid on. P29 Part B, API-CONTRACT M3
 * section 16.8.
 *
 * While no money is on a bill it is still being agreed with the guest, so
 * taking off a water bottle added by mistake, or adding a dessert, changes the
 * same bill: the same invoice number, new totals, and one entry in
 * `revisions`. Nothing is voided and no number is used. Once money is on a
 * bill, cancelling after billing (P25 Part E) and reopening (P26) apply as
 * before, because money has moved.
 *
 * Every figure is rebuilt by the code that made the bill: toBillLine and
 * applyTotals in billService, computeBillTotals and allocateLineShares in
 * utils/tax.js. A line taken off is cancelled on the order through the same
 * cancelLineInSession as a cancel before billing, so stock and the kitchen
 * ticket behave exactly the same.
 */
import mongoose from 'mongoose';

import { LINE_CANCEL_REASONS, reasonText } from '../config/cancelReasons.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Bill, BILL_STATUSES, REVISION_KINDS } from '../models/Bill.js';
import { Order, ORDER_LINE_STATUSES, ORDER_STATUSES, PREPARED_LINE_STATUSES } from '../models/Order.js';
import { TerminalTransaction } from '../models/TerminalTransaction.js';
import { BillNotRevisableError, BusinessRuleError, NotFoundError, WaitingForKitchenError } from '../utils/errors.js';
import { sumPaise } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { computeBillTotals, resolveDiscountAmount } from '../utils/tax.js';
import { nowUtc } from '../utils/time.js';
import { recordAudit } from './auditService.js';
import { approverIfNeeded } from './approvalService.js';
import { assertCaptainMayChangeBill, isSentTakeaway } from './billPermissionService.js';
import { applyTotals, billCreationErrorFor, readBill, toBillLine } from './billService.js';
import { assertDayOpen, isDayClosed, todayBusinessDate } from './dayLockService.js';
import { cancelLineInSession } from './lineCancelService.js';
import { applyVersionedUpdate, assertWasPreparedRule } from './orderService.js';
import { getSetting, getSettings, isFeatureOn } from './settingsService.js';

/** Thrown inside a preview's transaction so it rolls back. Never leaves this file. */
class PreviewOnly extends Error {}

/** Terminal payments that still have money in the air. */
const TERMINAL_OPEN = ['WAITING', 'UNKNOWN'];

const opts = (session) => (session ? { session } : {});

/**
 * Whether `bill` can be revised, and if not, the plain sentence why.
 * API-CONTRACT M3 16.8, the six conditions, in that order.
 */
export async function revisability(req, bill, { settings = null, session = null } = {}) {
  const { billing } = settings ?? (await getSettings(req.restaurantId, { req }));
  const no = (reason) => ({ revisable: false, reason });

  if (bill.isVoided) return no('This bill is voided.');
  if (bill.status === BILL_STATUSES.ON_ACCOUNT) return no('This bill is On Hold on an account. Void it and bill again.');
  if (bill.status !== BILL_STATUSES.UNPAID || (bill.amountPaidInPaise ?? 0) > 0) {
    return no('Money has been taken on this bill. Use Cancel an item, which voids it and makes a new one.');
  }
  const waiting = await TerminalTransaction.exists({ ...scoped(req), billId: bill._id, status: { $in: TERMINAL_OPEN } }).setOptions(opts(session));
  if (waiting) return no('A card machine payment on this bill is still waiting. Finish or cancel it first.');
  if (bill.orderType === 'DELIVERY' && bill.platform?.code) return no('Platform orders change through the platform.');
  if (await isDayClosed(req, bill.businessDate)) return no('This bill\'s business day is closed.');
  if (!billing.reviseUnpaidBills) return no('Changing a bill before payment is switched off. Use Cancel an item instead.');
  return { revisable: true, reason: null };
}

/**
 * A bill's discount on new lines: a percent stays the same percent; a flat
 * amount stays the same, never above the new item total. Who gave it, why and
 * when are kept. Null for no discount.
 */
function reappliedDiscount(discount, lines) {
  if (!discount) return { request: null, stored: null };
  const plain = typeof discount.toObject === 'function' ? discount.toObject() : { ...discount };
  const subtotal = sumPaise(0, ...lines.map((line) => line.lineTotalInPaise));
  const request =
    plain.kind === 'PERCENT'
      ? { kind: 'PERCENT', rateBps: plain.rateBps, valueInPaise: null }
      : { kind: 'FLAT', valueInPaise: Math.min(plain.valueInPaise ?? plain.amountInPaise, subtotal), rateBps: null };
  return { request, stored: { ...plain, ...request, amountInPaise: resolveDiscountAmount(request, subtotal) } };
}

/**
 * Rebuilds `bill` from the order's live lines and records one revision. The
 * bill's number, series, date and time issued are untouched. Saves inside
 * `session`, writes BILL_REVISED, and returns the revision.
 */
async function reviseInSession(req, { bill, order, kind, changedLines, reasonCode = null, note = null, approvedBy = null }, session) {
  const previousGrandTotalInPaise = bill.grandTotalInPaise;
  const lines = order.lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED).map(toBillLine);
  const { request, stored } = reappliedDiscount(bill.discount, lines);
  const totals = computeBillTotals({ lines, discount: request });

  bill.lines = lines;
  bill.discount = stored;
  // applyTotals writes the line shares onto the bill's own lines, so it is given those.
  applyTotals(bill, bill.lines, totals);

  const revision = {
    revision: (bill.revision ?? 0) + 1,
    kind,
    at: nowUtc(),
    by: req.user.id,
    approvedBy: approvedBy && String(approvedBy) !== String(req.user.id) ? approvedBy : null,
    lines: changedLines,
    reasonCode,
    note,
    previousGrandTotalInPaise,
    newGrandTotalInPaise: bill.grandTotalInPaise,
    wasPrinted: (bill.printCount ?? 0) > 0,
  };
  bill.revision = revision.revision;
  bill.revisions.push(revision);
  await bill.save(opts(session));

  const removed = kind === REVISION_KINDS.REMOVED;
  await recordAudit(
    req,
    {
      action: AUDIT_ACTIONS.BILL_REVISED,
      entityType: AUDIT_ENTITY_TYPES.BILL,
      entityId: bill._id,
      entityLabel: bill.billNumber,
      reason: `${removed ? 'Removed' : 'Added'}: ${changedLines.map((line) => line.itemName).join(', ')}${
        removed ? ` (${reasonText(LINE_CANCEL_REASONS, reasonCode, note)})` : ''
      }`.slice(0, 500),
      amountInPaise: removed ? previousGrandTotalInPaise - bill.grandTotalInPaise : bill.grandTotalInPaise - previousGrandTotalInPaise,
      details: {
        kind,
        revision: revision.revision,
        lineIds: changedLines.map((line) => String(line.orderLineId)),
        reasonCode,
        previousGrandTotalInPaise,
        newGrandTotalInPaise: bill.grandTotalInPaise,
        wasPrinted: revision.wasPrinted,
        ...(revision.approvedBy ? { approvedBy: String(revision.approvedBy) } : {}),
      },
    },
    session,
  );
  return revision;
}

/** The frozen shape of a line in a revision. */
function revisionLine(line, wasPrepared = null) {
  return {
    orderLineId: line._id,
    itemName: line.itemName,
    variantName: line.variantName ?? null,
    quantity: line.quantity,
    lineTotalInPaise: toBillLine(line).lineTotalInPaise,
    wasPrepared,
  };
}

/**
 * POST /bills/:billId/remove-lines. API-CONTRACT M3 16.8.1. Returns the
 * revised bill, or with `preview` the numbers it would have, writing nothing.
 */
export async function removeLines(req, billId, { lines, reasonCode, note = null, approval = null, preview = false }) {
  const settings = await getSettings(req.restaurantId, { req });
  const bill = await readBill(req, billId);
  // P39. A captain is stopped at a printed bill before anything else is said about it.
  assertCaptainMayChangeBill(req.user, bill);

  // A closed day answers first, before any rule about the bill.
  await assertDayOpen(req, [bill.businessDate, await todayBusinessDate(req)]);
  const { revisable, reason } = await revisability(req, bill, { settings });
  if (!revisable) throw new BillNotRevisableError(reason);

  const onBill = new Set(bill.lines.map((line) => String(line.orderLineId)));
  if (lines.some((entry) => !onBill.has(String(entry.lineId)))) {
    throw new BusinessRuleError('An item you picked is not on this bill. Open the bill again.');
  }

  const order = await Order.findOne({ ...scoped(req), _id: bill.orderId });
  if (!order) throw new NotFoundError('Order not found.');
  const chosen = lines.map((entry) => {
    const line = order.lines.id(entry.lineId);
    if (!line || line.status === ORDER_LINE_STATUSES.CANCELLED) {
      throw new BusinessRuleError('An item you picked is not on this bill. Open the bill again.');
    }
    assertWasPreparedRule(line.status, entry.wasPrepared);
    return { entry, line };
  });
  const remaining = order.lines.filter(
    (line) => line.status !== ORDER_LINE_STATUSES.CANCELLED && !lines.some((entry) => String(entry.lineId) === String(line._id)),
  );
  if (remaining.length === 0) throw new BusinessRuleError('To remove everything, cancel the order instead.');

  /**
   * The same approval as a cancel before billing, plus one: a bill the guest
   * has already been shown on paper needs a manager to lower it, when the
   * owner keeps that rule on. An owner or manager approves their own.
   */
  const sentToKitchen = chosen.some(({ line }) => PREPARED_LINE_STATUSES.includes(line.status));
  const needed =
    (settings.approvals.lineCancel && sentToKitchen) || (settings.approvals.revisePrintedBill && (bill.printCount ?? 0) > 0);
  const approvedBy = preview ? null : await approverIfNeeded(req, approval, needed);

  const inventoryOn = await isFeatureOn(req, 'inventory');
  const session = await mongoose.startSession();
  let previewed = null;
  try {
    await session.withTransaction(async () => {
      previewed = null;
      let current = await Order.findOne({ ...scoped(req), _id: bill.orderId }).session(session);
      for (const { entry } of chosen) {
        const line = current.lines.id(entry.lineId);
        current = await cancelLineInSession(
          req,
          {
            order: current,
            line,
            version: current.version,
            reasonCode,
            note,
            wasPrepared: entry.wasPrepared,
            inventoryOn,
            approvedBy,
            // BILL_REVISED names the approver, as BILL_LINES_CANCELLED_AFTER_BILLING does.
            auditApproval: false,
            removedFromBillId: bill._id,
          },
          session,
        );
      }

      const inSession = await Bill.findOne({ ...scoped(req), _id: bill._id }).session(session);
      const revision = await reviseInSession(
        req,
        {
          bill: inSession,
          order: current,
          kind: REVISION_KINDS.REMOVED,
          changedLines: chosen.map(({ entry, line }) => revisionLine(line, entry.wasPrepared ?? null)),
          reasonCode,
          note,
          approvedBy,
        },
        session,
      );

      if (preview) {
        previewed = {
          preview: true,
          billNumber: bill.billNumber,
          previousGrandTotalInPaise: revision.previousGrandTotalInPaise,
          newGrandTotalInPaise: revision.newGrandTotalInPaise,
          removed: revision.lines.map(({ itemName, variantName, quantity, lineTotalInPaise }) => ({ itemName, variantName, quantity, lineTotalInPaise })),
          // P35. What goes, added up here, so the screen's "2 × Roti ₹80.00" does no money arithmetic.
          removedQuantity: revision.lines.reduce((count, line) => count + line.quantity, 0),
          removedLineTotalInPaise: sumPaise(...revision.lines.map((line) => line.lineTotalInPaise)),
        };
        throw new PreviewOnly();
      }
    });
  } catch (error) {
    if (error instanceof PreviewOnly) return previewed;
    throw await billCreationErrorFor(req, bill.orderId, error);
  } finally {
    await session.endSession();
  }

  return readBill(req, billId);
}

/**
 * Adds lines to an order whose live bill can be revised. P29 Part B,
 * API-CONTRACT M3 16.8.2. The lines are pushed, the order goes back to OPEN
 * keeping its bill, and the bill is revised, in one transaction. Returns the
 * updated order. Throws the reason when the bill cannot be revised.
 */
export async function addLinesToBilledOrder(req, { order, version, snapshotLines, approval = null }) {
  const bill = await Bill.findOne({ ...scoped(req), _id: order.billId, isVoided: false });
  if (!bill) throw new BusinessRuleError('This order is waiting to be billed. It cannot be changed.');
  // P39. New dishes would revise a bill the guest may already hold on paper.
  assertCaptainMayChangeBill(req.user, bill);
  await assertDayOpen(req, [bill.businessDate, await todayBusinessDate(req)]);
  const settings = await getSettings(req.restaurantId, { req });
  const { revisable, reason } = await revisability(req, bill, { settings });
  if (!revisable) throw new BillNotRevisableError(reason);
  /**
   * P40. Raising a printed bill needs a manager, as lowering one does (16.8.1):
   * the guest has been shown a total, and only the counter, with a PIN, may
   * change it. A captain never reaches here (P39).
   */
  const approvedBy = await approverIfNeeded(req, approval, settings.approvals.revisePrintedBill && (bill.printCount ?? 0) > 0);

  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      updated = await applyVersionedUpdate(req, {
        orderId: order._id,
        version,
        update: {
          $push: { lines: { $each: snapshotLines } },
          $set: { status: ORDER_STATUSES.OPEN, readyToBillAt: null },
        },
        session,
      });
      const added = updated.lines.slice(-snapshotLines.length);
      const inSession = await Bill.findOne({ ...scoped(req), _id: bill._id }).session(session);
      await reviseInSession(
        req,
        { bill: inSession, order: updated, kind: REVISION_KINDS.ADDED, changedLines: added.map((line) => revisionLine(line)), approvedBy },
        session,
      );
    });
  } finally {
    await session.endSession();
  }
  return updated;
}

/**
 * P29 Part B. A bill whose order has dishes still with the kitchen takes no
 * money: the guest has not had them yet, and the total may still change.
 * Money already taken on the card machine is recorded regardless, which is
 * why recordPayment skips this for a terminal approval.
 *
 * Counter Sale: with `billing.payFirstTakeaway` on, a takeaway whose dishes are
 * all sent takes its money now; the guest pays first and waits at the counter.
 */
export async function assertBillTakesMoney(req, bill, session = null) {
  const order = await Order.findOne({ ...scoped(req), _id: bill.orderId }).select('status billId orderType lines.status').setOptions(opts(session)).lean();
  if (order?.status === ORDER_STATUSES.OPEN && String(order.billId) === String(bill._id)) {
    if (isSentTakeaway(order) && (await getSetting(req.restaurantId, 'billing.payFirstTakeaway', { req }))) return;
    throw new WaitingForKitchenError();
  }
}

export default { addLinesToBilledOrder, assertBillTakesMoney, removeLines, revisability };
