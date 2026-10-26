/**
 * Firing, and the kitchen's side of a ticket.
 *
 * The two documents this touches, an order and a KOT, must not drift. A line
 * the kitchen has marked ready and an order line that still says FIRED is a
 * waiter standing at the pass arguing with a screen. Every operation in here
 * that writes both does it in one transaction where the connection has one.
 */
import mongoose from 'mongoose';

import { COUNTER_NAMES } from '../models/Counter.js';
import { Kot, KOT_LINE_STATUSES } from '../models/Kot.js';
import { Order, ORDER_LINE_STATUSES, ORDER_STATUSES, ORDER_TYPES } from '../models/Order.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { BusinessRuleError, NotFoundError, OrderAlreadyBilledError, ValidationError } from '../utils/errors.js';
import { recordAudit } from './auditService.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';
import { nextNumber } from './counterService.js';
import {
  applyVersionedUpdate,
  assertOrderIsOpen,
  isReadyToBill,
  loadOrderInTenant,
  readyToBillChange,
  serialiseOrder,
} from './orderService.js';
// M4. Firing is the moment ingredients physically leave the shelf, so this is
// the one and only call site for a deduction -- see docs/DB-SCHEMA.md section
// 16. It runs inside this function's own transaction below, not as a second
// one, because a KOT that exists with no matching deduction (or the reverse)
// is exactly the kind of drift a transaction exists to prevent.
import { deductForFiredLines } from './stockMovementService.js';
import { getSetting, isFeatureOn } from './settingsService.js';
import { routeLinesToStations } from './stationService.js';

export const KOT_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
});

/**
 * A ticket's status, derived from its lines and stored nowhere.
 *
 * A ticket whose every line was cancelled counts as COMPLETED: there is nothing
 * left to cook, so it should leave the kitchen screen rather than sit there
 * forever looking like outstanding work.
 */
export function kotStatusOf(lines) {
  const live = lines.filter((line) => line.status !== KOT_LINE_STATUSES.CANCELLED);
  if (live.length === 0) return KOT_STATUSES.COMPLETED;

  const ready = live.filter((line) => line.status === KOT_LINE_STATUSES.READY);
  if (ready.length === 0) return KOT_STATUSES.PENDING;
  if (ready.length === live.length) return KOT_STATUSES.COMPLETED;
  return KOT_STATUSES.IN_PROGRESS;
}

/** The ticket as the API describes it, with its derived status filled in. */
export function serialiseKot(kot) {
  const json = kot.toJSON();
  json.status = kotStatusOf(json.lines ?? []);
  // P36. Each line's station and sent time, the ticket's standing in for a line from before P36.
  json.rounds = json.rounds ?? 1;
  json.lastFiredAt = json.lastFiredAt ?? json.firedAt;
  // P56. The order's note for every dish; null on a ticket from before P56.
  json.kitchenNote = json.kitchenNote ?? null;
  json.lines = (json.lines ?? []).map((line) => ({
    ...line,
    stationId: line.stationId ?? json.stationId ?? null,
    stationName: line.stationName ?? json.stationName ?? null,
    firedAt: line.firedAt ?? json.firedAt,
    round: line.round ?? 1,
  }));
  return json;
}

/** P36. A ticket line's station id as a string: its own, or the ticket's when it has none. */
export function lineStationId(kot, line) {
  const id = line.stationId ?? kot.stationId ?? null;
  return id ? String(id) : null;
}

/** Loads one ticket inside the caller's tenant, or 404. Never 403. */
export async function loadKotInTenant(req, kotId) {
  const kot = await Kot.findOne({ ...scoped(req), _id: kotId });
  if (!kot) throw new NotFoundError('Kitchen ticket not found.');
  return kot;
}

/* --------------------------------------------------------------------------
 * Firing
 * ----------------------------------------------------------------------- */

