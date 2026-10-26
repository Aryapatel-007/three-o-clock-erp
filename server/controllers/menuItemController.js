/**
 * Menu items, and the menu tree the ordering screen reads.
 *
 * Shapes come from docs/API-CONTRACT.md sections 5 and 6.
 *
 * The one thing in this file worth reading before editing it is
 * `reconcileSubdocuments`. Variant ids are foreign keys in M2 and M4, and the
 * obvious implementation of "replace the array" quietly breaks both.
 */
import { Category } from '../models/Category.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { MenuItem } from '../models/MenuItem.js';
import { recordAudit } from '../services/auditService.js';
import { getSetting } from '../services/settingsService.js';
import {
  AddOnNotFoundError,
  BusinessRuleError,
  DuplicateMenuItemNameError,
  NotFoundError,
  VariantNotFoundError,
} from '../utils/errors.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { sendList, sendSuccess } from '../utils/response.js';
import { scoped } from '../utils/scopedQuery.js';

const MONGO_DUPLICATE_KEY = 11000;

/** Turns the unique-index violation into the contract's 409. See categoryController. */
function rethrowDuplicate(error) {
  if (error?.code === MONGO_DUPLICATE_KEY) throw new DuplicateMenuItemNameError();
  throw error;
}

/** Loads one item inside the caller's tenant, or 404. Never 403. */
async function loadMenuItemInTenant(req, menuItemId) {
  const item = await MenuItem.findOne({ ...scoped(req), _id: menuItemId });
  if (!item) throw new NotFoundError('Menu item not found.');
  return item;
}

/**
 * Confirms a category exists in this tenant and is usable.
 *
 * 404 when it does not exist or belongs to another restaurant, 422 when it
 * exists but is switched off. The split matters: the first is "you named
 * something that isn't there", the second is "you named something real that
 * cannot take items right now", and the menu screen shows different things for
 * each.
 */
async function assertCategoryUsable(req, categoryId) {
  const category = await Category.findOne({ ...scoped(req), _id: categoryId });
  if (!category) throw new NotFoundError('Category not found.');
  if (!category.isActive) {
    throw new BusinessRuleError('That category is not active. Reactivate it before adding items.');
  }
  return category;
}

/**
 * Rebuilds a variant or add-on array while preserving the ids it already issued.
 *
 * An entry with an `id` that exists on the item keeps that `_id` and is updated
 * in place. An entry with no `id` becomes a new subdocument. An entry naming an
 * id that is not on this item throws, before anything is written.
 *
 * The naive version of this endpoint assigns the request array straight onto
 * the document, which makes Mongoose mint a fresh _id for every entry. M4
 * attaches recipes to a variantId and M2 stores one on an open order line, so
 * that version silently detaches a recipe from its variant the first time a
 * manager renames "Half" to "Half Plate", and nothing notices until a stock
 * deduction runs weeks later. Hence matching by id rather than by position or
 * by name: position changes when the manager reorders, name changes when they
 * rename, and the id is the only thing that is stable across both.
 *
 * An entry omitted from `incoming` is dropped, which is how a variant is
 * removed. Nothing checks whether something downstream still points at it. See
 * the known problems table in PROJECT-STATE.md.
 */
function reconcileSubdocuments(existing, incoming, NotFoundForKind) {
  const byId = new Map(existing.map((subdocument) => [String(subdocument._id), subdocument]));

  return incoming.map((entry) => {
    if (entry.id === undefined) {
      return {
        name: entry.name,
        priceInPaise: entry.priceInPaise,
        isAvailable: entry.isAvailable ?? true,
      };
    }

    const current = byId.get(entry.id);
    if (!current) throw new NotFoundForKind();

    return {
      _id: current._id,
      name: entry.name,
      priceInPaise: entry.priceInPaise,
      // Not supplied means unchanged. A rename should not silently put a
      // variant the kitchen switched off half an hour ago back on the screen.
      isAvailable: entry.isAvailable ?? current.isAvailable,
    };
  });
}

/** POST /menu-items */
export async function createMenuItem(req, res) {
  const { categoryId, name, description, priceInPaise, taxRateBps, displayOrder, variants, addOns, isOpenItem, hsnCode } =
    req.body;

  await assertCategoryUsable(req, categoryId);

  /**
   * An omitted rate falls back to the restaurant's default, added by M7. An
   * explicitly sent rate always wins, including an explicit 0, which is why
   * this tests for undefined rather than falsiness: a zero-rated dish is
   * legitimate and must not be silently rewritten to the default.
   *
   * The stored item keeps its own rate forever. Changing the setting tomorrow
   * moves nothing that already exists, which is the same snapshot discipline
   * order lines follow.
   */
  const rate =
    taxRateBps ?? (await getSetting(req.restaurantId, 'tax.defaultTaxRateBps', { req }));

  const item = new MenuItem({
    ...scoped(req),
    categoryId,
    name,
    description: description ?? null,
    priceInPaise,
    taxRateBps: rate,
    ...(displayOrder === undefined ? {} : { displayOrder }),
    // No reconciliation on create: there is nothing to preserve, and every
    // subdocument is new by definition.
    variants: variants ?? [],
    addOns: addOns ?? [],
    // P46.
    isOpenItem: isOpenItem ?? false,
    // P64.
    hsnCode: hsnCode ?? null,
  });

  await item.save().catch(rethrowDuplicate);

  return sendSuccess(res, item.toJSON(), 201);
}

