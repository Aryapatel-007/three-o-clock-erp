/**
 * Day Close. M16, built in P10. docs/API-CONTRACT.md "M16" section 6.
 *
 * Closing a business date computes its figures once, runs the checks, stores
 * both as the snapshot, and locks the date: from then on dayLockService
 * refuses every write that would change it. Only the owner reopens, with a
 * reason, and every close and reopen is kept in `history`.
 *
 * The blind count: a manager enters the counted cash without being shown what
 * the drawer should hold. Unless the owner switches
 * `dayClose.showCashDifferenceToManager` on, every response and print to a
 * manager leaves out the expected cash, the difference, and the C9 numbers
 * that would give them away. The rule is applied here, on the server.
 */
import { ROLES } from '../config/roles.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Bill, BILL_STATUSES } from '../models/Bill.js';
import { DAY_STATUSES, DayClosure } from '../models/DayClosure.js';
import { OCCUPYING_ORDER_STATUSES, Order, ORDER_LINE_STATUSES, ORDER_STATUSES } from '../models/Order.js';
import { ORDER_OPENED_BY_MISTAKE } from '../config/cancelReasons.js';
import { applyVersionedUpdate } from './orderService.js';
import { PlatformOrder } from '../models/PlatformOrder.js';
import { TerminalTransaction } from '../models/TerminalTransaction.js';
import { User } from '../models/User.js';
import { BusinessRuleError, CashCountMismatchError, DayNotReadyError, NotFoundError } from '../utils/errors.js';
import { countCash } from './cashService.js';
import { paiseToRupees } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { businessDateRangeToUtc, formatTimeIst12, nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';
import { recordAudit } from './auditService.js';
import { computeDayFigures } from './dayFiguresService.js';
import { buildDayEndMessage } from './dayEndMessageService.js';
import { isEmailSetUp, sendEmail } from './emailService.js';
import { todayBusinessDate } from './dayLockService.js';
import { centre, row, rule, wrapName } from './receiptService.js';
import { runDayChecks, SEVERITY } from './reconciliationService.js';
import { getSetting } from './settingsService.js';
import { markDayStale } from './integrations/tally/exportService.js';

const opts = (session) => (session ? { session } : {});

/** Whether this caller sees expected cash and the difference. */
async function seesCash(req) {
  if (req.user.role === ROLES.OWNER) return true;
  // P61. A cashier closes the day blind, always.
  if (req.user.role !== ROLES.MANAGER) return false;
  return Boolean(await getSetting(req.restaurantId, 'dayClose.showCashDifferenceToManager', { req }));
}

/** Removes everything that would reveal the expected cash, for a blind manager. */
function blind(view) {
  const copy = structuredClone(view);
  delete copy.expectedCashInPaise;
  delete copy.differenceInPaise;
  if (copy.figures?.cash) delete copy.figures.cash.expectedCashInPaise;
  if (Array.isArray(copy.checks)) {
    copy.checks = copy.checks.map((check) =>
      check.id === 'C9'
        ? { ...check, message: 'C9 Cash: the count is recorded.', expected: null, actual: null, difference: null }
        : check,
    );
  }
  if (Array.isArray(copy.history)) {
    for (const entry of copy.history) {
      delete entry.expectedCashInPaise;
      delete entry.differenceInPaise;
    }
  }
  return copy;
}

/**
 * P61. An open order with no bill, none of whose lines was ever sent: opened
 * by a tap on the floor and left, or dishes added and never sent. P50's rule.
 */
function neverSent(order) {
  return (
    order.status === ORDER_STATUSES.OPEN &&
    !order.billId &&
    order.lines.every((line) => !line.firedAt && [ORDER_LINE_STATUSES.PENDING, ORDER_LINE_STATUSES.CANCELLED].includes(line.status))
  );
}

/** P61. The open orders of the date that Day Close closes as opened by mistake. */
async function ordersClosingOnClose(req, businessDate, { session = null } = {}) {
  const startMinutes = await getSetting(req.restaurantId, 'business.businessDayStartsAtMinutes', { req });
  const { start, end } = businessDateRangeToUtc(businessDate, businessDate, startMinutes);
  const orders = await Order.find({ ...scoped(req), status: ORDER_STATUSES.OPEN, billId: null, openedAt: { $gte: start, $lt: end } })
    .select('orderNumber tableName orderType status billId version lines.status lines.firedAt')
    .setOptions(opts(session))
    .lean();
  return orders.filter(neverSent);
}

function presentUnsent(order) {
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    tableName: order.tableName ?? null,
    orderType: order.orderType,
    dishesNotSent: order.lines.filter((line) => line.status === ORDER_LINE_STATUSES.PENDING).length,
  };
}