/**
 * Sends every pending line on an order to the kitchen.
 *
 * P36. With `kitchen.oneTicketPerOrder` on (the default), an order keeps one
 * ticket: the first Send makes it, and every later Send adds its lines to it as
 * a new round, under the same KOT number. Each line still freezes the station
 * that makes it, so a station's screen shows its own dishes. Off, this is P05:
 * one new ticket per station on every Send, which is how a table that ordered
 * mains later got a second ticket.
 *
 * P58. With `kitchen.splitTicketsByStation` off, a Send's lines are not split:
 * one new ticket per Send (or the order's one ticket), with no station of its
 * own. Each line still keeps its station, for R13.
 *
 * A KOT number is reserved before the transaction, so an aborted fire leaves a
 * gap in the sequence rather than reusing a number. Kitchen tickets tolerate
 * gaps; see models/Counter.js for why bills will not.
 */
export async function fireOrder(req, { orderId, version }) {
  const order = await loadOrderInTenant(req, orderId);
  assertOrderIsOpen(order);

  const pending = order.lines.filter((line) => line.status === ORDER_LINE_STATUSES.PENDING);
  if (pending.length === 0) {
    // Firing an empty batch would print a blank chit in a hot kitchen.
    throw new BusinessRuleError('There is nothing new to send to the kitchen.');
  }

  /**
   * P59. Covers feed average per cover, so a restaurant can require them. P19
   * asked at opening; the count is now asked with the guest's details on the
   * first Send, so that is where it is required. A later Send never is.
   */
  if (
    order.orderType === ORDER_TYPES.DINE_IN &&
    order.guestCount == null &&
    order.lines.every((line) => !line.firedAt) &&
    (await getSetting(req.restaurantId, 'floor.requireGuestCount', { req }))
  ) {
    throw new ValidationError('How many guests? Enter the number before sending to the kitchen.', {
      guestCount: 'How many guests?',
    });
  }

  /**
   * P05. Each line goes to its category's current station, and anything
   * unroutable to the default station. With no active stations this is a
   * single group with no station, exactly as before.
   */
  const groups = await routeLinesToStations(req, pending);
  const oneTicket = (await getSetting(req.restaurantId, 'kitchen.oneTicketPerOrder', { req })) !== false;
  const splitByStation = (await getSetting(req.restaurantId, 'kitchen.splitTicketsByStation', { req })) !== false;
  const firedAt = nowUtc();

  // P36. The order's ticket, when it already has one and the restaurant keeps one per order.
  const existing = oneTicket
    ? await Kot.findOne({ ...scoped(req), orderId: order._id }).sort({ firedAt: -1 }).select('kotNumber rounds')
    : null;
  const round = existing ? (existing.rounds ?? 1) + 1 : 1;

  const ticketLine = (line, station) => ({
    _id: new mongoose.Types.ObjectId(),
    orderLineId: line._id,
    itemName: line.itemName,
    variantName: line.variantName,
    quantity: line.quantity,
    // Names only. No prices reach the kitchen.
    addOnNames: line.addOns.map((addOn) => addOn.name),
    notes: line.notes,
    status: KOT_LINE_STATUSES.PENDING,
    // P36. Frozen: moving the station later never rewrites this ticket.
    stationId: station?._id ?? null,
    stationName: station?.name ?? null,
    firedAt,
    round,
  });

  /**
   * The tickets this Send writes to: the order's one ticket (new or existing),
   * or, with the setting off, one new ticket per station in station order.
   */
  const reserve = () => nextNumber({ restaurantId: req.restaurantId, branchId: req.branchId, name: COUNTER_NAMES.KOT });
  const tickets = [];
  if (oneTicket || !splitByStation) {
    tickets.push({
      kotId: existing?._id ?? new mongoose.Types.ObjectId(),
      kotNumber: existing ? existing.kotNumber : await reserve(),
      append: Boolean(existing),
      // P58. Not split: the ticket has no station of its own, even if every line went to one.
      station: splitByStation && groups.length === 1 ? groups[0].station : null,
      lines: groups.flatMap((group) => group.lines.map((line) => ticketLine(line, group.station))),
    });
  } else {
    for (const group of groups) {
      tickets.push({
        kotId: new mongoose.Types.ObjectId(),
        kotNumber: await reserve(),
        append: false,
        station: group.station,
        lines: group.lines.map((line) => ticketLine(line, group.station)),
      });
    }
  }

  // P02. Read once, before the transaction. A restaurant with inventory
  // switched off fires exactly as before and writes no stock movement.
  const inventoryOn = await isFeatureOn(req, 'inventory');

  const result = await withOptionalTransaction(
    async (session) => {
      const options = session ? { session } : {};

      for (const ticket of tickets.filter((entry) => entry.append)) {
        await Kot.updateOne(
          { ...scoped(req), _id: ticket.kotId },
          { $push: { lines: { $each: ticket.lines } }, $set: { rounds: round, lastFiredAt: firedAt, kitchenNote: order.kitchenNote ?? null } },
          options,
        );
      }
      const created = tickets.filter((entry) => !entry.append);
      if (created.length > 0) {
        await Kot.create(
          created.map((ticket) => ({
            _id: ticket.kotId,
            ...scoped(req),
            kotNumber: ticket.kotNumber,
            orderId: order._id,
            // Denormalised so the kitchen screen needs one query, not a join
            // per ticket, and so a table renamed next month does not rewrite
            // what this chit said.
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            tableName: order.tableName,
            // P05. Frozen. P36: the one station every line went to, else null.
            stationId: ticket.station?._id ?? null,
            stationName: ticket.station?.name ?? null,
            rounds: 1,
            lastFiredAt: firedAt,
            // P56. The order's note for every dish.
            kitchenNote: order.kitchenNote ?? null,
            lines: ticket.lines,
            firedBy: req.user.id,
            firedAt,
          })),
          { ...options, ordered: true },
        );
      }

      /**
       * The version filter still applies. If someone added a line between the
       * read above and this write, nothing is written and the whole transaction
       * aborts, taking the ticket lines with it, so the kitchen never sees a
       * chit for an order state that did not happen.
       *
       * Each line points at the ticket it actually went on: one positional
       * filter per ticket, matching that ticket's own line ids.
       */
      const $set = {
        'lines.$[pending].status': ORDER_LINE_STATUSES.FIRED,
        'lines.$[pending].firedAt': firedAt,
      };
      const arrayFilters = [{ 'pending.status': ORDER_LINE_STATUSES.PENDING }];
      tickets.forEach((ticket, index) => {
        $set[`lines.$[kot${index}].kotId`] = ticket.kotId;
        arrayFilters.push({
          [`kot${index}._id`]: { $in: ticket.lines.map((line) => line.orderLineId) },
          [`kot${index}.status`]: ORDER_LINE_STATUSES.PENDING,
        });
      });

      const updatedOrder = await applyVersionedUpdate(req, {
        orderId,
        version,
        update: { $set },
        arrayFilters,
        session,
      });

      /**
       * M4: deduct stock for exactly the lines that just fired, in this same
       * transaction, once per line however many tickets the fire made.
       */
      if (inventoryOn) {
        await deductForFiredLines(req, { lines: pending, orderId: order._id, at: firedAt }, session);
      }

      const kots = await Kot.find({ ...scoped(req), _id: { $in: tickets.map((ticket) => ticket.kotId) } })
        .sort({ kotNumber: 1 })
        .setOptions(options);
      return { kots, order: updatedOrder };
    },
    {
      /**
       * No transaction available, so the ticket lines may exist while the order
       * was never updated. Undo them by hand rather than leaving the kitchen
       * chits for food nobody ordered.
       */
      onFailureWithoutTransaction: async () => {
        const made = tickets.filter((ticket) => !ticket.append).map((ticket) => ticket.kotId);
        if (made.length > 0) await Kot.deleteMany({ ...scoped(req), _id: { $in: made } });
        for (const ticket of tickets.filter((entry) => entry.append)) {
          await Kot.updateOne(
            { ...scoped(req), _id: ticket.kotId },
            { $pull: { lines: { _id: { $in: ticket.lines.map((line) => line._id) } } }, $set: { rounds: round - 1 } },
          );
        }
      },
    },
  );

  req.log?.info(
    {
      actorId: req.user.id,
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      kotIds: result.kots.map((kot) => String(kot._id)),
      kotNumbers: result.kots.map((kot) => kot.kotNumber),
      round,
      lineCount: pending.length,
    },
    'Order fired to the kitchen.',
  );

  const kots = result.kots.map(serialiseKot);
  // `kot` is the first ticket, so a client written before P05 keeps working.
  return { kot: kots[0], kots, order: serialiseOrder(result.order), round };
}

