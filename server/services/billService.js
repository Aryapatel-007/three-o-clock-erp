/**
 * Turning a finished order into a bill, and everything that happens to a bill
 * afterwards.
 *
 * Every business rule in M3 is either here or in billPermissionService.js.
 * Controllers read the request, call one of these, and send the answer.
 *
 * Three properties this file exists to hold:
 *
 * 1. A bill copies from the ORDER LINE, never from `menuitems`. The order line
 *    already copied name, price and tax rate when it was added. This file does
 *    not import the MenuItem model and must not start: the 7pm order bills at
 *    the 7pm price because the price travelled with the line, not because
 *    anything here looks it up.
 *
 * 2. Every figure comes from utils/tax.js. There is no arithmetic in this file
 *    beyond adding up payments, because two places that both work out a total
 *    eventually disagree by a rupee.
 *
 * 3. Creating a bill runs in a real transaction or not at all. The bill number
 *    is reserved inside it, so a failed insert burns no number.
 */
import { serveWithoutKotInSession } from './billWithoutKotService.js';
import mongoose from 'mongoose';

import { BILL_VOID_REASONS, reasonText } from '../config/cancelReasons.js';
import { DISCOUNT_REASONS } from '../config/discountReasons.js';
import { Bill, BILL_STATUSES } from '../models/Bill.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Order, ORDER_LINE_STATUSES, ORDER_STATUSES } from '../models/Order.js';
import { User } from '../models/User.js';
import { reverseChargeForVoid } from './accountService.js';
import { assertDayOpen, todayBusinessDate } from './dayLockService.js';
import { recordAudit } from './auditService.js';
import { reserveBillNumber } from './billNumberService.js';
import { frozenMethodFields, methodForBill } from './paymentMethodService.js';
import { ensureOnlineMethod, ONLINE_METHOD_CODE } from './paymentGatewayService.js';
import { advanceFor, refund, releaseAdvance } from './onlinePaymentService.js';
import { OnlinePayment, ONLINE_PAYMENT_STATUSES } from '../models/OnlinePayment.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { getSetting, getSettings } from './settingsService.js';
import { countCash } from './cashService.js';
import { carryPayments } from './billCarryService.js';
import { assertBillTakesMoney } from './billRevisionService.js';
import {
  assertBillHasLines,
  assertDiscountFits,
  assertNotPaid,
  assertNotVoided,
  assertOrderIsBillable,
  assertPaymentFits,
} from './billPermissionService.js';
import { applyVersionedUpdate, computeLineTotalInPaise } from './orderService.js';
import {
  AdvanceNotAppliedError,
  BillAlreadyExistsError,
  BusinessRuleError,
  CashCountMismatchError,
  ForbiddenError,
  NotFoundError,
  PaymentMethodNotAllowedError,
  TerminalRequiredError,
  TransactionRequiredError,
} from '../utils/errors.js';
import { sumPaise } from '../utils/money.js';
import { scoped } from '../utils/scopedQuery.js';
import { allocateLineShares, computeBillTotals, resolveDiscountAmount } from '../utils/tax.js';
import { businessDateFor, nowUtc } from '../utils/time.js';
import { withOptionalTransaction } from '../utils/transaction.js';

/** Mongo's duplicate key error. */
const DUPLICATE_KEY = 11000;

/**
 * Turns one order line into a bill line.
 *
 * `unitPriceInPaise` here is the per-unit price INCLUDING add-ons, which is
 * what was actually charged for one of these. The order stores the dish price
 * and the add-on prices separately and derives the line total; a bill freezes
 * the number that was printed, because it must still print the same in a year.
 */
