/**
 * One sellable dish.
 *
 * This is the record M2 copies from and M4 attaches a recipe to. Its `_id`, and
 * the `_id` of every variant on it, are foreign keys in modules that do not
 * exist yet. Read the note on subdocument ids below before editing this file.
 */
import mongoose from 'mongoose';

import { MAX_PAISE } from '../utils/money.js';
import { MAX_BASIS_POINTS } from '../validators/common.js';
import { applyJsonTransform } from './plugins/jsonTransform.js';
import { baseSchemaPlugin } from './plugins/baseSchema.js';
import { tenantGuardPlugin } from './plugins/tenantGuard.js';

export const MENU_ITEM_NAME_MAX_LENGTH = 100;
export const MENU_ITEM_DESCRIPTION_MAX_LENGTH = 500;
export const SUBDOCUMENT_NAME_MAX_LENGTH = 40;
export const MAX_VARIANTS = 20;
export const MAX_ADDONS = 30;

const wholeNumber = {
  validator: Number.isInteger,
  message: 'Must be a whole number.',
};

/** Money on a subdocument. Whole paise, never a decimal, same as everywhere. */
const subdocumentPrice = {
  type: Number,
  required: true,
  min: 0,
  max: MAX_PAISE,
  validate: wholeNumber,
};

const subdocumentName = {
  type: String,
  required: true,
  trim: true,
  minlength: 1,
  maxlength: SUBDOCUMENT_NAME_MAX_LENGTH,
};

/**
 * A size or portion. Half plate, full plate, 300ml.
 *
 * `priceInPaise` is the absolute price of this variant, not a delta from the
 * item's base price. A "Half" at 14000 costs 140 rupees. Storing a delta would
 * mean every variant price silently moved when the base price changed.
 */
const variantSchema = new mongoose.Schema(
  {
    name: subdocumentName,
    priceInPaise: subdocumentPrice,
    isAvailable: { type: Boolean, required: true, default: true },
  },
  { _id: true },
);

/**
 * An extra. Extra cheese, extra spicy.
 *
 * Typed per item on purpose. There is no shared add-on library, because "extra
 * cheese" on a pizza and on a sandwich are different prices and would drift the
 * moment one was edited.
 */
const addOnSchema = new mongoose.Schema(
  {
    name: subdocumentName,
    priceInPaise: subdocumentPrice,
    isAvailable: { type: Boolean, required: true, default: true },
  },
  { _id: true },
);

/**
 * baseSchemaPlugin cannot be applied to a subdocument: a variant has no
 * restaurantId of its own. Without this, an item would serialise with `id`
 * while its variants still carried `_id` and `__v`.
 */
applyJsonTransform(variantSchema);
applyJsonTransform(addOnSchema);

const menuItemSchema = new mongoose.Schema({
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Category',
  },

  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: MENU_ITEM_NAME_MAX_LENGTH,
  },

  /** Derived here, never sent by a caller, stripped in toJSON. See Category.js. */
  nameLower: { type: String, required: true },

  description: {
    type: String,
    trim: true,
    maxlength: MENU_ITEM_DESCRIPTION_MAX_LENGTH,
    default: null,
  },

  /** Whole paise. Never a decimal, never a float, never a string. */
  priceInPaise: {
    type: Number,
    required: true,
    min: 0,
    max: MAX_PAISE,
    validate: wholeNumber,
  },

  /**
   * Basis points. Five percent is 500, eighteen percent is 1800.
   *
   * The rate lives on the item rather than in a global setting because dishes
   * are taxed differently and a zero-rated item is legitimate. That is what
   * CLAUDE.md's "GST rates are settings, never hardcoded" asks for: the rate is
   * data on the record, not a constant in code.
   */
  taxRateBps: {
    type: Number,
    required: true,
    min: 0,
    max: MAX_BASIS_POINTS,
    validate: wholeNumber,
  },

  displayOrder: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
    validate: wholeNumber,
  },

  /**
   * "In stock right now." Flipped many times a day, by any of the six roles.
   *
   * Deliberately not the same field as isActive. A cook marking paneer out of
   * stock and a manager taking a dish off the menu are different events, and
   * collapsing them would mean reinstating one reinstated the other.
   */
  isAvailable: { type: Boolean, required: true, default: true },

  /** "On the menu at all." The soft delete. Owner and manager only. */
  isActive: { type: Boolean, required: true, default: true },

  /**
   * P46. An open item: staff type its name and price when ordering. Its
   * category routes it and its GST rate is its own; `priceInPaise` is unused.
   * Never on the guests' page or offered for platform mapping.
   */
  isOpenItem: { type: Boolean, default: false },

  /**
   * P64. The item's own HSN or SAC code, 4 to 8 digits, or null. An order line
   * freezes it when the dish is added, or the restaurant's default SAC when this
   * is null, and the bill copies the line. Never read at print time.
   */
  hsnCode: { type: String, trim: true, default: null, match: /^\d{4,8}$/ },

  /**
   * Subdocument ids here are permanent once issued.
   *
   * M4 attaches a recipe to a menuItemId plus an optional variantId, and M2
   * stores a variantId on an open order line. A PATCH that replaced this array
   * wholesale would regenerate every _id and silently detach a recipe from its
   * variant the first time someone renamed "Half" to "Half Plate". Nothing
   * would notice until M4 ran a deduction.
   *
   * The reconciliation that preserves them lives in
   * controllers/menuItemController.js. Do not replace this array by assignment
   * from a request body.
   */
  variants: {
    type: [variantSchema],
    default: [],
    validate: {
      validator: (value) => value.length <= MAX_VARIANTS,
      message: `Cannot have more than ${MAX_VARIANTS} variants.`,
    },
  },

  addOns: {
    type: [addOnSchema],
    default: [],
    validate: {
      validator: (value) => value.length <= MAX_ADDONS,
      message: `Cannot have more than ${MAX_ADDONS} add-ons.`,
    },
  },

  /**
   * P24. The dish's photo, or null. The bytes live in `menuphotos`, so this
   * read, which the ordering screen makes all service long, never carries an
   * image. Written and cleared only by services/menuPhotoService.js.
   */
  photo: {
    type: new mongoose.Schema(
      {
        sha256: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
        width: { type: Number, required: true },
        height: { type: Number, required: true },
      },
      { _id: false },
    ),
    default: null,
  },
});

menuItemSchema.plugin(baseSchemaPlugin);
menuItemSchema.plugin(tenantGuardPlugin);

menuItemSchema.pre('validate', function deriveNameLower() {
  if (typeof this.name === 'string') this.nameLower = this.name.trim().toLowerCase();
});

/** Two items in one branch cannot share a name, case-insensitively. */
menuItemSchema.index({ restaurantId: 1, branchId: 1, nameLower: 1 }, { unique: true });

/** The menu tree read. */
menuItemSchema.index({ restaurantId: 1, branchId: 1, categoryId: 1, displayOrder: 1 });

/** The filtered list read. */
menuItemSchema.index({ restaurantId: 1, branchId: 1, isActive: 1, isAvailable: 1 });

applyJsonTransform(menuItemSchema, { strip: ['nameLower'] });

export const MenuItem = mongoose.model('MenuItem', menuItemSchema);

export default MenuItem;
