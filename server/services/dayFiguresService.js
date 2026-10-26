/**
 * The figures for one business day. M16, built in P10.
 * docs/API-CONTRACT.md "M16" section 4, docs/REPORT-SPEC.md R2.
 *
 * computeDayFigures is the only place day-level figures are worked out. Day
 * Close stores its output as the snapshot and R2 returns it, so the printed
 * close and the report can never disagree.
 *
 * Rules, all of them load-bearing:
 * 1. Frozen fields only. A figure never comes from the live menu, a category,
 *    a user or a payment method's current settings. The payment methods are
 *    read only so that a method nobody used still shows as a zero row.
 * 2. Whole paise, added through sumPaise. Averages are a total divided by a
 *    total, through averagePaise, after totalling.
 * 3. Voided bills are out of every sales and money figure. They appear only in
 *    the controls section and the invoice register.
 * 4. "Cash" is a payment or collection whose frozen method code is CASH and
 *    whose frozen kind is IN_HAND, or null on a record from before P08.
 *
 * The data is read once into memory: a day is a few hundred bills at most, and
 * adding them up in one place in plain code is easier to check than a dozen
 * aggregation pipelines.
 */
import { BILL_VOID_REASONS, ORDER_OPENED_BY_MISTAKE, reasonText } from '../config/cancelReasons.js';
import { Account } from '../models/Account.js';
import { ACCOUNT_ENTRY_TYPES, AccountEntry } from '../models/AccountEntry.js';
import { Bill, BILL_STATUSES } from '../models/Bill.js';
import { CASH_MOVEMENT_TYPES, CashMovement } from '../models/CashMovement.js';
import { DayClosure } from '../models/DayClosure.js';
import { ORDER_LINE_STATUSES, ORDER_STATUSES, ORDER_TYPES, Order } from '../models/Order.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { Refund, REFUND_STATUSES } from '../models/Refund.js';
import { averagePaise, sumPaise } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { businessDateFor, businessDateRangeToUtc } from '../utils/time.js';
import { formatBillNumber, formatPrefixBillNumber, formatWebsiteBillNumber, WEBSITE_SEQUENCE_BASE } from './billNumberService.js';
import { computeLineTotalInPaise } from './orderService.js';
import { getSetting } from './settingsService.js';

const CASH = 'CASH';
const IN_HAND = 'IN_HAND';
const PLATFORM = 'PLATFORM';
const PLATFORM_COLLECTS = 'PLATFORM_COLLECTS';

const sum = (list, pick) => sumPaise(0, ...list.map(pick));
const kindOf = (record) => record.methodKind ?? IN_HAND;
const isCash = (record) => record.method === CASH && kindOf(record) === IN_HAND;
const opts = (session) => (session ? { session } : {});

/** A payment's own business date. One from before P08 reads as its bill's. */
const paymentDate = (payment, bill) => payment.businessDate ?? bill.businessDate;

/** Section A. */
function salesSection(bills) {
  const netSalesInPaise = sum(bills, (bill) => sum(bill.taxBreakdown, (slab) => slab.taxableInPaise));
  const dineIn = bills.filter((bill) => bill.orderType === ORDER_TYPES.DINE_IN);
  const covers = sum(dineIn, (bill) => bill.guestCount ?? 0);
  const dineInNetSalesInPaise = sum(dineIn, (bill) =>
    sum(bill.taxBreakdown, (slab) => slab.taxableInPaise),
  );
  const cgstInPaise = sum(bills, (bill) => sum(bill.taxBreakdown, (slab) => slab.cgstInPaise));
  const sgstInPaise = sum(bills, (bill) => sum(bill.taxBreakdown, (slab) => slab.sgstInPaise));

  return {
    billCount: bills.length,
    covers,
    itemTotalInPaise: sum(bills, (bill) => bill.subtotalInPaise),
    discountInPaise: sum(bills, (bill) => bill.discount?.amountInPaise ?? 0),
    netSalesInPaise,
    cgstInPaise,
    sgstInPaise,
    gstInPaise: sumPaise(cgstInPaise, sgstInPaise),
    roundOffInPaise: sum(bills, (bill) => bill.roundOffInPaise),
    billTotalInPaise: sum(bills, (bill) => bill.grandTotalInPaise),
    averageBillInPaise: averagePaise(netSalesInPaise, bills.length),
    dineInNetSalesInPaise,
    averagePerCoverInPaise: averagePaise(dineInNetSalesInPaise, covers),
  };
}