export function toBillLine(line) {
  const lineTotalInPaise = computeLineTotalInPaise(line);

  /**
   * Built up from the parts rather than by dividing the line total by the
   * quantity. The division is exact today, but only because of how
   * computeLineTotalInPaise happens to be written, and a bill is the wrong
   * place to depend on that holding.
   */
  const unitPriceInPaise = sumPaise(
    line.unitPriceInPaise,
    ...(line.addOns ?? []).map((addOn) => addOn.priceInPaise),
  );

  return {
    orderLineId: line._id,
    menuItemId: line.menuItemId,
    itemName: line.itemName,
    variantName: line.variantName ?? null,
    addOnNames: (line.addOns ?? []).map((addOn) => addOn.name),
    quantity: line.quantity,
    unitPriceInPaise,
    taxRateBps: line.taxRateBps,
    lineTotalInPaise,
    // P03. Frozen on the order line when it was added; null on older orders.
    categoryId: line.categoryId ?? null,
    categoryName: line.categoryName ?? null,
    // P46.
    isOpenItem: line.isOpenItem === true,
    // P64.
    hsnCode: line.hsnCode ?? null,
    // P60.
    billedWithoutKot: line.billedWithoutKot === true,
  };
}

/**
 * Writes the computed figures onto a bill, and each line's share of them.
 * Never partially applied.
 *
 * `bill` is a Bill document or the plain object about to become one, and
 * `lines` are its lines in the same shape. Creating a bill and discounting one
 * both come through here, so the line shares are written by one piece of code
 * and can never drift from the totals beside them. allocateLineShares checks
 * C2 itself and throws before anything is saved if the shares do not balance.
 */
export function applyTotals(bill, lines, totals) {
  const shares = allocateLineShares(lines, totals);
  lines.forEach((line, index) => {
    line.discountShareInPaise = shares[index].discountShareInPaise;
    line.taxableInPaise = shares[index].taxableInPaise;
    line.taxInPaise = shares[index].taxInPaise;
  });

  bill.subtotalInPaise = totals.subtotalInPaise;
  bill.taxBreakdown = totals.taxBreakdown;
  bill.totalTaxInPaise = totals.totalTaxInPaise;
  bill.roundOffInPaise = totals.roundOffInPaise;
  bill.grandTotalInPaise = totals.grandTotalInPaise;
}

/**
 * The captain's name as it is right now, frozen onto the bill. P03.
 * "Unknown" rather than a failed bill if the user record cannot be found.
 */
async function captainNameFor(req, userId, session) {
  if (!userId) return 'Unknown';
  const user = await User.findOne({ ...scopedToRestaurant(req), _id: userId })
    .select('name')
    .session(session);
  return user?.name ?? 'Unknown';
}

/** The restaurant filter alone: a captain may have been created on another branch. */
function scopedToRestaurant(req) {
  return { restaurantId: req.restaurantId };
}

/**
 * Creates the bill for an order.
 *
 * Runs in a real transaction, always. Unlike every other write in this project
 * it does not fall back to running plainly, because the bill number's
 * gap-freedom is exactly the guarantee a transaction provides and there is no
 * degraded version of it worth shipping. See utils/errors.js
 * TransactionRequiredError.
 */
