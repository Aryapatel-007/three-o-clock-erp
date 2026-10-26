/**
 * Opening an order. The one path every order takes into the database.
 *
 * `POST /orders` and M14 both open orders through `openOrder`: a cashier's
 * takeaway, a waiter's table, an accepted online takeaway, and a seated
 * booking. Numbering, snapshots, tax treatment and the table rules are
 * written once, here, so a second way of creating an order can never drift
 * from the first. P23 moved this out of controllers/orderController.js.
 */
import { platformByCode } from '../config/platforms.js';
import { COUNTER_NAMES } from '../models/Counter.js';
import { OCCUPYING_ORDER_STATUSES, Order, ORDER_TYPES, TAX_TREATMENTS } from '../models/Order.js';
import { Table } from '../models/Table.js';
import { BusinessRuleError, DuplicateError, NotFoundError, TableOccupiedError } from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { nextNumber } from './counterService.js';
import { buildLineSnapshots } from './orderService.js';
import { getSetting } from './settingsService.js';
import { recordVisit, staffConsent } from './customerService.js';

const MONGO_DUPLICATE_KEY = 11000;

/**
 * Confirms a table exists in this tenant and can take an order.
 *
 * 404 when it does not exist or belongs to another restaurant, 422 when it
 * exists but is switched off. The same split as M1's assertCategoryUsable, for
 * the same reason: "you named something that isn't there" and "you named
 * something real that cannot be used right now" are different answers and the
 * floor view shows different things for each.
 *
 * Part 4 does not spell out the inactive case. A table is only ever switched
 * off while nothing is open on it, so seating a new party on one would quietly
 * undo that decision.
 */
export async function assertTableUsable(req, tableId) {
  const table = await Table.findOne({ ...scoped(req), _id: tableId });
  if (!table) throw new NotFoundError('Table not found.');
  if (!table.isActive) {
    throw new BusinessRuleError(`Table ${table.name} is turned off. Turn it back on to seat anyone.`);
  }
  return table;
}

/**
 * Turns the partial unique index's duplicate key error into the contract's 409.
 *
 * This is the two waiters problem landing, and it is meant to land here. The
 * index on (restaurantId, tableId, status) filtered to OCCUPYING_ORDER_STATUSES
 * means the database refuses the second insert; nothing in this file checks
 * first, because a check followed by a write has a gap in the middle and
 * Friday night will find it.
 *
 * The lookup below uses the same status list as the index, for the same
 * reason: a table holding a READY_TO_BILL order is occupied too, and a query
 * that only matched OPEN would find nothing and answer as if the table were
 * actually free when the index just said otherwise.
 *
 * The existing order's id goes back with the error so the client opens that
 * order rather than showing the second waiter a dead end.
 */
export async function rethrowTableConflict(req, tableId, error) {
  const isDuplicate = error?.code === MONGO_DUPLICATE_KEY;
  const onTableIndex = Object.hasOwn(error?.keyPattern ?? {}, 'tableId');

  if (!isDuplicate || !onTableIndex) throw error;

  const existing = await Order.findOne({
    ...scoped(req),
    tableId,
    status: { $in: OCCUPYING_ORDER_STATUSES },
  }).select('_id');

  throw new TableOccupiedError(existing?._id);
}

/**
 * P06. The platform order index refused a second live order with the same
 * platform number. Turned into a 409 naming the order that already has it, so
 * the counter can open that one instead of entering it twice.
 */
export async function rethrowPlatformConflict(req, platform, error) {
  const isDuplicate = error?.code === MONGO_DUPLICATE_KEY;
  const onPlatformIndex = Object.hasOwn(error?.keyPattern ?? {}, 'platform.orderId');
  if (!isDuplicate || !onPlatformIndex) throw error;

  const existing = await Order.findOne({
    ...scoped(req),
    'platform.code': platform.code,
    'platform.orderId': platform.orderId,
    isCancelled: false,
  }).select('_id orderNumber');

  throw new DuplicateError(
    `${platform.name} order ${platform.orderId} is already entered as order ${existing?.orderNumber ?? '?'}.`,
    { 'platform.orderId': 'Already entered.' },
    existing ? { existingOrderId: String(existing._id) } : undefined,
  );
}

/**
 * Opens an order and returns the saved document.
 *
 * `input` is the validated body of `POST /orders`, plus `origin` when M14 is
 * the caller. `req` carries the tenant and the person opening it, who becomes
 * `openedBy`.
 */
export async function openOrder(req, input) {
  const { orderType, tableId, guestCount, customerName, customerPhone, lines, platform, origin = null, advancePaymentId = null, platformPrices = false, offersConsent = false, customerConsent = null } = input;

  const isDineIn = orderType === ORDER_TYPES.DINE_IN;

  /**
   * P19 required covers here; P59 moved the rule to the first Send
   * (kitchenService.fireOrder), where the Guest details sheet asks for them.
   */

  const table = isDineIn ? await assertTableUsable(req, tableId) : null;

  /**
   * P06. A delivery order freezes its platform, with the name from the list,
   * and its tax treatment: when the platform collects the GST, every line on
   * this order is frozen at 0%, now and for lines added later.
   */
  const listed = platform ? platformByCode(platform.code) : null;
  const frozenPlatform = listed ? { code: listed.code, name: listed.name, orderId: platform.orderId } : null;
  const taxTreatment =
    orderType === ORDER_TYPES.DELIVERY &&
    listed &&
    (await getSetting(req.restaurantId, 'delivery.platformCollectsGst', { req }))
      ? TAX_TREATMENTS.PLATFORM_COLLECTS
      : TAX_TREATMENTS.NORMAL;

  // P25 Part H. Only a platform order accepted through an integration freezes the platform's prices.
  const snapshotLines = lines?.length ? await buildLineSnapshots(req, lines, { taxTreatment, platformPrices }) : [];

  /**
   * The number is reserved before the document is written, so a failed insert
   * leaves a gap in the sequence rather than reusing a number. That is the
   * agreed trade for orders and kitchen tickets, and explicitly not the trade
   * M3 can make for bills. See models/Counter.js.
   */
  const orderNumber = await nextNumber({
    restaurantId: req.restaurantId,
    branchId: req.branchId,
    name: COUNTER_NAMES.ORDER,
  });

  const order = new Order({
    ...scoped(req),
    orderNumber,
    orderType,
    tableId: table?._id ?? null,
    // Snapshot, so renaming T1 to "Window 1" next month does not rewrite this.
    tableName: table?.name ?? null,
    guestCount: guestCount ?? null,
    customerName: customerName ?? null,
    customerPhone: customerPhone ?? null,
    platform: frozenPlatform,
    taxTreatment,
    origin,
    advancePaymentId,
    lines: snapshotLines,
    openedBy: req.user.id,
    openedAt: nowUtc(),
  });

  const saved = await order
    .save()
    .catch((error) => rethrowPlatformConflict(req, frozenPlatform, error))
    .catch((error) => rethrowTableConflict(req, tableId, error));

  // P27. A visit for the customer with this phone. It never fails the order.
  if (saved.customerPhone) {
    try {
      await recordVisit(req, saved, customerConsent ?? (offersConsent ? staffConsent() : null));
    } catch (error) {
      req.log?.warn({ err: { message: error?.message }, orderId: String(saved._id) }, 'Could not record the customer visit.');
    }
  }

  return saved;
}

export default { openOrder };
