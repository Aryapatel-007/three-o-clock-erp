/**
 * The balance checks. M16 and M19. docs/RECONCILIATION-RULES.md.
 *
 * Started in P10 with the checks Day Close needs for one business date: C1,
 * C3, C4, C6, C8 and C9. Completed in P14 with C2, C5, C7, C10, C11 and C12,
 * and the range versions, `runRangeChecks`. Each check is its own function
 * below, returning one result:
 *
 *   { id, severity, passed, message, expected, actual, difference, refs }
 *
 * `refs` lists the bill numbers or record ids behind a failure. Messages use
 * the exact wording in RECONCILIATION-RULES.md with the values filled in.
 *
 * A check never changes data and never throws for a broken rule: it returns a
 * failed result. A check compares whole paise and never rounds first.
 */
import { ACCOUNT_ENTRY_TYPES, AccountEntry, ENTRY_DIRECTIONS } from '../models/AccountEntry.js';
import { Account } from '../models/Account.js';
import { Bill, BILL_STATUSES } from '../models/Bill.js';
import { DAY_STATUSES, DayClosure } from '../models/DayClosure.js';
import { ORDER_LINE_STATUSES, ORDER_STATUSES, Order } from '../models/Order.js';
import { PlatformPayout } from '../models/PlatformPayout.js';
import { paiseToRupees, sumPaise } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { businessDateFor, businessDateRangeToUtc, toIst } from '../utils/time.js';
import { computeDayFigures, numberInSeries, seriesOf } from './dayFiguresService.js';
import { expectedFor } from './payoutService.js';
import { getSetting } from './settingsService.js';

export const SEVERITY = Object.freeze({ ERROR: 'ERROR', WARNING: 'WARNING' });

const rupees = (paise) => paiseToRupees(paise, { symbol: true });
const sum = (list, pick) => sumPaise(0, ...list.map(pick));
const paid = (bill) => sum(bill.payments, (payment) => payment.amountInPaise);

function result(id, severity, { passed, message, expected = null, actual = null, refs = [] }) {
  return {
    id,
    severity,
    passed,
    message,
    expected,
    actual,
    difference: expected === null || actual === null ? null : actual - expected,
    refs,
  };
}

/* ------------------------------------------------------------------------ *
 * One business date
 * ------------------------------------------------------------------------ */

/** C1 Bill arithmetic. Every live bill of the date. */
export function checkC1(bills) {
  const failures = [];
  for (const bill of bills) {
    const net = sum(bill.taxBreakdown, (slab) => slab.taxableInPaise);
    const gst = sum(bill.taxBreakdown, (slab) => slab.taxInPaise);
    const discount = bill.discount?.amountInPaise ?? 0;
    const rules = [
      ['Item total', sum(bill.lines, (line) => line.lineTotalInPaise), bill.subtotalInPaise],
      ['Net sales', bill.subtotalInPaise - discount, net],
      ...bill.taxBreakdown.map((slab) => [
        `GST at ${slab.taxRateBps / 100}%`,
        slab.taxInPaise,
        sumPaise(slab.cgstInPaise, slab.sgstInPaise),
      ]),
      ['GST', gst, bill.totalTaxInPaise],
      ['Bill total', sumPaise(net, gst, bill.roundOffInPaise), bill.grandTotalInPaise],
    ];
    let broken = rules.find(([, expected, actual]) => expected !== actual);
    if (!broken && (bill.roundOffInPaise < -49 || bill.roundOffInPaise > 50)) {
      broken = ['Round-off between -₹0.49 and +₹0.50', 0, bill.roundOffInPaise];
    }
    if (broken) failures.push({ bill, rule: broken[0], expected: broken[1], actual: broken[2] });
  }

  if (failures.length === 0) {
    return result('C1', SEVERITY.ERROR, { passed: true, message: 'C1 Bill arithmetic: every bill adds up.' });
  }
  const [first] = failures;
  return result('C1', SEVERITY.ERROR, {
    passed: false,
    message: `C1 Bill arithmetic: bill ${first.bill.billNumber} does not add up. ${first.rule} expected ${rupees(first.expected)}, found ${rupees(first.actual)}.`,
    expected: first.expected,
    actual: first.actual,
    refs: failures.map((failure) => failure.bill.billNumber),
  });
}