export async function createBill(req, { orderId, version, discount = null, preview = false, withoutKot = false }) {
  const session = await mongoose.startSession();
  let previewed = null;

  try {
    let created = null;

    let carriedSummary = null;
    let online = null;

    await session.withTransaction(async () => {
      carriedSummary = null;
      online = null;
      previewed = null;
      // P26. A reopened order carries the voided bill's discount and payments.
      const order = await Order.findOne({ ...scoped(req), _id: orderId }).select('reopenedFromBillId advancePaymentId').session(session).lean();
      // P57. Its discount is the voided bill's; a new one is given on the new bill.
      if (discount && order?.reopenedFromBillId) {
        throw new BusinessRuleError("This order carries its last bill's discount. Change it on the new bill.");
      }
      const voided = order?.reopenedFromBillId ? await Bill.findOne({ ...scoped(req), _id: order.reopenedFromBillId }).session(session) : null;
      // P60. The counter's dishes not sent become served without a KOT, in this same transaction.
      const billVersion = withoutKot ? await serveWithoutKotInSession(req, { orderId, version }, session) : version;
      created = await createBillInSession(req, { orderId, version: billVersion, discount: voided?.discount ?? null, requested: discount }, session);
      /**
       * P57. A preview is the bill exactly as it would be, then rolled back:
       * no number used, no order change, no audit line, nothing announced.
       */
      if (preview) {
        const shape = created.toJSON();
        delete shape.id;
        previewed = { ...shape, preview: true, billNumber: null };
        throw new PreviewOnly();
      }
      if (voided) {
        const today = await todayBusinessDate(req);
        const result = await carryPayments(req, { voided, newBill: created, order: { ...order, _id: order._id }, today }, session);
        created = result.newBill;
        await Order.updateOne({ ...scoped(req), _id: orderId }, { $set: { reopenedFromBillId: null } }, { session });
        carriedSummary = {
          fromBillId: String(voided._id),
          fromBillNumber: voided.billNumber,
          carriedInPaise: result.carriedInPaise,
          cashToGiveBackInPaise: result.cashToGiveBackInPaise,
          refundsOwed: result.refundsOwed,
        };
        if (result.onlineLeftoverInPaise > 0 && order.advancePaymentId) online = { id: order.advancePaymentId, amountInPaise: result.onlineLeftoverInPaise };
      }
    });

    // P24. Money paid online and not needed any more goes back through the gateway, after the transaction.
    if (online) {
      const payment = await OnlinePayment.findOne({ ...scoped(req), _id: online.id });
      if (payment) await refund(req, payment, { amountInPaise: online.amountInPaise, reason: 'The bill came to less than was paid' });
    }

    // P57. The discount given with the bill is audited as one given on it.
    if (discount) await auditDiscount(req, created, created.discount);

    return carriedSummary ? { ...created.toJSON(), carried: carriedSummary } : created;
  } catch (error) {
    if (error instanceof PreviewOnly) return previewed;
    throw await billCreationErrorFor(req, orderId, error);
  } finally {
    await session.endSession();
  }
}

/**
 * Turns the errors bill creation can meet into the ones the API answers with:
 * a second live bill is BILL_ALREADY_EXISTS carrying the one that exists, and a
 * connection that cannot run a transaction is TRANSACTION_REQUIRED.
 */
export async function billCreationErrorFor(req, orderId, error) {
  if (error?.code === DUPLICATE_KEY) {
    // The partial unique index on { restaurantId, orderId } caught a second
    // live bill. Hand back the one that exists so the client opens it.
    const existing = await Bill.findOne({ ...scoped(req), orderId, isVoided: false })
      .select('_id')
      .lean();
    return new BillAlreadyExistsError(existing?._id);
  }
  if (isTransactionUnavailable(error)) return new TransactionRequiredError();
  return error;
}

/**
 * The core of creating a bill, inside the transaction it is given. P25 Part E
 * runs it inside the transaction that voids the old bill and cancels lines.
 *
 * `discount`, P25 only: a discount carried over from a voided bill, applied as
 * the bill is created. `{ kind, valueInPaise, rateBps, reasonCode, note,
 * fundedBy, appliedBy }`; a flat amount larger than the new item total is
 * capped at it.
 */
export async function createBillInSession(req, { orderId, version, discount = null, requested = null }, session) {
  const order = await Order.findOne({ ...scoped(req), _id: orderId }).session(session);
  if (!order) throw new NotFoundError('Order not found.');

  assertOrderIsBillable(order);

  const lines = order.lines
    .filter((line) => line.status !== ORDER_LINE_STATUSES.CANCELLED)
    .map(toBillLine);

  assertBillHasLines(lines);

  const at = nowUtc();
  // P57. A discount chosen before the bill is made; otherwise one carried from a voided bill.
  const carried = requested ? requestedDiscount(req, requested, lines, at) : discount ? carriedDiscount(discount, lines) : null;
  const totals = computeBillTotals({ lines, discount: carried?.request ?? null });
  /**
   * Read inside the transaction, so the bill is numbered from the invoice
   * series as it is at this moment. Through settingsService, the one place
   * any module reads configuration from.
   */
  const settings = await getSettings(req.restaurantId, { session });
  const startMinutes = settings.business.businessDayStartsAtMinutes;
  // P10: a bill is never issued into a closed business day.
  await assertDayOpen(req, businessDateFor(at, startMinutes), { session });
  const numbering = await reserveBillNumber(
    { restaurantId: req.restaurantId, branchId: req.branchId, at, invoice: settings.invoice },
    session,
  );

  const captainName = await captainNameFor(req, order.openedBy, session);

  const draft = {
    restaurantId: req.restaurantId,
    branchId: req.branchId,
    ...numbering,
    orderId: order._id,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    tableName: order.tableName ?? null,
    // P06. Copied from the order, so a report groups delivery bills by
    // platform and knows which were billed at 0% for the platform.
    platform: order.platform ?? null,
    taxTreatment: order.taxTreatment ?? 'NORMAL',
    // P23. Where the order came from, frozen like everything else here.
    origin: order.origin ?? null,
    businessDate: businessDateFor(at, startMinutes),
    status: BILL_STATUSES.UNPAID,
    lines,
    discount: carried?.stored ?? null,
    payments: [],
    amountPaidInPaise: 0,
    billedBy: req.user.id,
    billedAt: at,
    // P03. Frozen from the order, so captain and covers reports never join back to it.
    captainId: order.openedBy ?? null,
    captainName,
    guestCount: order.guestCount ?? null,
    orderOpenedAt: order.openedAt ?? null,
  };
  applyTotals(draft, lines, totals);

  const [bill] = await Bill.create([draft], { session });

  /**
   * The order keeps its status. It moves to BILLED when the bill is PAID,
   * not when it is created, because M2 decided BILLED frees the table and
   * the customers are still sitting there until they have paid.
   */
  await applyVersionedUpdate(req, {
    orderId: order._id,
    version,
    update: { $set: { billId: bill._id } },
    session,
  });

  return bill;
}