/* --------------------------------------------------------------------------
 * The kitchen's side
 * ----------------------------------------------------------------------- */

/** P36. A station named for a ticket must make at least one of its dishes. */
function assertStationOnTicket(kot, stationId) {
  if (!stationId) return;
  if (!kot.lines.some((line) => lineStationId(kot, line) === String(stationId))) {
    throw new BusinessRuleError('Nothing on this ticket is for that station.');
  }
}

/**
 * Marks ticket lines ready, and the order lines they came from with them.
 *
 * `lineId` marks one line. Omitting it marks every line on the ticket that is
 * not already ready or cancelled.
 *
 * There is no version here, deliberately. A ticket is append-only from the
 * kitchen's side and two cooks marking the same dish ready is harmless. The
 * order's own version is still incremented, so a floor screen holding a stale
 * copy finds out the next time it writes.
 *
 * The matching order line is found by `orderLineId` and only moved if it is
 * still FIRED. A line that has already been served must not be dragged back to
 * READY by someone tidying up the pass.
 *
 * P29 Part C. With `kitchen.readyMeansServed` on, the kitchen's ready is the
 * serve: the order line goes straight from FIRED to SERVED, `readyAt` and
 * `servedAt` the same moment, and when every live line is then served the
 * order moves to READY_TO_BILL through the same readyToBillChange as a waiter's
 * serve, in the same transaction.
 */
