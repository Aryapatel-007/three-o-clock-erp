/**
 * One series, made safe (2026-10-25). API-CONTRACT "P63" section 2,
 * docs/REPLICATION.md section 13.
 *
 * Since 2026-10-22 the website numbers bills, orders, KOTs, online orders and
 * bookings from the same counters as the cafe PC. While the two are apart both
 * can hand out the same number. When they meet:
 *
 *   counters      a counter changed on both keeps the higher value, so neither
 *                 side ever hands a number out again (`counterValue`)
 *   a clash       the PC's record keeps the number; the website's takes the next
 *                 free one in the same series, and its copies follow
 *                 (`renumber`, `updateCopies`)
 *   copies        a KOT, bill, account entry, refund or card machine payment
 *                 that arrives carrying its order's or bill's old number takes
 *                 the number its order or bill has here (`alignCopies`)
 *
 * Works on the driver's collections, as the rest of the sync does.
 */
import { formatBillNumber, formatPrefixBillNumber } from '../billNumberService.js';
import { prefixCounterScope } from '../settingsService.js';
import { nowUtc } from '../../utils/time.js';

/** Per collection: the numbered field, its counter, and how a number is written. */
const NUMBERED = Object.freeze({
  orders: { field: 'orderNumber', keys: ['orderNumber'], counter: 'ORDER' },
  kots: { field: 'kotNumber', keys: ['kotNumber'], counter: 'KOT' },
  onlineorders: { field: 'reference', keys: ['reference'], counter: 'ONLINE_ORDER', prefix: 'W' },
  reservations: { field: 'reference', keys: ['reference'], counter: 'RESERVATION', prefix: 'R' },
  bills: { field: 'billNumber', keys: ['billNumber', 'billSequence'], counter: 'BILL' },
});

/** Bills before 2026-10-22 in the website's own series, `2026-27/W` or a prefix plus W. */
const OLD_WEBSITE_SERIES = /W$/;

/** True when a duplicate key error is about the number, not a table, a name or a live bill. */
export function isNumberClash(coll, error) {
  const rule = NUMBERED[coll];
  if (!rule) return false;
  const keys = Object.keys(error?.keyPattern ?? {});
  return rule.keys.some((key) => keys.includes(key));
}

/** The number a document holds, as a whole number. */
function numberOf(coll, doc) {
  const rule = NUMBERED[coll];
  if (coll === 'bills') return doc.billSequence ?? 0;
  const value = doc[rule.field];
  if (rule.prefix) return Number(String(value ?? '').split('-')[1]) || 0;
  return Number(value) || 0;
}

/** A counter changed on both sides keeps the higher value. */
export function counterValue(local, written) {
  if (!local || !written) return written;
  const value = Math.max(Number(local.value) || 0, Number(written.value) || 0);
  return value === written.value ? written : { ...written, value };
}

/** Which counter a bill's number came from, and how its numbers are written. */
function billSeries(doc) {
  const series = doc.invoiceSeries ?? doc.financialYear;
  if (!series || OLD_WEBSITE_SERIES.test(series)) return null;
  if (series === doc.financialYear) {
    return { scope: doc.financialYear, format: (sequence) => formatBillNumber(doc.financialYear, sequence) };
  }
  return { scope: prefixCounterScope(series), format: (sequence) => formatPrefixBillNumber(series, sequence) };
}

/** The highest number already used here, so the next one is free whatever the counter says. */
async function highestHere(db, coll, doc) {
  const rule = NUMBERED[coll];
  if (coll === 'bills') {
    const top = await db.collection('bills')
      .find({ restaurantId: doc.restaurantId, branchId: doc.branchId, financialYear: doc.financialYear })
      .sort({ billSequence: -1 }).limit(1).project({ billSequence: 1 }).next();
    return top?.billSequence ?? 0;
  }
  if (rule.prefix) return 0; // A reference sorts as text; the counter and the retry cover it.
  const top = await db.collection(coll)
    .find({ restaurantId: doc.restaurantId })
    .sort({ [rule.field]: -1 }).limit(1).project({ [rule.field]: 1 }).next();
  return Number(top?.[rule.field]) || 0;
}

