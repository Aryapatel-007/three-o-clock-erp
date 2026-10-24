/**
 * Menu management request schemas.
 *
 * Built on the primitives in common.js. Nothing here re-derives what a paise or
 * a basis point is: `paise` and `basisPoints` already reject a float, a
 * negative, a string and anything over the ceiling, and using them means the
 * menu screen and the staff screen fail the same way on the same input.
 *
 * Business rules are not here. A Zod refinement always surfaces as a 400
 * through the validate middleware, and rules like "the category is inactive"
 * have to be 422, so they are thrown in the controller instead.
 */
import { z } from 'zod';

import {
  MAX_ADDONS,
  MAX_VARIANTS,
  MENU_ITEM_DESCRIPTION_MAX_LENGTH,
  MENU_ITEM_NAME_MAX_LENGTH,
  SUBDOCUMENT_NAME_MAX_LENGTH,
} from '../models/MenuItem.js';
import { CATEGORY_NAME_MAX_LENGTH } from '../models/Category.js';
import { stationIdOrNull } from './stationValidators.js';
import { basisPoints, nonEmptyString, objectId, paginationQuery, paise, queryBoolean } from './common.js';

export const MAX_SEARCH_LENGTH = 60;

const categoryName = nonEmptyString.max(
  CATEGORY_NAME_MAX_LENGTH,
  `Cannot be longer than ${CATEGORY_NAME_MAX_LENGTH} characters.`,
);

const menuItemName = nonEmptyString.max(
  MENU_ITEM_NAME_MAX_LENGTH,
  `Cannot be longer than ${MENU_ITEM_NAME_MAX_LENGTH} characters.`,
);

const subdocumentName = nonEmptyString.max(
  SUBDOCUMENT_NAME_MAX_LENGTH,
  `Cannot be longer than ${SUBDOCUMENT_NAME_MAX_LENGTH} characters.`,
);

const displayOrder = z
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .min(0, 'Cannot be negative.');

const isActiveBody = z
  .object({ isActive: z.boolean({ error: 'Must be true or false.' }) })
  .strict('Is not a field you can set here.');

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const categoryIdParam = z.object({ categoryId: objectId });

export const createCategorySchema = z.object({
  body: z
    .object({
      name: categoryName,
      displayOrder: displayOrder.optional(),
    })
    .strict('Is not a field you can set here.'),
});

export const listCategoriesSchema = z.object({
  query: z.object({ includeInactive: queryBoolean }),
});

/**
 * `isActive` is refused rather than ignored, because it has its own endpoint.
 * Silently dropping it would let a caller believe a change landed when it did
 * not, which is the same rule PATCH /users/:userId follows.
 */
export const updateCategorySchema = z.object({
  params: categoryIdParam,
  body: z
    .object({
      name: categoryName.optional(),
      displayOrder: displayOrder.optional(),
      // P05. The station this category's dishes are cooked at, or null.
      stationId: stationIdOrNull.optional(),
      isActive: z
        .never({ error: 'Has its own endpoint: PATCH /categories/:categoryId/active' })
        .optional(),
    })
    .strict('Is not a field you can change here.')
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
});

export const setCategoryActiveSchema = z.object({
  params: categoryIdParam,
  body: isActiveBody,
});

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

const menuItemIdParam = z.object({ menuItemId: objectId });

/**
 * One variant or add-on in a request body.
 *
 * `id` is optional and is what makes an edit an edit. An entry carrying an id
 * that exists on the item updates it in place and keeps that id; an entry with
 * no id becomes a new subdocument. The controller resolves it, because an id
 * that does not exist on the item has to be a 404 and a Zod refinement cannot
 * produce one.
 */