/**
 * A discount carried over from a voided bill (P25 Part E): a percent stays the
 * same percent; a flat amount stays the same, capped at the new item total.
 */
function carriedDiscount(discount, lines) {
  const subtotal = sumPaise(...lines.map((line) => line.lineTotalInPaise));
  const request =
    discount.kind === 'PERCENT'
      ? { kind: 'PERCENT', rateBps: discount.rateBps, valueInPaise: null }
      : { kind: 'FLAT', valueInPaise: Math.min(discount.valueInPaise ?? discount.amountInPaise, subtotal), rateBps: null };
  const amountInPaise = resolveDiscountAmount(request, subtotal);
  return {
    request,
    stored: {
      ...request,
      amountInPaise,
      reason: discount.note ?? discount.reason ?? null,
      reasonCode: discount.reasonCode ?? null,
      fundedBy: discount.fundedBy ?? 'RESTAURANT',
      appliedBy: discount.appliedBy ?? null,
      appliedAt: nowUtc(),
    },
  };
}

/**
 * P57. A discount given as the bill is made: the same amount, refusal and
 * stored shape as POST /bills/:billId/discount.
 */
function requestedDiscount(req, { kind, valueInPaise, rateBps, reasonCode, note = null, fundedBy = 'RESTAURANT' }, lines, at) {
  const subtotal = sumPaise(...lines.map((line) => line.lineTotalInPaise));
  const request = { kind, valueInPaise: valueInPaise ?? null, rateBps: rateBps ?? null };
  const amountInPaise = resolveDiscountAmount(request, subtotal);
  assertDiscountFits(amountInPaise, subtotal);
  return {
    request,
    stored: { ...request, amountInPaise, reason: note ?? null, reasonCode, fundedBy, appliedBy: req.user.id, appliedAt: at },
  };
}

/** Thrown inside a preview's transaction so it rolls back. Never leaves this file. */
class PreviewOnly extends Error {}

/** A standalone mongod cannot start a transaction, and billing needs one. */
function isTransactionUnavailable(error) {
  const message = String(error?.message ?? '');
  return (
    error?.code === 20 ||
    /Transaction numbers are only allowed on a replica set/i.test(message) ||
    /does not support (?:sessions|transactions)/i.test(message) ||
    /Transactions are not supported/i.test(message)
  );
}

/** Reads one bill, scoped. 404 for another restaurant's, never 403. */
export async function readBill(req, billId, session = null) {
  const bill = await Bill.findOne({ ...scoped(req), _id: billId }).setOptions(
    session ? { session } : {},
  );
  if (!bill) throw new NotFoundError('Bill not found.');
  return bill;
}

/**
 * Applies a bill-level discount and recomputes everything.
 *
 * Replaces any existing discount rather than stacking: two discounts on one
 * bill is a conversation about which was authorised, and the audit trail
 * records each application either way.
 */