/**
 * The website's record with the next free number in its series. The counter is
 * first raised past every number seen here, then moved on by one, so the new
 * number is free on this side, and the counter's change goes over to the other.
 * Gives back null for a series this cannot continue (an old W bill).
 */
export async function renumber(db, coll, doc) {
  const rule = NUMBERED[coll];
  if (!rule) return null;
  let scope = null;
  let write = (number) => ({ [rule.field]: rule.prefix ? `${rule.prefix}-${number}` : number });
  if (coll === 'bills') {
    const series = billSeries(doc);
    if (!series) return null;
    scope = series.scope;
    write = (sequence) => ({ billNumber: series.format(sequence), billSequence: sequence });
  }

  const counters = db.collection('counters');
  const filter = { restaurantId: doc.restaurantId, branchId: doc.branchId, name: rule.counter, scope };
  const at = nowUtc();
  const floor = Math.max(numberOf(coll, doc), await highestHere(db, coll, doc));
  await counters.updateOne(
    filter,
    { $max: { value: floor }, $setOnInsert: { createdAt: at } },
    { upsert: true },
  );
  const counter = await counters.findOneAndUpdate(
    filter,
    { $inc: { value: 1 }, $set: { updatedAt: at } },
    { returnDocument: 'after' },
  );
  return { ...doc, ...write(counter.value), updatedAt: at };
}

/** Where each number is copied, by the id of the record it belongs to. */
const COPIES = Object.freeze({
  orders: [{ coll: 'kots', link: 'orderId', field: 'orderNumber' }, { coll: 'bills', link: 'orderId', field: 'orderNumber' }],
  bills: [
    { coll: 'accountentries', link: 'billId', field: 'billNumber' },
    { coll: 'refunds', link: 'billId', field: 'billNumber' },
    { coll: 'terminaltransactions', link: 'billId', field: 'billNumber' },
  ],
});

/** After a renumber here: the copies of the old number on this side take the new one. */
export async function updateCopies(db, coll, doc) {
  const field = NUMBERED[coll]?.field;
  for (const copy of COPIES[coll] ?? []) {
    await db.collection(copy.coll).updateMany(
      { restaurantId: doc.restaurantId, [copy.link]: doc._id, [copy.field]: { $ne: doc[field] } },
      { $set: { [copy.field]: doc[field], updatedAt: nowUtc() } },
    );
  }
}

/** For an incoming copy: which record it copies its number from. */
const COPY_OF = Object.freeze({
  kots: [{ parent: 'orders', link: 'orderId', field: 'orderNumber' }],
  bills: [{ parent: 'orders', link: 'orderId', field: 'orderNumber' }],
  accountentries: [{ parent: 'bills', link: 'billId', field: 'billNumber' }],
  refunds: [{ parent: 'bills', link: 'billId', field: 'billNumber' }],
  terminaltransactions: [{ parent: 'bills', link: 'billId', field: 'billNumber' }],
});

/**
 * An incoming KOT, bill or bill copy carries the number its order or bill has
 * here. A number is never changed otherwise, so this only ever corrects a copy
 * made before a renumber.
 */
export async function alignCopies(db, coll, doc) {
  let result = doc;
  for (const copy of COPY_OF[coll] ?? []) {
    const id = result?.[copy.link];
    if (!id || result[copy.field] === undefined || result[copy.field] === null) continue;
    const parent = await db.collection(copy.parent).findOne({ _id: id }, { projection: { [copy.field]: 1 } });
    if (parent && parent[copy.field] !== undefined && parent[copy.field] !== result[copy.field]) {
      result = { ...result, [copy.field]: parent[copy.field] };
    }
  }
  return result;
}

/** The words for a person, naming the old and the new number. */
export function renumberDetail(coll, before, after) {
  const field = NUMBERED[coll]?.field;
  const from = before?.[field];
  const to = after?.[field];
  if (coll === 'bills') {
    return `Bill number ${from} was used on the cafe PC and on the website while they were apart. The PC's bill keeps ${from}; the website's bill is now ${to}. Reprint the website's bill and give the guest the new copy.`;
  }
  const what = { orders: 'Order', kots: 'KOT', onlineorders: 'Online order', reservations: 'Booking' }[coll] ?? 'Number';
  return `${what} ${from} was used on the cafe PC and on the website while they were apart. The PC's keeps ${from}; the website's is now ${to}.`;
}
