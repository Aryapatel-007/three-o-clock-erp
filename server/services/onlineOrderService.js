/**
 * Online takeaway: quote, place, accept, decline. P23 (M14), API-CONTRACT M14.
 *
 * The rule this file exists to keep: nothing a guest sends reaches the kitchen
 * or a bill until a staff member accepts it, and accepting opens an ordinary
 * order through `openOrder`, with prices copied at that moment.
 */
import { guestLabelFor } from '../config/onlineReasons.js';
import { COUNTER_NAMES } from '../models/Counter.js';
import { ONLINE_ORDER_STATUSES, OnlineOrder } from '../models/OnlineOrder.js';
import { OnlinePayment, ONLINE_PAYMENT_KINDS } from '../models/OnlinePayment.js';
import { Order, ORDER_TYPES, ORIGIN_KINDS } from '../models/Order.js';
import {
  BusinessRuleError,
  NotFoundError,
  OnlineClosedError,
  OnlineOrderChangedError,
  RequestAlreadyDecidedError,
  TooManyOpenRequestsError,
  ValidationError,
} from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { computeBillTotals } from '../utils/tax.js';
import { formatTimeIst12, nowUtc } from '../utils/time.js';
import { fireOrder } from './kitchenService.js';
import {
  activePause,
  assertGuestToken,
  consentRecord,
  makeStatusToken,
  namesFor,
  nextReference,
  onlineSettings,
} from './onlineCommon.js';
import {
  attachToOrder,
  confirmFromReturn,
  paymentsById,
  presentPayment,
  readBackIfDue,
  refundAll,
  startPayment,
  takeawayAdvanceFor,
} from './onlinePaymentService.js';
import { pickupBounds, windowContaining } from './openingHoursService.js';
import { openOrder } from './orderOpenService.js';
import { buildLineSnapshots, computeLineTotalInPaise, serialiseOrder } from './orderService.js';
import { onlineConsent } from './customerService.js';
import { mirrorIsReadOnly } from './replication/writerState.js';

const MINUTE_MS = 60_000;
const MONGO_DUPLICATE_KEY = 11000;

/** At most this many waiting takeaway orders per phone per branch. */
export const MAX_WAITING_ORDERS_PER_PHONE = 2;

/* ------------------------------------------------------------------------- *
 * Status
 * ------------------------------------------------------------------------- */

/** WAITING past its deadline reads as EXPIRED. Derived here, never by a scheduler. */
export function effectiveStatus(doc, now = nowUtc()) {
  if (doc.status === ONLINE_ORDER_STATUSES.WAITING && doc.answerBy <= now) return ONLINE_ORDER_STATUSES.EXPIRED;
  return doc.status;
}

/** Stores EXPIRED on a request that has quietly run out, the first time anything touches it. */
async function persistExpiry(req, doc, now) {
  if (doc.status === ONLINE_ORDER_STATUSES.WAITING && doc.answerBy <= now) {
    const moved = await OnlineOrder.updateOne(
      { ...scoped(req), _id: doc._id, status: ONLINE_ORDER_STATUSES.WAITING },
      { $set: { status: ONLINE_ORDER_STATUSES.EXPIRED } },
    );
    // P24. Nobody answered, so money paid online goes back.
    if (moved.modifiedCount) await refundAll(req, doc.paymentId, 'Not answered in time');
  }
}

/** A filter for "waiting right now", which leaves out the quietly expired. */
export function waitingFilter(now) {
  return { status: ONLINE_ORDER_STATUSES.WAITING, answerBy: { $gt: now } };
}

/* ------------------------------------------------------------------------- *
 * Quote
 * ------------------------------------------------------------------------- */

/**
 * Prices lines exactly as an order would, and totals them with the bill's own
 * arithmetic. Writes nothing. The estimate is what the guest sees; the bill is
 * worked out again, from fresh snapshots, if the order is accepted.
 */
