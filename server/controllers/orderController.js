/**
 * Orders. Shapes come from Part 4 section M2.2 of docs/PROJECT-PLAN.md.
 *
 * Two things in this file are load-bearing and neither is obvious from reading
 * the happy path:
 *
 * Every price on a line is written by the server from the menu item, never sent
 * by the client. services/orderService.js does that copying.
 *
 * Every write goes through applyVersionedUpdate, which puts the client's
 * version into the update filter. There is no read-modify-save anywhere in
 * here, on purpose. See the note at the bottom of models/Order.js.
 */
import {
  ORDER_CANCEL_REASONS,
  ORDER_OPENED_BY_MISTAKE,
  reasonText,
} from '../config/cancelReasons.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import {
  Order,
  MADE_LINE_STATUSES,
  ORDER_LINE_STATUSES,
  PREPARED_LINE_STATUSES,
  ORDER_STATUSES,
  ORDER_TYPES,
} from '../models/Order.js';
import { Kot } from '../models/Kot.js';
import { recordAudit } from '../services/auditService.js';
import { recordVisit, staffConsent } from '../services/customerService.js';
import { cancelKotLinesFor, fireOrder as fireOrderToKitchen } from '../services/kitchenService.js';
import { changeSentNote, reduceSentLine } from '../services/sentLineService.js';
import { undoSend as undoSendToKitchen } from '../services/undoSendService.js';
// M4. wasPrepared: false means the kitchen had already deducted for this line
// and it was never actually made, so the ingredients go back. Keyed on the
// ledger, not on the flag alone -- see stockMovementService.js.
import { cancelLineInSession } from '../services/lineCancelService.js';
import { giveNoCharge } from '../services/noChargeService.js';
import { returnStockForCancelledLine } from '../services/stockMovementService.js';
import { getSetting, getSettings, isFeatureOn } from '../services/settingsService.js';
import { approverForManagerTask, approverIfNeeded } from '../services/approvalService.js';
import {
  applyVersionedUpdate,
  assertOrderIsOpen,
  assertOrderWasPreparedRule,
  assertWasPreparedRule,
  buildLineSnapshots,
  computeLineTotalInPaise,
  findLine,
  isReadyToBill,
  loadOrderInTenant,
  readyToBillChange,
  serialiseOrder,
} from '../services/orderService.js';
import { BusinessRuleError, ValidationError } from '../utils/errors.js';
import { sumPaise } from '../utils/money.js';
import { sendList, sendSuccess } from '../utils/response.js';
import { scoped } from '../utils/scopedQuery.js';
import { withOptionalTransaction } from '../utils/transaction.js';
import { assertTableUsable, openOrder, rethrowTableConflict } from '../services/orderOpenService.js';
import { addLinesToBilledOrder } from '../services/billRevisionService.js';
import { Bill, BILL_STATUSES } from '../models/Bill.js';
import { voidBillInSession } from '../services/billService.js';
import { nowUtc } from '../utils/time.js';

/**
 * P29. While an order has a live bill its lines change only through the bill,
 * so the bill and the order can never disagree about what was ordered. A bill
 * is voided by clearing `billId`, so a set `billId` is a live bill.
 */
function assertNoLiveBill(order) {
  if (order.billId) throw new BusinessRuleError('This table has a bill. Change the items from the bill.');
}

/** POST /orders */
export async function createOrder(req, res) {
  const saved = await openOrder(req, req.body);

  req.log?.info(
    {
      actorId: req.user.id,
      orderId: String(saved._id),
      orderNumber: saved.orderNumber,
      orderType: saved.orderType,
      lineCount: saved.lines.length,
    },
    'Order opened.',
  );

  return sendSuccess(res, serialiseOrder(saved), 201);
}

/** POST /orders/:orderId/no-charge. P08. Every rule is in services/noChargeService.js. */
export async function postNoCharge(req, res) {
  const order = await giveNoCharge(req, req.params.orderId, req.body);
  return sendSuccess(res, serialiseOrder(order));
}

