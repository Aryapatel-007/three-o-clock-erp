/**
 * Changing a dish after it is sent. P42, API-CONTRACT P42.
 *
 * The guest changes their mind once the kitchen has the ticket: fewer of a
 * dish, or a different note. Removing a dish is 12.6's cancel, and a swap is a
 * cancel plus a new dish, so this file holds only the two changes that had no
 * path before.
 *
 * Lowering a quantity splits the line rather than editing it: the line keeps
 * the new quantity, and a copy holding the difference is cancelled through the
 * one line cancel, so the reason, the approval, the audit and the reports
 * treat the part taken off exactly as any cancelled dish.
 */
import mongoose from 'mongoose';

import { Kot } from '../models/Kot.js';
import { MADE_LINE_STATUSES, ORDER_LINE_STATUSES, ORDER_STATUSES } from '../models/Order.js';
import { BusinessRuleError, ValidationError } from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { approverIfNeeded } from './approvalService.js';
import { cancelLineInSession } from './lineCancelService.js';
import { applyVersionedUpdate, assertOrderIsOpen, assertWasPreparedRule, findLine, loadOrderInTenant, serialiseOrder } from './orderService.js';
import { getSetting, getSettings, isFeatureOn } from './settingsService.js';
import { returnStockForReducedLine } from './stockMovementService.js';

/** P29. A billed table's lines change through the bill. Same sentence as orderController's. */
function assertNoLiveBill(order) {
  if (order.billId) throw new BusinessRuleError('This table has a bill. Change the items from the bill.');
}

/**
 * The order may change its sent lines: open, or (with the kitchen's ready
 * serving the dish) waiting to be billed with no bill yet, as 12.6 allows.
 */
async function assertSentLinesMayChange(req, order) {
  const waitingWithoutBill = order.status === ORDER_STATUSES.READY_TO_BILL && !order.billId;
  if (!(waitingWithoutBill && (await getSetting(req.restaurantId, 'kitchen.readyMeansServed', { req })))) {
    assertOrderIsOpen(order);
  }
  assertNoLiveBill(order);
}

const SNAPSHOT_FIELDS = [
  'menuItemId',
  'itemName',
  'variantId',
  'variantName',
  'unitPriceInPaise',
  'taxRateBps',
  'menuTaxRateBps',
  'addOns',
  'notes',
  'priceSource',
  'categoryId',
  'categoryName',
  // P46.
  'isOpenItem',
  // P64.
  'hsnCode',
  'status',
  'kotId',
  'addedBy',
  'addedAt',
  'firedAt',
  'readyAt',
  'servedAt',
];

/**
 * POST /orders/:orderId/lines/:lineId/reduce. Returns the order, serialised.
 */
export async function reduceSentLine(req, { orderId, lineId, version, quantity, reasonCode, note = null, wasPrepared, approval = null }) {
  const order = await loadOrderInTenant(req, orderId);
  await assertSentLinesMayChange(req, order);

  const line = findLine(order, lineId);
  if (line.status === ORDER_LINE_STATUSES.PENDING) {
    throw new BusinessRuleError('Change the quantity of a dish not sent yet with its stepper.');
  }
  if (line.status === ORDER_LINE_STATUSES.CANCELLED) throw new BusinessRuleError('That line is already cancelled.');
  if (quantity >= line.quantity) {
    throw new ValidationError('Validation failed.', { quantity: `Must be less than ${line.quantity}.` });
  }
  assertWasPreparedRule(line.status, wasPrepared);

  // P42. A made dish (marked ready, or said to be made) needs the manager, as cancelling one does.
  const { approvals } = await getSettings(req.restaurantId, { req });
  const made = MADE_LINE_STATUSES.includes(line.status) || wasPrepared === true;
  const approvedBy = await approverIfNeeded(req, approval, approvals.lineCancel && made);

  const inventoryOn = await isFeatureOn(req, 'inventory');
  const fromQuantity = line.quantity;
  const difference = fromQuantity - quantity;
  const plain = line.toObject();
  const split = { _id: new mongoose.Types.ObjectId(), quantity: difference };
  for (const field of SNAPSHOT_FIELDS) if (plain[field] !== undefined) split[field] = plain[field];
  const at = nowUtc();

  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      // 1 and 2. The line keeps the new quantity; the difference is its own line.
      // Two writes: MongoDB refuses a positional $set and a $push on the same array in one.
      const lowered = await applyVersionedUpdate(req, {
        orderId: order._id,
        version,
        update: { $set: { 'lines.$[line].quantity': quantity } },
        arrayFilters: [{ 'line._id': line._id, 'line.status': line.status }],
        session,
      });
      const splitOrder = await applyVersionedUpdate(req, {
        orderId: order._id,
        version: lowered.version,
        update: { $push: { lines: split } },
        session,
      });

      // 3. The kitchen ticket: the new quantity, marked changed, and a line for the difference.
      if (line.kotId) {
        const kot = await Kot.findOne({ ...scoped(req), _id: line.kotId }).session(session);
        const kotLine = kot?.lines.find((entry) => String(entry.orderLineId) === String(line._id));
        if (kotLine) {
          await Kot.updateOne(
            { ...scoped(req), _id: kot._id },
            { $set: { 'lines.$[target].quantity': quantity, 'lines.$[target].changedAt': at } },
            { arrayFilters: [{ 'target._id': kotLine._id }], session },
          );
          const kotPlain = kotLine.toObject();
          await Kot.updateOne(
            { ...scoped(req), _id: kot._id },
            { $push: { lines: { ...kotPlain, _id: new mongoose.Types.ObjectId(), orderLineId: split._id, quantity: difference, changedAt: at } } },
            { session },
          );
        }
      }

      // 5. Before the cancel, so the share is worked out on what the line still has out.
      if (wasPrepared === false && inventoryOn) {
        await returnStockForReducedLine(
          req,
          { orderLineId: line._id, orderId: order._id, fromQuantity, toQuantity: quantity, splitLineId: split._id },
          session,
        );
      }

      // 4. The difference is cancelled like any dish: the ticket line, the audit, the reports.
      updated = await cancelLineInSession(
        req,
        {
          order: splitOrder,
          line: splitOrder.lines.id(split._id),
          version: splitOrder.version,
          reasonCode,
          note,
          wasPrepared,
          inventoryOn,
          approvedBy,
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  req.log?.info({ actorId: req.user.id, orderId: String(order._id), lineId: String(line._id), fromQuantity, toQuantity: quantity }, 'Sent line lowered.');
  return serialiseOrder(updated);
}

/**
 * 12.5 for a FIRED line: a new note, on the order and on its kitchen ticket,
 * marked changed. Returns the updated order document.
 */
export async function changeSentNote(req, { order, line, version, notes }) {
  await assertSentLinesMayChange(req, order);
  const at = nowUtc();
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      updated = await applyVersionedUpdate(req, {
        orderId: order._id,
        version,
        update: { $set: { 'lines.$[line].notes': notes } },
        // Only while it is still FIRED: a dish made meanwhile keeps the note it was made with.
        arrayFilters: [{ 'line._id': line._id, 'line.status': ORDER_LINE_STATUSES.FIRED }],
        session,
      });
      if (line.kotId) {
        await Kot.updateOne(
          { ...scoped(req), _id: line.kotId },
          { $set: { 'lines.$[target].notes': notes, 'lines.$[target].changedAt': at } },
          { arrayFilters: [{ 'target.orderLineId': line._id, 'target.status': { $ne: 'CANCELLED' } }], session },
        );
      }
    });
  } finally {
    await session.endSession();
  }
  return updated;
}

export default { changeSentNote, reduceSentLine };