/**
 * P61. Closes those orders exactly as P50's Close table does: the not-sent
 * dishes removed, the order cancelled as opened by mistake, by the person
 * closing the day. No audit line; they count nowhere.
 */
async function closeUnsentOrders(req, businessDate, session) {
  const orders = await ordersClosingOnClose(req, businessDate, { session });
  for (const order of orders) {
    await applyVersionedUpdate(req, {
      orderId: order._id,
      version: order.version,
      update: {
        $pull: { lines: { status: ORDER_LINE_STATUSES.PENDING } },
        $set: {
          status: ORDER_STATUSES.CANCELLED,
          isCancelled: true,
          cancelledAt: nowUtc(),
          cancelledBy: req.user.id,
          cancelReasonCode: ORDER_OPENED_BY_MISTAKE,
          cancelReason: null,
        },
      },
      session,
    });
  }
  if (orders.length > 0) {
    req.log?.info({ businessDate, orders: orders.map((order) => order.orderNumber) }, 'Day Close closed orders nothing was sent from.');
  }
}

/** Everything that stops a date being closed, reported together. */
async function blockersFor(req, businessDate, checks, { session = null } = {}) {
  const startMinutes = await getSetting(req.restaurantId, 'business.businessDayStartsAtMinutes', { req });
  const { start, end } = businessDateRangeToUtc(businessDate, businessDate, startMinutes);

  const [openOrders, unpaidBills, platformOrders, terminalPayments] = await Promise.all([
    Order.find({
      ...scoped(req),
      status: { $in: [...OCCUPYING_ORDER_STATUSES] },
      openedAt: { $gte: start, $lt: end },
    })
      .select('orderNumber tableName orderType status billId lines.status lines.firedAt')
      .setOptions(opts(session))
      .lean(),
    Bill.find({ ...scoped(req), businessDate, isVoided: false, status: BILL_STATUSES.UNPAID })
      .select('billNumber orderId')
      .setOptions(opts(session))
      .lean(),
    // P25 Part H. A platform order of that date still waiting, accepted and not picked up, or failed.
    PlatformOrder.find({
      ...scoped(req),
      businessDate,
      status: { $in: ['RECEIVED', 'NEEDS_ATTENTION', 'ACCEPTED', 'FAILED'] },
    })
      .select('platformCode platformOrderId status orderId')
      .setOptions(opts(session))
      .lean(),
    // P25 Part I. A card machine payment of that date still waiting, or one the machine approved for a different amount.
    TerminalTransaction.find({ ...scoped(req), businessDate, status: { $in: ['WAITING', 'UNKNOWN'] } })
      .select('billNumber status amountInPaise')
      .setOptions(opts(session))
      .lean(),
  ]);

  // An order waiting on its unpaid bill is reported once, as the bill.
  const billedOrders = new Set(unpaidBills.map((bill) => String(bill.orderId)));

  return [
    // P61. An order nothing was sent from closes itself at Day Close: listed apart, never a blocker.
    ...openOrders.filter((order) => !billedOrders.has(String(order._id)) && !neverSent(order)).map((order) => ({
      kind: 'OPEN_ORDER',
      message: `Order ${order.orderNumber}${order.tableName ? ` on ${order.tableName}` : ''} is still open.`,
      ref: String(order._id),
    })),
    ...unpaidBills.map((bill) => ({
      kind: 'UNPAID_BILL',
      message: `Bill ${bill.billNumber} is not paid.`,
      ref: String(bill._id),
    })),
    ...platformOrders.map((order) => {
      const name = `${order.platformCode === 'SWIGGY' ? 'Swiggy' : 'Zomato'} order ${order.platformOrderId}`;
      return order.status === 'FAILED'
        ? { kind: 'PLATFORM_ORDER_FAILED', message: `${name} was accepted on the platform but not created here. Enter it by hand.`, ref: String(order._id) }
        : { kind: 'PLATFORM_ORDER', message: order.status === 'ACCEPTED' ? `${name} has not been picked up.` : `${name} is still waiting for an answer.`, ref: String(order._id) };
    }),
    ...terminalPayments.map((payment) => ({
      kind: 'TERMINAL_PAYMENT',
      message:
        payment.status === 'WAITING'
          ? `A card machine payment for bill ${payment.billNumber} is still waiting.`
          : `A card machine payment for bill ${payment.billNumber} needs checking against the machine's slip.`,
      ref: String(payment._id),
    })),
    ...checks
      .filter((check) => check.severity === SEVERITY.ERROR && !check.passed)
      .map((check) => ({ kind: 'CHECK', message: check.message, ref: check.id })),
  ];
}