/**
 * GET /orders
 *
 * Paginated, unlike the floor view's table list. An order list grows without
 * bound over the life of a restaurant.
 */
export async function listOrders(req, res) {
  const { page, limit, status, orderType, tableId } = req.query;

  const filter = { ...scoped(req) };
  if (status !== undefined) filter.status = { $in: status };
  if (orderType !== undefined) filter.orderType = orderType;
  if (tableId !== undefined) filter.tableId = tableId;

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  // The same serialisation as a single read, totals included. A list of orders
  // that could not show a running total would send every screen back for a
  // second request per row.
  return sendList(res, orders.map(serialiseOrder), { page, limit, total });
}

/** GET /orders/:orderId */
export async function getOrder(req, res) {
  const order = await loadOrderInTenant(req, req.params.orderId);
  return sendSuccess(res, serialiseOrder(order));
}

/**
 * POST /orders/:orderId/lines
 *
 * The client sends ids and a quantity. Every price, name and tax rate on the
 * stored line is copied here from the menu item, and after this nothing reads
 * the menu for a price again.
 */
export async function addOrderLines(req, res) {
  const { orderId } = req.params;
  const { version, lines, approval = null } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  // P26. A served table orders more: a READY_TO_BILL order with no live bill reopens.
  const reopens = order.status === ORDER_STATUSES.READY_TO_BILL && !order.billId;
  // P29. An order with a live bill that can be revised takes the lines, and its bill is revised.
  const revisesBill = Boolean(order.billId) && [ORDER_STATUSES.OPEN, ORDER_STATUSES.READY_TO_BILL].includes(order.status);
  if (!reopens && !revisesBill) assertOrderIsOpen(order);

  /**
   * Snapshotted before the write, on the order as we last read it. If someone
   * else changes the order in between, the version in the update filter will
   * not match and nothing is written, so the worst case is wasted work rather
   * than a line priced against a stale read.
   */
  // P06: a PLATFORM_COLLECTS order freezes every new line at 0% too.
  const snapshotLines = await buildLineSnapshots(req, lines, { taxTreatment: order.taxTreatment });

  if (revisesBill) {
    const revised = await addLinesToBilledOrder(req, { order, version, snapshotLines, approval });
    req.log?.info(
      { actorId: req.user.id, orderId: String(revised._id), orderNumber: revised.orderNumber, addedLines: snapshotLines.length },
      'Lines added to a billed order; its bill was revised.',
    );
    return sendSuccess(res, serialiseOrder(revised));
  }

  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update: {
      $push: { lines: { $each: snapshotLines } },
      ...(reopens ? { $set: { status: ORDER_STATUSES.OPEN, readyToBillAt: null } } : {}),
    },
  });

  req.log?.info(
    {
      actorId: req.user.id,
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      addedLines: snapshotLines.length,
    },
    'Lines added to order.',
  );

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * PATCH /orders/:orderId/lines/:lineId
 *
 * Quantity and notes only. Changing what was ordered is a cancel plus a new
 * line, because the snapshot on a line has to keep being the thing that was
 * actually ordered.
 */