export async function markKotLinesReady(req, { kotId, lineId, stationId = null }) {
  const kot = await loadKotInTenant(req, kotId);
  assertStationOnTicket(kot, stationId);

  if (lineId) {
    const line = kot.lines.id(lineId);
    if (!line) throw new NotFoundError('That line is not on this ticket.');
    if (line.status === KOT_LINE_STATUSES.READY) {
      throw new BusinessRuleError('That one is already marked ready.');
    }
    if (line.status === KOT_LINE_STATUSES.CANCELLED) {
      throw new BusinessRuleError('That one was cancelled. It does not need to be made.');
    }
  }

  const targets = kot.lines.filter(
    (line) =>
      line.status === KOT_LINE_STATUSES.PENDING &&
      (!lineId || String(line._id) === String(lineId)) &&
      (!stationId || lineStationId(kot, line) === String(stationId)),
  );

  const readyAt = nowUtc();
  const orderLineIds = targets.map((line) => line.orderLineId);
  const readyMeansServed = Boolean(await getSetting(req.restaurantId, 'kitchen.readyMeansServed', { req }));

  const updated = await withOptionalTransaction(async (session) => {
    const options = session ? { session } : {};

    if (targets.length > 0) {
      await Kot.updateOne(
        { ...scoped(req), _id: kot._id },
        {
          $set: {
            'lines.$[target].status': KOT_LINE_STATUSES.READY,
            'lines.$[target].readyAt': readyAt,
          },
        },
        {
          arrayFilters: [
            {
              'target._id': { $in: targets.map((line) => line._id) },
              'target.status': KOT_LINE_STATUSES.PENDING,
            },
          ],
          ...options,
        },
      );

      await Order.updateOne(
        { ...scoped(req), _id: kot.orderId },
        {
          $set: readyMeansServed
            ? {
                'lines.$[line].status': ORDER_LINE_STATUSES.SERVED,
                'lines.$[line].readyAt': readyAt,
                'lines.$[line].servedAt': readyAt,
              }
            : {
                'lines.$[line].status': ORDER_LINE_STATUSES.READY,
                'lines.$[line].readyAt': readyAt,
              },
          // The order changed, so anyone holding it has a stale copy.
          $inc: { version: 1 },
        },
        {
          arrayFilters: [
            { 'line._id': { $in: orderLineIds }, 'line.status': ORDER_LINE_STATUSES.FIRED },
          ],
          ...options,
        },
      );

      if (readyMeansServed) await moveToReadyToBillIfServed(req, kot.orderId, readyAt, session);
    }

    return Kot.findOne({ ...scoped(req), _id: kot._id }).setOptions(options);
  });

  req.log?.info(
    {
      actorId: req.user.id,
      role: req.user.role,
      kotId: String(kot._id),
      kotNumber: kot.kotNumber,
      lineCount: targets.length,
    },
    'Kitchen marked food ready.',
  );

  // P25 Part H. A platform order whose food is all ready: the platform is told, by a queued call.
  if (targets.length > 0) {
    const { notifyFoodReadyIfDone } = await import('./integrations/platformOrderService.js');
    await notifyFoodReadyIfDone(req, kot.orderId);
  }

  return serialiseKot(updated);
}

