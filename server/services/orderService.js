/**
 * Order logic that is too big, or too dangerous, to sit in a controller.
 *
 * Three things live here, and each one exists because the obvious inline
 * version of it is subtly wrong:
 *
 *   buildLineSnapshots   copies the menu onto the line, once, forever
 *   applyVersionedUpdate writes through the version filter, never read-modify-save
 *   serialiseOrder       derives the totals rather than storing them
 */
import { Category } from '../models/Category.js';
import { MenuItem } from '../models/MenuItem.js';
import {
  Order,
  ORDER_LINE_STATUSES,
  ORDER_STATUSES,
  PREPARED_LINE_STATUSES,
  TAX_TREATMENTS,
} from '../models/Order.js';
import {
  BusinessRuleError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../utils/errors.js';
import { sumPaise } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { getSetting } from './settingsService.js';

/* --------------------------------------------------------------------------
 * Reading
 * ----------------------------------------------------------------------- */

/** Loads one order inside the caller's tenant, or 404. Never 403. */
export async function loadOrderInTenant(req, orderId) {
  const order = await Order.findOne({ ...scoped(req), _id: orderId });
  if (!order) throw new NotFoundError('Order not found.');
  return order;
}

/** Finds a line on an already-loaded order, or 404. */
export function findLine(order, lineId) {
  const line = order.lines.id(lineId);
  if (!line) throw new NotFoundError('That line is not on this order.');
  return line;
}

/** Every write in section 2 of the contract needs the order to still be open. */
export function assertOrderIsOpen(order) {
  if (order.status === ORDER_STATUSES.OPEN) return;

  const explanation = {
    [ORDER_STATUSES.READY_TO_BILL]: 'This order is waiting to be billed.',
    [ORDER_STATUSES.BILLED]: 'This order has already been billed.',
    [ORDER_STATUSES.CANCELLED]: 'This order was cancelled.',
    [ORDER_STATUSES.NO_CHARGE]: 'This order was given No Charge.',
  };

  throw new BusinessRuleError(
    `${explanation[order.status] ?? 'This order is closed.'} It cannot be changed.`,
  );
}

/* --------------------------------------------------------------------------
 * Money, derived and never stored
 * ----------------------------------------------------------------------- */

/**
 * (unit price + every add-on price) * quantity.
 *
 * Whole paise throughout. Every input is an integer and the multiplication is
 * exact, so there is no rounding here and no opportunity for one.
 */
export function computeLineTotalInPaise(line) {
  const unitWithAddOns = sumPaise(
    line.unitPriceInPaise,
    ...(line.addOns ?? []).map((addOn) => addOn.priceInPaise),
  );

  const total = unitWithAddOns * line.quantity;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`A line total of ${total} is too large to be represented exactly.`);
  }
  return total;
}

/**
 * The order as the API describes it, with the derived fields filled in.
 *
 * `lineTotalInPaise` and `totals` are computed here on every read and written
 * nowhere. A stored total can disagree with the parts it was built from.
 *
 * This is NOT a bill. No tax, no discount, no rounding, no service charge. M3
 * owns every one of those and M2 must not preview them, because two pieces of
 * code that both "work out the total" will eventually disagree by a rupee and
 * nobody will trust either.
 */
export function serialiseOrder(order) {
  const json = order.toJSON();

  json.lines = (json.lines ?? []).map((line) => ({
    ...line,
    lineTotalInPaise: computeLineTotalInPaise(line),
  }));

  // A cancelled line keeps its snapshot and stays in the array as evidence, but
  // nobody is paying for it, so it counts towards neither number.
  const live = json.lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED);

  json.totals = {
    subtotalInPaise: sumPaise(...live.map((line) => line.lineTotalInPaise)),
    lineCount: live.length,
  };

  return json;
}

/* --------------------------------------------------------------------------
 * Snapshotting: the reason this module exists
 * ----------------------------------------------------------------------- */

/**
 * Turns the ids a client sent into fully priced lines.
 *
 * The client sends a menu item id, an optional variant id, a quantity and some
 * add-on ids. It never sends a price, and the request schema refuses one, so
 * the numbers on a line can only have come from here.
 *
 * After this function returns, nothing in M2, M3 or M6 reads `menuitems` for a
 * price again. `menuItemId` survives on the line as a reference for reporting
 * and for M4's recipes, and that is all it is for.
 *
 * One query for every distinct item, not one per line: a waiter adding four
 * portions of the same dish should not cost four round trips.
 */
/**
 * `platformPrices` (P25 Part H, platform orders only): each request carries
 * `platformUnitPriceInPaise` and optional `platformAddOnPrices` (our add-on id
 * to the platform's price), and those prices are frozen instead of the menu's,
 * because that is what the customer was charged. The line says so in
 * `priceSource`. No other path passes it.
 */