function presentClosure(closure) {
  const plain = closure.toJSON();
  return {
    businessDate: plain.businessDate,
    status: plain.status,
    isClosed: plain.status === DAY_STATUSES.CLOSED,
    countedCashInPaise: plain.countedCashInPaise,
    // P25 Part F. The manager's own count by notes; the blind count never hides it.
    cashCount: plain.cashCount ?? null,
    // P29 Part F. The manager's own split of the count: never hidden, it is what they decided.
    keptForTomorrowInPaise: plain.keptForTomorrowInPaise ?? null,
    keptForTomorrowCount: plain.keptForTomorrowCount ?? null,
    takenOutAtCloseInPaise: plain.takenOutAtCloseInPaise ?? null,
    takenOutTo: plain.takenOutTo ?? null,
    expectedCashInPaise: plain.expectedCashInPaise,
    differenceInPaise: plain.differenceInPaise,
    note: plain.note,
    figures: plain.snapshot,
    checks: plain.checks,
    blockers: [],
    closedBy: plain.closedBy ? String(plain.closedBy) : null,
    closedAt: plain.closedAt,
    history: plain.history,
    // P44. Whether the day-end email went out after the close.
    dayEndEmail: plain.dayEndEmail ?? null,
  };
}

/**
 * P29 Part F. What stays in the drawer for tomorrow, and the rest taken out
 * after the count. Nothing sent is a close as before P29: no kept cash, so no
 * float to propose tomorrow. Kept is never more than the count.
 */
async function keptAtClose(req, countedCashInPaise, { keptForTomorrowInPaise, keptForTomorrowCount, takenOutTo, takenOutBy }) {
  if (keptForTomorrowInPaise === undefined && !keptForTomorrowCount) return {};
  let kept = keptForTomorrowInPaise;
  let keptCount;
  if (keptForTomorrowCount) {
    const counted = await countCash(req, keptForTomorrowCount);
    if (kept !== undefined && kept !== counted.totalInPaise) throw new CashCountMismatchError(counted.totalInPaise, kept);
    kept = counted.totalInPaise;
    keptCount = counted.cashCount;
  }
  if (kept > countedCashInPaise) throw new BusinessRuleError('You cannot keep more than you counted.');
  const takenOut = countedCashInPaise - kept;
  if (takenOut > 0 && !takenOutTo) throw new BusinessRuleError('Say where the rest of the cash went: the bank, or the owner.');
  let taker = null;
  if (takenOut > 0) {
    taker = req.user.id;
    if (takenOutBy && String(takenOutBy) !== String(req.user.id)) {
      const person = await User.findOne({ restaurantId: req.restaurantId, _id: takenOutBy, isActive: true }).select('_id').lean();
      if (!person) throw new BusinessRuleError('That person is not on the staff list. Pick someone who is.');
      taker = person._id;
    }
  }
  return {
    keptForTomorrowInPaise: kept,
    ...(keptCount ? { keptForTomorrowCount: keptCount } : {}),
    takenOutAtCloseInPaise: takenOut,
    takenOutTo: takenOut > 0 ? takenOutTo : null,
    takenOutBy: taker,
  };
}

