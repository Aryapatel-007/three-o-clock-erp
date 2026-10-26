/**
 * Building and checking the indexes every model declares.
 *
 * `autoIndex` is off in production (config/database.js), so a live server never
 * builds an index in the middle of service. That leaves nothing building them
 * at all, and on a fresh production database the unique indexes that stop a
 * duplicate bill number, a second open order on one table, a reused KOT number
 * and a double stock deduction would simply not exist. Every one of those
 * guards would be silently off.
 *
 * So indexes are built deliberately, by `npm run db:indexes` on every deploy,
 * and the production boot check in server.js refuses to start while one is
 * missing.
 *
 * This file NEVER drops an index. Not `syncIndexes`, which drops whatever the
 * schema does not mention, not `dropIndex`, not for any reason. An index the
 * schema does not declare is reported as extra and left exactly where it is:
 * someone may have built it by hand for a reason, and removing it is a
 * decision for a person, not a deploy script.
 */
import { ALL_MODELS } from '../models/index.js';

/** The options that change what an index enforces. Everything else is noise. */
const MEANINGFUL_OPTIONS = ['unique', 'partialFilterExpression', 'expireAfterSeconds', 'sparse'];

const DUPLICATE_KEY = 11000;
const INDEX_OPTIONS_CONFLICT = 85;
const INDEX_KEY_SPECS_CONFLICT = 86;

function meaningfulOptions(options = {}) {
  const out = {};
  for (const key of MEANINGFUL_OPTIONS) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out;
}

/** An index as listed, without the simple collation MongoDB 9 reports on every index. */
export function withoutDefaultCollation(index) {
  const collation = index.collation;
  if (!collation || collation.locale !== 'simple' || Object.keys(collation).length !== 1) return index;
  const { collation: _default, ...rest } = index;
  return rest;
}

/** The name MongoDB gives an index when none is supplied: `restaurantId_1_billNumber_1`. */
export function defaultIndexName(key) {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join('_');
}

/** `{ restaurantId: 1, billNumber: 1 }`, for a person reading a terminal. */
export function describeKey(key) {
  const parts = Object.entries(key).map(([field, direction]) => `${field}: ${direction}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * What the schema declares against what the database has, for one model.
 *
 * `Model.diffIndexes()` compares by key and by unique, partialFilterExpression,
 * sparse, expireAfterSeconds and collation, and already treats a collection
 * that does not exist yet (NamespaceNotFound, code 26) as one with no indexes,
 * so every declared index comes back as missing rather than as a throw.
 * Checked against the installed Mongoose 8.x source before relying on it.
 */
async function diffModel(model) {
  // MongoDB 9 lists every index with `collation: { locale: 'simple' }`, the
  // server's own default, and Mongoose 8 reads that as a different index from
  // one declared with no collation. So the diff reads the indexes with that
  // default left out; any other collation still counts.
  const view = Object.create(model);
  view.listIndexes = async () => (await model.listIndexes()).map(withoutDefaultCollation);
  const { toCreate, toDrop } = await model.diffIndexes.call(view, { indexOptionsToCreate: true });
  return {
    toCreate: toCreate.map(([key, options]) => ({ key, options })),
    toDrop,
  };
}

/**
 * Every declared index the database lacks, and every index it has that nothing
 * declares, apart from `_id_`.
 */
export async function findMissingIndexes(models = ALL_MODELS) {
  const missing = [];
  const extra = [];

  for (const model of models) {
    const collection = model.collection.collectionName;
    const { toCreate, toDrop } = await diffModel(model);

    for (const { key, options } of toCreate) {
      missing.push({ model: model.modelName, collection, key, options: meaningfulOptions(options) });
    }
    for (const name of toDrop) {
      extra.push({ model: model.modelName, collection, name });
    }
  }

  return { missing, extra };
}

/** One plain sentence saying what went wrong and what a person has to do about it. */
function explainBuildError(error, key) {
  const where = describeKey(key);

  if (error?.code === DUPLICATE_KEY) {
    return `Duplicate key on ${where}. Find and fix the duplicates by hand, then run this again.`;
  }

  if (error?.code === INDEX_OPTIONS_CONFLICT || error?.code === INDEX_KEY_SPECS_CONFLICT) {
    return (
      `An index named ${defaultIndexName(key)} already exists on ${where} with different options. ` +
      'Review it, and drop it by hand only after checking nothing depends on it, then run this again.'
    );
  }

  return `Error ${error?.code ?? 'unknown'} on ${where}: ${error?.message ?? String(error)}`;
}

/**
 * Builds whatever is missing, model by model, and reports what it did.
 *
 * One index is built per `createIndexes` call, so a failure names the exact
 * key that failed and the model's other missing indexes are still built. One
 * model failing never stops the next one.
 */
export async function buildIndexes(models = ALL_MODELS) {
  const report = [];

  for (const model of models) {
    const row = {
      model: model.modelName,
      collection: model.collection.collectionName,
      created: [],
      alreadyPresent: 0,
      extra: [],
      error: null,
    };

    try {
      const declared = model.schema.indexes().length;
      const { toCreate, toDrop } = await diffModel(model);
      row.alreadyPresent = declared - toCreate.length;
      row.extra = toDrop;

      const errors = [];
      for (const { key, options } of toCreate) {
        try {
          // createIndexes only ever creates. It is never syncIndexes.
          await model.createIndexes({ toCreate: [[key, options]] });
          row.created.push(options.name ?? defaultIndexName(key));
        } catch (error) {
          errors.push(explainBuildError(error, key));
        }
      }
      if (errors.length > 0) row.error = errors.join(' ');
    } catch (error) {
      row.error = `Error ${error?.code ?? 'unknown'}: ${error?.message ?? String(error)}`;
    }

    report.push(row);
  }

  return report;
}