export async function editOrderLine(req, res) {
  const { orderId, lineId } = req.params;
  const { version, quantity, notes } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);
  assertNoLiveBill(order);

  const line = findLine(order, lineId);
  // P42. A dish sent but not made takes a new note, which reaches its kitchen ticket.
  if (line.status === ORDER_LINE_STATUSES.FIRED && quantity === undefined && notes !== undefined) {
    const updated = await changeSentNote(req, { order, line, version, notes });
    return sendSuccess(res, serialiseOrder(updated));
  }
  if (line.status !== ORDER_LINE_STATUSES.PENDING) {
    throw new BusinessRuleError(
      line.status === ORDER_LINE_STATUSES.FIRED
        ? 'Lower the quantity of a sent dish with Change.'
        : 'The kitchen has already made this one. It can be cancelled, but not changed.',
    );
  }

  const changes = {};
  if (quantity !== undefined) changes['lines.$[line].quantity'] = quantity;
  if (notes !== undefined) changes['lines.$[line].notes'] = notes;

  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update: { $set: changes },
    /**
     * The positional filter carries the line's status as well as its id. If the
     * line is fired between the read above and this write, the filter matches
     * nothing, the update touches no line, and the version check still passes
     * because the order itself did change. Belt and braces, cheaply.
     */
    arrayFilters: [{ 'line._id': lineId, 'line.status': ORDER_LINE_STATUSES.PENDING }],
  });

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * POST /orders/:orderId/lines/:lineId/cancel
 *
 * The line is never removed from the array. It keeps every snapshot value and
 * becomes evidence: who cancelled it, when, why, and whether the kitchen had
 * already made it.
 */
export async function cancelOrderLine(req, res) {
  const { orderId, lineId } = req.params;
  const { version, reasonCode, note, wasPrepared, approval } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  /**
   * P29. With the kitchen's ready serving the dish, an order is waiting to be
   * billed the moment the kitchen finishes, while the guest may still send a
   * made dish back. Until a bill exists, the line is cancelled here; once one
   * does, assertNoLiveBill sends the change to the bill's Remove.
   */
  const waitingWithoutBill = order.status === ORDER_STATUSES.READY_TO_BILL && !order.billId;
  if (!(waitingWithoutBill && (await getSetting(req.restaurantId, 'kitchen.readyMeansServed', { req })))) {
    assertOrderIsOpen(order);
  }
  assertNoLiveBill(order);

  const line = findLine(order, lineId);
  if (line.status === ORDER_LINE_STATUSES.CANCELLED) {
    throw new BusinessRuleError('That line is already cancelled.');
  }

  // 400 when the question does not apply, 422 when it does and was not
  // answered. See the note on this function.
  assertWasPreparedRule(line.status, wasPrepared);

  /**
   * P28, narrowed by P42. A cashier or captain cancelling a dish that was made
   * (the kitchen marked it ready, or they say it was made) needs an owner's or
   * manager's PIN. A dish not made yet costs nothing to take back.
   */
  const { approvals } = await getSettings(req.restaurantId, { req });
  const made = MADE_LINE_STATUSES.includes(line.status) || wasPrepared === true;
  const approvedBy = await approverIfNeeded(req, approval, approvals.lineCancel && made);

  const inventoryOn = await isFeatureOn(req, 'inventory');

  const updated = await withOptionalTransaction((session) =>
    cancelLineInSession(req, { order, line, version, reasonCode, note, wasPrepared, inventoryOn, approvedBy }, session),
  );

  req.log?.info(
    {
      actorId: req.user.id,
      role: req.user.role,
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      lineId: String(lineId),
      previousStatus: line.status,
      wasPrepared: wasPrepared ?? null,
    },
    'Order line cancelled.',
  );

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * POST /orders/:orderId/fire
 *
 * Everything pending goes to the kitchen as one new ticket. The work is in
 * services/kitchenService.js, because it writes an order and a KOT together
 * and those two must not drift.
 */
export async function fireOrder(req, res) {
  const { kot, kots, order, round } = await fireOrderToKitchen(req, {
    orderId: req.params.orderId,
    version: req.body.version,
  });

  // P05: `kots` is every ticket, one per station; `kot` is the first of them.
  // P36: with one ticket per order, `kots` is that ticket, and `round` the Send just made.
  return sendSuccess(res, { kot, kots, order, round });
}

/**
 * POST /orders/:orderId/close. P50: an order nothing was ever sent from was
 * opened by mistake, and anyone who takes orders closes it with no reason.
 * Orders are never deleted, so it is kept, cancelled as OPENED_BY_MISTAKE,
 * with its unsent dishes removed as P49 removes one. Nothing reached the
 * kitchen, so there is no stock, no ticket and no audit line, and reports
 * leave it out.
 */
export async function closeOrder(req, res) {
  const { orderId } = req.params;
  const { version } = req.body;
  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);
  assertNoLiveBill(order);
  const everSent = order.lines.some((line) => line.firedAt || ![ORDER_LINE_STATUSES.PENDING, ORDER_LINE_STATUSES.CANCELLED].includes(line.status));
  if (everSent) {
    throw new BusinessRuleError('Dishes have been sent to the kitchen. Ask a manager to cancel the order.');
  }

  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update: {
      $pull: { lines: { status: ORDER_LINE_STATUSES.PENDING } },
      $set: {
        status: ORDER_STATUSES.CANCELLED,
        isCancelled: true,
        cancelledAt: nowUtc(),
        cancelledBy: req.user.id,
        cancelReasonCode: ORDER_OPENED_BY_MISTAKE,
        cancelReason: null,
      },
    },
  });

  req.log?.info({ actorId: req.user.id, role: req.user.role, orderId: String(updated._id), orderNumber: updated.orderNumber }, 'Order closed, opened by mistake.');
  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * DELETE /orders/:orderId/lines/:lineId. P49: a dish not sent yet is a draft,
 * removed with no reason and no trace, because the guest changed their mind
 * before the kitchen saw it. A sent dish is never deleted (12.6, P42).
 */