const subdocumentEntry = z
  .object({
    id: objectId.optional(),
    name: subdocumentName,
    priceInPaise: paise,
    isAvailable: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .strict('Is not a field you can set here.');

/** Two variants on one item cannot share a name, compared case-insensitively. */
function namesAreUnique(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

const variants = z
  .array(subdocumentEntry)
  .max(MAX_VARIANTS, `Cannot have more than ${MAX_VARIANTS} variants.`)
  .refine(namesAreUnique, 'Two variants cannot have the same name.');

const addOns = z
  .array(subdocumentEntry)
  .max(MAX_ADDONS, `Cannot have more than ${MAX_ADDONS} add-ons.`)
  .refine(namesAreUnique, 'Two add-ons cannot have the same name.');

const description = z
  .union([
    z
      .string()
      .trim()
      .max(
        MENU_ITEM_DESCRIPTION_MAX_LENGTH,
        `Cannot be longer than ${MENU_ITEM_DESCRIPTION_MAX_LENGTH} characters.`,
      ),
    z.null(),
  ])
  .optional();

/** P64. 4 to 8 digits, or null to clear. "" is stored as null, the receipt text rule. */
export const HSN_CODE_MESSAGE = 'An HSN or SAC code is 4 to 8 digits.';
const hsnCode = z
  .union([z.string(), z.null()], { error: HSN_CODE_MESSAGE })
  .transform((value) => (value === null || value.trim() === '' ? null : value.trim()))
  .refine((value) => value === null || /^\d{4,8}$/.test(value), HSN_CODE_MESSAGE)
  .optional();

export const createMenuItemSchema = z.object({
  body: z
    .object({
      categoryId: objectId,
      name: menuItemName,
      description,
      priceInPaise: paise,
      /**
       * Optional as of M7. When it is absent the controller fills it from
       * `settings.tax.defaultTaxRateBps`, so an owner does not retype 5% two
       * hundred times during onboarding.
       *
       * Only the API's default moved. The field stays required in the schema
       * and required on every stored document, and an explicitly sent rate
       * always wins.
       */
      taxRateBps: basisPoints.optional(),
      displayOrder: displayOrder.optional(),
      variants: variants.optional(),
      addOns: addOns.optional(),
      // P46.
      isOpenItem: z.boolean({ error: 'Must be true or false.' }).optional(),
      // P64.
      hsnCode,
    })
    .strict('Is not a field you can set here.'),
});

export const listMenuItemsSchema = z.object({
  query: paginationQuery.extend({
    categoryId: objectId.optional(),
    /**
     * Capped before it reaches the controller, which escapes it before it
     * becomes a regular expression. Both matter: the cap bounds the work, the
     * escape stops ".*" matching every row.
     */
    search: z.string().trim().max(MAX_SEARCH_LENGTH).optional(),
    availableOnly: queryBoolean,
    includeInactive: queryBoolean,
  }),
});

export const readMenuItemSchema = z.object({ params: menuItemIdParam });

/**
 * Everything editable in one place, with the two toggles refused.
 *
 * `isAvailable` is refused here because its endpoint is open to all six roles
 * and this one is not. Letting it through here would be a second, wider path to
 * the same field, guarded differently.
 */
export const updateMenuItemSchema = z.object({
  params: menuItemIdParam,
  body: z
    .object({
      categoryId: objectId.optional(),
      name: menuItemName.optional(),
      description,
      priceInPaise: paise.optional(),
      taxRateBps: basisPoints.optional(),
      displayOrder: displayOrder.optional(),
      variants: variants.optional(),
      addOns: addOns.optional(),
      // P46.
      isOpenItem: z.boolean({ error: 'Must be true or false.' }).optional(),
      // P64.
      hsnCode,
      isAvailable: z
        .never({ error: 'Has its own endpoint: PATCH /menu-items/:menuItemId/availability' })
        .optional(),
      isActive: z
        .never({ error: 'Has its own endpoint: PATCH /menu-items/:menuItemId/active' })
        .optional(),
    })
    .strict('Is not a field you can change here.')
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
});

/**
 * The one write open to all six roles.
 *
 * `.strict()` is doing real work here. This endpoint is reachable by a cashier
 * and a cook, so a body carrying priceInPaise has to be rejected outright
 * rather than ignored. Two fields in, one boolean out.
 */
export const setAvailabilitySchema = z.object({
  params: menuItemIdParam,
  body: z
    .object({
      isAvailable: z.boolean({ error: 'Must be true or false.' }),
      variantId: z.union([objectId, z.null()]).optional(),
    })
    .strict('Is not a field you can set here.'),
});

export const setMenuItemActiveSchema = z.object({
  params: menuItemIdParam,
  body: isActiveBody,
});

// ---------------------------------------------------------------------------
// The menu tree
// ---------------------------------------------------------------------------

/**
 * There is no includeInactive here on purpose.
 *
 * GET /menu is the ordering screen's read. An inactive category or item must
 * never appear on it under any query, so the parameter that would reveal one
 * does not exist rather than defaulting to false.
 */
export const readMenuSchema = z.object({
  query: z.object({ includeUnavailable: queryBoolean }),
});