/**
 * C3 Where the money went. Payments on the day's bills, plus what was charged
 * to accounts, plus the unpaid remainder of UNPAID bills, equals the day's bill
 * total. The charge counts wherever it is recorded, so a bill wrongly marked
 * PAID fails C4 and not this.
 */
export function checkC3(businessDate, bills) {
  const billTotal = sum(bills, (bill) => bill.grandTotalInPaise);
  const received = sum(bills, paid);
  const onHold = sum(bills, (bill) => bill.chargedToAccountInPaise ?? 0);
  const unpaid = sum(
    bills.filter((bill) => bill.status === BILL_STATUSES.UNPAID),
    (bill) => bill.grandTotalInPaise - paid(bill),
  );
  const accounted = sumPaise(received, onHold, unpaid);
  const passed = accounted === billTotal;

  return result('C3', SEVERITY.ERROR, {
    passed,
    message: passed
      ? `C3 Money: on ${businessDate}, every rupee of the bill total is accounted for.`
      : `C3 Money: on ${businessDate}, bills total ${rupees(billTotal)} but received plus On Hold plus unpaid is ${rupees(accounted)}. ${rupees(Math.abs(billTotal - accounted))} is unaccounted for.`,
    expected: billTotal,
    actual: accounted,
    refs: passed ? [] : [businessDate],
  });
}

/** C4 Paid means paid. PAID adds up, UNPAID is short, ON_ACCOUNT adds up with its charge. */
export function checkC4(bills) {
  const failures = bills.filter((bill) => {
    const payments = paid(bill);
    if (bill.status === BILL_STATUSES.PAID) return payments !== bill.grandTotalInPaise;
    if (bill.status === BILL_STATUSES.UNPAID) return payments >= bill.grandTotalInPaise;
    if (bill.status === BILL_STATUSES.ON_ACCOUNT) {
      return sumPaise(payments, bill.chargedToAccountInPaise ?? 0) !== bill.grandTotalInPaise;
    }
    return false;
  });

  if (failures.length === 0) {
    return result('C4', SEVERITY.ERROR, { passed: true, message: 'C4 Payment: every bill is settled as its status says.' });
  }
  const [first] = failures;
  return result('C4', SEVERITY.ERROR, {
    passed: false,
    message: `C4 Payment: bill ${first.billNumber} is marked ${first.status} but its payments total ${rupees(paid(first))} against a bill total of ${rupees(first.grandTotalInPaise)}.`,
    expected: first.grandTotalInPaise,
    actual: paid(first),
    refs: failures.map((bill) => bill.billNumber),
  });
}

/**
 * C6 Invoices. Per series, among the numbers issued that day: none missing
 * between the lowest and highest, none repeated, and the lowest follows the
 * highest earlier number in the series when there is one. `earlier` maps a
 * series to its highest sequence before the day's lowest.
 */