/** Section B. Where the day's bill total went. */
function moneySection(bills, methodList) {
  const rows = new Map();
  for (const method of methodList) {
    rows.set(method.code, {
      method: method.code,
      methodName: method.name,
      methodKind: method.kind,
      amountInPaise: 0,
      paymentCount: 0,
    });
  }
  for (const bill of bills) {
    for (const payment of bill.payments) {
      const row = rows.get(payment.method) ?? {
        method: payment.method,
        methodName: payment.methodName ?? payment.method,
        methodKind: kindOf(payment),
        amountInPaise: 0,
        paymentCount: 0,
      };
      row.amountInPaise = sumPaise(row.amountInPaise, payment.amountInPaise);
      row.paymentCount += 1;
      rows.set(payment.method, row);
    }
  }
  const methods = [...rows.values()];

  const onHoldRows = new Map();
  for (const bill of bills) {
    if (!bill.chargedToAccountInPaise) continue;
    const key = String(bill.account?.accountId ?? 'unknown');
    const row = onHoldRows.get(key) ?? {
      accountId: bill.account?.accountId ? String(bill.account.accountId) : null,
      accountName: bill.account?.accountName ?? 'Unknown account',
      amountInPaise: 0,
      billCount: 0,
    };
    row.amountInPaise = sumPaise(row.amountInPaise, bill.chargedToAccountInPaise);
    row.billCount += 1;
    onHoldRows.set(key, row);
  }
  const onHold = [...onHoldRows.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));

  const unpaidBills = bills.filter((bill) => bill.status === BILL_STATUSES.UNPAID);
  const inHandInPaise = sum(methods.filter((row) => row.methodKind === IN_HAND), (row) => row.amountInPaise);
  const platformInPaise = sum(methods.filter((row) => row.methodKind === PLATFORM), (row) => row.amountInPaise);
  const onHoldInPaise = sum(onHold, (row) => row.amountInPaise);
  const unpaidInPaise = sum(unpaidBills, (bill) => bill.grandTotalInPaise - sum(bill.payments, (p) => p.amountInPaise));

  return {
    methods,
    inHandInPaise,
    platformInPaise,
    onHold,
    onHoldInPaise,
    unpaidInPaise,
    unpaidBillCount: unpaidBills.length,
    totalInPaise: sumPaise(inHandInPaise, platformInPaise, onHoldInPaise, unpaidInPaise),
  };
}

