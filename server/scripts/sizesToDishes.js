/**
 * P35 Part B: an item's sizes become dishes of their own.
 *
 *   npm run menu:sizes-to-dishes -- --restaurant "Three O’Clock" --item "Aerated Drinks"           a dry run
 *   npm run menu:sizes-to-dishes -- --restaurant "Three O’Clock" --item "Aerated Drinks" --apply   writes
 *
 * For the named item, every size becomes a dish in the same category, at the
 * size's own price, the item's GST, the size's availability and a copy of the
 * item's extras. The dishes sit where the item sat, in the order of its sizes;
 * the dishes after it in the category move down to make room. A size's recipe
 * becomes the new dish's item-level recipe, or, without one, the dish gets a
 * copy of the item's own. A platform mapping on a size moves to the new dish;
 * one on the item with no size is listed and left alone, because nobody can
 * tell which drink it meant. A photo is copied to each new dish. The item is
 * then switched off, never deleted, so old bills keep the name they were sold
 * under: their lines have it frozen on them, and nothing here touches an order
 * or a bill.
 *
 * Every write is in one transaction, so a failure writes nothing, and a second
 * run finds the item switched off and says there is nothing to do. No schema
 * change. docs/prompts/P35-same-dish-once-and-drinks-as-dishes.md Part B.
 */
import { pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Category } from '../models/Category.js';
import { IntegrationConnection } from '../models/IntegrationConnection.js';
import { MENU_ITEM_NAME_MAX_LENGTH, MenuItem } from '../models/MenuItem.js';
import { MenuPhoto } from '../models/MenuPhoto.js';
import { PlatformItemMapping } from '../models/PlatformItemMapping.js';
import { Recipe } from '../models/Recipe.js';
import { Restaurant } from '../models/Restaurant.js';
import { paiseToRupees } from '../utils/money.js';
import { isTransactionUnsupported } from '../utils/transaction.js';

/** A reason the script stops before writing anything. Its message is for the person running it. */
export class SizesToDishesError extends Error {}

const VALUE_FLAGS = { '--restaurant': 'restaurant', '--item': 'item' };

/**
 * `--restaurant <name>`, `--item <name>` (or `--restaurant=<name>`) and an
 * optional `--apply`. Anything else is refused rather than ignored, so a typo
 * like `--aply` can never turn a write into a silent dry run, or the reverse.
 */
export function parseArgs(argv) {
  const out = { restaurant: undefined, item: undefined, apply: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inline] = argument.startsWith('--') && argument.includes('=') ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)] : [argument, undefined];
    if (seen.has(flag)) throw new SizesToDishesError(`${flag} is given twice.`);
    if (flag === '--apply' && inline === undefined) {
      out.apply = true;
    } else if (VALUE_FLAGS[flag]) {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      out[VALUE_FLAGS[flag]] = value;
    } else {
      throw new SizesToDishesError(`Unknown argument: ${argument}. The script takes --restaurant, --item and --apply.`);
    }
    seen.add(flag);
  }
  for (const flag of Object.keys(VALUE_FLAGS)) {
    const value = out[VALUE_FLAGS[flag]];
    if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) throw new SizesToDishesError(`${flag} needs a name, like ${flag} "${flag === '--item' ? 'Aerated Drinks' : 'Z Chaat'}".`);
    out[VALUE_FLAGS[flag]] = value.trim();
  }
  return out;
}

const PROVIDER_NAMES = { SWIGGY: 'Swiggy', ZOMATO: 'Zomato', SANDBOX_PLATFORM: 'Sandbox platform' };

/** "Zomato: Coke 300 ml", for the report. */
const mappingLabel = (mapping, providers) =>
  `${PROVIDER_NAMES[providers.get(String(mapping.connectionId))] ?? 'A platform'}: ${mapping.externalName ?? mapping.externalItemId}`;

/**
 * Reads, checks and plans. Writes only with `apply`, and then all in one
 * transaction. Returns the report `formatReport` prints. Throws
 * SizesToDishesError, having written nothing, for every rule in P35 B5.
 */