export function checkC6(bills, earlierHighest = new Map()) {
  const problems = [];
  const bySeries = new Map();
  for (const bill of bills) bySeries.set(seriesOf(bill), [...(bySeries.get(seriesOf(bill)) ?? []), bill]);

  for (const [series, list] of bySeries) {
    const counts = new Map();
    for (const bill of list) counts.set(bill.billSequence, (counts.get(bill.billSequence) ?? 0) + 1);
    const sequences = [...counts.keys()].sort((a, b) => a - b);
    const low = sequences[0];
    const high = sequences.at(-1);

    const before = earlierHighest.get(series);
    if (before !== undefined && before !== null && before + 1 < low) {
      for (let sequence = before + 1; sequence < low; sequence += 1) {
        problems.push({ text: `number ${numberInSeries(series, sequence)} is missing from series ${series}.`, ref: numberInSeries(series, sequence) });
      }
    }
    for (let sequence = low; sequence <= high; sequence += 1) {
      const count = counts.get(sequence) ?? 0;
      const number = numberInSeries(series, sequence);
      if (count === 0) problems.push({ text: `number ${number} is missing from series ${series}.`, ref: number });
      if (count > 1) problems.push({ text: `number ${number} appears ${count} times.`, ref: number });
    }
  }

  if (problems.length === 0) {
    return result('C6', SEVERITY.ERROR, { passed: true, message: 'C6 Invoices: no number is missing or repeated.' });
  }
  return result('C6', SEVERITY.ERROR, {
    passed: false,
    message: `C6 Invoices: ${problems[0].text}`,
    refs: problems.map((problem) => problem.ref),
  });
}

/** C8 Business date matches the clock. */
export function checkC8(bills, startMinutes) {
  const failures = bills
    .map((bill) => ({ bill, computed: businessDateFor(bill.billedAt, startMinutes) }))
    .filter(({ bill, computed }) => computed !== bill.businessDate);

  if (failures.length === 0) {
    return result('C8', SEVERITY.ERROR, { passed: true, message: 'C8 Date: every bill sits on the business date its clock gives.' });
  }
  const [{ bill, computed }] = failures;
  return result('C8', SEVERITY.ERROR, {
    passed: false,
    message: `C8 Date: bill ${bill.billNumber} was issued at ${toIst(bill.billedAt)} India time, which is business date ${computed}, but it is stored as ${bill.businessDate}.`,
    refs: failures.map((failure) => failure.bill.billNumber),
  });
}

/**
 * C9 Cash drawer. The expected cash must be its own parts added up (ERROR if
 * not, because then the arithmetic is broken), and a count that differs from
 * it is a WARNING. Without a count, only the arithmetic is checked.
 */
export function checkC9(cash, countedCashInPaise = null) {
  // P29 Part F: cash taken out comes off too. A snapshot from before P29 has none.
  const parts = sumPaise(
    cash.openingFloatInPaise,
    cash.cashFromBillsInPaise,
    cash.cashCollectionsInPaise,
    cash.paidInInPaise,
    -cash.paidOutInPaise,
    -(cash.cashTakenOutInPaise ?? 0),
  );
  if (parts !== cash.expectedCashInPaise) {
    return result('C9', SEVERITY.ERROR, {
      passed: false,
      message: `C9 Cash: expected cash is ${rupees(cash.expectedCashInPaise)} but its parts add up to ${rupees(parts)}.`,
      expected: parts,
      actual: cash.expectedCashInPaise,
    });
  }
  if (countedCashInPaise === null || countedCashInPaise === undefined) {
    return result('C9', SEVERITY.WARNING, {
      passed: true,
      message: 'C9 Cash: the drawer has not been counted yet.',
      expected: cash.expectedCashInPaise,
    });
  }
  const difference = countedCashInPaise - cash.expectedCashInPaise;
  return result('C9', SEVERITY.WARNING, {
    passed: difference === 0,
    message:
      difference === 0
        ? `C9 Cash: counted ${rupees(countedCashInPaise)}, exactly as expected.`
        : `C9 Cash: counted ${rupees(countedCashInPaise)}, expected ${rupees(cash.expectedCashInPaise)}. ${rupees(Math.abs(difference))} ${difference < 0 ? 'short' : 'over'}.`,
    expected: cash.expectedCashInPaise,
    actual: countedCashInPaise,
  });
}

