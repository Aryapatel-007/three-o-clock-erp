/**
 * Handing out sequential numbers.
 *
 * One function, one operation, and the operation is the whole point: a single
 * atomic findOneAndUpdate. Never a read followed by a write.
 *
 * Read-then-write looks like this, and it is wrong:
 *
 *   const counter = await Counter.findOne({ ... });   // both waiters read 42
 *   counter.value += 1;                               // both compute 43
 *   await counter.save();                             // both write 43
 *
 * Two waiters pressing send in the same millisecond on a Friday both get order
 * number 43, and the unique index on orderNumber then rejects one of their
 * orders for a reason neither of them can act on. $inc does the read, the add
 * and the write inside the database, where nothing can interleave.
 */
import { Counter } from '../models/Counter.js';

/**
 * Reserves and returns the next number in a sequence.
 *
 * `upsert: true` means the counter creates itself the first time a restaurant
 * fires an order. There is no seeding step and provisioning does not know this
 * collection exists.
 *
 * The filter carries restaurantId, so the tenant guard is satisfied the
 * ordinary way. No escape hatch here, or anywhere else in M2.
 *
 * Deliberately NOT run inside the caller's transaction, even when there is one.
 * The number is reserved before the document that will carry it is written, so
 * a failed write leaves a gap rather than reusing a number. Gaps are acceptable
 * for orders and kitchen tickets and the reasoning is written out in full in
 * models/Counter.js. Bill numbers in M3 are a different problem.
 */
export async function nextNumber({ restaurantId, branchId, name }) {
  if (!restaurantId || !branchId) {
    throw new Error('nextNumber() needs a restaurantId and a branchId.');
  }
  if (!name) {
    throw new Error('nextNumber() needs the name of a sequence.');
  }

  /**
   * `scope: null` is in the filter deliberately, and removing it breaks this
   * function under concurrency.
   *
   * The unique index is { restaurantId, branchId, name, scope }. When two
   * callers race an upsert and neither finds a document, both attempt an
   * insert and one hits a duplicate key. MongoDB can retry that as an update
   * only when the query covers every field of the unique index; if `scope` is
   * missing from the filter it cannot, and the duplicate key surfaces to the
   * caller instead.
   *
   * M3 added `scope` to carry a bill sequence's financial year. ORDER and KOT
   * do not reset, so their scope is null, but it still has to be named here.
   */
  // 2026-10-22, Arya: the website numbers orders and tickets in the same run as the cafe PC.

  const counter = await Counter.findOneAndUpdate(
    { restaurantId, branchId, name, scope: null },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return counter.value;
}

/**
 * P63. While the cafe PC and the website both write, the website draws from
 * its own run, 900001 on, so an order or ticket number made on each side can
 * never be the same one. Created at 900000 by $setOnInsert, then the same
 * atomic $inc, both filters naming every field of the unique index (see above).
 */
export const WEBSITE_NUMBER_SCOPE = 'W';
export const WEBSITE_NUMBER_START = 900_000;

export default { nextNumber };
