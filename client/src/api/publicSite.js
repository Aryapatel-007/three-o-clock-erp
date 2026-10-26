/**
 * The public page's calls. P23 (M14), API-CONTRACT M14 section 2.
 *
 * Deliberately not built on `client.js`: a guest has no session, so there is
 * no token to send and nothing to refresh, and the page must never start the
 * staff sign-in flow, so it imports nothing from the staff client. Same
 * envelope, same error shape.
 */

/** The same fields as the staff ApiError, without importing the staff client. */
export class PublicApiError extends Error {
  constructor({ code, message, status, ...rest }) {
    super(message ?? 'Something went wrong. Please try again.');
    this.name = 'PublicApiError';
    this.code = code ?? 'INTERNAL_ERROR';
    this.status = status;
    Object.assign(this, rest);
  }
}

const BASE = '/api/v1/public';

async function call(path, { method = 'GET', body, statusToken } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (statusToken) headers['X-Status-Token'] = statusToken;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
    });
  } catch {
    throw new PublicApiError({ code: 'NETWORK', message: 'No connection. Check your internet and try again.', status: 0 });
  }

  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new PublicApiError({ code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', status: response.status });
  }
  if (!response.ok || envelope?.success === false) {
    throw new PublicApiError({ ...(envelope?.error ?? {}), status: response.status });
  }
  return envelope.data;
}

const at = (slug, rest = '') => `/${encodeURIComponent(slug)}${rest}`;

/**
 * P62. On the cloud copy, a new order or booking is taken into intake (202)
 * and the cafe's own server decides it a few seconds later. The page waits
 * for that answer here, so every screen above sees exactly what it saw before:
 * the request, with its status token, or the cafe's refusal in words.
 */
const INTAKE_POLL_MS = 2_000;
const INTAKE_WAIT_MS = 3 * 60_000;

async function waitForCafe(slug, intake) {
  const until = Date.now() + INTAKE_WAIT_MS;
  for (;;) {
    const seen = await call(at(slug, `/intake/${encodeURIComponent(intake.id)}?secret=${encodeURIComponent(intake.secret ?? '')}`));
    if (seen.status === 'APPLIED' && seen.statusToken) return seen;
    // Applied twice after the cafe server restarted mid-way: the request is in, but its tracking token went with the first try.
    if (seen.status === 'APPLIED') {
      const reference = seen.result?.reference ? ` ${seen.result.reference}` : '';
      throw new PublicApiError({ code: 'RECEIVED_NO_TRACKING', message: `The cafe has your request${reference}. Live tracking is not available for it; the cafe will call you if anything changes.`, status: 200 });
    }
    if (seen.status === 'REJECTED') {
      throw new PublicApiError({ code: seen.reasonCode ?? 'REJECTED', message: seen.reasonMessage ?? 'The cafe could not take this request.', status: 422 });
    }
    if (Date.now() > until) {
      throw new PublicApiError({ code: 'WAITING_FOR_CAFE', message: 'Your request reached us and is waiting for the cafe to confirm. Please call the cafe if you do not hear back soon.', status: 202 });
    }
    await new Promise((resolve) => setTimeout(resolve, INTAKE_POLL_MS));
  }
}

export const getSite = (slug) => call(at(slug));
export const getPublicMenu = (slug) => call(at(slug, '/menu'));
export const getQuote = (slug, lines) => call(at(slug, '/quote'), { method: 'POST', body: { lines } });
export const placeOrder = async (slug, body) => {
  const placed = await call(at(slug, '/orders'), { method: 'POST', body });
  if (!placed?.intake) return placed;
  const decided = await waitForCafe(slug, placed.intake);
  const view = await getOrderStatus(slug, decided.result.onlineOrderId, decided.statusToken);
  return { ...view, statusToken: decided.statusToken };
};
export const getOrderStatus = (slug, id, statusToken) => call(at(slug, `/orders/${id}`), { statusToken });
export const cancelOrder = (slug, id, statusToken) =>
  call(at(slug, `/orders/${id}/cancel`), { method: 'POST', statusToken });

export const getSlots = (slug, date, partySize) =>
  call(at(slug, `/reservations/slots?date=${encodeURIComponent(date)}&partySize=${partySize}`));
export const requestBooking = async (slug, body) => {
  const requested = await call(at(slug, '/reservations'), { method: 'POST', body });
  if (!requested?.intake) return requested;
  const decided = await waitForCafe(slug, requested.intake);
  const view = await getBookingStatus(slug, decided.result.reservationId, decided.statusToken);
  return { ...view, statusToken: decided.statusToken };
};
export const getBookingStatus = (slug, id, statusToken) => call(at(slug, `/reservations/${id}`), { statusToken });
export const cancelBooking = (slug, id, statusToken) =>
  call(at(slug, `/reservations/${id}/cancel`), { method: 'POST', statusToken });

/* P24. The guest's return from Razorpay, exactly the query Razorpay appended. */
export const sendOrderPaymentReturn = (slug, id, statusToken, body) =>
  call(at(slug, `/orders/${id}/payment-return`), { method: 'POST', body, statusToken });
export const sendBookingPaymentReturn = (slug, id, statusToken, body) =>
  call(at(slug, `/reservations/${id}/payment-return`), { method: 'POST', body, statusToken });