/** C2 Line shares. Bills from before P03 have no shares and are skipped. */
export function checkC2(bills) {
  const failures = [];
  for (const bill of bills) {
    if (bill.lines.some((line) => line.discountShareInPaise === null || line.discountShareInPaise === undefined)) continue;
    const rules = [['Discount shares', bill.discount?.amountInPaise ?? 0, sum(bill.lines, (line) => line.discountShareInPaise)]];
    for (const slab of bill.taxBreakdown) {
      const lines = bill.lines.filter((line) => line.taxRateBps === slab.taxRateBps);
      const percent = slab.taxRateBps / 100;
      rules.push([`Line net sales at ${percent}%`, slab.taxableInPaise, sum(lines, (line) => line.taxableInPaise)]);
      rules.push([`Line GST at ${percent}%`, slab.taxInPaise, sum(lines, (line) => line.taxInPaise)]);
    }
    const broken = rules.find(([, expected, actual]) => expected !== actual);
    if (broken) failures.push({ bill, rule: broken[0], expected: broken[1], actual: broken[2] });
  }
  if (failures.length === 0) {
    return result('C2', SEVERITY.ERROR, { passed: true, message: 'C2 Line shares: every bill\'s lines add up to the bill.' });
  }
  const [first] = failures;
  return result('C2', SEVERITY.ERROR, {
    passed: false,
    message: `C2 Line shares: bill ${first.bill.billNumber}, the line shares do not add up to the bill. ${first.rule} expected ${rupees(first.expected)}, found ${rupees(first.actual)}.`,
    expected: first.expected,
    actual: first.actual,
    refs: failures.map((failure) => failure.bill.billNumber),
  });
}

/** The groupings C5 knows, by number. */
export const C5_GROUPINGS = Object.freeze({
  1: 'categories',
  2: 'items',
  3: 'captains',
  4: 'order types',
  5: 'hours',
  6: 'days',
  7: 'tax rates',
  // P65, R20.
  8: 'HSN or SAC codes',
});

/**
 * C5 Groups add up to the whole. A report passes its own grouped rows and the
 * ungrouped total; `field` is the figure being added up.
 */
export function checkC5(number, rows, field, total) {
  const id = `C5.${number}`;
  const grouping = C5_GROUPINGS[number];
  const added = sum(rows, (row) => row[field] ?? 0);
  const passed = added === total;
  return result(id, SEVERITY.ERROR, {
    passed,
    message: passed
      ? `C5 Totals: the ${grouping} totals add up to the whole.`
      : `C5 Totals: the ${grouping} totals add up to ${rupees(added)}, but the whole is ${rupees(total)}. ${rupees(Math.abs(total - added))} is missing from one of the groups.`,
    expected: total,
    actual: added,
  });
}

/**
 * C7 Cancelled never sold. No bill line points at a cancelled order line, and
 * no No Charge order has a live bill.
 */
export function checkC7(bills, orders) {
  const failures = [];
  const ordersById = new Map(orders.map((order) => [String(order._id), order]));
  for (const bill of bills) {
    const order = ordersById.get(String(bill.orderId));
    if (!order) continue;
    if (order.status === ORDER_STATUSES.NO_CHARGE) {
      failures.push({ text: `C7 Cancelled: No Charge order ${order.orderNumber} has bill ${bill.billNumber}.`, ref: bill.billNumber });
    }
    const cancelled = new Map(
      order.lines.filter((line) => line.status === ORDER_LINE_STATUSES.CANCELLED).map((line) => [String(line._id), line]),
    );
    for (const line of bill.lines) {
      const hit = cancelled.get(String(line.orderLineId));
      if (hit) {
        failures.push({
          text: `C7 Cancelled: item ${hit.itemName} on order ${order.orderNumber} was cancelled but appears on bill ${bill.billNumber}.`,
          ref: bill.billNumber,
        });
      }
    }
  }
  if (failures.length === 0) {
    return result('C7', SEVERITY.ERROR, { passed: true, message: 'C7 Cancelled: nothing cancelled was billed.' });
  }
  return result('C7', SEVERITY.ERROR, {
    passed: false,
    message: failures[0].text,
    refs: [...new Set(failures.map((failure) => failure.ref))],
  });
}