/** POST /day-close. OWNER, MANAGER and, from P61, CASHIER. */
export async function closeDay(req, { businessDate, countedCashInPaise, cashCount = null, note = null, ...keptRequest }) {
  // P25 Part F. A count by notes and coins: the server totals it, and a total sent beside it must agree.
  let counted = null;
  if (cashCount) {
    counted = await countCash(req, cashCount);
    if (countedCashInPaise !== undefined && countedCashInPaise !== null && countedCashInPaise !== counted.totalInPaise) {
      throw new CashCountMismatchError(counted.totalInPaise, countedCashInPaise);
    }
    countedCashInPaise = counted.totalInPaise;
  }
  // P29 Part F. Checked before anything is written; recorded after the count, so it never moves the difference.
  const keptFields = await keptAtClose(req, countedCashInPaise, keptRequest);

  const today = await todayBusinessDate(req);
  if (businessDate > today) {
    throw new BusinessRuleError('That business date has not happened yet.');
  }

  const closure = await withOptionalTransaction(async (session) => {
    const existing = await DayClosure.findOne({ ...scoped(req), businessDate }).setOptions(opts(session));
    if (existing?.status === DAY_STATUSES.CLOSED) {
      throw new BusinessRuleError(`${businessDate} is already closed.`);
    }

    // P61. First, the orders nothing was sent from: they close themselves, opened by mistake.
    await closeUnsentOrders(req, businessDate, session);

    const figures = await computeDayFigures(req, businessDate, { session });
    const checks = await runDayChecks(req, businessDate, figures, { countedCashInPaise, session });
    const blockers = await blockersFor(req, businessDate, checks, { session });
    if (blockers.length > 0) throw new DayNotReadyError(blockers);

    const expectedCashInPaise = figures.cash.expectedCashInPaise;
    const differenceInPaise = countedCashInPaise - expectedCashInPaise;
    if (differenceInPaise !== 0 && !note) {
      // Says only that it differs: a blind manager must not learn by how much.
      const error = new BusinessRuleError(
        'The cash counted is not what the drawer should hold. Add a note saying why, then close.',
      );
      error.details = { noteRequired: true };
      throw error;
    }

    const at = nowUtc();
    const record = existing ?? new DayClosure({ ...scoped(req), businessDate });
    Object.assign(record, {
      status: DAY_STATUSES.CLOSED,
      countedCashInPaise,
      expectedCashInPaise,
      differenceInPaise,
      note: note ?? null,
      snapshot: figures,
      checks,
      closedBy: req.user.id,
      closedAt: at,
      cashCount: counted ? counted.cashCount : undefined,
      keptForTomorrowInPaise: keptFields.keptForTomorrowInPaise ?? null,
      keptForTomorrowCount: keptFields.keptForTomorrowCount,
      takenOutAtCloseInPaise: keptFields.takenOutAtCloseInPaise ?? null,
      takenOutTo: keptFields.takenOutTo ?? null,
      takenOutBy: keptFields.takenOutBy ?? null,
    });
    record.history.push({
      action: 'CLOSED',
      by: req.user.id,
      at,
      note: note ?? null,
      countedCashInPaise,
      expectedCashInPaise,
      differenceInPaise,
      ...(counted ? { cashCount: counted.cashCount } : {}),
      keptForTomorrowInPaise: keptFields.keptForTomorrowInPaise ?? null,
      takenOutAtCloseInPaise: keptFields.takenOutAtCloseInPaise ?? null,
    });
    record.markModified('snapshot');
    record.markModified('checks');
    await record.save(opts(session));

    await recordAudit(
      req,
      {
        action: AUDIT_ACTIONS.DAY_CLOSED,
        entityType: AUDIT_ENTITY_TYPES.DAY,
        entityId: record._id,
        entityLabel: businessDate,
        reason: note ?? 'Day closed',
        amountInPaise: figures.sales.billTotalInPaise,
        details: { countedCashInPaise, differenceInPaise, keptForTomorrowInPaise: keptFields.keptForTomorrowInPaise ?? null, takenOutAtCloseInPaise: keptFields.takenOutAtCloseInPaise ?? null },
      },
      session,
    );

    return record;
  });

  // P44. The day-end email, after the close is saved: a failure never undoes the close.
  closure.dayEndEmail = await emailDayEnd(req, businessDate, { quiet: true });

  const view = presentClosure(closure);
  return (await seesCash(req)) ? view : blind(view);
}

