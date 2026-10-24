/**
 * Undo a Send to kitchen. P41, API-CONTRACT P41 section 2.
 *
 * For a minute after a Send, before the kitchen has marked any of it ready,
 * the captain can take it back. Nothing new is invented for it: each dish is
 * cancelled through the same line cancel as everywhere else (the kitchen line
 * is cancelled, stock comes back), and an unsent copy is put back on the order
 * with a new line id. The new id matters: stock is deducted under a key made
 * from the line id, so the next Send deducts again rather than being taken for
 * a repeat of the first.
 *
 * No reason and no PIN, because within the window nothing can have been
 * cooked. After it, a sent dish is an ordinary cancel with its approvals.
 */
import mongoose from 'mongoose';

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { ORDER_LINE_STATUSES, ORDER_STATUSES } from '../models/Order.js';
import { BusinessRuleError } from '../utils/errors.js';
import { nowUtc } from '../utils/time.js';
import { recordAudit } from './auditService.js';
import { cancelLineInSession } from './lineCancelService.js';
import { applyVersionedUpdate, assertOrderIsOpen, loadOrderInTenant, serialiseOrder } from './orderService.js';
import { isFeatureOn } from './settingsService.js';

/** How long after a Send it can be taken back. A constant, like the station undo window. */
export const UNDO_SEND_WINDOW_MS = 60_000;

const SENT = [ORDER_LINE_STATUSES.FIRED, ORDER_LINE_STATUSES.READY, ORDER_LINE_STATUSES.SERVED];

/** The snapshot a copy keeps. Everything about what was ordered; nothing about what happened to it. */
const SNAPSHOT_FIELDS = [
  'menuItemId',
  'itemName',
  'variantId',
  'variantName',
  'unitPriceInPaise',
  'taxRateBps',
  'menuTaxRateBps',
  'quantity',
  'addOns',
  'notes',
  'priceSource',
  'categoryId',
  'categoryName',
  // P46.
  'isOpenItem',
  // P64.
  'hsnCode',
];

function unsentCopy(line, req, at) {
  const plain = typeof line.toObject === 'function' ? line.toObject() : line;
  const copy = { _id: new mongoose.Types.ObjectId(), status: ORDER_LINE_STATUSES.PENDING, addedBy: req.user.id, addedAt: at };
  for (const field of SNAPSHOT_FIELDS) if (plain[field] !== undefined) copy[field] = plain[field];
  return copy;
}

/** POST /orders/:orderId/undo-send. Returns the order, serialised. */
export async function undoSend(req, { orderId, version }) {
  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);
  if (order.billId) throw new BusinessRuleError('This table has a bill. Change the items from the bill.');

  const sent = order.lines.filter((line) => SENT.includes(line.status) && line.firedAt);
  if (sent.length === 0) throw new BusinessRuleError('Nothing has been sent to the kitchen yet.');

  const lastFiredAt = Math.max(...sent.map((line) => new Date(line.firedAt).getTime()));
  const lastSend = sent.filter((line) => new Date(line.firedAt).getTime() === lastFiredAt);
  const at = nowUtc();
  if (at.getTime() - lastFiredAt > UNDO_SEND_WINDOW_MS) {
    throw new BusinessRuleError('Too late to undo. Cancel the dishes instead.');
  }
  if (lastSend.some((line) => line.status !== ORDER_LINE_STATUSES.FIRED)) {
    throw new BusinessRuleError('The kitchen has already marked some of these ready. Cancel them instead.');
  }

  const inventoryOn = await isFeatureOn(req, 'inventory');
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      let current = order;
      let currentVersion = version;
      for (const sentLine of lastSend) {
        current = await cancelLineInSession(
          req,
          {
            order: current,
            line: current.lines.id(sentLine._id),
            version: currentVersion,
            reasonCode: 'SENT_BY_MISTAKE',
            note: null,
            wasPrepared: false,
            inventoryOn,
          },
          session,
        );
        currentVersion = current.version;
      }

      updated = await applyVersionedUpdate(req, {
        orderId: order._id,
        version: currentVersion,
        update: {
          $push: { lines: { $each: lastSend.map((line) => unsentCopy(line, req, at)) } },
          // A cancel can leave the order waiting for the cashier when the rest is served; the copies are not.
          $set: { status: ORDER_STATUSES.OPEN, readyToBillAt: null },
        },
        session,
      });

      const itemNames = lastSend.map((line) => `${line.quantity} × ${line.itemName}${line.variantName ? ` (${line.variantName})` : ''}`);
      await recordAudit(
        req,
        {
          action: AUDIT_ACTIONS.KOT_SEND_UNDONE,
          entityType: AUDIT_ENTITY_TYPES.ORDER,
          entityId: order._id,
          entityLabel: `Order ${order.orderNumber}`,
          reason: itemNames.join(', '),
          details: {
            lineIds: lastSend.map((line) => String(line._id)),
            itemNames,
            kotIds: [...new Set(lastSend.map((line) => String(line.kotId)).filter((id) => id !== 'null'))],
            tableName: order.tableName ?? null,
          },
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  req.log?.info({ actorId: req.user.id, orderId: String(order._id), orderNumber: order.orderNumber, lineCount: lastSend.length }, 'Send to kitchen undone.');
  return serialiseOrder(updated);
}

export default { undoSend, UNDO_SEND_WINDOW_MS };