export async function applyDiscount(
  req,
  billId,
  { kind, valueInPaise, rateBps, reasonCode, note = null, fundedBy = 'RESTAURANT' },
) {
  const bill = await readBill(req, billId);

  // P10: a closed day answers first, before any rule about the bill itself.
  await assertDayOpen(req, bill.businessDate);
  assertNotVoided(bill);
  assertNotPaid(bill, 'discounted');

  const request = { kind, valueInPaise: valueInPaise ?? null, rateBps: rateBps ?? null };
  const amountInPaise = resolveDiscountAmount(request, bill.subtotalInPaise);
  assertDiscountFits(amountInPaise, bill.subtotalInPaise);

  const totals = computeBillTotals({ lines: bill.lines, discount: request });

  // P08: a fixed code, the optional note in `reason`, and who paid for it.
  bill.discount = {
    ...request,
    amountInPaise,
    reason: note ?? null,
    reasonCode,
    fundedBy,
    appliedBy: req.user.id,
    appliedAt: nowUtc(),
  };
  applyTotals(bill, bill.lines, totals);
  await bill.save();

  await auditDiscount(req, bill, bill.discount);

  return bill;
}

/** DISCOUNT_APPLIED, the same line whether the discount came with the bill (P57) or after it. */
async function auditDiscount(req, bill, discount) {
  await recordAudit(req, {
    action: AUDIT_ACTIONS.DISCOUNT_APPLIED,
    entityType: AUDIT_ENTITY_TYPES.BILL,
    entityId: bill._id,
    entityLabel: bill.billNumber,
    reason: reasonText(DISCOUNT_REASONS, discount.reasonCode, discount.reason),
    amountInPaise: discount.amountInPaise,
    details: { kind: discount.kind, rateBps: discount.rateBps ?? null, reasonCode: discount.reasonCode, fundedBy: discount.fundedBy },
  });
}

/**
 * Records a payment.
 *
 * When the payments reach the grand total the bill becomes PAID, the order
 * moves to BILLED, and the table frees. That is the moment the customer has
 * finished, which is why it is here and not at bill creation.
 */
/**
 * `terminal` is internal (P25 Part I): set only by the card machine flow, with
 * what the machine approved; no request can send it. `terminalBypassReason`
 * comes from a request: an owner or manager typing in a card-machine method
 * because the machine is down.
 */
/** P43. The built-in method for a way of paying the restaurant has no method for. */
const OTHER_METHOD_CODE = 'OTHER';

export async function recordPayment(req, billId, { method, amountInPaise, reference, tender = null, terminalBypassReason = null }, { terminal = null, session = null } = {}) {
  const bill = await readBill(req, billId, session);

  // P10: neither the bill's day nor today's may be closed. Checked first.
  await assertDayOpen(req, [bill.businessDate, await todayBusinessDate(req)]);

  assertNotVoided(bill);
  assertPaymentFits(bill, amountInPaise);
  // P29. Items added to the bill are still with the kitchen. A card machine approval is recorded regardless: the money moved.
  if (!terminal) await assertBillTakesMoney(req, bill, session);

  // P24. "Paid online" only ever comes from the advance, never from a cashier's pick.
  if (method === ONLINE_METHOD_CODE) {
    throw new PaymentMethodNotAllowedError('Paid online is added with Apply advance, not chosen by hand.');
  }
  // P24. An order paid online takes its advance first, so no guest pays twice.
  const order = await Order.findOne({ ...scoped(req), _id: bill.orderId }).select('advancePaymentId');
  const advance = await advanceFor(req, order);
  if (advance && advance.available > 0 && advance.payment.appliedInPaise === 0) throw new AdvanceNotAppliedError();

  // P08: the four method rules, then freeze the method onto the payment.
  const paymentMethod = await methodForBill(req, bill, method);
  // P43. Other says how it was paid: the mode is its reference, and it is not optional.
  if (paymentMethod.code === OTHER_METHOD_CODE && !reference?.trim()) {
    throw new BusinessRuleError('Say how it was paid, for example Cheque.');
  }

  // P25 Part I. A method on the card machine is taken there, not typed in.
  let bypassed = false;
  if (paymentMethod.terminalProvider && !terminal) {
    const required = await getSetting(req.restaurantId, 'payments.requireTerminalForLinkedMethods', { req });
    const isManager = ['OWNER', 'MANAGER'].includes(req.user.role);
    if (terminalBypassReason && !isManager) {
      throw new ForbiddenError('Only an owner or a manager can enter a card-machine payment by hand.');
    }
    if (required && !terminalBypassReason) throw new TerminalRequiredError();
    bypassed = Boolean(terminalBypassReason);
  }

  const settled = await addPaymentAndSettle(req, bill, {
    paymentMethod,
    amountInPaise,
    reference,
    tender: await checkedTender(req, amountInPaise, tender),
    terminal,
    session,
  });
  if (bypassed) {
    await recordAudit(req, {
      action: AUDIT_ACTIONS.TERMINAL_BYPASSED,
      entityType: AUDIT_ENTITY_TYPES.BILL,
      entityId: bill._id,
      entityLabel: bill.billNumber,
      reason: terminalBypassReason,
      amountInPaise,
      details: { method: paymentMethod.code },
    });
  }
  return settled;
}