export async function sizesToDishes({ restaurant: restaurantName, item: itemName, apply = false }) {
  if (!restaurantName || !itemName) throw new SizesToDishesError('Give both --restaurant and --item.');

  // `restaurants` is the tenancy root, read by its own documents. Every read after this one is scoped to it.
  const restaurants = await Restaurant.find({ name: restaurantName }).select('name').lean();
  if (restaurants.length === 0) throw new SizesToDishesError(`No restaurant is named "${restaurantName}".`);
  if (restaurants.length > 1) throw new SizesToDishesError(`${restaurants.length} restaurants are named "${restaurantName}". Remove the duplicate first.`);
  const restaurantId = restaurants[0]._id;

  const items = await MenuItem.find({ restaurantId, name: itemName }).lean();
  if (items.length === 0) throw new SizesToDishesError(`No item in ${restaurantName} is named "${itemName}".`);
  if (items.length > 1) throw new SizesToDishesError(`${items.length} items in ${restaurantName} are named "${itemName}", one per branch. This script splits one item at a time.`);
  const old = items[0];
  const report = { restaurant: restaurantName, item: itemName, apply, nothingToDo: false };
  if (!old.isActive) return { ...report, nothingToDo: true };

  const sizes = old.variants ?? [];
  if (sizes.length === 0) throw new SizesToDishesError(`${itemName} has no sizes, so there is nothing to split.`);
  const names = sizes.map((size) => (size.name ?? '').trim());
  const tooLong = names.filter((name) => name === '' || name.length > MENU_ITEM_NAME_MAX_LENGTH);
  if (tooLong.length > 0) throw new SizesToDishesError(`A size name is empty or longer than ${MENU_ITEM_NAME_MAX_LENGTH} characters.`);
  const lowers = names.map((name) => name.toLowerCase());
  const twice = names.filter((name, index) => lowers.indexOf(name.toLowerCase()) !== index);
  if (twice.length > 0) throw new SizesToDishesError(`Two sizes share a name: ${[...new Set(twice)].join(', ')}.`);

  const { branchId, categoryId } = old;
  // Switched off or on: a name stays taken in the database either way. The item itself counts, because it is kept.
  const clashes = await MenuItem.find({ restaurantId, branchId, nameLower: { $in: lowers } }).select('name isActive').lean();
  if (clashes.length > 0) {
    const list = clashes.map((clash) => `"${clash.name}"${clash.isActive ? '' : ' (switched off)'}`).join(', ');
    throw new SizesToDishesError(`A dish already has the name of a size: ${list}. Rename one of them first.`);
  }

  const category = await Category.findOne({ restaurantId, _id: categoryId }).select('name').lean();
  const recipes = await Recipe.find({ restaurantId, branchId, menuItemId: old._id }).lean();
  const itemRecipe = recipes.find((recipe) => recipe.variantId === null) ?? null;
  const mappings = await PlatformItemMapping.find({ restaurantId, menuItemId: old._id }).lean();
  const connections = await IntegrationConnection.find({ restaurantId, _id: { $in: [...new Set(mappings.map((m) => String(m.connectionId)))] } }).select('provider').lean();
  const providers = new Map(connections.map((connection) => [String(connection._id), connection.provider]));
  const photo = await MenuPhoto.findOne({ restaurantId, menuItemId: old._id }).select('_id').lean();

  // Where the dishes go: the item's own place, then the next ones down. Anything in the way moves down.
  const after = await MenuItem.find({ restaurantId, branchId, categoryId, _id: { $ne: old._id }, displayOrder: { $gt: old.displayOrder } })
    .sort({ displayOrder: 1, name: 1 })
    .select('name displayOrder')
    .lean();
  const lastNew = old.displayOrder + sizes.length - 1;
  const shift = after.length > 0 && after[0].displayOrder <= lastNew ? lastNew - after[0].displayOrder + 1 : 0;

  const sizeIds = new Set(sizes.map((size) => String(size._id)));
  const dishes = sizes.map((size, index) => {
    const ownRecipe = recipes.find((recipe) => recipe.variantId !== null && String(recipe.variantId) === String(size._id)) ?? null;
    const recipe = ownRecipe ?? itemRecipe;
    return {
      sizeId: size._id,
      name: names[index],
      priceInPaise: size.priceInPaise,
      taxRateBps: old.taxRateBps,
      isAvailable: size.isAvailable,
      displayOrder: old.displayOrder + index,
      recipe: recipe && { from: ownRecipe ? 'size' : 'item', items: recipe.items, isActive: recipe.isActive, ingredients: recipe.items.length },
      mappings: mappings.filter((mapping) => mapping.variantId !== null && String(mapping.variantId) === String(size._id)),
      photo: photo !== null,
    };
  });
  const leftAlone = mappings
    .filter((mapping) => mapping.variantId === null || !sizeIds.has(String(mapping.variantId)))
    .map((mapping) => ({ label: mappingLabel(mapping, providers), reason: mapping.variantId === null ? 'it points at the item with no size' : 'it points at a size the item no longer has' }));

  const planned = {
    ...report,
    category: category?.name ?? null,
    addOns: (old.addOns ?? []).length,
    dishes: dishes.map(({ sizeId: _sizeId, mappings: moved, recipe, ...dish }) => ({
      ...dish,
      recipe: recipe && { from: recipe.from, ingredients: recipe.ingredients },
      mappings: moved.map((mapping) => mappingLabel(mapping, providers)),
    })),
    movedDown: shift > 0 ? { names: after.map((dish) => dish.name), by: shift } : null,
    mappingsLeftAlone: leftAlone,
  };
  if (!apply) return planned;

  await writeInOneTransaction({ restaurantId, old, dishes, shift });
  return planned;
}