export async function buildLineSnapshots(req, lineRequests, { taxTreatment = TAX_TREATMENTS.NORMAL, platformPrices = false } = {}) {
  const wantedIds = [...new Set(lineRequests.map((line) => String(line.menuItemId)))];

  const items = await MenuItem.find({ ...scoped(req), _id: { $in: wantedIds } });
  const itemsById = new Map(items.map((item) => [String(item._id), item]));

  /**
   * P03. The category is frozen onto the line too, so a category report reads
   * the line rather than today's menu. One scoped query for every distinct
   * category, the same shape as the item query above.
   */
  const categoryIds = [...new Set(items.map((item) => String(item.categoryId)))];
  const categories = await Category.find({ ...scoped(req), _id: { $in: categoryIds } }).select(
    'name',
  );
  const categoryNames = new Map(categories.map((category) => [String(category._id), category.name]));
  // P64. The code a dish with none of its own is frozen at, read once.
  const defaultSacCode = await getSetting(req.restaurantId, 'invoice.defaultSacCode', { req });

  const now = nowUtc();

  return lineRequests.map((request) => {
    const item = itemsById.get(String(request.menuItemId));

    /**
     * Missing and belonging-to-another-restaurant are the same answer here.
     * The query above was scoped, so an item from restaurant B simply is not in
     * the map, and the caller is told the same thing either way.
     */
    if (!item) {
      throw new BusinessRuleError('One of those dishes is not on this menu any more.');
    }
    if (!item.isActive) {
      throw new BusinessRuleError(`"${item.name}" has been taken off the menu.`);
    }
    if (!item.isAvailable) {
      throw new BusinessRuleError(`"${item.name}" is out of stock right now.`);
    }

    /**
     * P46. An open item takes its name and price from staff, and only from
     * staff: a public quote (no signed-in person) is told it is not on the menu.
     */
    // P48. Typed extras are priced by staff, so never by a guest.
    if ((request.extras ?? []).length > 0 && !req.user) {
      throw new BusinessRuleError('One of those dishes is not on this menu any more.');
    }
    if (item.isOpenItem) {
      if (!req.user) throw new BusinessRuleError('One of those dishes is not on this menu any more.');
      if (!request.openItem) throw new BusinessRuleError("Type the dish's name and price.");
      if (request.variantId || (request.addOnIds ?? []).length > 0) throw new BusinessRuleError('An open item has no sizes or extras.');
    } else if (request.openItem) {
      throw new BusinessRuleError('Only an open item takes a typed name and price.');
    }

    let variantId = null;
    let variantName = null;
    let unitPriceInPaise = item.isOpenItem ? request.openItem.priceInPaise : item.priceInPaise;

    if (request.variantId !== undefined && request.variantId !== null) {
      const variant = item.variants.id(request.variantId);
      if (!variant) {
        throw new BusinessRuleError(`That size of "${item.name}" is not on the menu any more.`);
      }
      // P04. The kitchen switched this size off for a reason.
      if (variant.isAvailable === false) {
        throw new BusinessRuleError(
          `The ${variant.name} size of "${item.name}" is out of stock right now.`,
        );
      }
      variantId = variant._id;
      variantName = variant.name;
      // Absolute, not a delta from the base price. A "Half" at 14000 costs 140
      // rupees, whatever the full plate costs.
      unitPriceInPaise = variant.priceInPaise;
    }

    const addOns = (request.addOnIds ?? []).map((addOnId) => {
      const addOn = item.addOns.id(addOnId);
      if (!addOn) {
        throw new BusinessRuleError(`One of the extras on "${item.name}" is not on the menu any more.`);
      }
      // P04. Same as a size: switched off means not orderable.
      if (addOn.isAvailable === false) {
        throw new BusinessRuleError(`"${addOn.name}" is out of stock right now.`);
      }
      const platformPrice = platformPrices ? request.platformAddOnPrices?.[String(addOn._id)] : undefined;
      return { addOnId: addOn._id, name: addOn.name, priceInPaise: Number.isInteger(platformPrice) ? platformPrice : addOn.priceInPaise };
    });
    // P48. Typed extras after the menu's own, with no id: the name and price are staff's.
    for (const extra of request.extras ?? []) addOns.push({ addOnId: null, name: extra.name, priceInPaise: extra.priceInPaise });

    if (platformPrices && Number.isInteger(request.platformUnitPriceInPaise)) {
      unitPriceInPaise = request.platformUnitPriceInPaise;
    }

    return {
      menuItemId: item._id,
      itemName: item.isOpenItem ? request.openItem.name : item.name,
      isOpenItem: Boolean(item.isOpenItem),
      variantId,
      variantName,
      unitPriceInPaise,
      /**
       * P06. On a PLATFORM_COLLECTS order the platform pays the GST, so the
       * line is frozen at 0% now, never decided at bill time. The item's own
       * rate is kept for reference. The tax arithmetic sees a 0% line.
       */
      taxRateBps: taxTreatment === TAX_TREATMENTS.PLATFORM_COLLECTS ? 0 : item.taxRateBps,
      menuTaxRateBps: taxTreatment === TAX_TREATMENTS.PLATFORM_COLLECTS ? item.taxRateBps : null,
      // A missing category should not happen. If it does, the id is still
      // kept and the order is not blocked over it.
      categoryId: item.categoryId ?? null,
      categoryName: categoryNames.get(String(item.categoryId)) ?? null,
      // P64. Frozen like the price and the rate: the item's code, else the default SAC.
      hsnCode: item.hsnCode || defaultSacCode || null,
      quantity: request.quantity,
      addOns,
      notes: request.notes ?? null,
      priceSource: platformPrices && Number.isInteger(request.platformUnitPriceInPaise) ? 'PLATFORM' : 'MENU',
      status: ORDER_LINE_STATUSES.PENDING,
      // P23. A public quote has no signed-in person; it is never saved.
      addedBy: req.user?.id ?? null,
      addedAt: now,
    };
  });
}