/**
 * P25 Part F. A cash payment's tender: a count by notes totalled on the
 * server, at least the amount, and change exactly tendered minus amount.
 */
async function checkedTender(req, amountInPaise, tender) {
  if (!tender) return null;
  let rows;
  if (tender.cashCount) {
    const counted = await countCash(req, tender.cashCount);
    if (counted.totalInPaise !== tender.tenderedInPaise) throw new CashCountMismatchError(counted.totalInPaise, tender.tenderedInPaise);
    rows = counted.cashCount;
  }
  if (tender.tenderedInPaise < amountInPaise) {
    throw new BusinessRuleError('The cash handed over is less than the amount. Count again.');
  }
  if (tender.changeInPaise !== tender.tenderedInPaise - amountInPaise) {
    throw new BusinessRuleError('The change must be the cash handed over less the amount.');
  }
  return { ...(rows ? { cashCount: rows } : {}), tenderedInPaise: tender.tenderedInPaise, changeInPaise: tender.changeInPaise };
}

/**
 * Pushes one payment and settles the bill when the payments reach its total.
 * Shared by a cashier's payment and by applying an online advance (P24).
 */
async function addPaymentAndSettle(req, bill, { paymentMethod, amountInPaise, reference, tender = null, terminal = null, session = null }) {
  const startMinutes = await getSetting(req.restaurantId, 'business.businessDayStartsAtMinutes', {
    req,
  });

  const at = nowUtc();
  /**
   * P29 Part D. The bill screen asks for the print first; a payment taken on a
   * bill never printed is allowed and recorded, so the owner sees how often.
   * A platform order paid by the integration at pickup is never printed first.
   */
  if ((bill.printCount ?? 0) === 0 && !req.isIntegration) bill.paymentBeforePrint = true;
  bill.payments.push({
    ...frozenMethodFields(paymentMethod),
    businessDate: businessDateFor(at, startMinutes),
    amountInPaise,
    reference: reference ?? null,
    receivedBy: req.user.id,
    receivedAt: at,
    ...(tender ? { tender } : {}),
    ...(terminal ? { terminal } : {}),
  });
  bill.amountPaidInPaise = sumPaise(...bill.payments.map((payment) => payment.amountInPaise));

  const settled = bill.amountPaidInPaise >= bill.grandTotalInPaise;
  if (settled) {
    bill.status = BILL_STATUSES.PAID;
    bill.paidAt = at;
  }

  await bill.save(session ? { session } : {});

  if (settled) {
    /**
     * Not applyVersionedUpdate: the cashier has no order version in hand here,
     * and the order is not being raced for. It is still a scoped, targeted
     * write, and the pre hook on the Order schema keeps occupiesTable in step
     * with the status so the table frees.
     */
    await Order.updateOne(
      { ...scoped(req), _id: bill.orderId },
      { $set: { status: ORDER_STATUSES.BILLED }, $inc: { version: 1 } },
      session ? { session } : {},
    );
  }

  return bill;
}