const TYPE_SIGN = Object.freeze({
  [ACCOUNT_ENTRY_TYPES.OPENING]: 1,
  [ACCOUNT_ENTRY_TYPES.CHARGE]: 1,
  [ACCOUNT_ENTRY_TYPES.CHARGE_REVERSED]: -1,
  [ACCOUNT_ENTRY_TYPES.COLLECTION]: -1,
});

/**
 * C10 Account balances. The balance by each entry's stored direction must
 * equal the balance by the rules for its type (an ERROR if not), and a
 * negative balance is a WARNING.
 */
export function checkC10(accounts, entries) {
  const errors = [];
  const negative = [];
  for (const account of accounts) {
    const mine = entries.filter((entry) => String(entry.accountId) === String(account._id));
    const outstanding = sum(mine, (entry) => (entry.direction === ENTRY_DIRECTIONS.UP ? entry.amountInPaise : -entry.amountInPaise));
    const computed = sum(mine, (entry) => {
      const sign = TYPE_SIGN[entry.type] ?? (entry.direction === ENTRY_DIRECTIONS.UP ? 1 : -1);
      return sign * entry.amountInPaise;
    });
    if (outstanding !== computed) errors.push({ account, outstanding, computed });
    else if (outstanding < 0) negative.push({ account, outstanding });
  }
  if (errors.length > 0) {
    const [first] = errors;
    return result('C10', SEVERITY.ERROR, {
      passed: false,
      message: `C10 Account: ${first.account.name} shows ${rupees(first.outstanding)} outstanding, but its entries add up to ${rupees(first.computed)}.`,
      expected: first.computed,
      actual: first.outstanding,
      refs: errors.map((error) => String(error.account._id)),
    });
  }
  if (negative.length > 0) {
    const [first] = negative;
    return result('C10', SEVERITY.WARNING, {
      passed: false,
      message: `C10 Account: ${first.account.name} shows ${rupees(first.outstanding)} outstanding: it has paid more than it owes.`,
      actual: first.outstanding,
      refs: negative.map((row) => String(row.account._id)),
    });
  }
  return result('C10', SEVERITY.ERROR, { passed: true, message: 'C10 Account: every account balance adds up.' });
}

/**
 * C11 Platform payouts. For each live payout: received against expected,
 * each payment at its own frozen commission. A difference, or payments with
 * no rate set, is a WARNING for review. `payouts` carry their expectedFor.
 */
export function checkC11(payouts) {
  const flagged = payouts.filter(
    (payout) => payout.amountReceivedInPaise !== payout.expectedInPaise || payout.rateNotSet.length > 0,
  );
  if (flagged.length === 0) {
    return result('C11', SEVERITY.WARNING, { passed: true, message: 'C11 Platform: every payout matches what was expected.' });
  }
  const [first] = flagged;
  const difference = first.amountReceivedInPaise - first.expectedInPaise;
  const notSet = first.rateNotSet.length > 0 ? ` ${first.rateNotSet.length} payment${first.rateNotSet.length === 1 ? '' : 's'} with no commission rate set.` : '';
  return result('C11', SEVERITY.WARNING, {
    passed: false,
    message: `C11 Platform: ${first.methodName} paid ${rupees(first.amountReceivedInPaise)} for ${first.includedPaymentCount} bills against ${rupees(first.expectedInPaise)} expected. Difference ${rupees(difference)}.${notSet}`,
    expected: first.expectedInPaise,
    actual: first.amountReceivedInPaise,
    refs: flagged.map((payout) => String(payout._id)),
  });
}

/**
 * C14 Brought forward. P29 Part F, WARNING. A float brought forward from a
 * closed day is what that day kept for tomorrow. The drawer can change
 * overnight, so a difference is shown, never an error.
 */
