/**
 * The tenant guard.
 *
 * Tenant isolation is the whole product. If restaurant A can ever see
 * restaurant B data, there is no business here. This plugin exists so that the
 * failure mode of forgetting a tenant filter is a loud crash instead of a
 * silent leak.
 *
 * It attaches a pre hook to every read and write query on the model. Each hook
 * looks at the filter that is about to reach the database. If there is no
 * restaurantId in it, the query throws before the driver is called.
 *
 * Apply it to every model, immediately after the base schema plugin:
 *
 *   schema.plugin(baseSchemaPlugin);
 *   schema.plugin(tenantGuardPlugin);
 *
 * Document writes are covered by a different mechanism: restaurantId is
 * `required: true` in the base schema, so save() and insertMany() cannot
 * create a record without one.
 */
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { TenantFilterMissingError } from '../../utils/errors.js';
import { writerGuardPlugin } from './writerGuard.js';

/** Every query operation that reaches the database with a filter. */
export const GUARDED_QUERY_OPERATIONS = Object.freeze([
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'countDocuments',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
]);

/**
 * Does this filter restrict the query to one restaurant?
 *
 * A plain restaurantId key counts. So does an $and where any branch has one,
 * and an $or where every branch has one, because a single unscoped branch of
 * an $or widens the whole query.
 *
 * $nor deliberately does not count. `$nor: [{ restaurantId: A }]` means
 * "every restaurant except A", which is the exact leak this guard exists to
 * stop, and it mentions restaurantId while doing it.
 */
export function hasRestaurantIdFilter(filter) {
  if (filter === null || typeof filter !== 'object') return false;

  if (Object.prototype.hasOwnProperty.call(filter, 'restaurantId') && filter.restaurantId !== undefined) {
    return true;
  }

  if (Array.isArray(filter.$and) && filter.$and.some(hasRestaurantIdFilter)) return true;

  if (Array.isArray(filter.$or) && filter.$or.length > 0 && filter.$or.every(hasRestaurantIdFilter)) {
    return true;
  }

  return false;
}

/**
 * Best effort model name, used in the error message and the log line.
 *
 * A Query carries the Model itself on `this.model`. An Aggregate carries a
 * `model()` accessor instead. Handle both, and never let a naming problem
 * swallow the violation it is describing.
 */
function modelNameOf(context) {
  try {
    const candidate = context?.model;

    if (typeof candidate?.modelName === 'string') return candidate.modelName;
    if (typeof candidate === 'function') {
      const resolved = candidate.call(context);
      if (typeof resolved?.modelName === 'string') return resolved.modelName;
    }
    if (typeof context?._model?.modelName === 'string') return context._model.modelName;
  } catch {
    // Fall through to the placeholder below.
  }
  return 'UnknownModel';
}

function raiseViolation(modelName, operation) {
  const error = new TenantFilterMissingError(modelName, operation);

  if (config.isProduction) {
    // Fatal, with the stack, then throw anyway. Do not soften this in
    // production. A crash is recoverable. A cross-restaurant leak is not.
    logger.fatal(
      { model: modelName, operation, stack: error.stack, err: error },
      'Tenant filter missing. Query blocked before it reached the database.',
    );
  }

  throw error;
}

/**
 * Reads and clears the escape hatch flag.
 *
 * The flag is removed from the options object so it never travels on to the
 * MongoDB driver as an unrecognised option.
 */
function takeSkipFlag(options) {
  if (!options || options.skipTenantGuard !== true) return false;
  delete options.skipTenantGuard;
  return true;
}

export function tenantGuardPlugin(schema) {
  for (const operation of GUARDED_QUERY_OPERATIONS) {
    // Explicit options because deleteOne and updateOne exist as both document
    // and query middleware. We want the query form, every time.
    schema.pre(operation, { query: true, document: false }, function guardQuery() {
      if (takeSkipFlag(this.getOptions())) return;
      if (hasRestaurantIdFilter(this.getFilter())) return;
      raiseViolation(modelNameOf(this), operation);
    });
  }

  schema.pre('aggregate', function guardAggregate() {
    if (takeSkipFlag(this.options)) return;

    // The tenant filter has to be the first stage. A $match after a $lookup or
    // a $group has already read across every restaurant to build the result.
    const [firstStage] = this.pipeline();
    if (firstStage?.$match && hasRestaurantIdFilter(firstStage.$match)) return;

    raiseViolation(modelNameOf(this), 'aggregate');
  });

  // P62. Every tenant model also refuses a write while this machine is not the
  // writer. One line here rather than one in each of forty model files, so a
  // new model cannot forget it. models/plugins/writerGuard.js says why.
  schema.plugin(writerGuardPlugin);
}

export default tenantGuardPlugin;

/* ------------------------------------------------------------------------- *
 * THE ESCAPE HATCH
 *
 *   // Nightly job: rebuild the plan tier cache for every restaurant.
 *   const all = await Restaurant.find({}).setOptions({ skipTenantGuard: true });
 *
 * For aggregate, use .option({ skipTenantGuard: true }).
 *
 * Rules:
 *
 *   It is for genuinely global operations only. Migrations, scheduled jobs,
 *   platform level admin. Never for a request handler. A request always knows
 *   which restaurant it belongs to, because the token says so.
 *
 *   Every use gets a comment on the line above saying why.
 *
 * This is deliberately the only way through, and it is deliberately easy to
 * find:
 *
 *   grep -rn "skipTenantGuard" server/
 *
 * That is the whole security audit for tenant isolation. Five seconds. Every
 * hit should have a comment above it, and every comment should convince you.
 * ------------------------------------------------------------------------- */