export async function removeOrderLine(req, res) {
  const { orderId, lineId } = req.params;
  const { version } = req.query;
  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);
  assertNoLiveBill(order);
  const line = findLine(order, lineId);
  if (line.status !== ORDER_LINE_STATUSES.PENDING) {
    throw new BusinessRuleError('This dish has been sent to the kitchen. Use Change.');
  }
  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    // Only while it is still PENDING: a dish sent meanwhile stays.
    update: { $pull: { lines: { _id: line._id, status: ORDER_LINE_STATUSES.PENDING } } },
  });
  return sendSuccess(res, serialiseOrder(updated));
}

/** POST /orders/:orderId/lines/:lineId/reduce. P42: lower a sent dish's quantity. */
export async function reduceOrderLine(req, res) {
  const order = await reduceSentLine(req, { orderId: req.params.orderId, lineId: req.params.lineId, ...req.body });
  return sendSuccess(res, order);
}

/** POST /orders/:orderId/undo-send. P41: take the last Send back within the minute. */
export async function undoSend(req, res) {
  const order = await undoSendToKitchen(req, { orderId: req.params.orderId, version: req.body.version });
  return sendSuccess(res, order);
}

/**
 * PATCH /orders/:orderId/lines/:lineId/served
 *
 * The one place M2 moves an order's own status without being asked to. When
 * the last live line is served there is nothing left to do on the floor, so the
 * order goes to the cashier's queue by itself.
 */
