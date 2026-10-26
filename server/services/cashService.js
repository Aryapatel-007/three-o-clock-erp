/**
 * The cash drawer. M16, built in P10. docs/API-CONTRACT.md "M16" sections 3
 * and 9.
 *
 * The opening float, top-ups (paid in), expenses (paid out), and from P29
 * cash taken out and cash checks. Each takes today's business date from the
 * service clock and nothing else. Voided, never deleted. Cash taken for bills
 * and cash collected on accounts are not here: they are payments and account
 * entries, and computeDayFigures adds them in.
 *
 * P29 Part F, the cash book. The flow reads like the owner's own drawing:
 * brought forward + top-ups + cash sales + cash collections - expenses - cash
 * taken out = cash in drawer. The blind count still works: the server leaves
 * the cash in the drawer and every difference out for anyone who may not see
 * them (seesDrawerTotal), never only hiding them on screen.
 */
import { ROLES } from '../config/roles.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { CASH_MOVEMENT_TYPES, CashMovement } from '../models/CashMovement.js';
import { DAY_STATUSES, DayClosure } from '../models/DayClosure.js';
import { User } from '../models/User.js';
import { BusinessRuleError, CashCountMismatchError, DuplicateError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { CashCountError, sumCashCount } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';
import { recordAudit } from './auditService.js';
import { assertDayOpen, todayBusinessDate } from './dayLockService.js';
import { approverForManagerTask, approverIfNeeded } from './approvalService.js';
import { getSetting, getSettings } from './settingsService.js';

const DUPLICATE_KEY = 11000;

/** The types counted by notes and coins: the float, cash taken out and a cash check. */
const COUNTED = [CASH_MOVEMENT_TYPES.OPENING_FLOAT, CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT, CASH_MOVEMENT_TYPES.CASH_CHECK];

/**
 * P29 Part F. Whether this caller sees the cash in the drawer and every
 * difference: the owner always; staff only when `cash.showDrawerTotalToStaff`
 * is on, and a manager also when the Day Close blind count is switched off for
 * managers (`dayClose.showCashDifferenceToManager`).
 */
export async function seesDrawerTotal(req) {
  if (req.user.role === ROLES.OWNER) return true;
  const settings = await getSettings(req.restaurantId, { req });
  if (settings.cash.showDrawerTotalToStaff) return true;
  return req.user.role === ROLES.MANAGER && Boolean(settings.dayClose.showCashDifferenceToManager);
}

/** A movement as a caller may see it: a cash check's expected cash and difference only for those who see the total. */
function present(movement, seesTotal) {
  const json = typeof movement.toJSON === 'function' ? movement.toJSON() : { ...movement };
  if (!seesTotal) {
    delete json.expectedCashInPaise;
    delete json.differenceInPaise;
  }
  return json;
}

/** GET /cash-movements?date=. Default today's business date. Voided ones included, marked. */
export async function listCashMovements(req, { date } = {}) {
  const businessDate = date ?? (await todayBusinessDate(req));
  const movements = await CashMovement.find({ ...scoped(req), businessDate }).sort({ at: 1 });
  const seesTotal = await seesDrawerTotal(req);
  return { businessDate, movements: movements.map((movement) => present(movement, seesTotal)) };
}

/** The most recent closed day before `businessDate` that kept cash for tomorrow, or null. */
function lastKeptClose(req, businessDate) {
  return DayClosure.findOne({
    ...scoped(req),
    status: DAY_STATUSES.CLOSED,
    businessDate: { $lt: businessDate },
    keptForTomorrowInPaise: { $type: 'number' },
  })
    .sort({ businessDate: -1 })
    .lean();
}

/** An active person of this restaurant, for who took cash out. Defaults to the actor. */
async function takerOf(req, takenBy) {
  if (!takenBy || String(takenBy) === String(req.user.id)) return req.user.id;
  const person = await User.findOne({ restaurantId: req.restaurantId, _id: takenBy, isActive: true }).select('_id').lean();
  if (!person) throw new BusinessRuleError('That person is not on the staff list. Pick someone who is.');
  return person._id;
}

/**
 * POST /cash-movements. P28 approvals unchanged: a cashier's expense (paid
 * out) needs an owner's or manager's PIN and is refused when
 * `approvals.managerTasks` is off; a cashier's top-up (paid in) needs the PIN
 * when `approvals.paidIn` is on. P29: cash taken out is owner and manager
 * only; a cash check and the opening float need nobody.
 */
export async function recordCashMovement(req, body) {
  const { type, reason = null, cashCount = null, approval = null, source = null, category = null, destination = null, takenBy = null, broughtForward = false } = body;
  let { amountInPaise } = body;
  const settings = await getSettings(req.restaurantId, { req });
  const { approvals } = settings;

  let approvedBy = null;
  if (type === CASH_MOVEMENT_TYPES.PAID_OUT) {
    approvedBy = await approverForManagerTask(req, approval, approvals, 'Only an owner or a manager can take cash out of the drawer.');
  } else if (type === CASH_MOVEMENT_TYPES.PAID_IN) {
    approvedBy = await approverIfNeeded(req, approval, approvals.paidIn);
  } else if (type === CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT && ![ROLES.OWNER, ROLES.MANAGER].includes(req.user.role)) {
    throw new ForbiddenError('Only an owner or a manager can take cash out to the bank or the owner.');
  }

  // P25 Part F, and P29 for cash taken out and a check: a count by notes, totalled here.
  let counted = null;
  if (cashCount) {
    counted = await countCash(req, cashCount);
    if (amountInPaise !== undefined && amountInPaise !== counted.totalInPaise) {
      throw new CashCountMismatchError(counted.totalInPaise, amountInPaise);
    }
    amountInPaise = counted.totalInPaise;
    if (amountInPaise <= 0 && type !== CASH_MOVEMENT_TYPES.CASH_CHECK) {
      throw new BusinessRuleError('Count at least one note or coin.');
    }
  }
  if (cashCount && !COUNTED.includes(type)) throw new BusinessRuleError('Only the float, cash taken out and a cash check are counted by notes.');

  const businessDate = await todayBusinessDate(req);
  const extra = {};

  // P29 Part F. An expense's category, checked against the restaurant's own list and frozen with its label.
  if (type === CASH_MOVEMENT_TYPES.PAID_OUT && category) {
    const found = settings.cash.expenseCategories.find((entry) => entry.code === category && entry.isActive);
    if (!found) throw new BusinessRuleError('That expense category is not on the list. Pick one that is.');
    Object.assign(extra, { category: found.code, categoryLabel: found.label });
  }
  if (type === CASH_MOVEMENT_TYPES.PAID_IN && source) extra.source = source;
  if (type === CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT) Object.assign(extra, { destination, takenBy: await takerOf(req, takenBy) });

  // P29 Part F. Yesterday's kept cash, confirmed as today's float, or recounted.
  let differed = null;
  if (type === CASH_MOVEMENT_TYPES.OPENING_FLOAT && broughtForward) {
    const kept = await lastKeptClose(req, businessDate);
    if (!kept) throw new BusinessRuleError('There is no cash kept from a closed day to bring forward. Count the float instead.');
    extra.broughtForwardFrom = kept.businessDate;
    if (amountInPaise === undefined) {
      amountInPaise = kept.keptForTomorrowInPaise;
      if (kept.keptForTomorrowCount?.length) counted = { cashCount: kept.keptForTomorrowCount, totalInPaise: amountInPaise };
    }
    if (amountInPaise <= 0) throw new BusinessRuleError('Nothing was kept in the drawer last night. Count the float instead.');
    const difference = amountInPaise - kept.keptForTomorrowInPaise;
    if (difference !== 0) {
      if (!reason) throw new BusinessRuleError('Say why the drawer is not what was kept last night.');
      extra.openingDifferenceInPaise = difference;
      differed = { kept: kept.keptForTomorrowInPaise, fromDate: kept.businessDate };
    }
  }

  // P29 Part F. A check stores the cash in the drawer at that moment, and the difference. It moves no money.
  if (type === CASH_MOVEMENT_TYPES.CASH_CHECK) {
    const { computeDayFigures } = await import('./dayFiguresService.js');
    const expected = (await computeDayFigures(req, businessDate)).cash.expectedCashInPaise;
    Object.assign(extra, { expectedCashInPaise: expected, differenceInPaise: amountInPaise - expected });
  }

  try {
    const movement = await withOptionalTransaction(async (session) => {
      await assertDayOpen(req, businessDate, { session });

      const [created] = await CashMovement.create(
        [{ ...scoped(req), type, amountInPaise, reason, businessDate, at: nowUtc(), by: req.user.id, approvedBy, ...extra, ...(counted ? { cashCount: counted.cashCount } : {}) }],
        session ? { session } : {},
      );

      if (type === CASH_MOVEMENT_TYPES.PAID_OUT) {
        await recordAudit(
          req,
          {
            action: AUDIT_ACTIONS.CASH_PAID_OUT,
            entityType: AUDIT_ENTITY_TYPES.CASH,
            entityId: created._id,
            entityLabel: `Paid out ${businessDate}`,
            reason: reason ?? extra.categoryLabel ?? 'Expense',
            amountInPaise,
            details: { businessDate, category: extra.category ?? null, ...(approvedBy ? { approvedBy: String(approvedBy) } : {}) },
          },
          session,
        );
      }
      // P28. A paid in someone else approved is never silent.
      if (type === CASH_MOVEMENT_TYPES.PAID_IN && approvedBy) {
        await recordAudit(
          req,
          {
            action: AUDIT_ACTIONS.CASH_PAID_IN,
            entityType: AUDIT_ENTITY_TYPES.CASH,
            entityId: created._id,
            entityLabel: `Paid in ${businessDate}`,
            reason: reason ?? 'Top-up',
            amountInPaise,
            details: { businessDate, source: extra.source ?? null, approvedBy: String(approvedBy) },
          },
          session,
        );
      }
      // P29 Part F. Cash out of the drawer that is not an expense.
      if (type === CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT) {
        await recordAudit(
          req,
          {
            action: AUDIT_ACTIONS.CASH_TAKEN_OUT,
            entityType: AUDIT_ENTITY_TYPES.CASH,
            entityId: created._id,
            entityLabel: `Cash taken out ${businessDate}`,
            reason: reason ?? (destination === 'BANK_DEPOSIT' ? 'Bank deposit' : 'Given to the owner'),
            amountInPaise,
            details: { businessDate, destination, takenBy: String(extra.takenBy) },
          },
          session,
        );
      }
      // P29 Part F. A morning float that was not what was kept the night before.
      if (differed) {
        await recordAudit(
          req,
          {
            action: AUDIT_ACTIONS.OPENING_FLOAT_DIFFERED,
            entityType: AUDIT_ENTITY_TYPES.CASH,
            entityId: created._id,
            entityLabel: `Opening float ${businessDate}`,
            reason,
            amountInPaise: extra.openingDifferenceInPaise,
            details: { businessDate, fromDate: differed.fromDate, keptInPaise: differed.kept, countedInPaise: amountInPaise },
          },
          session,
        );
      }
      return created;
    });
    return present(movement, await seesDrawerTotal(req));
  } catch (error) {
    if (error?.code === DUPLICATE_KEY) {
      throw new DuplicateError(
        'An opening float is already recorded for today. Void it first if it was wrong.',
      );
    }
    throw error;
  }
}

/**
 * POST /cash-movements/:id/void. OWNER and MANAGER, with a reason; from
 * 2026-10-17 a CASHIER too, with an owner's or manager's PIN, exactly as for
 * an expense.
 */
export async function voidCashMovement(req, movementId, { reason, approval = null }) {
  const { approvals } = await getSettings(req.restaurantId, { req });
  const voidApprovedBy = await approverForManagerTask(req, approval, approvals, 'Only an owner or a manager can void a cash entry.');
  const movement = await CashMovement.findOne({ ...scoped(req), _id: movementId });
  if (!movement) throw new NotFoundError('Cash entry not found.');
  if (movement.isVoided) throw new BusinessRuleError('This cash entry is already voided.');

  await assertDayOpen(req, movement.businessDate);

  movement.isVoided = true;
  movement.voidedAt = nowUtc();
  movement.voidedBy = req.user.id;
  movement.voidReason = reason;
  movement.voidApprovedBy = voidApprovedBy;
  await movement.save();
  return present(movement, await seesDrawerTotal(req));
}

/** The business date `days` before `businessDate`, as "YYYY-MM-DD". */
function daysBefore(businessDate, days) {
  return new Date(Date.parse(`${businessDate}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * GET /cash-book?date=. P29 Part F, API-CONTRACT M16 section 9.5. The day's
 * cash as the owner drew it, with what to propose as the float, yesterday at
 * a glance, and the last amount spent on each expense category for "Same as
 * last time". The total and every difference only for those who may see them.
 */
export async function readCashBook(req, { date } = {}) {
  const businessDate = date ?? (await todayBusinessDate(req));
  const { computeDayFigures } = await import('./dayFiguresService.js');
  const [figures, closure, kept, previous, seesTotal, recentExpenses, cashBillCount] = await Promise.all([
    computeDayFigures(req, businessDate),
    DayClosure.findOne({ ...scoped(req), businessDate }).select('status').lean(),
    lastKeptClose(req, businessDate),
    DayClosure.findOne({ ...scoped(req), status: DAY_STATUSES.CLOSED, businessDate: { $lt: businessDate } }).sort({ businessDate: -1 }).lean(),
    seesDrawerTotal(req),
    CashMovement.find({
      ...scoped(req),
      type: CASH_MOVEMENT_TYPES.PAID_OUT,
      isVoided: false,
      category: { $type: 'string' },
      businessDate: { $gte: daysBefore(businessDate, 7), $lte: businessDate },
    })
      .sort({ at: -1 })
      .select('category amountInPaise')
      .lean(),
    Bill.countDocuments({
      ...scoped(req),
      isVoided: false,
      $or: [
        { payments: { $elemMatch: { method: 'CASH', businessDate } } },
        { businessDate, payments: { $elemMatch: { method: 'CASH', businessDate: null } } },
      ],
    }),
  ]);
  const movements = await CashMovement.find({ ...scoped(req), businessDate }).sort({ at: 1 });
  const live = movements.filter((movement) => !movement.isVoided);
  const ofType = (type) => live.filter((movement) => movement.type === type);
  const float = ofType(CASH_MOVEMENT_TYPES.OPENING_FLOAT)[0] ?? null;
  const lastCheck = ofType(CASH_MOVEMENT_TYPES.CASH_CHECK).at(-1) ?? null;
  const { cash } = figures;

  const lastUsedExpense = {};
  for (const entry of recentExpenses) lastUsedExpense[entry.category] ??= entry.amountInPaise;

  const view = {
    businessDate,
    isClosed: closure?.status === DAY_STATUSES.CLOSED,
    broughtForward: kept
      ? {
          fromDate: kept.businessDate,
          keptInPaise: kept.keptForTomorrowInPaise,
          keptCount: kept.keptForTomorrowCount ?? null,
          confirmed: float
            ? { id: String(float._id), amountInPaise: float.amountInPaise, broughtForwardFrom: float.broughtForwardFrom ?? null, openingDifferenceInPaise: float.openingDifferenceInPaise ?? null, at: float.at }
            : null,
        }
      : null,
    openingFloatInPaise: cash.openingFloatInPaise,
    topUps: { totalInPaise: cash.paidInInPaise, count: ofType(CASH_MOVEMENT_TYPES.PAID_IN).length, bySource: cash.topUpsBySource },
    cashSales: { totalInPaise: cash.cashFromBillsInPaise, billCount: cashBillCount },
    cashCollections: { totalInPaise: cash.cashCollectionsInPaise, count: figures.collections.entries.filter((entry) => entry.method === 'CASH').length },
    expenses: { totalInPaise: cash.paidOutInPaise, count: ofType(CASH_MOVEMENT_TYPES.PAID_OUT).length, byCategory: cash.expensesByCategory },
    cashTakenOut: { totalInPaise: cash.cashTakenOutInPaise, count: ofType(CASH_MOVEMENT_TYPES.CASH_TAKEN_OUT).length },
    cashInDrawerInPaise: cash.expectedCashInPaise,
    lastCheck: lastCheck ? { at: lastCheck.at, countedInPaise: lastCheck.amountInPaise, differenceInPaise: lastCheck.differenceInPaise ?? null } : null,
    yesterday: previous
      ? {
          businessDate: previous.businessDate,
          countedCashInPaise: previous.countedCashInPaise,
          keptForTomorrowInPaise: previous.keptForTomorrowInPaise ?? null,
          takenOutAtCloseInPaise: previous.takenOutAtCloseInPaise ?? null,
          takenOutTo: previous.takenOutTo ?? null,
          expectedCashInPaise: previous.expectedCashInPaise,
          differenceInPaise: previous.differenceInPaise,
        }
      : null,
    lastUsedExpense,
    movements: movements.map((movement) => present(movement, seesTotal)),
  };

  if (!seesTotal) {
    delete view.cashInDrawerInPaise;
    if (view.lastCheck) delete view.lastCheck.differenceInPaise;
    if (view.yesterday) {
      delete view.yesterday.expectedCashInPaise;
      delete view.yesterday.differenceInPaise;
    }
  }
  return view;
}

export default { listCashMovements, readCashBook, recordCashMovement, seesDrawerTotal, voidCashMovement };

/**
 * Totals a count by notes and coins against this restaurant's denominations.
 * P25 Part F. Shared by the opening float, Day Close and a cash payment.
 */
export async function countCash(req, cashCount) {
  const denominations = await getSetting(req.restaurantId, 'cash.denominations', { req });
  try {
    return sumCashCount(cashCount, denominations);
  } catch (error) {
    if (error instanceof CashCountError) throw new BusinessRuleError(error.message);
    throw error;
  }
}
