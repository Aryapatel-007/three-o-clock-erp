/**
 * The mirror's intake. P62 section 5.1, docs/REPLICATION.md section 6.
 *
 * What the internet sends while the cafe box sits behind its router: a guest's
 * order or booking, their cancel or payment return, Razorpay's and the
 * partners' webhooks. Each is verified the way M14 and M21 verify it today,
 * then stored as an intake item, as it arrived. Nothing here makes an order.
 *
 * THE ONLY WRITE THIS FILE MAY MAKE IS TO `intake`.
 * `tests/intake.test.js` reads this file's imports and fails if it imports any
 * model but `IntakeItem`. The signature checks it calls are read-only lookups
 * of the restaurant's sealed keys.
 */
import { createHash, randomBytes } from 'node:crypto';

import { INTAKE_SOURCES, INTAKE_STATUSES, IntakeItem } from '../../models/IntakeItem.js';
import { OnlineClosedError } from '../../utils/errors.js';
import { nowUtc } from '../../utils/time.js';
import { keysFor } from '../paymentGatewayService.js';
import { webhookSignatureMatches } from '../razorpayClient.js';
import { verifyWebhookSignatureOnly } from '../integrations/webhookService.js';

const DUPLICATE_KEY = 11000;

/**
 * P62 section 15 question 3, provisional answer: while the box has not
 * checked in for this long, the public page takes no new order or booking,
 * so no guest pays for a request no kitchen can see. Webhooks and a guest's
 * cancel or payment return are always taken: they are about something that
 * already exists.
 */
export const BOX_SILENT_CLOSES_PAGE_AFTER_MS = 5 * 60_000;