export async function markLineServed(req, res) {
  const { orderId, lineId } = req.params;
  const { version } = req.body;

  const order = await loadOrderInTenant(req, orderId);

  /**
   * P29 Part C. With the kitchen's ready serving the line, a screen written
   * before P29 may still send this for a line already served, on an order that
   * is already waiting for the cashier: that is not an error worth stopping a
   * waiter for, so the order comes back as it is.
   */
  const already = order.lines.id(lineId);
  if (already?.status === ORDER_LINE_STATUSES.SERVED && (await getSetting(req.restaurantId, 'kitchen.readyMeansServed', { req }))) {
    return sendSuccess(res, serialiseOrder(order));
  }
  assertOrderIsOpen(order);

  const line = findLine(order, lineId);
  if (line.status !== ORDER_LINE_STATUSES.READY) {
    throw new BusinessRuleError(
      line.status === ORDER_LINE_STATUSES.SERVED
        ? 'That one has already been served.'
        : 'The kitchen has not marked that ready yet.',
    );
  }

  const servedAt = nowUtc();

  /**
   * Whether this is the last one is worked out from the order as read, with
   * this line counted as served. If someone else changes the order in between,
   * the version filter rejects the write and none of this is applied, so the
   * conclusion cannot be acted on while stale.
   */
  const linesAfter = order.lines.map((existing) =>
    String(existing._id) === String(lineId)
      ? { status: ORDER_LINE_STATUSES.SERVED }
      : { status: existing.status },
  );

  const closesTheOrder = isReadyToBill(linesAfter);

  const update = {
    $set: {
      'lines.$[line].status': ORDER_LINE_STATUSES.SERVED,
      'lines.$[line].servedAt': servedAt,
      ...(closesTheOrder ? readyToBillChange(servedAt) : {}),
    },
  };

  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update,
    arrayFilters: [{ 'line._id': lineId, 'line.status': ORDER_LINE_STATUSES.READY }],
  });

  if (closesTheOrder) {
    req.log?.info(
      { actorId: req.user.id, orderId: String(updated._id), orderNumber: updated.orderNumber },
      'Order ready to bill.',
    );
  }

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * PATCH /orders/:orderId/table
 *
 * `tableName` is re-snapshotted to the new table, because it describes where
 * the order is now, not where it started.
 */
export async function moveOrderToTable(req, res) {
  const { orderId } = req.params;
  const { version, tableId } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);

  if (order.orderType !== ORDER_TYPES.DINE_IN) {
    throw new BusinessRuleError('A takeaway order is not on a table, so it cannot be moved to one.');
  }

  const table = await assertTableUsable(req, tableId);

  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update: { $set: { tableId: table._id, tableName: table.name } },
  }).catch((error) => rethrowTableConflict(req, tableId, error));

  req.log?.info(
    {
      actorId: req.user.id,
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      fromTable: order.tableName,
      toTable: table.name,
    },
    'Order moved to another table.',
  );

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * PATCH /orders/:orderId/kitchen-note. P56.
 *
 * One note for every dish, like "Less spicy". The order's kitchen tickets get
 * the same note, so the kitchen sees the latest one on dishes already sent.
 * Not audited: it is an instruction to the kitchen, not money.
 */