export async function quote(req, lines) {
  const snapshots = await buildLineSnapshots(req, lines);

  const display = snapshots.map((line) => ({
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    itemName: line.itemName,
    variantName: line.variantName,
    unitPriceInPaise: line.unitPriceInPaise,
    addOns: line.addOns,
    quantity: line.quantity,
    notes: line.notes,
    lineTotalInPaise: computeLineTotalInPaise(line),
  }));

  const totals = computeBillTotals({
    lines: display.map((line, index) => ({
      taxRateBps: snapshots[index].taxRateBps,
      lineTotalInPaise: line.lineTotalInPaise,
    })),
  });

  return {
    lines: display,
    estimate: {
      itemTotalInPaise: totals.subtotalInPaise,
      gstInPaise: totals.totalTaxInPaise,
      roundOffInPaise: totals.roundOffInPaise,
      billTotalInPaise: totals.grandTotalInPaise,
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Placing
 * ------------------------------------------------------------------------- */

/** The sentence the page shows when takeaway is not open, and why. */
function closedMessage(now, online, dayStartMinutes, pausedUntil) {
  if (pausedUntil) return `Not taking takeaway orders right now. Back at ${formatTimeIst12(pausedUntil)}.`;
  const open = windowContaining(now, online, dayStartMinutes);
  if (open) return 'The cafe is closing soon and is not taking more takeaway orders today.';
  return 'Closed for takeaway right now.';
}

/** The page's view of whether takeaway is open, for GET /public/:slug. */
export function takeawayState(now, online, dayStartMinutes, branch) {
  const pausedUntil = activePause(branch, now);
  const bounds = pickupBounds(now, online, dayStartMinutes);
  return {
    enabled: online.takeawayEnabled,
    openNow: Boolean(online.takeawayEnabled && bounds && !pausedUntil),
    pausedUntil,
    earliestPickupAt: bounds?.earliestPickupAt ?? null,
    latestPickupAt: bounds?.latestPickupAt ?? null,
    message: online.takeawayEnabled && (!bounds || pausedUntil) ? closedMessage(now, online, dayStartMinutes, pausedUntil) : null,
  };
}

export async function place(req, body) {
  const now = nowUtc();
  const { online, dayStartMinutes } = await onlineSettings(req);

  if (!online.takeawayEnabled) throw new OnlineClosedError('This cafe is not taking takeaway orders online.');

  // A retry or a double tap: the same request back, and nothing new written.
  // P24: unless the gateway failed to start its payment last time, when it tries again.
  const repeat = await OnlineOrder.findOne({ ...scoped(req), idempotencyKey: body.idempotencyKey });
  if (repeat?.status === ONLINE_ORDER_STATUSES.PAYMENT_FAILED) return retryPayment(req, repeat, online);
  if (repeat) return { created: false, doc: repeat, token: null };

  const pausedUntil = activePause(req.publicSite?.branch, now);
  const bounds = pickupBounds(now, online, dayStartMinutes);
  if (pausedUntil || !bounds) throw new OnlineClosedError(closedMessage(now, online, dayStartMinutes, pausedUntil));

  let pickupAt = bounds.earliestPickupAt;
  if (body.pickup !== 'ASAP') {
    // A minute's grace, so a time picked from the list a moment ago still counts.
    if (body.pickup < new Date(bounds.earliestPickupAt.getTime() - MINUTE_MS) || body.pickup > bounds.latestPickupAt) {
      throw new ValidationError('Choose a pickup time from the list.', {
        pickup: `Choose a time between ${formatTimeIst12(bounds.earliestPickupAt)} and ${formatTimeIst12(bounds.latestPickupAt)}.`,
      });
    }
    pickupAt = body.pickup;
  }

  const waiting = await OnlineOrder.countDocuments({
    ...scoped(req),
    customerPhone: body.customerPhone,
    ...waitingFilter(now),
  });
  if (waiting >= MAX_WAITING_ORDERS_PER_PHONE) {
    throw new TooManyOpenRequestsError('You already have orders waiting for the cafe. Please wait for them first.');
  }

  const priced = await quote(req, body.lines);
  // P24. Paid in full online first, when the cafe asks for it and has a gateway.
  const advanceInPaise = await takeawayAdvanceFor(req, online, priced.estimate);
  const reference = await nextReference(req, COUNTER_NAMES.ONLINE_ORDER, 'W');
  const { token, hash } = makeStatusToken();

  try {
    const doc = await OnlineOrder.create({
      ...scoped(req),
      reference,
      idempotencyKey: body.idempotencyKey,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      lines: priced.lines,
      estimate: priced.estimate,
      note: body.note,
      pickupAt,
      pickupWasAsap: body.pickup === 'ASAP',
      businessDate: bounds.businessDate,
      status: advanceInPaise > 0 ? ONLINE_ORDER_STATUSES.AWAITING_PAYMENT : ONLINE_ORDER_STATUSES.WAITING,
      // The cafe's clock starts when the money arrives.
      answerBy: advanceInPaise > 0 ? null : new Date(now.getTime() + online.takeawayAnswerWithinMinutes * MINUTE_MS),
      statusTokenHash: hash,
      marketingConsent: consentRecord(body.marketingConsent, now),
    });
    if (advanceInPaise > 0) {
      await startPayment(req, {
        kind: ONLINE_PAYMENT_KINDS.TAKEAWAY,
        request: doc,
        amountInPaise: advanceInPaise,
        online,
        slug: req.publicSite.branch.online.publicSlug,
        customer: { name: doc.customerName, contact: doc.customerPhone },
        description: `Takeaway ${reference}`,
      });
      return { created: true, doc: await OnlineOrder.findOne({ ...scoped(req), _id: doc._id }), token };
    }
    return { created: true, doc, token };
  } catch (error) {
    // Two copies of one request racing: the index let one in. Return that one.
    if (error?.code === MONGO_DUPLICATE_KEY && Object.hasOwn(error.keyPattern ?? {}, 'idempotencyKey')) {
      const winner = await OnlineOrder.findOne({ ...scoped(req), idempotencyKey: body.idempotencyKey });
      return { created: false, doc: winner, token: null };
    }
    throw error;
  }
}

/** A placed request whose payment never started: try the gateway again. */
async function retryPayment(req, doc, online) {
  await OnlineOrder.updateOne(
    { ...scoped(req), _id: doc._id, status: ONLINE_ORDER_STATUSES.PAYMENT_FAILED },
    { $set: { status: ONLINE_ORDER_STATUSES.AWAITING_PAYMENT } },
  );
  await startPayment(req, {
    kind: ONLINE_PAYMENT_KINDS.TAKEAWAY,
    request: doc,
    amountInPaise: doc.estimate.billTotalInPaise,
    online,
    slug: req.publicSite.branch.online.publicSlug,
    customer: { name: doc.customerName, contact: doc.customerPhone },
    description: `Takeaway ${doc.reference}`,
  });
  return { created: false, doc: await OnlineOrder.findOne({ ...scoped(req), _id: doc._id }), token: null };
}

/* ------------------------------------------------------------------------- *
 * Reading
 * ------------------------------------------------------------------------- */

/** The guest's view. A whitelist: no phone, no staff note, no staff name. */
export async function serialiseForGuest(req, doc, now = nowUtc()) {
  const status = effectiveStatus(doc, now);
  const payment = doc.paymentId ? await OnlinePayment.findOne({ ...scoped(req), _id: doc.paymentId }) : null;
  let orderNumber = null;
  if (doc.orderId) {
    const order = await Order.findOne({ ...scoped(req), _id: doc.orderId }).select('orderNumber');
    orderNumber = order?.orderNumber ?? null;
  }
  return {
    id: String(doc._id),
    reference: doc.reference,
    status,
    customerName: doc.customerName,
    pickupAt: doc.pickupAt,
    answerBy: doc.answerBy,
    lines: doc.lines.map((line) => ({
      itemName: line.itemName,
      variantName: line.variantName,
      addOns: line.addOns.map((addOn) => ({ name: addOn.name, priceInPaise: addOn.priceInPaise })),
      quantity: line.quantity,
      notes: line.notes,
      unitPriceInPaise: line.unitPriceInPaise,
      lineTotalInPaise: line.lineTotalInPaise,
    })),
    estimate: doc.estimate.toObject ? doc.estimate.toObject() : doc.estimate,
    declineReason: status === ONLINE_ORDER_STATUSES.DECLINED ? guestLabelFor(doc.declineReasonCode) : null,
    orderNumber,
    payment: presentPayment(payment, { forGuest: true }),
  };
}

export function serialiseForStaff(doc, names, now = nowUtc(), payments = new Map()) {
  const json = doc.toJSON();
  json.status = effectiveStatus(doc, now);
  json.payment = presentPayment(payments.get(String(doc.paymentId)) ?? null);
  json.decidedByName = doc.decidedBy ? (names.get(String(doc.decidedBy)) ?? null) : null;
  json.itemCount = doc.lines.reduce((sum, line) => sum + line.quantity, 0);
  return json;
}

export async function guestRead(req, id) {
  const doc = await OnlineOrder.findOne({ ...scoped(req), _id: id });
  assertGuestToken(doc, req);
  // P62. The read-only cloud mirror only shows what the box shipped: the read-back
  // and the expiry are the box's writes, made when the box reads it.
  if (mirrorIsReadOnly()) return serialiseForGuest(req, doc);
  // P24. A guest who paid and is watching this page sees it move, even without a webhook.
  if (doc.status === ONLINE_ORDER_STATUSES.AWAITING_PAYMENT && doc.paymentId) {
    const { online } = await onlineSettings(req);
    await readBackIfDue(req, await OnlinePayment.findOne({ ...scoped(req), _id: doc.paymentId }), { online });
    return serialiseForGuest(req, await OnlineOrder.findOne({ ...scoped(req), _id: id }));
  }
  await persistExpiry(req, doc, nowUtc());
  return serialiseForGuest(req, await OnlineOrder.findOne({ ...scoped(req), _id: id }));
}

/** P24. The guest's return from Razorpay's payment page. */
export async function guestPaymentReturn(req, id, body) {
  const doc = await OnlineOrder.findOne({ ...scoped(req), _id: id });
  assertGuestToken(doc, req);
  if (doc.paymentId) {
    const { online } = await onlineSettings(req);
    await confirmFromReturn(req, await OnlinePayment.findOne({ ...scoped(req), _id: doc.paymentId }), body, { online });
  }
  return serialiseForGuest(req, await OnlineOrder.findOne({ ...scoped(req), _id: id }));
}

export async function guestCancel(req, id) {
  const now = nowUtc();
  const doc = await OnlineOrder.findOne({ ...scoped(req), _id: id });
  assertGuestToken(doc, req);

  const cancelled = await OnlineOrder.findOneAndUpdate(
    {
      ...scoped(req),
      _id: id,
      $or: [waitingFilter(now), { status: ONLINE_ORDER_STATUSES.AWAITING_PAYMENT }],
    },
    { $set: { status: ONLINE_ORDER_STATUSES.CANCELLED, cancelledAt: now } },
    { new: true },
  );
  if (!cancelled) {
    await persistExpiry(req, doc, now);
    throw new RequestAlreadyDecidedError(effectiveStatus(doc, now));
  }
  // P24. Paid already: the money goes back. Not yet paid: a payment arriving later is refunded too.
  await refundAll(req, cancelled.paymentId, 'Cancelled by the guest');
  return serialiseForGuest(req, cancelled, now);
}

export async function list(req, { page, limit, status, date }) {
  const now = nowUtc();
  const filter = { ...scoped(req) };
  if (date) filter.businessDate = date;
  if (status === ONLINE_ORDER_STATUSES.WAITING) Object.assign(filter, waitingFilter(now));
  else if (status === ONLINE_ORDER_STATUSES.EXPIRED) {
    filter.$or = [
      { status: ONLINE_ORDER_STATUSES.EXPIRED },
      { status: ONLINE_ORDER_STATUSES.WAITING, answerBy: { $lte: now } },
    ];
  } else if (status) filter.status = status;

  // Waiting requests oldest first, the order they should be answered in.
  const sort = status === ONLINE_ORDER_STATUSES.WAITING ? { createdAt: 1 } : { createdAt: -1 };
  const [docs, total] = await Promise.all([
    OnlineOrder.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
    OnlineOrder.countDocuments(filter),
  ]);
  const names = await namesFor(req, docs.map((doc) => doc.decidedBy));
  const payments = await paymentsById(req, docs.map((doc) => doc.paymentId));
  return { data: docs.map((doc) => serialiseForStaff(doc, names, now, payments)), total };
}

export async function readOne(req, id) {
  const doc = await OnlineOrder.findOne({ ...scoped(req), _id: id });
  if (!doc) throw new NotFoundError('Online order not found.');
  const names = await namesFor(req, [doc.decidedBy]);
  return serialiseForStaff(doc, names, nowUtc(), await paymentsById(req, [doc.paymentId]));
}

/* ------------------------------------------------------------------------- *
 * Accepting and declining
 * ------------------------------------------------------------------------- */

function requestLinesOf(doc) {
  return doc.lines.map((line) => ({
    menuItemId: line.menuItemId,
    ...(line.variantId ? { variantId: line.variantId } : {}),
    addOnIds: line.addOns.map((addOn) => addOn.addOnId),
    quantity: line.quantity,
    ...(line.notes ? { notes: line.notes } : {}),
  }));
}

/**
 * Compares the guest's quote with the menu as it is now. Returns every
 * difference: an item that can no longer be ordered, or a price that moved.
 */
async function changesSinceQuote(req, doc) {
  const requested = requestLinesOf(doc);
  let fresh;
  try {
    fresh = await buildLineSnapshots(req, requested);
  } catch (error) {
    if (!(error instanceof BusinessRuleError)) throw error;
    // Something is unavailable. Price each line alone to name every one.
    const changes = [];
    for (const [index, line] of requested.entries()) {
      try {
        await buildLineSnapshots(req, [line]);
      } catch (lineError) {
        if (!(lineError instanceof BusinessRuleError)) throw lineError;
        changes.push({ itemName: doc.lines[index].itemName, variantName: doc.lines[index].variantName, unavailable: true });
      }
    }
    return changes;
  }

  const changes = [];
  fresh.forEach((line, index) => {
    const was = doc.lines[index].lineTotalInPaise / doc.lines[index].quantity;
    const now = computeLineTotalInPaise(line) / line.quantity;
    if (was !== now) {
      changes.push({ itemName: line.itemName, variantName: line.variantName, wasInPaise: was, nowInPaise: now });
    }
  });
  return changes;
}

/** Puts a claimed request back to WAITING after the accept could not finish. */
async function releaseClaim(req, id) {
  await OnlineOrder.updateOne(
    { ...scoped(req), _id: id, status: ONLINE_ORDER_STATUSES.ACCEPTED, orderId: null, decidedBy: req.user.id },
    { $set: { status: ONLINE_ORDER_STATUSES.WAITING, decidedBy: null, decidedAt: null } },
  );
}

/**
 * Claims a waiting request for this person. The status filter makes the
 * database decide between two cashiers tapping at once: one matches, the
 * other is told what happened.
 */
async function claim(req, id, now, set) {
  const claimed = await OnlineOrder.findOneAndUpdate(
    { ...scoped(req), _id: id, ...waitingFilter(now) },
    { $set: { ...set, decidedBy: req.user.id, decidedAt: now } },
    { new: true },
  );
  if (claimed) return claimed;

  const doc = await OnlineOrder.findOne({ ...scoped(req), _id: id });
  if (!doc) throw new NotFoundError('Online order not found.');
  await persistExpiry(req, doc, now);
  throw new RequestAlreadyDecidedError(effectiveStatus(doc, now));
}

/**
 * Accept. Claim, check the quote still stands, open the order, send it to the
 * kitchen. Anything that fails before the order exists puts the request back,
 * so it can be accepted again or declined.
 */
export async function accept(req, id, { pickupAt, fireNow, acceptChangedPrices }) {
  const now = nowUtc();
  const { online, dayStartMinutes } = await onlineSettings(req);

  if (pickupAt) {
    if (pickupAt <= now || !windowContaining(pickupAt, online, dayStartMinutes)) {
      throw new ValidationError('Choose a pickup time later today, while the cafe is open.', {
        pickupAt: 'Must be later than now and within opening hours.',
      });
    }
  }

  const doc = await claim(req, id, now, { status: ONLINE_ORDER_STATUSES.ACCEPTED });

  let order;
  try {
    const changes = await changesSinceQuote(req, doc);
    const unavailable = changes.some((change) => change.unavailable);
    if (unavailable || (changes.length > 0 && !acceptChangedPrices)) throw new OnlineOrderChangedError(changes);

    order = await openOrder(req, {
      orderType: ORDER_TYPES.TAKEAWAY,
      customerName: doc.customerName,
      customerPhone: doc.customerPhone,
      // P27. The guest's own consent from the page.
      customerConsent: onlineConsent(doc.marketingConsent),
      lines: requestLinesOf(doc),
      origin: {
        kind: ORIGIN_KINDS.ONLINE_ORDER,
        id: doc._id,
        reference: doc.reference,
        pickupAt: pickupAt ?? doc.pickupAt,
      },
      // P24. The money paid online goes with the order, to be applied on its bill.
      advancePaymentId: doc.paymentId ?? null,
    });

    doc.acceptedChangedPrices = changes.length > 0;
  } catch (error) {
    await releaseClaim(req, id);
    throw error;
  }

  await attachToOrder(req, doc.paymentId, order._id);

  const accepted = await OnlineOrder.findOneAndUpdate(
    { ...scoped(req), _id: id },
    {
      $set: {
        orderId: order._id,
        pickupAt: pickupAt ?? doc.pickupAt,
        acceptedChangedPrices: doc.acceptedChangedPrices,
      },
    },
    { new: true },
  );

  /**
   * The order exists from here on. A fire that fails does not undo it: the
   * order is on the takeaway list and can be sent from its own screen, and the
   * response says why it was not sent.
   */
  let kots = [];
  let fireError = null;
  let current = serialiseOrder(order);
  if (fireNow) {
    try {
      const fired = await fireOrder(req, { orderId: order._id, version: order.version });
      kots = fired.kots ?? [];
      current = fired.order;
    } catch (error) {
      fireError = error?.isOperational ? error.message : 'The order was accepted but could not be sent to the kitchen.';
      req.log?.warn({ onlineOrderId: String(id), err: error }, 'Accepted online order not fired.');
    }
  }

  req.log?.info(
    { actorId: req.user.id, onlineOrderId: String(id), orderId: String(order._id), reference: doc.reference },
    'Online order accepted.',
  );

  const names = await namesFor(req, [accepted.decidedBy]);
  return {
    onlineOrder: serialiseForStaff(accepted, names, now, await paymentsById(req, [accepted.paymentId])),
    order: current,
    kots,
    fireError,
  };
}

export async function decline(req, id, { reasonCode, note }) {
  const now = nowUtc();
  const doc = await claim(req, id, now, {
    status: ONLINE_ORDER_STATUSES.DECLINED,
    declineReasonCode: reasonCode,
    declineNote: note,
  });
  // P24. The cafe could not take it, so money paid online goes back.
  await refundAll(req, doc.paymentId, 'Declined by the cafe');
  const names = await namesFor(req, [doc.decidedBy]);
  return serialiseForStaff(doc, names, now, await paymentsById(req, [doc.paymentId]));
}