/** Every write, or none. A transaction is required: without one, a failure halfway would leave half a menu. */
async function writeInOneTransaction({ restaurantId, old, dishes, shift }) {
  const { branchId, categoryId } = old;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Switch the item off first, and only if it is still on: two runs at once write once.
      const off = await MenuItem.updateOne({ restaurantId, _id: old._id, isActive: true }, { $set: { isActive: false } }, { session });
      if (off.modifiedCount !== 1) throw new SizesToDishesError(`${old.name} changed while this ran. Nothing was written; run it again.`);

      if (shift > 0) {
        await MenuItem.updateMany(
          { restaurantId, branchId, categoryId, _id: { $ne: old._id }, displayOrder: { $gt: old.displayOrder } },
          { $inc: { displayOrder: shift } },
          { session },
        );
      }

      const photo = dishes.some((dish) => dish.photo) ? await MenuPhoto.findOne({ restaurantId, menuItemId: old._id }).session(session).lean() : null;

      for (const dish of dishes) {
        const [created] = await MenuItem.create(
          [
            {
              restaurantId,
              branchId,
              categoryId,
              name: dish.name,
              description: old.description ?? null,
              priceInPaise: dish.priceInPaise,
              taxRateBps: dish.taxRateBps,
              isAvailable: dish.isAvailable,
              isActive: true,
              displayOrder: dish.displayOrder,
              variants: [],
              addOns: (old.addOns ?? []).map(({ name, priceInPaise, isAvailable }) => ({ name, priceInPaise, isAvailable })),
            },
          ],
          { session },
        );
        // The extras are copies with new ids, so a moved mapping's extras follow them by position.
        const addOnIds = new Map((old.addOns ?? []).map((addOn, index) => [String(addOn._id), created.addOns[index]._id]));

        if (dish.recipe) {
          await Recipe.create(
            [{ restaurantId, branchId, menuItemId: created._id, variantId: null, items: dish.recipe.items, isActive: dish.recipe.isActive }],
            { session },
          );
        }

        for (const mapping of dish.mappings) {
          const addOnMap = Object.fromEntries(
            Object.entries(mapping.addOnMap ?? {}).map(([external, ours]) => {
              const moved = addOnIds.get(String(ours));
              return [external, moved ? (typeof ours === 'string' ? String(moved) : moved) : ours];
            }),
          );
          await PlatformItemMapping.updateOne(
            { restaurantId, _id: mapping._id, menuItemId: old._id },
            { $set: { menuItemId: created._id, variantId: null, addOnMap } },
            { session },
          );
        }

        if (photo) {
          const { _id, menuItemId: _menuItemId, createdAt: _createdAt, updatedAt: _updatedAt, __v, ...copy } = photo;
          await MenuPhoto.create([{ ...copy, menuItemId: created._id }], { session });
        }
      }
    });
  } catch (error) {
    if (isTransactionUnsupported(error)) throw new SizesToDishesError('This database cannot run transactions, so nothing was written. It needs a replica set, as Atlas is.');
    throw error;
  } finally {
    await session.endSession();
  }
}

const gstText = (bps) => `GST ${bps / 100}%`;

/** The report as lines to print. */
export function formatReport(report) {
  if (report.nothingToDo) return [`Nothing to do: ${report.item} is already switched off.`];
  const will = report.apply ? '' : 'will ';
  const lines = [
    `${report.restaurant}, ${report.category ?? 'its category'}: ${report.item} has ${report.dishes.length} sizes. Each ${report.apply ? 'became' : 'becomes'} its own dish.`,
    '',
  ];
  for (const dish of report.dishes) {
    const recipe = !dish.recipe
      ? 'none'
      : dish.recipe.from === 'size'
        ? `its size's recipe, ${dish.recipe.ingredients} ingredient${dish.recipe.ingredients === 1 ? '' : 's'}`
        : `a copy of ${report.item}'s recipe, ${dish.recipe.ingredients} ingredient${dish.recipe.ingredients === 1 ? '' : 's'}`;
    lines.push(`  ${dish.name}  ${paiseToRupees(dish.priceInPaise, { symbol: true })}  ${gstText(dish.taxRateBps)}  ${dish.isAvailable ? 'available' : 'not available'}`);
    lines.push(`    recipe: ${recipe}`);
    lines.push(`    platform mappings: ${dish.mappings.length === 0 ? 'none' : dish.mappings.join('; ')}`);
    lines.push(`    photo: ${dish.photo ? 'a copy of the item\'s photo' : 'none'}`);
    lines.push(`    extras: ${report.addOns === 0 ? 'none' : `a copy of the item's ${report.addOns}`}`);
  }
  lines.push('');
  if (report.movedDown) {
    lines.push(`${report.movedDown.names.join(', ')} ${will}move down ${report.movedDown.by}, so the new dishes sit where ${report.item} was.`);
  }
  if (report.mappingsLeftAlone.length > 0) {
    lines.push(`Platform mappings left alone, because nobody can tell which dish they meant:`);
    for (const mapping of report.mappingsLeftAlone) lines.push(`  ${mapping.label} (${mapping.reason})`);
  }
  lines.push(`${report.item} ${report.apply ? 'is' : 'will be'} switched off, not deleted. Open orders and old bills keep "${report.item}" and the size, frozen on their lines.`);
  return lines;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Stopped, nothing written: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(args.apply ? 'Writing.' : 'Dry run: nothing is written. Add --apply to write.');
  await connectDatabase();
  try {
    const report = await sizesToDishes(args);
    for (const line of formatReport(report)) console.log(line);
  } catch (error) {
    console.error(`Stopped, nothing written: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await main();