/** Groups entries by a key, adding their amounts, in the order first met. */
function grouped(entries, keyOf, labelOf) {
  const rows = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const row = rows.get(key) ?? { code: key, label: labelOf(entry), amountInPaise: 0, count: 0 };
    row.amountInPaise = sumPaise(row.amountInPaise, entry.amountInPaise);
    row.count += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

const SOURCE_WORDS = { OWNER: 'From the owner', BANK: 'From the bank', CHANGE: 'Change', OTHER: 'Other' };
const DESTINATION_WORDS = { BANK_DEPOSIT: 'Bank deposit', OWNER: 'Given to the owner', OTHER: 'Other' };

/**
 * Section D. The drawer, the cash book's flow (P29 Part F): opening float
 * (brought forward or counted) + top-ups + cash sales + cash collections -
 * expenses - cash taken out. `cashFromBills` counts cash by the payment's own
 * date, on any live bill. A cash check moves no money and is listed only.
 * `broughtForward` is the closed day the float came from and what it kept.
 */
function cashSection(movements, cashFromBillsInPaise, cashCollectionsInPaise, broughtForward = null) {
  const live = movements.filter((movement) => !movement.isVoided);
  const ofType = (type) => live.filter((movement) => movement.type === type);
  const openingFloatInPaise = sum(ofType(CASH_MOVEMENT_TYPES.OPENING_FLOAT), (m) => m.amountInPaise);
  const paidInInPaise = sum(ofType(CASH_MOVEMENT_TYPES.PAID_IN), (m) => m.amountInPaise);
  const paidOutInPaise = sum(ofType(CASH_MOVEMENT_TYPES.PAID_OUT), (m) => m.amountInPaise);
  const cashTakenOutInPaise = sum(ofType(CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT), (m) => m.amountInPaise);
  const brief = (movement) => ({ amountInPaise: movement.amountInPaise, reason: movement.reason, at: movement.at });
  const float = ofType(CASH_MOVEMENT_TYPES.OPENING_FLOAT)[0] ?? null;

  return {
    openingFloatInPaise,
    cashFromBillsInPaise,
    cashCollectionsInPaise,
    paidInInPaise,
    paidOutInPaise,
    cashTakenOutInPaise,
    expectedCashInPaise: sumPaise(
      openingFloatInPaise,
      cashFromBillsInPaise,
      cashCollectionsInPaise,
      paidInInPaise,
      -paidOutInPaise,
      -cashTakenOutInPaise,
    ),
    paidIn: ofType(CASH_MOVEMENT_TYPES.PAID_IN).map(brief),
    paidOut: ofType(CASH_MOVEMENT_TYPES.PAID_OUT).map(brief),
    // P29 Part F.
    broughtForward: float?.broughtForwardFrom
      ? {
          fromDate: float.broughtForwardFrom,
          keptInPaise: broughtForward?.keptForTomorrowInPaise ?? null,
          openingDifferenceInPaise: float.openingDifferenceInPaise ?? null,
          note: float.openingDifferenceInPaise ? float.reason ?? null : null,
        }
      : null,
    topUpsBySource: grouped(ofType(CASH_MOVEMENT_TYPES.PAID_IN), (m) => m.source ?? 'NOT_RECORDED', (m) => SOURCE_WORDS[m.source] ?? 'Not recorded'),
    expensesByCategory: grouped(ofType(CASH_MOVEMENT_TYPES.PAID_OUT), (m) => m.category ?? 'NOT_RECORDED', (m) => m.categoryLabel ?? 'Not recorded'),
    takenOut: ofType(CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT).map((movement) => ({
      ...brief(movement),
      destination: movement.destination,
      destinationLabel: DESTINATION_WORDS[movement.destination] ?? movement.destination,
    })),
    checks: ofType(CASH_MOVEMENT_TYPES.CASH_CHECK).map((movement) => ({
      at: movement.at,
      countedInPaise: movement.amountInPaise,
      expectedCashInPaise: movement.expectedCashInPaise ?? null,
      differenceInPaise: movement.differenceInPaise ?? null,
    })),
  };
}

/** Section E. Delivery is split by the frozen platform code. */
function orderTypeSection(bills) {
  const rows = new Map();
  for (const bill of bills) {
    const platformCode = bill.platform?.code ?? null;
    const key = `${bill.orderType}:${platformCode ?? ''}`;
    const row = rows.get(key) ?? {
      orderType: bill.orderType,
      platformCode,
      billCount: 0,
      covers: 0,
      netSalesInPaise: 0,
      billTotalInPaise: 0,
    };
    row.billCount += 1;
    row.covers += bill.orderType === ORDER_TYPES.DINE_IN ? (bill.guestCount ?? 0) : 0;
    row.netSalesInPaise = sumPaise(row.netSalesInPaise, sum(bill.taxBreakdown, (slab) => slab.taxableInPaise));
    row.billTotalInPaise = sumPaise(row.billTotalInPaise, bill.grandTotalInPaise);
    rows.set(key, row);
  }
  const order = [ORDER_TYPES.DINE_IN, ORDER_TYPES.TAKEAWAY, ORDER_TYPES.DELIVERY];
  return [...rows.values()].sort(
    (a, b) =>
      order.indexOf(a.orderType) - order.indexOf(b.orderType) ||
      String(a.platformCode).localeCompare(String(b.platformCode)),
  );
}

/** Section F. A platform-collected bill's 0% sits in its own row. */
function gstSection(bills) {
  const rows = new Map();
  for (const bill of bills) {
    const platformCollects = bill.taxTreatment === PLATFORM_COLLECTS;
    for (const slab of bill.taxBreakdown) {
      const key = `${slab.taxRateBps}:${platformCollects}`;
      const row = rows.get(key) ?? {
        taxRateBps: slab.taxRateBps,
        platformCollects,
        netSalesInPaise: 0,
        cgstInPaise: 0,
        sgstInPaise: 0,
        gstInPaise: 0,
      };
      row.netSalesInPaise = sumPaise(row.netSalesInPaise, slab.taxableInPaise);
      row.cgstInPaise = sumPaise(row.cgstInPaise, slab.cgstInPaise);
      row.sgstInPaise = sumPaise(row.sgstInPaise, slab.sgstInPaise);
      row.gstInPaise = sumPaise(row.gstInPaise, slab.taxInPaise);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.taxRateBps - a.taxRateBps || Number(a.platformCollects) - Number(b.platformCollects),
  );
}

/**
 * P29. The revisions made during the day, on any bill: how many, the value
 * taken off, the value added, and how many were after the bill was printed.
 */
function revisionsSection(revisions) {
  const removed = revisions.filter((entry) => entry.kind === 'REMOVED');
  const added = revisions.filter((entry) => entry.kind === 'ADDED');
  return {
    count: revisions.length,
    removedValueInPaise: sum(removed, (entry) => entry.previousGrandTotalInPaise - entry.newGrandTotalInPaise),
    addedValueInPaise: sum(added, (entry) => entry.newGrandTotalInPaise - entry.previousGrandTotalInPaise),
    afterPrintingCount: revisions.filter((entry) => entry.wasPrinted).length,
  };
}

/** Section G. */
function controlsSection({ bills, voidedBills, noChargeOrders, cancelledLines, cancelledOrders, revisions = [] }) {
  const discounted = bills
    .filter((bill) => bill.discount?.amountInPaise > 0)
    .map((bill) => ({ billNumber: bill.billNumber, amountInPaise: bill.discount.amountInPaise }))
    .sort((a, b) => b.amountInPaise - a.amountInPaise || a.billNumber.localeCompare(b.billNumber));

  return {
    discounts: {
      count: discounted.length,
      totalInPaise: sum(discounted, (row) => row.amountInPaise),
      largest: discounted.slice(0, 3),
    },
    noCharge: {
      count: noChargeOrders.length,
      valueInPaise: sum(noChargeOrders, (order) => order.noCharge.valueInPaise),
    },
    cancelledItems: {
      count: cancelledLines.length,
      valueInPaise: sum(cancelledLines, (row) => row.valueInPaise),
      wastedValueInPaise: sum(cancelledLines.filter((row) => row.wasPrepared === true), (row) => row.valueInPaise),
    },
    cancelledOrders: {
      count: cancelledOrders.length,
      valueInPaise: sum(cancelledOrders, (row) => row.valueInPaise),
    },
    voidedBills: {
      count: voidedBills.length,
      valueInPaise: sum(voidedBills, (bill) => bill.grandTotalInPaise),
      bills: voidedBills.map((bill) => ({
        billNumber: bill.billNumber,
        amountInPaise: bill.grandTotalInPaise,
        reasonCode: bill.voidReasonCode ?? null,
        reason: bill.voidReasonCode
          ? reasonText(BILL_VOID_REASONS, bill.voidReasonCode, bill.voidReason)
          : bill.voidReason,
      })),
    },
    billRevisions: revisionsSection(revisions),
  };
}

/** The series a bill belongs to. A null series is its financial year's. */
export const seriesOf = (bill) => bill.invoiceSeries ?? bill.financialYear;

const FINANCIAL_YEAR_SERIES = /^\d{4}-\d{2}$/;

/** A sequence as the number printed on a bill in that series. */
export function numberInSeries(series, sequence) {
  // P63. The website's series counts from WEBSITE_SEQUENCE_BASE.
  if (sequence > WEBSITE_SEQUENCE_BASE) return formatWebsiteBillNumber(series, sequence);
  return FINANCIAL_YEAR_SERIES.test(series)
    ? formatBillNumber(series, sequence)
    : formatPrefixBillNumber(series, sequence);
}

/** Section H. One row per invoice series, voided bills included. */
function invoiceSection(allBills) {
  const bySeries = new Map();
  for (const bill of allBills) {
    const key = seriesOf(bill);
    bySeries.set(key, [...(bySeries.get(key) ?? []), bill]);
  }

  return [...bySeries.entries()].map(([series, list]) => {
    const sorted = [...list].sort((a, b) => a.billSequence - b.billSequence);
    const present = new Set(sorted.map((bill) => bill.billSequence));
    const gaps = [];
    for (let sequence = sorted[0].billSequence; sequence <= sorted.at(-1).billSequence; sequence += 1) {
      if (!present.has(sequence)) gaps.push(numberInSeries(series, sequence));
    }
    return {
      series,
      first: sorted[0].billNumber,
      last: sorted.at(-1).billNumber,
      issued: sorted.length,
      voided: sorted.filter((bill) => bill.isVoided).length,
      gaps,
    };
  });
}

/**
 * The records as they stood at `upTo`, for R1 Today. P18.
 *
 * A bill not yet issued is left out; a payment not yet received, a charge to
 * an account not yet made, and a void not yet done are taken off the bill, and
 * its status worked out again from what was left. Drawer entries, collections,
 * No Charge and cancellations after `upTo` are left out. With no `upTo` the
 * records are returned untouched, which is what Day Close and R2 always use.
 */
function asAt(upTo, loaded) {
  if (!upTo) return loaded;
  const by = (instant) => instant && new Date(instant) <= upTo;
  const asItWas = (bill) => {
    const payments = bill.payments.filter((payment) => by(payment.receivedAt));
    const charged = by(bill.chargedAt) ? bill.chargedToAccountInPaise : null;
    const voided = bill.isVoided && by(bill.voidedAt);
    const paid = sumPaise(0, ...payments.map((payment) => payment.amountInPaise));
    const status = voided
      ? bill.status
      : charged
        ? BILL_STATUSES.ON_ACCOUNT
        : paid >= bill.grandTotalInPaise
          ? BILL_STATUSES.PAID
          : BILL_STATUSES.UNPAID;
    return { ...bill, payments, chargedToAccountInPaise: charged, isVoided: voided, status };
  };
  return {
    ...loaded,
    dayBills: loaded.dayBills.filter((bill) => by(bill.billedAt)).map(asItWas),
    billsWithDayPayments: loaded.billsWithDayPayments.map((bill) => ({
      ...bill,
      payments: bill.payments.filter((payment) => by(payment.receivedAt)),
    })),
    movements: loaded.movements.filter((movement) => by(movement.at)),
    collections: loaded.collections.filter((entry) => by(entry.at)),
    noChargeOrders: loaded.noChargeOrders.filter((order) => by(order.noCharge.at)),
    cancelOrders: loaded.cancelOrders.map((order) => ({
      ...order,
      isCancelled: order.isCancelled && by(order.cancelledAt),
      lines: order.lines.map((line) =>
        line.status === ORDER_LINE_STATUSES.CANCELLED && !by(line.cancelledAt) ? { ...line, status: 'LIVE_AT_THE_TIME' } : line,
      ),
    })),
  };
}

/**
 * The figures for `businessDate`, sections A to H, plus the collections in
 * section C. Plain data: stored as the Day Close snapshot and returned by R2.
 *
 * `upTo`, an instant, gives the day as it stood at that moment, for R1 Today
 * (P18). Day Close and R2 never pass it.
 */
export async function computeDayFigures(req, businessDate, { session = null, upTo = null } = {}) {
  const startMinutes = await getSetting(req.restaurantId, 'business.businessDayStartsAtMinutes', { req });
  const { start, end } = businessDateRangeToUtc(businessDate, businessDate, startMinutes);
  const tenant = scoped(req);

  const [loadedDayBills, loadedPaymentBills, loadedMovements, loadedCollections, loadedNoCharge, loadedCancelOrders, methods] =
    await Promise.all([
      Bill.find({ ...tenant, businessDate }).setOptions(opts(session)).lean(),
      // Cash counts on the payment's own business date, whichever day the bill was issued.
      Bill.find({
        ...tenant,
        isVoided: false,
        $or: [{ 'payments.businessDate': businessDate }, { businessDate }],
      })
        .select('businessDate payments')
        .setOptions(opts(session))
        .lean(),
      CashMovement.find({ ...tenant, businessDate }).sort({ at: 1 }).setOptions(opts(session)).lean(),
      AccountEntry.find({ ...tenant, businessDate, type: ACCOUNT_ENTRY_TYPES.COLLECTION })
        .sort({ at: 1 })
        .setOptions(opts(session))
        .lean(),
      Order.find({ ...tenant, status: ORDER_STATUSES.NO_CHARGE, 'noCharge.businessDate': businessDate })
        .setOptions(opts(session))
        .lean(),
      Order.find({
        ...tenant,
        $or: [
          { 'lines.cancelledAt': { $gte: start, $lt: end } },
          { cancelledAt: { $gte: start, $lt: end } },
        ],
      })
        .setOptions(opts(session))
        .lean(),
      PaymentMethod.find({ ...tenant, isActive: true }).sort({ displayOrder: 1 }).setOptions(opts(session)).lean(),
    ]);

  // P25 Part E. Money owed back to guests, created on this business date. Moves no money here.
  const refundRows = await Refund.find({ ...tenant, businessDate }).sort({ createdAt: 1 }).setOptions(opts(session)).lean();

  // P29 Part F. The closed day a brought-forward float came from, for what it kept.
  const float = loadedMovements.find((movement) => movement.type === CASH_MOVEMENT_TYPES.OPENING_FLOAT && !movement.isVoided && movement.broughtForwardFrom);
  const broughtForward = float
    ? await DayClosure.findOne({ ...tenant, businessDate: float.broughtForwardFrom }).select('keptForTomorrowInPaise').setOptions(opts(session)).lean()
    : null;

  // P29. Bills revised during the day's hours, whichever day they were issued on.
  const revisedBills = await Bill.find({ ...tenant, 'revisions.at': { $gte: start, $lt: end } })
    .select('revisions')
    .setOptions(opts(session))
    .lean();
  const dayRevisions = revisedBills
    .flatMap((bill) => bill.revisions)
    .filter((entry) => entry.at >= start && entry.at < end && (!upTo || entry.at <= upTo));

  const { dayBills, billsWithDayPayments, movements, collections, noChargeOrders, cancelOrders } = asAt(upTo, {
    dayBills: loadedDayBills,
    billsWithDayPayments: loadedPaymentBills,
    movements: loadedMovements,
    collections: loadedCollections,
    noChargeOrders: loadedNoCharge,
    cancelOrders: loadedCancelOrders,
  });

  const liveBills = dayBills.filter((bill) => !bill.isVoided);
  // P56. Whole voids only. A bill voided before P56 has no mark, so a closed day's figures never move.
  const voidedBills = dayBills.filter((bill) => bill.isVoided && !bill.isVoidedToChangeItems);
  const inDay = (instant) => instant && businessDateFor(instant, startMinutes) === businessDate;

  const cashFromBillsInPaise = sum(billsWithDayPayments, (bill) =>
    sum(
      bill.payments.filter((payment) => isCash(payment) && paymentDate(payment, bill) === businessDate),
      (payment) => payment.amountInPaise,
    ),
  );

  const accountIds = [...new Set(collections.map((entry) => String(entry.accountId)))];
  const accounts = accountIds.length
    ? await Account.find({ ...tenant, _id: { $in: accountIds } }).select('name').setOptions(opts(session)).lean()
    : [];
  const accountName = new Map(accounts.map((account) => [String(account._id), account.name]));
  const collectionRows = collections.map((entry) => ({
    accountId: String(entry.accountId),
    accountName: accountName.get(String(entry.accountId)) ?? 'Unknown account',
    method: entry.method,
    methodName: entry.methodName ?? entry.method,
    methodKind: kindOf(entry),
    amountInPaise: entry.amountInPaise,
    at: entry.at,
  }));
  const cashCollectionsInPaise = sum(collections.filter(isCash), (entry) => entry.amountInPaise);

  // A line cancelled as part of a whole-order cancel is counted with the order, not as an item.
  const cancelledLines = [];
  const cancelledOrders = [];
  for (const order of cancelOrders) {
    const orderCancelledToday = order.isCancelled && inDay(order.cancelledAt);
    // P50. An order closed because it was opened by mistake sent nothing and sold nothing.
    if (orderCancelledToday && order.cancelReasonCode !== ORDER_OPENED_BY_MISTAKE) {
      const withOrder = order.lines.filter(
        (line) =>
          line.status === ORDER_LINE_STATUSES.CANCELLED &&
          line.cancelledAt?.getTime() === order.cancelledAt.getTime(),
      );
      cancelledOrders.push({
        orderNumber: order.orderNumber,
        valueInPaise: sum(withOrder, computeLineTotalInPaise),
      });
    }
    for (const line of order.lines) {
      if (line.status !== ORDER_LINE_STATUSES.CANCELLED || !inDay(line.cancelledAt)) continue;
      if (order.isCancelled && line.cancelledAt?.getTime() === order.cancelledAt?.getTime()) continue;
      cancelledLines.push({ valueInPaise: computeLineTotalInPaise(line), wasPrepared: line.wasPrepared ?? null });
    }
  }

  return {
    businessDate,
    sales: salesSection(liveBills),
    money: moneySection(liveBills, methods),
    collections: {
      entries: collectionRows,
      totalInPaise: sum(collectionRows, (row) => row.amountInPaise),
      cashInPaise: cashCollectionsInPaise,
    },
    cash: cashSection(movements, cashFromBillsInPaise, cashCollectionsInPaise, broughtForward),
    orderTypes: orderTypeSection(liveBills),
    gst: gstSection(liveBills),
    controls: controlsSection({ bills: liveBills, voidedBills, noChargeOrders, cancelledLines, cancelledOrders, revisions: dayRevisions }),
    invoices: invoiceSection(dayBills),
    refunds: {
      owed: refundRows
        .filter((row) => row.status === REFUND_STATUSES.OWED)
        .map((row) => ({ billNumber: row.billNumber ?? row.voidedBillNumber, methodName: row.methodName, amountInPaise: row.amountInPaise })),
      owedInPaise: sum(refundRows.filter((row) => row.status === REFUND_STATUSES.OWED), (row) => row.amountInPaise),
      refundedInPaise: sum(refundRows.filter((row) => row.status === REFUND_STATUSES.REFUNDED), (row) => row.amountInPaise),
    },
  };
}

export default { computeDayFigures, numberInSeries, seriesOf };
