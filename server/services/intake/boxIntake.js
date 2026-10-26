/**
 * The box applies intake. P62 section 5.2, docs/REPLICATION.md section 6.
 *
 * Claims items from the mirror, oldest first, and applies each through the
 * same services the public routes and webhooks call on a CLOUD deployment:
 * `onlineOrderService.place` for an online order, `handleWebhook` for
 * Razorpay, `receiveWebhook` for a partner. An online order therefore gets its
 * reference, its alert and, once accepted, its KOT the way a till order does.
 *
 * The body is validated again here with the route's own schema. The box does
 * not trust the cloud's parsing any more than a route trusts a browser's.
 *
 * Idempotent on the item: `intakeapplications` records STARTED before and the
 * outcome after. A crash between the two applies the item again, and the
 * services underneath are idempotent on the request's own key (an online
 * order's `idempotencyKey`, a partner event's dedupe key, Razorpay's confirm),
 * so one item makes one order, never two.
 *
 * Outcomes: APPLIED with what was made, or REJECTED with the error's code,
 * for any refusal a person would see at the till (ITEM_UNAVAILABLE,
 * ONLINE_CLOSED, VALIDATION_FAILED ...). Anything else (a database error, a
 * partner timeout) leaves the item to be claimed again.
 */
import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { INTAKE_SOURCES, INTAKE_STATUSES } from '../../models/IntakeItem.js';
import { INTAKE_APPLICATION_STATUSES, IntakeApplication } from '../../models/IntakeApplication.js';
import { MenuItem } from '../../models/MenuItem.js';
import { AppError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { paymentReturnSchema } from '../../validators/paymentValidators.js';
import { publicPlaceOrderSchema, publicRequestReservationSchema, publicStatusSchema } from '../../validators/onlineValidators.js';
import { onlineSettings } from '../onlineCommon.js';
import * as onlineOrders from '../onlineOrderService.js';
import { handleWebhook } from '../onlinePaymentService.js';
import { resolveSlug } from '../publicSiteService.js';
import * as reservations from '../reservationService.js';
import { receiveWebhook } from '../integrations/webhookService.js';
import { postToMirror } from '../replication/shipper.js';
import { mayRunWriterLoops } from '../replication/writerState.js';

/** A refusal: the request was read and the answer is no. Kept, reported, never retried. */
class Rejected extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The request a route would have built, for a service to read. */
async function requestFor(item) {
  const headers = Object.fromEntries(Object.entries(item.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const req = {
    restaurantId: String(item.restaurantId),
    branchId: String(item.branchId),
    params: { ...(item.params ?? {}) },
    body: item.body ?? null,
    query: {},
    headers,
    rawBody: item.rawBody ?? null,
    get: (name) => headers[String(name).toLowerCase()],
    log: logger,
  };
  if (item.params?.slug) {
    const site = await resolveSlug(String(item.params.slug).toLowerCase());
    req.publicSite = site;
    req.restaurantId = String(site.restaurant._id);
    req.branchId = String(site.branch._id);
  }
  return req;
}

/** Validates again with the route's own schema, writing the parsed values back as `validate` does. */
function revalidate(schema, req) {
  const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query });
  if (!parsed.success) throw new Rejected('VALIDATION_FAILED', 'The request did not pass the cafe server\'s checks.');
  if (parsed.data.body !== undefined) req.body = parsed.data.body;
  if (parsed.data.params !== undefined) req.params = parsed.data.params;
}

/**
 * P62 section 5.3. The one conflict left: the mirror took an order on a menu
 * seconds old, and the kitchen has since switched a dish off. Named here with
 * its own code, before the order service refuses it in its own words.
 */
async function assertDishesAvailable(req) {
  const ids = [...new Set((req.body?.lines ?? []).map((line) => String(line.menuItemId)))];
  if (ids.length === 0) return;
  const items = await MenuItem.find({ restaurantId: req.restaurantId, _id: { $in: ids } }).select('name isAvailable isActive').lean();
  const off = items.filter((item) => !item.isAvailable || !item.isActive).map((item) => item.name);
  if (items.length < ids.length || off.length > 0) {
    throw new Rejected('ITEM_UNAVAILABLE', off.length ? `${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} not available right now.` : 'A dish in this order is not on the menu any more.');
  }
}

const APPLIERS = {
  async [INTAKE_SOURCES.ONLINE_ORDER](req) {
    revalidate(publicPlaceOrderSchema, req);
    await assertDishesAvailable(req);
    const { doc, token } = await onlineOrders.place(req, req.body);
    return { result: { onlineOrderId: String(doc._id), reference: doc.reference }, statusToken: token ?? null };
  },
  async [INTAKE_SOURCES.RESERVATION](req) {
    revalidate(publicRequestReservationSchema, req);
    const { doc, token } = await reservations.request(req, req.body);
    return { result: { reservationId: String(doc._id), reference: doc.reference ?? null }, statusToken: token ?? null };
  },
  async [INTAKE_SOURCES.ONLINE_ORDER_CANCEL](req) {
    revalidate(publicStatusSchema, req);
    await onlineOrders.guestCancel(req, req.params.id);
    return { result: { onlineOrderId: req.params.id } };
  },
  async [INTAKE_SOURCES.ONLINE_ORDER_PAYMENT_RETURN](req) {
    revalidate(paymentReturnSchema, req);
    await onlineOrders.guestPaymentReturn(req, req.params.id, req.body);
    return { result: { onlineOrderId: req.params.id } };
  },
  async [INTAKE_SOURCES.RESERVATION_CANCEL](req) {
    revalidate(publicStatusSchema, req);
    await reservations.guestCancel(req, req.params.id);
    return { result: { reservationId: req.params.id } };
  },
  async [INTAKE_SOURCES.RESERVATION_PAYMENT_RETURN](req) {
    revalidate(paymentReturnSchema, req);
    await reservations.guestPaymentReturn(req, req.params.id, req.body);
    return { result: { reservationId: req.params.id } };
  },
  async [INTAKE_SOURCES.RAZORPAY_WEBHOOK](req) {
    const { online } = await onlineSettings(req);
    const accepted = await handleWebhook(req, req.rawBody, req.get('x-razorpay-signature'), { online });
    if (!accepted) throw new Rejected('BAD_SIGNATURE', 'The Razorpay signature did not match on the cafe server.');
    return { result: { received: true } };
  },
  async [INTAKE_SOURCES.PARTNER_WEBHOOK](req, item) {
    const outcome = await receiveWebhook(item.params.provider, item.params.key, Buffer.from(item.rawBody ?? '', 'utf8'), req.headers);
    if (outcome.status === 200) return { result: { received: true } };
    throw new Rejected(outcome.status === 401 ? 'BAD_SIGNATURE' : outcome.status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED', 'The partner\'s webhook was refused on the cafe server.');
  },
};

/** Gives back { status, reasonCode, reasonMessage, result, statusToken }, or throws to be retried. */
export async function applyIntakeItem(item) {
  const ctx = { restaurantId: item.restaurantId, branchId: item.branchId };
  const intakeId = String(item._id);
  const existing = await IntakeApplication.findOne({ restaurantId: ctx.restaurantId, intakeId }).lean();
  if (existing && existing.status !== INTAKE_APPLICATION_STATUSES.STARTED) {
    return { status: existing.status, reasonCode: existing.reasonCode, reasonMessage: null, result: existing.result, statusToken: null };
  }
  if (existing) {
    await IntakeApplication.updateOne({ restaurantId: ctx.restaurantId, intakeId }, { $inc: { attempts: 1 } });
  } else {
    await IntakeApplication.create({ ...ctx, intakeId, source: item.source, status: INTAKE_APPLICATION_STATUSES.STARTED });
  }

  const applier = APPLIERS[item.source];
  let outcome;
  try {
    if (!applier) throw new Rejected('UNKNOWN_SOURCE', `No way to apply ${item.source}.`);
    const req = await requestFor(item);
    const made = await applier(req, item);
    outcome = { status: INTAKE_STATUSES.APPLIED, reasonCode: null, reasonMessage: null, result: made.result ?? null, statusToken: made.statusToken ?? null };
  } catch (error) {
    const refused = error instanceof Rejected || (error instanceof AppError && error.statusCode < 500);
    if (!refused) throw error;
    outcome = { status: INTAKE_STATUSES.REJECTED, reasonCode: error.code ?? 'REJECTED', reasonMessage: error.message, result: null, statusToken: null };
  }

  await IntakeApplication.updateOne(
    { restaurantId: ctx.restaurantId, intakeId },
    { $set: { status: outcome.status, reasonCode: outcome.reasonCode, result: outcome.result } },
  );
  return outcome;
}

/** The restaurants this box holds. Read through the driver: the tenant itself has no tenant filter. */
async function localRestaurantIds() {
  const docs = await mongoose.connection.db.collection('restaurants').find({}, { projection: { _id: 1 } }).toArray();
  return docs.map((doc) => doc._id);
}

/**
 * One pull: claim, apply, report. Gives back how many were applied or
 * refused. Does nothing on a fenced box.
 */
export async function pullIntakeOnce(options = {}) {
  if (!mayRunWriterLoops()) return 0;
  const restaurantIds = await localRestaurantIds();
  if (restaurantIds.length === 0) return 0;
  const claim = await postToMirror('/intake/claim', { restaurantIds, limit: 20 }, options);
  if (claim.status !== 200) throw new Error(`The mirror answered ${claim.status} to an intake claim.`);
  let done = 0;
  for (const item of claim.body?.data?.items ?? []) {
    let outcome;
    try {
      outcome = await applyIntakeItem(item);
    } catch (error) {
      logger.warn({ err: error, intakeId: String(item._id), source: item.source }, 'An intake item could not be applied yet. It will be claimed again.');
      continue;
    }
    const report = await postToMirror('/intake/result', { restaurantId: item.restaurantId, intakeId: String(item._id), ...outcome }, options);
    if (report.status === 200) {
      await IntakeApplication.updateOne({ restaurantId: item.restaurantId, intakeId: String(item._id) }, { $set: { reportedAt: nowUtc() } });
      done += 1;
    }
  }
  return done;
}