/* --------------------------------------------------------------------------
 * Optimistic concurrency
 * ----------------------------------------------------------------------- */

/**
 * Writes to an order through its version, and bumps the version.
 *
 * The version goes into the FILTER, not into a comparison in JavaScript:
 *
 *   { _id, restaurantId, branchId, version: theVersionTheClientRead }
 *
 * so the database is what decides who wins. Two waiters who both read version 7
 * both send 7; the first update matches and moves it to 8, the second matches
 * nothing. There is no window between the check and the write, because there is
 * no separate check.
 *
 * A null result means one of three things, and the caller deserves to know
 * which, so one extra scoped read separates them: no such order (404), or the
 * order moved on without us (409 with the version it actually has).
 *
 * `session` is passed through for the two operations that write an order and a
 * kitchen ticket together.
 */
export async function applyVersionedUpdate(req, { orderId, version, update, arrayFilters, session }) {
  const { $inc: callerInc, ...restOfUpdate } = update;

  const updated = await Order.findOneAndUpdate(
    { ...scoped(req), _id: orderId, version },
    { ...restOfUpdate, $inc: { ...callerInc, version: 1 } },
    { new: true, runValidators: true, ...(arrayFilters ? { arrayFilters } : {}), ...(session ? { session } : {}) },
  );

  if (updated) return updated;

  const current = await Order.findOne({ ...scoped(req), _id: orderId })
    .select('version')
    .lean()
    .setOptions(session ? { session } : {});

  if (!current) throw new NotFoundError('Order not found.');

  throw new VersionConflictError(current.version);
}

/* --------------------------------------------------------------------------
 * The wasPrepared rule
 * ----------------------------------------------------------------------- */

/**
 * Was the kitchen already cooking this?
 *
 * The rule depends on the line's stored status, so it cannot be a Zod
 * refinement: the schema never sees the document. It also cannot be one status
 * code, because the two failures are genuinely different mistakes.
 *
 * Sending the field for a line that never reached the kitchen is a malformed
 * request, 400. The question does not apply and answering it would record
 * something meaningless for M4 to read later.
 *
 * Omitting it for a line that did reach the kitchen is a well formed request
 * that breaks a rule of the business, 422. The system cannot guess, and
 * guessing wrong means either paying for ingredients that were never used or
 * losing stock that was. Whoever cancels is asked.
 */
export function assertWasPreparedRule(lineStatus, wasPrepared) {
  const reachedKitchen = PREPARED_LINE_STATUSES.includes(lineStatus);

  if (reachedKitchen && wasPrepared === undefined) {
    throw new BusinessRuleError(
      'The kitchen already has this. Say whether it was made, so stock is counted correctly.',
    );
  }

  if (!reachedKitchen && wasPrepared !== undefined) {
    throw new ValidationError('One of the values sent was not valid.', {
      wasPrepared: 'This never went to the kitchen, so there is nothing to answer.',
    });
  }
}

/**
 * The same question, asked of a whole order.
 *
 * One answer covers every fired line, because a manager cancelling a walkout is
 * answering "did the kitchen make any of this", not auditing it dish by dish.
 */
export function assertOrderWasPreparedRule(order, wasPrepared) {
  const anyReachedKitchen = order.lines.some((line) => PREPARED_LINE_STATUSES.includes(line.status));

  if (anyReachedKitchen && wasPrepared === undefined) {
    throw new BusinessRuleError(
      'Some of this order is already with the kitchen. Say whether it was made, so stock is counted correctly.',
    );
  }

  if (!anyReachedKitchen && wasPrepared !== undefined) {
    throw new ValidationError('One of the values sent was not valid.', {
      wasPrepared: 'Nothing on this order went to the kitchen, so there is nothing to answer.',
    });
  }
}

/**
 * Should this order move to READY_TO_BILL?
 *
 * Only when there is something to bill for. An order whose lines were all
 * cancelled stays OPEN on purpose, so a human closes it deliberately rather
 * than a zero-value order drifting into the cashier's queue by itself.
 */
export function isReadyToBill(lines) {
  const live = lines.filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED);
  return live.length > 0 && live.every((line) => line.status === ORDER_LINE_STATUSES.SERVED);
}

/**
 * The fields an order gains when it moves to READY_TO_BILL. P29: one shared
 * change, used when a waiter serves the last dish (12.7), when the kitchen's
 * ready serves it (13.3), when a cancel leaves only served lines, and undone
 * by the kitchen's undo (13.5). Callers decide whether with isReadyToBill.
 */
export function readyToBillChange(at) {
  return { status: ORDER_STATUSES.READY_TO_BILL, readyToBillAt: at };
}
