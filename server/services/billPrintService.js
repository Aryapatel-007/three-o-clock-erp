/**
 * Printing a bill at the counter. P25 Part D, API-CONTRACT M3 section 16.3.
 *
 * A captain's phone usually has no printer, so the captain asks, and the
 * counter computer prints. The queue is a read of `bills`, not a collection of
 * its own: a bill is in it while its latest request is newer than its latest
 * print, so it can never be in it twice, and asking again after a print puts
 * it back.
 */
import { currentRole, ROLES } from '../config/deployment.js';
import { Bill } from '../models/Bill.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../models/ReplicationState.js';
import { User } from '../models/User.js';
import { isTwoWay } from './sync/mode.js';
import { BusinessRuleError, DuplicateError } from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { readBill } from './billService.js';
import { isDuplicatePrint } from './receiptService.js';

const QUEUE_LIMIT = 50;

/** A request is waiting while the bill has not been printed since it was made. */
function isWaiting(bill) {
  return Boolean(bill.printRequestedAt) && (!bill.lastPrintedAt || bill.lastPrintedAt < bill.printRequestedAt);
}

/**
 * POST /bills/:billId/print-request. Every role that can read the bill.
 * P59. A second tap while the first request waits changes nothing: a new
 * request time would read as a second request at the counter.
 */
export async function requestPrint(req, billId) {
  const bill = await readBill(req, billId);
  if (bill.isVoided) throw new BusinessRuleError('This bill is voided, so it cannot be printed at the counter.');
  if (isWaiting(bill)) return bill;
  bill.printRequestedAt = nowUtc();
  bill.printRequestedBy = req.user.id;
  await bill.save();
  return bill;
}

/** How recently the cafe PC must have synced for the website to leave captains' bills to it. */
const PC_PRINTS_WHILE_SEEN_MS = 2 * 60_000;

/**
 * 2026-10-22. With two-way sync a captain's print request reaches both the cafe
 * PC and the website, and each claims it on its own database, so a website
 * counter printed it too, with its own paper settings (blank paper above the
 * bill at Z Chaat). While the PC is in touch, the website's queue is empty: the
 * PC prints. When the PC is away, the website prints, as the fallback.
 */
async function pcPrintsHere(req) {
  if (!isTwoWay() || currentRole() !== ROLES.CLOUD) return false;
  const seen = await ReplicationState.findById(REPLICATION_STATE_IDS.boxSeen(req.restaurantId)).lean();
  return Boolean(seen?.seenAt) && nowUtc() - new Date(seen.seenAt) < PC_PRINTS_WHILE_SEEN_MS;
}

/** GET /bills/print-queue. The bills waiting for the counter, oldest request first. */
export async function printQueue(req) {
  if (await pcPrintsHere(req)) return [];
  const bills = await Bill.find({
    ...scoped(req),
    isVoided: false,
    printRequestedAt: { $type: 'date' },
    $expr: { $or: [{ $eq: ['$lastPrintedAt', null] }, { $gt: ['$printRequestedAt', '$lastPrintedAt'] }] },
  })
    .select('billNumber tableName printRequestedAt printRequestedBy printCount')
    .sort({ printRequestedAt: 1 })
    .limit(QUEUE_LIMIT)
    .lean();

  const askers = await User.find({ restaurantId: req.restaurantId, _id: { $in: bills.map((bill) => bill.printRequestedBy) } })
    .select('name')
    .lean();
  const names = new Map(askers.map((user) => [String(user._id), user.name]));

  return bills.map((bill) => ({
    id: String(bill._id),
    billNumber: bill.billNumber,
    tableName: bill.tableName ?? null,
    printRequestedAt: bill.printRequestedAt,
    printRequestedByName: names.get(String(bill.printRequestedBy)) ?? null,
    printCount: bill.printCount ?? 0,
  }));
}

/**
 * POST /bills/:billId/printed. Every print, from any device, records itself
 * here. P29: it also records which revision was printed, so the first print
 * after a revision is not a duplicate and a second print with no change is.
 *
 * P59. With `forRequestAt`, a counter device claims a captain's request before
 * printing it. The write matches only while that request is the one waiting,
 * so of two devices (or two Chrome profiles) reading the same queue, exactly
 * one gets 200 and prints; the other gets 409 and prints nothing.
 */
export async function markPrinted(req, billId, { forRequestAt } = {}) {
  const bill = await readBill(req, billId);
  const wasDuplicate = isDuplicatePrint(bill);
  const revision = bill.revision ?? 0;
  const claim = forRequestAt
    ? {
        printRequestedAt: forRequestAt,
        $or: [{ lastPrintedAt: null }, { lastPrintedAt: { $lt: forRequestAt } }],
      }
    : {};
  const updated = await Bill.findOneAndUpdate(
    { ...scoped(req), _id: billId, ...claim },
    { $inc: { printCount: 1 }, $set: { lastPrintedAt: nowUtc(), lastPrintedRevision: revision } },
    { new: true },
  ).select('printCount');
  if (!updated) throw new DuplicateError('Another device has printed this bill.');
  return { printCount: updated.printCount, isDuplicate: wasDuplicate, revision };
}

export default { markPrinted, printQueue, requestPrint };
