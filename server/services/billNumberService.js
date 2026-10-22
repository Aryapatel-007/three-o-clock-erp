/**
 * Bill numbers. Sequential per restaurant, branch and financial year, and
 * never reused.
 *
 * This exists as its own file rather than as another function in
 * counterService.js because the two have opposite guarantees, and putting them
 * side by side is how somebody eventually calls the wrong one.
 *
 * counterService.nextNumber reserves a number and lets the caller write the
 * document afterwards. If that write fails the number is spent and the sequence
 * has a hole. models/Counter.js says in as many words that this is fine for an
 * order or a kitchen ticket and not fine for a bill.
 *
 * So this reserves the number INSIDE the caller's transaction. Both the counter
 * increment and the bill insert commit together or neither does, and an aborted
 * insert rolls the counter back with it. That is the whole gap-free guarantee
 * and it is the reason a session is a required argument rather than an option.
 */
import { Counter, COUNTER_NAMES } from '../models/Counter.js';
import { INVOICE_MODES } from '../models/Restaurant.js';
import { TransactionRequiredError } from '../utils/errors.js';
import { financialYearFor } from '../utils/time.js';
import { prefixCounterScope } from './settingsService.js';

/** 2026-27/000148. Zero-padded so numbers sort as strings and read as a series. */
const SEQUENCE_PAD = 6;

export function formatBillNumber(financialYear, sequence) {
  return `${financialYear}/${String(sequence).padStart(SEQUENCE_PAD, '0')}`;
}

/**
 * CFA/C/22442. P02. Not padded: the series continues an existing printed run,
 * and padding it would change how every number looks on the day of cutover.
 */
export function formatPrefixBillNumber(prefix, sequence) {
  return `${prefix}${sequence}`;
}

/**
 * Reserves the next bill number, inside the given transaction.
 *
 * `session` is required and must be a real transaction session. Passing null
 * throws rather than quietly falling back, because a bill number allocated
 * outside a transaction carries none of the guarantee this function exists to
 * provide, and a silent fallback in development is how the gappy version
 * reaches production.
 *
 * Returns `{ billNumber, financialYear, billSequence }`.
 */
export async function reserveBillNumber({ restaurantId, branchId, at, invoice = null }, session) {
  if (!restaurantId || !branchId) {
    throw new Error('reserveBillNumber() needs a restaurantId and a branchId.');
  }
  if (!session) {
    throw new TransactionRequiredError();
  }

  const financialYear = financialYearFor(at);

  // 2026-10-22, Arya: the website bills in the same series as the cafe PC, and only while the PC is off.

  if (invoice?.mode === INVOICE_MODES.PREFIX) {
    return reservePrefixNumber({ restaurantId, branchId, financialYear, invoice }, session);
  }

  const counter = await Counter.findOneAndUpdate(
    { restaurantId, branchId, name: COUNTER_NAMES.BILL, scope: financialYear },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session },
  );

  return {
    billNumber: formatBillNumber(financialYear, counter.value),
    financialYear,
    billSequence: counter.value,
    invoiceSeries: financialYear,
  };
}

/**
 * PREFIX mode. P02.
 *
 * The counter is scoped to the prefix, not the financial year, so it never
 * resets. A brand-new series is created at `startingNumber - 1` by
 * $setOnInsert, then the same atomic $inc as the financial-year path hands out
 * `startingNumber` itself. Both writes are inside the bill's transaction, so a
 * failed insert rolls the series back with it, including its creation.
 *
 * Two steps rather than one upsert with both operators, because $setOnInsert
 * and $inc cannot both write `value` in one update. The filter names every
 * field of the unique index, so two transactions racing to create the series
 * collide on it and `withTransaction` retries the loser.
 */
async function reservePrefixNumber({ restaurantId, branchId, financialYear, invoice }, session) {
  const { prefix, startingNumber } = invoice;
  if (!prefix || !Number.isInteger(startingNumber) || startingNumber < 1) {
    throw new Error('A PREFIX invoice series needs a prefix and a whole starting number.');
  }

  const filter = {
    restaurantId,
    branchId,
    name: COUNTER_NAMES.BILL,
    scope: prefixCounterScope(prefix),
  };

  await Counter.updateOne(
    filter,
    { $setOnInsert: { value: startingNumber - 1 } },
    { upsert: true, session },
  );

  const counter = await Counter.findOneAndUpdate(
    filter,
    { $inc: { value: 1 } },
    { new: true, session },
  );

  return {
    billNumber: formatPrefixBillNumber(prefix, counter.value),
    financialYear,
    billSequence: counter.value,
    invoiceSeries: prefix,
  };
}

/**
 * P63. The website's own series while the cafe PC and the website both bill:
 * `2026-27/W00001`, or the prefix plus W (`ZC/W1`). Gap-free in the same
 * transaction as every bill. Its `billSequence` is WEBSITE_SEQUENCE_BASE plus
 * the number, so the unique index on { financialYear, billSequence } holds with
 * the PC's series beside it and no index changes.
 */
export const WEBSITE_SEQUENCE_BASE = 900_000_000;
const WEBSITE_PAD = 5;
const FINANCIAL_YEAR_WEBSITE_SERIES = /^\d{4}-\d{2}\/W$/;

export function websiteSeriesFor(financialYear, invoice) {
  return invoice?.mode === INVOICE_MODES.PREFIX && invoice.prefix ? `${invoice.prefix}W` : `${financialYear}/W`;
}

/** A website series and a sequence as the printed number. */
export function formatWebsiteBillNumber(series, sequence) {
  const number = sequence - WEBSITE_SEQUENCE_BASE;
  return FINANCIAL_YEAR_WEBSITE_SERIES.test(series)
    ? `${series}${String(number).padStart(WEBSITE_PAD, '0')}`
    : `${series}${number}`;
}

export default { formatBillNumber, formatPrefixBillNumber, formatWebsiteBillNumber, reserveBillNumber };