export function checkC14(cash, businessDate) {
  const forward = cash?.broughtForward;
  if (!forward || forward.keptInPaise === null || forward.keptInPaise === undefined) {
    return result('C14', SEVERITY.WARNING, { passed: true, message: 'C14 Brought forward: nothing was brought forward.' });
  }
  if (forward.keptInPaise === cash.openingFloatInPaise) {
    return result('C14', SEVERITY.WARNING, {
      passed: true,
      message: `C14 Brought forward: ${businessDate} opened with the ${rupees(forward.keptInPaise)} kept on ${forward.fromDate}.`,
      expected: forward.keptInPaise,
      actual: cash.openingFloatInPaise,
    });
  }
  return result('C14', SEVERITY.WARNING, {
    passed: false,
    message: `C14 Brought forward: ${businessDate} opened with ${rupees(cash.openingFloatInPaise)}, but ${forward.fromDate} kept ${rupees(forward.keptInPaise)}.${forward.note ? ` Note: ${forward.note}` : ''}`,
    expected: forward.keptInPaise,
    actual: cash.openingFloatInPaise,
    refs: [businessDate],
  });
}

/**
 * C13 Revision trail. P29. A revised bill holds one entry per revision,
 * numbered 1 to `revision`, and the last one's total is the bill's.
 */
export function checkC13(bills) {
  const failures = [];
  for (const bill of bills) {
    const revision = bill.revision ?? 0;
    if (revision === 0 && (bill.revisions ?? []).length === 0) continue;
    const entries = bill.revisions ?? [];
    const numbered = entries.length === revision && entries.every((entry, index) => entry.revision === index + 1);
    const last = entries.at(-1);
    if (!numbered || !last || last.newGrandTotalInPaise !== bill.grandTotalInPaise) {
      failures.push({ bill, last });
    }
  }
  if (failures.length === 0) {
    return result('C13', SEVERITY.ERROR, { passed: true, message: 'C13 Revision: every revised bill ends at its own total.' });
  }
  const [{ bill, last }] = failures;
  return result('C13', SEVERITY.ERROR, {
    passed: false,
    message: last
      ? `C13 Revision: bill ${bill.billNumber} is ${rupees(bill.grandTotalInPaise)} but its last revision says ${rupees(last.newGrandTotalInPaise)}.`
      : `C13 Revision: bill ${bill.billNumber} says it was revised ${bill.revision ?? 0} times but holds ${(bill.revisions ?? []).length} revisions.`,
    expected: last?.newGrandTotalInPaise ?? null,
    actual: bill.grandTotalInPaise,
    refs: failures.map(({ bill: row }) => row.billNumber),
  });
}