/**
 * Puts an order's online advance on its bill. P24, API-CONTRACT M14 section 4.6.
 *
 * A payment of method ONLINE for the smaller of the advance and what is due,
 * received now, so the day figures and C3 count it on the bill's day. Any of
 * the advance left over is refunded at once. The advance is claimed with a
 * filtered write first, so two taps apply it once.
 */
export async function applyAdvance(req, billId) {
  const bill = await readBill(req, billId);
  await assertDayOpen(req, [bill.businessDate, await todayBusinessDate(req)]);
  assertNotVoided(bill);
  if (bill.status === BILL_STATUSES.ON_ACCOUNT) {
    throw new BusinessRuleError('This bill is charged to an account and takes no payment.');
  }
  await assertBillTakesMoney(req, bill);

  const order = await Order.findOne({ ...scoped(req), _id: bill.orderId }).select('advancePaymentId');
  const advance = await advanceFor(req, order);
  if (!advance || advance.available <= 0) {
    throw new BusinessRuleError('There is no online advance left to apply to this bill.');
  }
  const due = bill.grandTotalInPaise - bill.amountPaidInPaise;
  if (due <= 0) throw new BusinessRuleError('This bill is already paid.');

  const amountInPaise = Math.min(advance.available, due);
  const claimed = await OnlinePayment.findOneAndUpdate(
    {
      ...scoped(req),
      _id: advance.payment._id,
      status: { $in: [ONLINE_PAYMENT_STATUSES.PAID, ONLINE_PAYMENT_STATUSES.PARTLY_REFUNDED] },
      appliedInPaise: advance.payment.appliedInPaise,
    },
    { $inc: { appliedInPaise: amountInPaise }, $set: { appliedToBillId: bill._id, appliedAt: nowUtc(), appliedBy: req.user.id } },
    { new: true },
  );
  if (!claimed) throw new BusinessRuleError('The online advance was just applied. Refresh the bill.');

  await ensureOnlineMethod(req.restaurantId, req.branchId);
  const method = await PaymentMethod.findOne({ ...scoped(req), code: ONLINE_METHOD_CODE });
  const settled = await addPaymentAndSettle(req, bill, {
    paymentMethod: method,
    amountInPaise,
    reference: claimed.gatewayPaymentId,
  });

  // The bill came to less than the guest paid: the rest goes back now.
  const leftover = claimed.amountInPaise - claimed.appliedInPaise - claimed.refundedInPaise;
  let advanceRefundedInPaise = 0;
  if (leftover > 0) {
    const after = await refund(req, claimed, { amountInPaise: leftover, reason: 'The bill came to less than the advance' });
    advanceRefundedInPaise = after.refunds.at(-1)?.status === 'FAILED' ? 0 : leftover;
  }
  return { bill: settled, advanceRefundedInPaise };
}

/** The advance block on a bill read: what was paid online and what is left to apply. */
export async function advanceOnBill(req, bill) {
  const order = await Order.findOne({ ...scoped(req), _id: bill.orderId }).select('advancePaymentId');
  const advance = await advanceFor(req, order);
  if (!advance) return null;
  return {
    paymentId: String(advance.payment._id),
    amountInPaise: advance.payment.amountInPaise,
    appliedInPaise: advance.payment.appliedInPaise,
    refundedInPaise: advance.payment.refundedInPaise,
    available: advance.available,
  };
}

/**
 * Changes how one payment was made. P08.
 *
 * Only the method moves, never the amount: to change an amount, void and bill
 * again. The new method must pass every rule a new payment would. The payment
 * keeps its business date, because the money arrived when it arrived; only
 * the frozen method fields are replaced, and the history records the change.
 */