/** Headers a replay needs. Never a cookie, never Authorization. */
const KEPT_GUEST_HEADERS = ['x-status-token'];
const DROPPED_PARTNER_HEADERS = new Set(['cookie', 'authorization', 'host', 'connection', 'content-length']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function pickHeaders(headers, names) {
  const kept = {};
  for (const name of names) if (headers[name] !== undefined) kept[name] = String(headers[name]);
  return kept;
}

function partnerHeaders(headers) {
  const kept = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!DROPPED_PARTNER_HEADERS.has(name.toLowerCase())) kept[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return kept;
}

/**
 * Stores one item, once. A second delivery of the same external id is the
 * same item back, never a second one.
 */
export async function storeIntake(ctx, { source, externalId, params = {}, body = null, rawBody = null, headers = {}, withGuestSecret = false }) {
  const guestSecret = withGuestSecret ? randomBytes(24).toString('base64url') : null;
  try {
    const item = await IntakeItem.create({
      restaurantId: ctx.restaurantId,
      branchId: ctx.branchId,
      source,
      externalId,
      params,
      body,
      rawBody,
      headers,
      receivedAt: nowUtc(),
      status: INTAKE_STATUSES.RECEIVED,
      guestSecretHash: guestSecret ? sha256(guestSecret) : null,
    });
    return { item, created: true, guestSecret };
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    const item = await IntakeItem.findOne({ restaurantId: ctx.restaurantId, source, externalId });
    return { item, created: false, guestSecret: null };
  }
}

/** When the box last checked in for this restaurant, from the receiver's note. */
export function assertBoxRecentlySeen(seenAt, now = nowUtc()) {
  if (!seenAt || now.getTime() - new Date(seenAt).getTime() > BOX_SILENT_CLOSES_PAGE_AFTER_MS) {
    throw new OnlineClosedError("The cafe can't take online requests right now. Please try again in a little while, or call them.");
  }
}

/** A guest's request, from a public route, as an intake item. */
export function guestIntake(source, req) {
  const ctx = { restaurantId: req.restaurantId, branchId: req.branchId };
  const params = { slug: req.params.slug, id: req.params.id ?? null };
  const body = req.body ?? null;
  const headers = pickHeaders(req.headers, KEPT_GUEST_HEADERS);
  // The guest's own key makes a double tap one item; a cancel or return is one per request id and body.
  const externalId = source === INTAKE_SOURCES.ONLINE_ORDER || source === INTAKE_SOURCES.RESERVATION
    ? String(body?.idempotencyKey ?? sha256(JSON.stringify(body)))
    : sha256(`${params.id}:${JSON.stringify(body)}`);
  const withGuestSecret = source === INTAKE_SOURCES.ONLINE_ORDER || source === INTAKE_SOURCES.RESERVATION;
  return storeIntake(ctx, { source, externalId, params, body, headers, withGuestSecret });
}

/**
 * Razorpay's webhook for one cafe, verified with the cafe's sealed webhook
 * secret exactly as `handleWebhook` does, then kept. False for a bad signature.
 */
export async function razorpayIntake(req) {
  const keys = await keysFor(req.restaurantId);
  const signature = req.get('x-razorpay-signature');
  if (!keys || typeof req.rawBody !== 'string' || !webhookSignatureMatches(keys.webhookSecret, req.rawBody, signature)) return false;
  await storeIntake(
    { restaurantId: req.restaurantId, branchId: req.branchId },
    {
      source: INTAKE_SOURCES.RAZORPAY_WEBHOOK,
      externalId: sha256(req.rawBody),
      params: { slug: req.params.slug },
      rawBody: req.rawBody,
      headers: { 'x-razorpay-signature': String(signature) },
    },
  );
  return true;
}

/**
 * A partner's webhook (Swiggy, Zomato, Pine Labs, WhatsApp), verified by the
 * partner's own adapter as `receiveWebhook` does, then kept. Gives back the
 * status the partner should see.
 */
export async function partnerIntake(provider, key, rawBody, headers) {
  const verified = await verifyWebhookSignatureOnly(provider, key, rawBody, headers);
  if (verified.status !== 200) return { status: verified.status };
  const text = rawBody.toString('utf8');
  await storeIntake(
    { restaurantId: verified.restaurantId, branchId: verified.branchId },
    {
      source: INTAKE_SOURCES.PARTNER_WEBHOOK,
      externalId: sha256(`${provider}:${text}`),
      params: { provider, key },
      rawBody: text,
      headers: partnerHeaders(headers),
    },
  );
  return { status: 200, body: { received: true } };
}

/**
 * The guest collects what the box made of their request, once, with the
 * secret they were given at intake. Gives back the item's public shape.
 */
export async function guestIntakeStatus(ctx, intakeId, secret) {
  const item = await IntakeItem.findOne({ restaurantId: ctx.restaurantId, _id: intakeId }).select('+pendingStatusToken');
  if (!item || !secret || item.guestSecretHash !== sha256(String(secret))) return null;
  const view = {
    id: String(item._id),
    status: item.status,
    reasonCode: item.reasonCode,
    reasonMessage: item.reasonMessage,
    result: item.result,
    statusToken: null,
  };
  if (item.status === INTAKE_STATUSES.APPLIED && item.pendingStatusToken) {
    view.statusToken = item.pendingStatusToken;
    await IntakeItem.updateOne({ restaurantId: ctx.restaurantId, _id: item._id }, { $set: { pendingStatusToken: null } });
  }
  return view;
}

/* ------------------------------------------------------------------------- *
 * The box's side of the conversation, over the signed replication routes.
 * ------------------------------------------------------------------------- */

export const CLAIM_HOLD_MS = 2 * 60_000;

/**
 * Claims up to `limit` items for the box, oldest first: RECEIVED ones, and
 * CLAIMED ones whose hold ran out (a box that crashed mid-apply).
 */
export async function claimIntake(restaurantIds, { limit = 20, now = nowUtc() } = {}) {
  const claimed = [];
  for (const restaurantId of restaurantIds) {
    while (claimed.length < limit) {
      const item = await IntakeItem.findOneAndUpdate(
        {
          restaurantId,
          $or: [
            { status: INTAKE_STATUSES.RECEIVED },
            { status: INTAKE_STATUSES.CLAIMED, claimExpiresAt: { $lte: now } },
          ],
        },
        { $set: { status: INTAKE_STATUSES.CLAIMED, claimedAt: now, claimExpiresAt: new Date(now.getTime() + CLAIM_HOLD_MS) }, $inc: { attempts: 1 } },
        { sort: { receivedAt: 1 }, new: true },
      ).lean();
      if (!item) break;
      claimed.push(item);
    }
  }
  return claimed;
}

/** The box's outcome for one item. Idempotent: the same outcome twice changes nothing. */
export function recordIntakeOutcome(restaurantId, intakeId, { status, reasonCode = null, reasonMessage = null, result = null, statusToken = null }) {
  if (![INTAKE_STATUSES.APPLIED, INTAKE_STATUSES.REJECTED].includes(status)) return null;
  const set = { status, reasonCode, reasonMessage, result, decidedAt: nowUtc(), claimExpiresAt: null };
  if (statusToken) set.pendingStatusToken = statusToken;
  return IntakeItem.findOneAndUpdate(
    { restaurantId, _id: intakeId, status: { $in: [INTAKE_STATUSES.CLAIMED, INTAKE_STATUSES.RECEIVED] } },
    { $set: set },
    { new: true },
  ).lean();
}