/** The parts of a snapshot C12 compares: a zero row for an unused method is not a figure. */
function comparable(figures) {
  const copy = structuredClone(figures);
  copy.money.methods = copy.money.methods.filter((row) => row.amountInPaise !== 0 || row.paymentCount !== 0);
  return JSON.stringify(copy);
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * P29. `now` cut down to the keys `stored` holds, object by object. A figure a
 * later prompt adds to computeDayFigures is then compared only for days closed
 * after it existed, so adding one never reads as every earlier day changing.
 * Arrays are compared whole, as before.
 */
export function onStoredKeys(now, stored) {
  if (!isPlainObject(now) || !isPlainObject(stored)) return now;
  return Object.fromEntries(Object.keys(stored).filter((key) => key in now).map((key) => [key, onStoredKeys(now[key], stored[key])]));
}

/** C12 Closed days do not change. `closures` with their fresh figures. */
export function checkC12(comparisons) {
  const changed = comparisons.filter(
    ({ closure, now }) => comparable(closure.snapshot) !== comparable(onStoredKeys(structuredClone(now), closure.snapshot)),
  );
  if (changed.length === 0) {
    return result('C12', SEVERITY.ERROR, { passed: true, message: 'C12 Closed day: every closed day still adds up to its close.' });
  }
  const [{ closure, now }] = changed;
  return result('C12', SEVERITY.ERROR, {
    passed: false,
    message: `C12 Closed day: ${closure.businessDate} was closed at ${toIst(closure.closedAt)} with bill total ${rupees(closure.snapshot.sales.billTotalInPaise)}. The records now add up to ${rupees(now.sales.billTotalInPaise)}.`,
    expected: closure.snapshot.sales.billTotalInPaise,
    actual: now.sales.billTotalInPaise,
    refs: changed.map(({ closure: row }) => row.businessDate),
  });
}

/* ------------------------------------------------------------------------ *
 * Reading what the checks need
 * ------------------------------------------------------------------------ */

function startMinutesOf(req) {
  return getSetting(req.restaurantId, 'business.businessDayStartsAtMinutes', { req });
}

/** Every bill stored on a date in the range or issued during its hours. */
function registerFor(req, from, to, startMinutes, options) {
  const { start, end } = businessDateRangeToUtc(from, to, startMinutes);
  return Bill.find({
    ...scoped(req),
    $or: [{ businessDate: { $gte: from, $lte: to } }, { billedAt: { $gte: start, $lt: end } }],
  })
    .setOptions(options)
    .lean();
}

/** The highest earlier sequence of each series in the register, for C6. */
async function earlierHighestFor(req, register, options) {
  const earlierHighest = new Map();
  const lowest = new Map();
  for (const bill of register) {
    const series = seriesOf(bill);
    lowest.set(series, Math.min(lowest.get(series) ?? Infinity, bill.billSequence));
  }
  for (const [series, low] of lowest) {
    const isFinancialYear = register.some((bill) => seriesOf(bill) === series && !bill.invoiceSeries);
    const seriesFilter = isFinancialYear
      ? { $or: [{ invoiceSeries: series }, { invoiceSeries: null, financialYear: series }] }
      : { invoiceSeries: series };
    const [previous] = await Bill.find({ ...scoped(req), ...seriesFilter, billSequence: { $lt: low } })
      .sort({ billSequence: -1 })
      .limit(1)
      .select('billSequence')
      .setOptions(options)
      .lean();
    if (previous) earlierHighest.set(series, previous.billSequence);
  }
  return earlierHighest;
}

/** The orders behind a set of bills, for C7. */
function ordersFor(req, bills, options) {
  const ids = [...new Set(bills.map((bill) => String(bill.orderId)))];
  if (ids.length === 0) return Promise.resolve([]);
  return Order.find({ ...scoped(req), _id: { $in: ids } }).select('orderNumber status lines').setOptions(options).lean();
}

async function accountsCheck(req, options) {
  const [accounts, entries] = await Promise.all([
    Account.find({ ...scoped(req) }).select('name').setOptions(options).lean(),
    AccountEntry.find({ ...scoped(req) }).select('accountId type direction amountInPaise').setOptions(options).lean(),
  ]);
  return checkC10(accounts, entries);
}

async function payoutsCheck(req, from, to, options) {
  const payouts = await PlatformPayout.find({ ...scoped(req), isVoided: false, periodFrom: { $lte: to }, periodTo: { $gte: from } })
    .setOptions(options)
    .lean();
  const withExpected = [];
  for (const payout of payouts) withExpected.push({ ...payout, ...(await expectedFor(req, payout)) });
  return checkC11(withExpected);
}

async function closedDaysCheck(req, from, to, options) {
  const closures = await DayClosure.find({ ...scoped(req), status: DAY_STATUSES.CLOSED, businessDate: { $gte: from, $lte: to } })
    .setOptions(options)
    .lean();
  const comparisons = [];
  for (const closure of closures) {
    comparisons.push({ closure, now: await computeDayFigures(req, closure.businessDate, options) });
  }
  return checkC12(comparisons);
}

/** The business dates from `from` to `to`, inclusive. */
export function datesBetween(from, to) {
  const dates = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** C3 over a range: every day checked, one result listing every failing day. */
function checkC3Range(from, to, liveBills) {
  const failing = [];
  let first = null;
  for (const date of datesBetween(from, to)) {
    const day = checkC3(date, liveBills.filter((bill) => bill.businessDate === date));
    if (!day.passed) {
      failing.push(date);
      first ??= day;
    }
  }
  if (!first) {
    return result('C3', SEVERITY.ERROR, { passed: true, message: `C3 Money: every day from ${from} to ${to} is accounted for.` });
  }
  return { ...first, refs: failing };
}

/**
 * Runs the named checks over a range, for a report. `ids` names them: C1, C2,
 * C3, C4, C6, C7, C8, C10, C11, C12. C5 and C9 need a report's own figures and
 * are run by the report itself.
 */
export async function runRangeChecks(req, { from, to }, ids, { session = null } = {}) {
  const options = session ? { session } : {};
  const startMinutes = await startMinutesOf(req);
  const register = await registerFor(req, from, to, startMinutes, options);
  const inRange = register.filter((bill) => bill.businessDate >= from && bill.businessDate <= to);
  const live = inRange.filter((bill) => !bill.isVoided);

  const results = [];
  for (const id of ids) {
    if (id === 'C1') results.push(checkC1(live));
    else if (id === 'C2') results.push(checkC2(live));
    else if (id === 'C3') results.push(checkC3Range(from, to, live));
    else if (id === 'C4') results.push(checkC4(live));
    else if (id === 'C6') results.push(checkC6(register, await earlierHighestFor(req, register, options)));
    else if (id === 'C7') results.push(checkC7(live, await ordersFor(req, live, options)));
    else if (id === 'C8') results.push(checkC8(register, startMinutes));
    else if (id === 'C10') results.push(await accountsCheck(req, options));
    else if (id === 'C11') results.push(await payoutsCheck(req, from, to, options));
    else if (id === 'C12') results.push(await closedDaysCheck(req, from, to, options));
    else if (id === 'C13') results.push(checkC13(live));
    else throw new Error(`runRangeChecks does not run ${id}; a report runs it with its own figures.`);
  }
  return results;
}

/**
 * Every one-day check for `businessDate`, given its figures. C6 and C8 also
 * look at bills whose clock falls in the day, so a bill stored on the wrong
 * date is caught by C8 alone rather than also opening a gap in C6.
 */
export async function runDayChecks(req, businessDate, figures, { countedCashInPaise = null, session = null } = {}) {
  const ranged = await runRangeChecks(req, { from: businessDate, to: businessDate }, ['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'C8', 'C10', 'C11', 'C13'], { session });
  const byId = Object.fromEntries(ranged.map((check) => [check.id, check]));
  return [
    byId.C1,
    byId.C2,
    byId.C3,
    byId.C4,
    checkC5(4, figures.orderTypes, 'billTotalInPaise', figures.sales.billTotalInPaise),
    checkC5(7, figures.gst, 'netSalesInPaise', figures.sales.netSalesInPaise),
    byId.C6,
    byId.C7,
    byId.C8,
    checkC9(figures.cash, countedCashInPaise),
    byId.C10,
    byId.C11,
    // P29.
    byId.C13,
    checkC14(figures.cash, businessDate),
    // P25 Part E. A warning while money is owed back to guests; never a blocker.
    ...(figures.refunds?.owedInPaise > 0 ? [checkRefundsOwed(figures.refunds)] : []),
  ];
}

/** P25 Part E. Card, UPI or platform money still to hand back after an item was cancelled on a paid bill. */
export function checkRefundsOwed(refunds) {
  return result('REFUNDS', SEVERITY.WARNING, {
    passed: false,
    message: `${rupees(refunds.owedInPaise)} is owed back to guests on card or UPI.`,
    actual: refunds.owedInPaise,
    refs: refunds.owed.map((row) => row.billNumber).filter(Boolean),
  });
}

export default {
  checkC1,
  checkC2,
  checkC3,
  checkC4,
  checkC5,
  checkC6,
  checkC7,
  checkC8,
  checkC9,
  checkC10,
  checkC11,
  checkC12,
  checkC13,
  checkC14,
  datesBetween,
  runDayChecks,
  runRangeChecks,
  SEVERITY,
};
