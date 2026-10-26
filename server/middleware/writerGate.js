/**
 * The writer gate. P62 sections 5.1, 6.3 and 8.
 *
 * Refuses a writing request, with words a person can act on, when this
 * machine may not write:
 *
 *   MIRROR, not promoted   every write but the allowlist below -> 503 MIRROR_READ_ONLY
 *   BOX, stood down        every write but signing in           -> 503 WRITER_FENCED
 *   BOX, clock behind      every write but signing in           -> 503 CLOCK_BEHIND
 *
 * The mirror's allowlist is exact: signing in (sessions are each machine's
 * own), a price quote (writes nothing), the guest's requests and the partners'
 * webhooks that go into intake, and the box's own replication routes.
 * `tests/mirrorRoutes.test.js` walks the whole route table and fails if the
 * set of writing routes this lets through is not exactly this list. One extra
 * route is a failure.
 *
 * models/plugins/writerGuard.js refuses the same writes again at the model,
 * for anything that writes without a request.
 */
import { isBox } from '../config/deployment.js';
import { clockIsRefusing } from '../services/replication/clockGuard.js';
import { boxIsFenced, mirrorIsReadOnly } from '../services/replication/writerState.js';
import { ClockBehindError, MirrorReadOnlyError, WriterFencedError } from '../utils/errors.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const slug = '[^/]+';
const id = '[^/]+';

/** Every writing route a read-only mirror answers. Method, path, and why. */
export const MIRROR_WRITE_ALLOWLIST = Object.freeze([
  { method: 'POST', path: '/api/v1/auth/login', pattern: /^\/api\/v1\/auth\/login\/?$/, why: 'Signing in to read the copy. Sessions are LOCAL_ONLY.' },
  { method: 'POST', path: '/api/v1/auth/refresh', pattern: /^\/api\/v1\/auth\/refresh\/?$/, why: 'Staying signed in. Sessions are LOCAL_ONLY.' },
  { method: 'POST', path: '/api/v1/auth/logout', pattern: /^\/api\/v1\/auth\/logout\/?$/, why: 'Signing out. Sessions are LOCAL_ONLY.' },
  { method: 'POST', path: '/api/v1/public/:slug/quote', pattern: new RegExp(`^/api/v1/public/${slug}/quote/?$`), why: 'A price quote writes nothing.' },
  { method: 'POST', path: '/api/v1/public/:slug/orders', pattern: new RegExp(`^/api/v1/public/${slug}/orders/?$`), why: 'Intake: an online order.' },
  { method: 'POST', path: '/api/v1/public/:slug/orders/:id/cancel', pattern: new RegExp(`^/api/v1/public/${slug}/orders/${id}/cancel/?$`), why: "Intake: a guest's cancel." },
  { method: 'POST', path: '/api/v1/public/:slug/orders/:id/payment-return', pattern: new RegExp(`^/api/v1/public/${slug}/orders/${id}/payment-return/?$`), why: "Intake: a guest back from Razorpay." },
  { method: 'POST', path: '/api/v1/public/:slug/reservations', pattern: new RegExp(`^/api/v1/public/${slug}/reservations/?$`), why: 'Intake: a booking.' },
  { method: 'POST', path: '/api/v1/public/:slug/reservations/:id/cancel', pattern: new RegExp(`^/api/v1/public/${slug}/reservations/${id}/cancel/?$`), why: "Intake: a guest's cancel." },
  { method: 'POST', path: '/api/v1/public/:slug/reservations/:id/payment-return', pattern: new RegExp(`^/api/v1/public/${slug}/reservations/${id}/payment-return/?$`), why: 'Intake: a guest back from Razorpay.' },
  { method: 'POST', path: '/api/v1/public/:slug/payments/webhook', pattern: new RegExp(`^/api/v1/public/${slug}/payments/webhook/?$`), why: "Intake: Razorpay's webhook." },
  { method: 'POST', path: '/api/v1/hooks/:provider/:webhookKey', pattern: /^\/api\/v1\/hooks\/[^/]+\/[^/]+\/?$/, why: "Intake: a partner's webhook." },
  { method: 'POST', path: '/api/v1/replication/batches', pattern: /^\/api\/v1\/replication\/batches\/?$/, why: 'The box ships its changelog.' },
  { method: 'POST', path: '/api/v1/replication/intake/claim', pattern: /^\/api\/v1\/replication\/intake\/claim\/?$/, why: 'The box claims intake.' },
  { method: 'POST', path: '/api/v1/replication/intake/result', pattern: /^\/api\/v1\/replication\/intake\/result\/?$/, why: "The box reports an intake item's outcome." },
  { method: 'POST', path: '/api/v1/replication/reconcile', pattern: /^\/api\/v1\/replication\/reconcile\/?$/, why: 'The box asks for digests to compare.' },
]);

/** What a box answers even when it may not write: signing in, and its own network report. */
const BOX_ALWAYS = [/^\/api\/v1\/auth\/(login|refresh|logout)\/?$/, /^\/api\/v1\/network\/report\/?$/];

export function mirrorAllows(method, path) {
  if (READS.has(method)) return true;
  return MIRROR_WRITE_ALLOWLIST.some((entry) => entry.method === method && entry.pattern.test(path));
}

/** The refusal for this request now, or null. */
export function gateRefusal(method, path) {
  if (READS.has(method)) return null;
  if (mirrorIsReadOnly()) return mirrorAllows(method, path) ? null : new MirrorReadOnlyError();
  if (isBox() && !BOX_ALWAYS.some((pattern) => pattern.test(path))) {
    if (boxIsFenced()) return new WriterFencedError();
    if (clockIsRefusing()) return new ClockBehindError();
  }
  return null;
}

export function writerGate(req, _res, next) {
  const refusal = gateRefusal(req.method, req.path);
  return next(refusal ?? undefined);
}

export default writerGate;