/**
 * P44. Emails the day-end message to the owner's chosen addresses, and keeps
 * the result on a closed day's record. `quiet` (at Day Close): nothing set up
 * sends nothing and returns null, and a failure is kept, not thrown. Otherwise
 * (Email this report) every refusal is thrown in plain words.
 */
export async function emailDayEnd(req, businessDate, { quiet = false } = {}) {
  const addresses = (await getSetting(req.restaurantId, 'reports.dayEndEmails', { req })) ?? [];
  if (addresses.length === 0) {
    if (quiet) return null;
    throw new BusinessRuleError('Add an email address for the day-end report in Settings first.');
  }
  if (!isEmailSetUp()) {
    if (quiet) return null;
    throw new BusinessRuleError('Email is not set up on the server.');
  }

  let result;
  try {
    const { subject, text } = await buildDayEndMessage(req, businessDate, { full: true });
    await sendEmail({ to: addresses, subject, text });
    result = { sentAt: nowUtc(), to: addresses, error: null };
  } catch (error) {
    if (!quiet) throw error;
    req.log?.warn({ businessDate, err: error.message }, 'Day-end email failed after the close.');
    result = { sentAt: null, to: addresses, error: error.message };
  }
  await DayClosure.updateOne({ ...scoped(req), businessDate, status: DAY_STATUSES.CLOSED }, { $set: { dayEndEmail: result } });
  return result;
}

/** GET /day-close/:businessDate. The stored close, or the live figures and blockers. */
export async function readDay(req, businessDate) {
  const view = await readDayView(req, businessDate);
  return (await seesCash(req)) ? view : blind(view);
}

/** P44. Whether this caller may see the expected cash: the same rule as GET /day-close/:businessDate. */
export { seesCash };

/**
 * The day as the owner sees it, before the blind count is applied. P44: the
 * day-end email goes only to the owner's chosen addresses, so it is built
 * from this; anything shown to the caller goes through readDay.
 */
export async function readDayView(req, businessDate) {
  const closure = await DayClosure.findOne({ ...scoped(req), businessDate });
  let view;
  if (closure?.status === DAY_STATUSES.CLOSED) {
    view = presentClosure(closure);
  } else {
    const figures = await computeDayFigures(req, businessDate);
    const checks = await runDayChecks(req, businessDate, figures);
    view = {
      businessDate,
      status: closure?.status ?? 'OPEN',
      isClosed: false,
      countedCashInPaise: null,
      cashCount: null,
      keptForTomorrowInPaise: null,
      keptForTomorrowCount: null,
      takenOutAtCloseInPaise: null,
      takenOutTo: null,
      expectedCashInPaise: figures.cash.expectedCashInPaise,
      differenceInPaise: null,
      note: null,
      figures,
      checks,
      blockers: await blockersFor(req, businessDate, checks),
      // P61. Orders nothing was sent from: closed by the close, not blocking it.
      closesOnClose: (await ordersClosingOnClose(req, businessDate)).map(presentUnsent),
      closedBy: null,
      closedAt: null,
      history: closure ? closure.toJSON().history : [],
    };
  }
  return view;
}