/**
 * Takes back a ready tick made by mistake. P29 Part E, API-CONTRACT M2
 * section 13.5. `lineId` undoes one line; without it, every READY line on the
 * ticket.
 *
 * Only while the order has no live bill: once billed, what was served is on a
 * bill, and the cashier changes the bill. In one transaction the ticket line
 * goes back to PENDING, the order line back to FIRED (clearing `readyAt`, and
 * `servedAt` when the ready had served it), and a READY_TO_BILL order back to
 * OPEN. A platform's queued "food is ready" call is stopped while it still
 * waits. Returns the ticket with `platformAlreadyTold`.
 */
export async function undoKotReady(req, { kotId, lineId, stationId = null }) {
  const kot = await loadKotInTenant(req, kotId);
  assertStationOnTicket(kot, stationId);
  if (lineId) {
    const line = kot.lines.id(lineId);
    if (!line) throw new NotFoundError('That line is not on this ticket.');
    if (line.status !== KOT_LINE_STATUSES.READY) throw new BusinessRuleError('That one is not marked ready.');
  }
  const targets = kot.lines.filter(
    (line) =>
      line.status === KOT_LINE_STATUSES.READY &&
      (!lineId || String(line._id) === String(lineId)) &&
      (!stationId || lineStationId(kot, line) === String(stationId)),
  );
  if (targets.length === 0) throw new BusinessRuleError('Nothing on this ticket is marked ready.');

  const order = await Order.findOne({ ...scoped(req), _id: kot.orderId }).select('status billId orderNumber tableName').lean();
  if (!order) throw new NotFoundError('Order not found.');
  if (order.billId) throw new OrderAlreadyBilledError();
  if (![ORDER_STATUSES.OPEN, ORDER_STATUSES.READY_TO_BILL].includes(order.status)) {
    throw new BusinessRuleError('This order is closed. It cannot be changed.');
  }

  const orderLineIds = targets.map((line) => line.orderLineId);
  const updated = await withOptionalTransaction(async (session) => {
    const options = session ? { session } : {};
    await Kot.updateOne(
      { ...scoped(req), _id: kot._id },
      { $set: { 'lines.$[target].status': KOT_LINE_STATUSES.PENDING, 'lines.$[target].readyAt': null } },
      { arrayFilters: [{ 'target._id': { $in: targets.map((line) => line._id) }, 'target.status': KOT_LINE_STATUSES.READY }], ...options },
    );
    const reopens = order.status === ORDER_STATUSES.READY_TO_BILL;
    const changed = await Order.updateOne(
      { ...scoped(req), _id: kot.orderId, status: order.status, billId: null },
      {
        $set: {
          'lines.$[line].status': ORDER_LINE_STATUSES.FIRED,
          'lines.$[line].readyAt': null,
          'lines.$[line].servedAt': null,
          ...(reopens ? { status: ORDER_STATUSES.OPEN, readyToBillAt: null } : {}),
        },
        $inc: { version: 1 },
      },
      {
        arrayFilters: [{ 'line._id': { $in: orderLineIds }, 'line.status': { $in: [ORDER_LINE_STATUSES.READY, ORDER_LINE_STATUSES.SERVED] } }],
        ...options,
      },
    );
    // The order was billed or moved on between the read and this write: nothing changes.
    if (changed.matchedCount === 0) throw new OrderAlreadyBilledError();

    await recordAudit(
      req,
      {
        action: AUDIT_ACTIONS.KITCHEN_READY_UNDONE,
        entityType: AUDIT_ENTITY_TYPES.ORDER,
        entityId: kot.orderId,
        entityLabel: `Order ${order.orderNumber}`,
        reason: `Ready undone: ${targets.map((line) => line.itemName).join(', ')}`.slice(0, 500),
        details: {
          kotId: String(kot._id),
          kotNumber: kot.kotNumber,
          lineIds: targets.map((line) => String(line._id)),
          itemNames: targets.map((line) => line.itemName),
          tableName: order.tableName ?? null,
        },
      },
      session,
    );
    return Kot.findOne({ ...scoped(req), _id: kot._id }).setOptions(options);
  });

  const { cancelFoodReadyIfQueued } = await import('./integrations/platformOrderService.js');
  const { platformAlreadyTold } = await cancelFoodReadyIfQueued(req, kot.orderId);

  req.log?.info({ actorId: req.user.id, kotId: String(kot._id), lineCount: targets.length }, 'Kitchen took back a ready tick.');
  return { ...serialiseKot(updated), platformAlreadyTold };
}