export async function setKitchenNote(req, res) {
  const { orderId } = req.params;
  const { version, kitchenNote } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  if (![ORDER_STATUSES.OPEN, ORDER_STATUSES.READY_TO_BILL].includes(order.status)) {
    throw new BusinessRuleError('This order is closed, so its note cannot change.');
  }

  const updated = await applyVersionedUpdate(req, { orderId, version, update: { $set: { kitchenNote } } });
  await Kot.updateMany({ ...scoped(req), orderId: updated._id }, { $set: { kitchenNote } });

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * PATCH /orders/:orderId/customer. P56.
 *
 * The guest's details, asked on a table's first Send rather than when it is
 * seated. A mobile, once on the order, is never swapped for another: the visit
 * was recorded against it. The first mobile records the visit exactly as
 * opening an order with one does (P27), and never fails the request.
 */
export async function setOrderCustomer(req, res) {
  const { orderId } = req.params;
  const { version, customerName, customerPhone, offersConsent, guestCount } = req.body;

  const order = await loadOrderInTenant(req, orderId);
  // P59. Covers belong to a table.
  if (guestCount !== undefined && order.orderType !== ORDER_TYPES.DINE_IN) {
    throw new ValidationError('Only a dine-in order has a number of guests.', { guestCount: 'Only for a table.' });
  }
  if (order.billId || order.status === ORDER_STATUSES.BILLED) {
    throw new BusinessRuleError("This order has a bill, so the guest's details are on it already.");
  }
  if (order.status !== ORDER_STATUSES.OPEN) {
    throw new BusinessRuleError("This order is closed, so the guest's details cannot change.");
  }
  if (customerPhone && order.customerPhone && customerPhone !== order.customerPhone) {
    throw new BusinessRuleError("This order already has the guest's mobile.");
  }

  const firstPhone = Boolean(customerPhone) && !order.customerPhone;
  const updated = await applyVersionedUpdate(req, {
    orderId,
    version,
    update: {
      $set: {
        ...(customerName !== undefined ? { customerName } : {}),
        ...(firstPhone ? { customerPhone } : {}),
        ...(guestCount !== undefined ? { guestCount } : {}),
      },
    },
  });

  if (firstPhone) {
    try {
      await recordVisit(req, updated, offersConsent ? staffConsent() : null);
    } catch (error) {
      req.log?.warn({ err: { message: error?.message }, orderId: String(updated._id) }, 'Could not record the customer visit.');
    }
  }

  return sendSuccess(res, serialiseOrder(updated));
}

/**
 * POST /orders/:orderId/cancel
 *
 * OWNER and MANAGER only, and that is the whole point of the endpoint.
 *
 * A waiter can cancel one line, which is an ordinary correction. Making a whole
 * table disappear is the move a dishonest staff member uses to pocket a cash
 * bill, and it is the exact gap restaurant owners lose money to today. The
 * route gating is in routes/orderRoutes.js; this comment is here because this
 * is where someone would come to "simplify" it.
 *
 * Nothing is deleted. The order and every line stay in the database forever.
 */
export async function cancelOrder(req, res) {
  const { orderId } = req.params;
  const { version, reasonCode, note, wasPrepared, approval } = req.body;

  // P28. A cashier may, with an owner's or manager's PIN, when the owner allows it.
  const { approvals } = await getSettings(req.restaurantId, { req });
  const approvedBy = await approverForManagerTask(req, approval, approvals, 'Only an owner or a manager can cancel a whole order.');

  const order = await loadOrderInTenant(req, orderId);

  if (order.status === ORDER_STATUSES.CANCELLED) {
    throw new BusinessRuleError('That order is already cancelled.');
  }
  if (order.status === ORDER_STATUSES.BILLED) {
    throw new BusinessRuleError('That order has been billed. A bill is voided, not cancelled.');
  }
  if (order.status === ORDER_STATUSES.NO_CHARGE) {
    throw new BusinessRuleError('That order was given No Charge and is closed.');
  }

  // One answer covers every fired line: the manager is answering "did the
  // kitchen make any of this", not auditing it dish by dish.
  assertOrderWasPreparedRule(order, wasPrepared);

  /**
   * P29. An order with a live bill nothing was paid on goes with its bill: the
   * bill is voided in the same transaction, because no sale happened. Before
   * P29 the bill was left live and unpaid, and blocked Day Close. A bill with
   * money on it, or On Hold, is voided by itself first, deliberately.
   */
  const liveBill = order.billId ? await Bill.findOne({ ...scoped(req), _id: order.billId, isVoided: false }) : null;
  if (liveBill && (liveBill.amountPaidInPaise > 0 || liveBill.status === BILL_STATUSES.ON_ACCOUNT)) {
    throw new BusinessRuleError('This bill has money on it. Void the bill first.');
  }

  const now = nowUtc();

  const liveLines = order.lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED);
  const stillLive = liveLines.map((line) => line._id);
  const liveValueInPaise = sumPaise(...liveLines.map(computeLineTotalInPaise));

  const inventoryOn = await isFeatureOn(req, 'inventory');

  const updated = await withOptionalTransaction(async (session) => {
    // Voiding moves the order on by one version, so the cancel below expects the next one.
    if (liveBill) {
      await voidBillInSession(req, liveBill._id, { reasonCode: 'ITEMS_CHANGED', note: 'Order cancelled', approvedBy }, session);
    }
    const cancelled = await applyVersionedUpdate(req, {
      orderId,
      version: liveBill ? version + 1 : version,
      update: {
        $set: {
          status: ORDER_STATUSES.CANCELLED,
          isCancelled: true,
          cancelledAt: now,
          cancelledBy: req.user.id,
          cancelApprovedBy: approvedBy,
          cancelReasonCode: reasonCode,
          // P04: the free-text field now holds the optional note.
          cancelReason: note ?? null,
          // Every line that is not already cancelled goes with it, keeping its
          // own snapshot. The positional filter leaves already-cancelled lines
          // alone so their original reason and wasPrepared survive.
          'lines.$[live].status': ORDER_LINE_STATUSES.CANCELLED,
          'lines.$[live].cancelledAt': now,
          'lines.$[live].cancelledBy': req.user.id,
          'lines.$[live].cancelReason': note ?? null,
          // The order's reasons are a different list from a line's. The line
          // keeps the note; its code stays null rather than borrowing an order
          // code the line enum does not contain.
          /**
           * The one answer only lands on lines that actually reached the
           * kitchen. A line still PENDING was never fired, so no stock was
           * ever deducted for it and there is nothing to give back; writing
           * "yes it was made" onto it would be recording something untrue.
           *
           * This is the same rule the single-line cancel enforces, where
           * answering for a line that never went to the kitchen is a 400. The
           * whole-order path used to contradict it by writing the answer onto
           * every live line.
           *
           * arrayFilters are matched against the document as it was before
           * this update, so `kitchen` selects the lines that were FIRED,
           * READY or SERVED going in.
           */
          'lines.$[kitchen].wasPrepared': wasPrepared ?? null,
        },
      },
      arrayFilters: [
        { 'live.status': { $ne: ORDER_LINE_STATUSES.CANCELLED } },
        { 'kitchen.status': { $in: [...PREPARED_LINE_STATUSES] } },
      ],
      session,
    });

    await cancelKotLinesFor(req, { orderId, orderLineIds: stillLive }, session);

    // P56. A bill voided to add items, whose order now goes as a whole, is a whole void after all.
    if (order.reopenedFromBillId) {
      await Bill.updateOne({ ...scoped(req), _id: order.reopenedFromBillId }, { $set: { isVoidedToChangeItems: false } }, session ? { session } : {});
    }

    /**
     * P04. ORDER_CANCELLED was in the audit list from M3 and nothing wrote it,
     * so a table could disappear without a trace. Every whole-order cancel
     * writes one line now, inside the transaction, carrying the value of every
     * line that was still live.
     */
    await recordAudit(
      req,
      {
        action: AUDIT_ACTIONS.ORDER_CANCELLED,
        entityType: AUDIT_ENTITY_TYPES.ORDER,
        entityId: order._id,
        entityLabel: `Order ${order.orderNumber}`,
        reason: reasonText(ORDER_CANCEL_REASONS, reasonCode, note),
        amountInPaise: liveValueInPaise,
        details: {
          orderNumber: order.orderNumber,
          tableName: order.tableName ?? null,
          lineCount: stillLive.length,
          reasonCode,
          wasPrepared: wasPrepared ?? null,
          ...(approvedBy ? { approvedBy: String(approvedBy) } : {}),
        },
      },
      session,
    );

    /**
     * M4: the same one-answer-covers-the-whole-order rule as wasPrepared
     * itself. Called for every live line, including ones that were still
     * PENDING and never fired -- returnStockForCancelledLine reads the ledger
     * for each and is a safe no-op wherever there is nothing to return.
     */
    if (wasPrepared === false && inventoryOn) {
      for (const orderLineId of stillLive) {
        await returnStockForCancelledLine(req, { orderLineId, orderId }, session);
      }
    }

    return cancelled;
  });

  req.log?.warn(
    {
      actorId: req.user.id,
      role: req.user.role,
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      lineCount: updated.lines.length,
      wasPrepared: wasPrepared ?? null,
    },
    'Whole order cancelled.',
  );

  return sendSuccess(res, serialiseOrder(updated));
}