/** GET /day-close?from&to. One row per date with a closure record. */
export async function listDays(req, { from, to }) {
  const filter = { ...scoped(req) };
  if (from || to) filter.businessDate = {};
  if (from) filter.businessDate.$gte = from;
  if (to) filter.businessDate.$lte = to;

  const closures = await DayClosure.find(filter).sort({ businessDate: -1 });
  const showCash = await seesCash(req);
  return closures.map((closure) => {
    const row = {
      businessDate: closure.businessDate,
      status: closure.status,
      countedCashInPaise: closure.countedCashInPaise,
      expectedCashInPaise: closure.expectedCashInPaise,
      differenceInPaise: closure.differenceInPaise,
      billTotalInPaise: closure.snapshot?.sales?.billTotalInPaise ?? null,
      closedAt: closure.closedAt,
    };
    if (!showCash) {
      delete row.expectedCashInPaise;
      delete row.differenceInPaise;
    }
    return row;
  });
}

/** POST /day-close/:businessDate/reopen. OWNER, with a reason. */
export async function reopenDay(req, businessDate, { reason }) {
  const closure = await DayClosure.findOne({ ...scoped(req), businessDate });
  if (!closure || closure.status !== DAY_STATUSES.CLOSED) {
    throw new BusinessRuleError(`${businessDate} is not closed.`);
  }

  await withOptionalTransaction(async (session) => {
    closure.status = DAY_STATUSES.REOPENED;
    closure.history.push({ action: 'REOPENED', by: req.user.id, at: nowUtc(), note: reason });
    await closure.save(opts(session));
    await recordAudit(
      req,
      {
        action: AUDIT_ACTIONS.DAY_REOPENED,
        entityType: AUDIT_ENTITY_TYPES.DAY,
        entityId: closure._id,
        entityLabel: businessDate,
        reason,
        amountInPaise: closure.snapshot?.sales?.billTotalInPaise ?? null,
      },
      session,
    );
    // P25 Part J. A reopened day's Tally exports no longer describe it.
    await markDayStale(req, businessDate, session);
  });

  return presentClosure(closure);
}

/**
 * GET /day-close/:businessDate/print. Plain text laid out like the receipt:
 * sections A, B, D and G, the checks, and who closed it. The blind count
 * applies to the print exactly as to the screen.
 */