/**
 * P29 Part C. An OPEN order whose every live line is now served moves to
 * READY_TO_BILL, filtered on OPEN so a concurrent change is never overwritten.
 */
async function moveToReadyToBillIfServed(req, orderId, at, session) {
  const order = await Order.findOne({ ...scoped(req), _id: orderId }).select('status lines.status').setOptions(session ? { session } : {}).lean();
  if (order?.status !== ORDER_STATUSES.OPEN || !isReadyToBill(order.lines)) return;
  await Order.updateOne(
    { ...scoped(req), _id: orderId, status: ORDER_STATUSES.OPEN },
    { $set: readyToBillChange(at), $inc: { version: 1 } },
    session ? { session } : {},
  );
}

/**
 * Cancels the ticket lines belonging to order lines that were just cancelled.
 *
 * Without this, the kitchen keeps cooking a dish the floor has already voided,
 * which is the "cancelled item problem" from BUILD-PLAN section 8 landing in
 * the most expensive possible way. Part 4 does not spell this out, but the KOT
 * line schema has a CANCELLED status and nothing else could ever set it.
 *
 * Runs inside the caller's session when there is one.
 */
export async function cancelKotLinesFor(req, { orderId, orderLineIds }, session) {
  if (orderLineIds.length === 0) return;

  await Kot.updateMany(
    { ...scoped(req), orderId },
    {
      $set: {
        'lines.$[target].status': KOT_LINE_STATUSES.CANCELLED,
      },
    },
    {
      arrayFilters: [
        {
          'target.orderLineId': { $in: orderLineIds },
          'target.status': { $ne: KOT_LINE_STATUSES.CANCELLED },
        },
      ],
      ...(session ? { session } : {}),
    },
  );
}