/**
 * GET /menu-items
 *
 * `includeInactive` covers both the item's own flag and its category's, because
 * an item in a switched-off section is not on the menu either way and showing
 * one but not the other would be arbitrary.
 */
export async function listMenuItems(req, res) {
  const { page, limit, categoryId, search, availableOnly, includeInactive } = req.query;

  const filter = { ...scoped(req) };
  if (categoryId !== undefined) filter.categoryId = categoryId;
  if (availableOnly) filter.isAvailable = true;

  if (!includeInactive) {
    filter.isActive = true;

    // Excluding the inactive ones rather than listing the active ones: the
    // inactive set is almost always the smaller of the two, and an empty
    // exclusion list means no clause at all.
    const inactiveCategories = await Category.find({ ...scoped(req), isActive: false }).select('_id');
    if (inactiveCategories.length > 0) {
      filter.categoryId = {
        ...(categoryId === undefined ? {} : { $eq: categoryId }),
        $nin: inactiveCategories.map((category) => category._id),
      };
    }
  }

  if (search) {
    // Escaped before it becomes a pattern. Unescaped, "search=.*" matches every
    // row and turns the search box into a full collection scan.
    filter.nameLower = new RegExp(escapeRegex(search.toLowerCase()));
  }

  const [items, total] = await Promise.all([
    MenuItem.find(filter)
      .sort({ displayOrder: 1, name: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    MenuItem.countDocuments(filter),
  ]);

  return sendList(
    res,
    items.map((item) => item.toJSON()),
    { page, limit, total },
  );
}

/** GET /menu-items/:menuItemId */
export async function getMenuItem(req, res) {
  const item = await loadMenuItemInTenant(req, req.params.menuItemId);
  return sendSuccess(res, item.toJSON());
}

/** PATCH /menu-items/:menuItemId */
export async function updateMenuItem(req, res) {
  const item = await loadMenuItemInTenant(req, req.params.menuItemId);
  const { categoryId, name, description, priceInPaise, taxRateBps, displayOrder, variants, addOns, isOpenItem, hsnCode } =
    req.body;

  if (categoryId !== undefined && String(categoryId) !== String(item.categoryId)) {
    await assertCategoryUsable(req, categoryId);
  }

  /**
   * Both arrays are reconciled before either is assigned.
   *
   * If addOns names an id that does not exist, this throws while variants has
   * already been rebuilt but not yet written, so the request leaves the document
   * exactly as it found it. Assigning as we go would half-apply it.
   */
  const nextVariants =
    variants === undefined ? undefined : reconcileSubdocuments(item.variants, variants, VariantNotFoundError);
  const nextAddOns =
    addOns === undefined ? undefined : reconcileSubdocuments(item.addOns, addOns, AddOnNotFoundError);

  const pricesBefore = priceSnapshot(item);

  if (categoryId !== undefined) item.categoryId = categoryId;
  if (name !== undefined) item.name = name;
  if (description !== undefined) item.description = description;
  if (priceInPaise !== undefined) item.priceInPaise = priceInPaise;
  if (taxRateBps !== undefined) item.taxRateBps = taxRateBps;
  if (displayOrder !== undefined) item.displayOrder = displayOrder;
  if (nextVariants !== undefined) item.variants = nextVariants;
  if (nextAddOns !== undefined) item.addOns = nextAddOns;
  // P46.
  if (isOpenItem !== undefined) item.isOpenItem = isOpenItem;
  // P64. Changes only lines added from now: every line already added froze its own.
  if (hsnCode !== undefined) item.hsnCode = hsnCode;

  await item.save().catch(rethrowDuplicate);

  // M8. A price quietly moved before or after a shift. A rename writes nothing.
  const changes = priceChanges(pricesBefore, priceSnapshot(item));
  if (changes.length > 0) {
    await recordAudit(req, {
      action: AUDIT_ACTIONS.MENU_PRICE_CHANGED,
      entityType: AUDIT_ENTITY_TYPES.MENU_ITEM,
      entityId: item._id,
      entityLabel: item.name.slice(0, 100),
      reason: `${changes.length === 1 ? 'Price' : 'Prices'} changed on ${item.name}.`.slice(0, 500),
      amountInPaise: changes.find((change) => change.field === 'priceInPaise')?.to ?? null,
      details: { changes },
    });
  }

  return sendSuccess(res, item.toJSON());
}

/** The fields M8 audits: base price, tax rate, and each size's and extra's price, by id. */
function priceSnapshot(item) {
  const entries = [
    ['priceInPaise', item.priceInPaise],
    ['taxRateBps', item.taxRateBps],
    ...item.variants.map((variant) => [`variant:${variant._id}`, variant.priceInPaise]),
    ...item.addOns.map((addOn) => [`addOn:${addOn._id}`, addOn.priceInPaise]),
  ];
  return new Map(entries);
}

/** Every audited field whose value moved, added or removed. Small and flat, no names. */
function priceChanges(before, after) {
  const fields = new Set([...before.keys(), ...after.keys()]);
  const changes = [];
  for (const field of fields) {
    const from = before.get(field) ?? null;
    const to = after.get(field) ?? null;
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/**
 * PATCH /menu-items/:menuItemId/availability
 *
 * The one write in M1 open to all six roles.
 *
 * A kitchen that runs out of paneer at 8pm cannot wait for the owner to unlock
 * a phone. The schema is strict, so this endpoint can change one boolean and
 * nothing else: the worst a cashier can do with it is make a dish disappear
 * from the ordering screen, which someone with a key can undo in a second.
 */
export async function setAvailability(req, res) {
  const item = await loadMenuItemInTenant(req, req.params.menuItemId);
  const { isAvailable, variantId } = req.body;

  if (variantId === undefined || variantId === null) {
    item.isAvailable = isAvailable;
  } else {
    const variant = item.variants.id(variantId);
    if (!variant) throw new VariantNotFoundError();
    // The item's own flag is deliberately untouched. Running out of half plates
    // does not mean the dish is off.
    variant.isAvailable = isAvailable;
  }

  await item.save();

  req.log?.info(
    {
      actorId: req.user.id,
      role: req.user.role,
      menuItemId: String(item._id),
      variantId: variantId ?? null,
      isAvailable,
    },
    'Menu availability changed.',
  );

  // P25 Part H. Every active delivery platform where this dish is mapped is told, by a queued call.
  const { queueAvailabilityFor } = await import('../services/integrations/platformOrderService.js');
  await queueAvailabilityFor(req, item._id);

  return sendSuccess(res, item.toJSON());
}

/**
 * PATCH /menu-items/:menuItemId/active
 *
 * This is the delete. There is no DELETE route and there will not be one: a
 * bill from M3 references this item by id forever.
 */
export async function setMenuItemActive(req, res) {
  const item = await loadMenuItemInTenant(req, req.params.menuItemId);

  item.isActive = req.body.isActive;
  await item.save();

  req.log?.info(
    { actorId: req.user.id, menuItemId: String(item._id), isActive: item.isActive },
    'Menu item active flag changed.',
  );

  return sendSuccess(res, item.toJSON());
}

/**
 * GET /menu
 *
 * Two queries, always. Categories, then every item across those categories in
 * one go, grouped in memory. Looping categories and querying per category would
 * be one round trip per section on the busiest read in the product.
 *
 * Inactive categories and inactive items are excluded here unconditionally.
 * There is no query parameter that reveals one, which is why the schema for
 * this endpoint has no includeInactive at all.
 */
export async function getMenu(req, res) {
  const { includeUnavailable } = req.query;

  const categories = await Category.find({ ...scoped(req), isActive: true }).sort({
    displayOrder: 1,
    name: 1,
  });

  if (categories.length === 0) return sendSuccess(res, []);

  const itemFilter = {
    ...scoped(req),
    isActive: true,
    categoryId: { $in: categories.map((category) => category._id) },
  };
  if (!includeUnavailable) itemFilter.isAvailable = true;

  const items = await MenuItem.find(itemFilter).sort({ displayOrder: 1, name: 1 });

  const itemsByCategory = new Map();
  for (const item of items) {
    const key = String(item.categoryId);
    if (!itemsByCategory.has(key)) itemsByCategory.set(key, []);
    itemsByCategory.get(key).push(item.toJSON());
  }

  return sendSuccess(
    res,
    categories.map((category) => ({
      id: String(category._id),
      name: category.name,
      displayOrder: category.displayOrder,
      // A category with nothing sellable in it still appears, with an empty
      // array, so the ordering screen keeps a stable set of tabs through a
      // service rather than having them vanish as things sell out.
      items: itemsByCategory.get(String(category._id)) ?? [],
    })),
  );
}
