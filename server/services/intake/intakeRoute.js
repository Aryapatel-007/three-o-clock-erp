/**
 * Intake in front of the public routes. P62 section 5.1.
 *
 * On a read-only mirror, a guest's order, booking, cancel or payment return,
 * and Razorpay's webhook, stop here and become an intake item. Everywhere
 * else (the box, a CLOUD deployment, a promoted mirror) this steps aside and
 * the route runs exactly as before.
 *
 * The guest gets 202 and an intake id with a one-time secret, and the public
 * page asks `GET /public/:slug/intake/:id` until the box has decided.
 */
import { INTAKE_SOURCES } from '../../models/IntakeItem.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { sendSuccess } from '../../utils/response.js';
import { mirrorIsReadOnly } from '../replication/writerState.js';
import { assertBoxRecentlySeen, guestIntake, guestIntakeStatus, razorpayIntake } from './cloudIntake.js';

const NEW_REQUESTS = new Set([INTAKE_SOURCES.ONLINE_ORDER, INTAKE_SOURCES.RESERVATION]);

async function boxSeenAt(restaurantId) {
  const doc = await ReplicationState.findById(REPLICATION_STATE_IDS.boxSeen(restaurantId)).lean();
  return doc?.seenAt ?? null;
}

/** A guest's request into intake, on a read-only mirror. */
export function intakeOnMirror(source) {
  return async function takeIntoIntake(req, res, next) {
    if (!mirrorIsReadOnly()) return next();
    // A new request is refused before any money moves when the box has gone quiet.
    if (NEW_REQUESTS.has(source)) assertBoxRecentlySeen(await boxSeenAt(req.restaurantId));
    const { item, guestSecret } = await guestIntake(source, req);
    res.set('Cache-Control', 'no-store');
    return sendSuccess(res, { intake: { id: String(item._id), status: item.status, secret: guestSecret } }, 202);
  };
}

/** Razorpay's webhook into intake, on a read-only mirror, verified first. */
export async function razorpayWebhookOnMirror(req, res, next) {
  if (!mirrorIsReadOnly()) return next();
  if (!(await razorpayIntake(req))) throw new ValidationError('The webhook signature did not match.');
  return sendSuccess(res, { received: true });
}

/** GET /public/:slug/intake/:id?secret=... What the box made of a guest's request. Mirror only. */
export async function getIntakeStatus(req, res) {
  if (!mirrorIsReadOnly()) throw new NotFoundError();
  const view = await guestIntakeStatus({ restaurantId: req.restaurantId }, req.params.id, req.query.secret);
  if (!view) throw new NotFoundError();
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, view);
}