export async function printDay(req, businessDate, width) {
  const day = await readDay(req, businessDate);
  if (!day) throw new NotFoundError('Nothing to print for that date.');
  const { figures } = day;
  const money = (paise) => paiseToRupees(paise);
  const lines = [];
  const push = (line) => lines.push(line);
  const heading = (text) => {
    push('');
    push(text.toUpperCase().slice(0, width));
    push(rule(width));
  };

  push(centre('DAY CLOSE', width));
  push(centre(businessDate, width));
  if (!day.isClosed) push(centre('NOT CLOSED YET', width));
  push(rule(width, '='));

  heading('Sales');
  const s = figures.sales;
  push(row('Bills', String(s.billCount), width));
  push(row('Covers', String(s.covers), width));
  push(row('Item total', money(s.itemTotalInPaise), width));
  push(row('Discount', money(s.discountInPaise), width));
  push(row('Net sales', money(s.netSalesInPaise), width));
  push(row('CGST', money(s.cgstInPaise), width));
  push(row('SGST', money(s.sgstInPaise), width));
  push(row('GST', money(s.gstInPaise), width));
  push(row('Round-off', money(s.roundOffInPaise), width));
  push(row('Bill total', money(s.billTotalInPaise), width));
  push(row('Average bill', money(s.averageBillInPaise), width));
  push(row('Average per cover', money(s.averagePerCoverInPaise), width));

  heading('Where the bill total went');
  for (const method of figures.money.methods) push(row(method.methodName, money(method.amountInPaise), width));
  push(row('Money in hand', money(figures.money.inHandInPaise), width));
  push(row('Platform money', money(figures.money.platformInPaise), width));
  for (const account of figures.money.onHold) {
    push(row(`On Hold: ${account.accountName}`, money(account.amountInPaise), width));
  }
  push(row('Unpaid', money(figures.money.unpaidInPaise), width));
  push(row('Total', money(figures.money.totalInPaise), width));

  heading('Cash book');
  const c = figures.cash;
  if (c.broughtForward) push(row(`Brought forward from ${c.broughtForward.fromDate}`, money(c.broughtForward.keptInPaise ?? 0), width));
  push(row('Opening float', money(c.openingFloatInPaise), width));
  push(row('Top-ups', money(c.paidInInPaise), width));
  push(row('Cash from bills', money(c.cashFromBillsInPaise), width));
  push(row('Cash collections', money(c.cashCollectionsInPaise), width));
  push(row('Expenses', money(c.paidOutInPaise), width));
  for (const category of c.expensesByCategory ?? []) push(row(`  ${category.label}`, money(category.amountInPaise), width));
  if (c.cashTakenOutInPaise !== undefined) push(row('Cash taken out', money(c.cashTakenOutInPaise), width));
  if (c.expectedCashInPaise !== undefined) push(row('Expected cash', money(c.expectedCashInPaise), width));
  if (day.countedCashInPaise !== null) push(row('Counted cash', money(day.countedCashInPaise), width));
  // P25 Part F. Each note and coin counted, its count and its value.
  for (const entry of day.cashCount ?? []) {
    const label = `  ${paiseToRupees(entry.valueInPaise)} ${entry.kind === 'COIN' ? 'coin' : 'note'} x ${entry.count}`;
    push(row(label, money(entry.valueInPaise * entry.count), width));
  }
  if (day.differenceInPaise !== undefined && day.differenceInPaise !== null) {
    push(row('Cash difference', money(day.differenceInPaise), width));
  }
  // P29 Part F. What the counter kept and what went out after the count.
  if (day.keptForTomorrowInPaise !== null && day.keptForTomorrowInPaise !== undefined) {
    push(row('Kept for tomorrow', money(day.keptForTomorrowInPaise), width));
    push(row('Taken out at close', money(day.takenOutAtCloseInPaise ?? 0), width));
  }

  heading('Controls');
  const g = figures.controls;
  push(row(`Discounts (${g.discounts.count})`, money(g.discounts.totalInPaise), width));
  push(row(`No Charge (${g.noCharge.count})`, money(g.noCharge.valueInPaise), width));
  push(row(`Orders cancelled (${g.cancelledOrders.count})`, money(g.cancelledOrders.valueInPaise), width));
  push(row(`Voided bills (${g.voidedBills.count})`, money(g.voidedBills.valueInPaise), width));

  heading('Checks');
  for (const check of day.checks) {
    const mark = check.passed ? 'OK' : check.severity === SEVERITY.ERROR ? 'FAIL' : 'LOOK';
    for (const part of wrapName(`${mark} ${check.message}`, width, 2)) push(part);
  }

  push(rule(width, '='));
  if (day.isClosed && day.closedBy) {
    const closer = await User.findOne({ ...scoped(req), _id: day.closedBy }).select('name').lean();
    for (const part of wrapName(`Closed by ${closer?.name ?? 'Unknown'} at ${formatTimeIst12(day.closedAt)}`, width, 0)) {
      push(part);
    }
  }

  return lines.map((line) => line.slice(0, width)).join('\n');
}

export default { closeDay, listDays, printDay, readDay, reopenDay };