export async function correctPayment(req, billId, paymentId, { method, reason }) {
  const bill = await readBill(req, billId);
  assertNotVoided(bill);

  const payment = bill.payments.id(paymentId);
  if (!payment) throw new NotFoundError('Payment not found on this bill.');

  // P10: the bill's day, the day the money arrived, and today's must all be open.
  await assertDayOpen(req, [
    bill.businessDate,
    payment.businessDate ?? bill.businessDate,
    await todayBusinessDate(req),
  ]);

  if (payment.method === method) {
    throw new BusinessRuleError('That payment was already made by that method.');
  }
  const paymentMethod = await methodForBill(req, bill, method);

  const fromMethod = payment.method;
  const at = nowUtc();
  Object.assign(payment, frozenMethodFields(paymentMethod));
  payment.corrections.push({ fromMethod, toMethod: paymentMethod.code, by: req.user.id, at, reason });
  await bill.save();

  await recordAudit(req, {
    action: AUDIT_ACTIONS.PAYMENT_METHOD_CORRECTED,
    entityType: AUDIT_ENTITY_TYPES.BILL,
    entityId: bill._id,
    entityLabel: bill.billNumber,
    reason,
    amountInPaise: payment.amountInPaise,
    details: { paymentId: String(payment._id), fromMethod, toMethod: paymentMethod.code },
  });

  return bill;
}

/**
 * Voids a bill.
 *
 * Returns the order to READY_TO_BILL and re-occupies the table, so it can be
 * billed again correctly. The bill number stays spent: it is never reissued,
 * not to the replacement and not to anything else.
 *
 * Voiding never restocks. The food was made and eaten, and an automatic
 * restock on void turns a dishonest void into free inventory. If it genuinely
 * was not consumed, a storekeeper writes a visible manual adjustment.
 */
export async function voidBill(req, billId, { reasonCode, note = null, approvedBy = null }) {
  const existing = await readBill(req, billId);
  assertNotVoided(existing);

  const at = nowUtc();

  /**
   * P09: one transaction, because voiding a bill charged to an On Hold
   * account also takes the charge off the account's ledger, and the two must
   * land together or not at all.
   */
  return withOptionalTransaction((session) => voidBillInSession(req, billId, { reasonCode, note, at, approvedBy }, session));
}

/**
 * The core of voiding, inside the transaction it is given. P25 Part E voids a
 * bill and re-issues it in one transaction through here.
 */
export async function voidBillInSession(req, billId, { reasonCode, note = null, at = nowUtc(), approvedBy = null, toChangeItems = false }, session) {
  const bill = await readBill(req, billId, session);
  assertNotVoided(bill);
  // P10: a closed day's bills stay as they are.
  await assertDayOpen(req, bill.businessDate, { session });

  bill.isVoided = true;
  bill.voidedAt = at;
  bill.voidedBy = req.user.id;
  // P28. The owner or manager who typed their PIN for a cashier's void.
  bill.voidApprovedBy = approvedBy;
  // P04: a fixed code, and the free-text field now holds the optional note.
  bill.voidReasonCode = reasonCode;
  bill.voidReason = note ?? null;
  // P56. Voided only so the items could change, and billed again: on no list of voided bills.
  bill.isVoidedToChangeItems = toChangeItems;
  await bill.save(session ? { session } : {});

  await Order.updateOne(
    { ...scoped(req), _id: bill.orderId },
    { $set: { status: ORDER_STATUSES.READY_TO_BILL, billId: null }, $inc: { version: 1 } },
    session ? { session } : {},
  );

  await reverseChargeForVoid(req, bill, { session });

  // P24. A voided bill gives its online advance back to the order, for the next bill.
  for (const payment of bill.payments.filter((entry) => entry.method === ONLINE_METHOD_CODE)) {
    await releaseAdvance(req, bill._id, payment.amountInPaise, session);
  }

  await recordAudit(
    req,
    {
      action: AUDIT_ACTIONS.BILL_VOIDED,
      entityType: AUDIT_ENTITY_TYPES.BILL,
      entityId: bill._id,
      entityLabel: bill.billNumber,
      reason: reasonText(BILL_VOID_REASONS, reasonCode, note),
      amountInPaise: bill.grandTotalInPaise,
      details: {
        wasPaid: bill.amountPaidInPaise > 0,
        wasOnAccount: bill.status === BILL_STATUSES.ON_ACCOUNT,
        reasonCode,
        ...(approvedBy ? { approvedBy: String(approvedBy) } : {}),
      },
    },
    session,
  );

  return bill;
}

export default {
  applyDiscount,
  correctPayment,
  createBill,
  readBill,
  recordPayment,
  voidBill,
};
