/**
 * Cash drawer and Day Close. P10. Shapes from docs/API-CONTRACT.md "M16"
 * sections 3 and 6. The blind count is applied by the server: a manager's
 * responses simply do not carry the expected cash.
 */
import { api } from './client.js';

export function listCashMovements(date) {
  return api.get(`/cash-movements${date ? `?date=${date}` : ''}`);
}

/**
 * `type` is OPENING_FLOAT, PAID_IN (a top-up), PAID_OUT (an expense), and from
 * P29 CASH_TAKEN_OUT or CASH_CHECK. The server dates it today.
 */
export function recordCashMovement({ type, amountInPaise, reason, cashCount, approval, source, category, destination, takenBy, broughtForward }) {
  // P25 Part F. A count by notes sends the count; the server works out the amount.
  return api.post('/cash-movements', {
    type,
    ...(cashCount ? { cashCount } : amountInPaise !== undefined && amountInPaise !== null ? { amountInPaise } : {}),
    ...(reason ? { reason } : {}),
    // P28. An owner's or manager's PIN, for a cashier's paid in or paid out.
    ...(approval ? { approval } : {}),
    // P29 Part F.
    ...(source ? { source } : {}),
    ...(category ? { category } : {}),
    ...(destination ? { destination } : {}),
    ...(takenBy ? { takenBy } : {}),
    ...(broughtForward ? { broughtForward: true } : {}),
  });
}

/** P29 Part F. The day's cash as one flow. The server leaves out what this role may not see. */
export function getCashBook(date) {
  return api.get(`/cash-book${date ? `?date=${date}` : ''}`);
}

export function voidCashMovement(movementId, reason, extra = {}) {
  return api.post(`/cash-movements/${movementId}/void`, { reason, ...extra });
}

/** P44. The day-end message: `{ businessDate, subject, text }`. Cash in hand reads "—" for a blind manager. */
export function getDayMessage(businessDate) {
  return api.get(`/day-close/${businessDate}/message`);
}

/** P44. Emails the day-end message to the addresses in Settings. Returns `{ sentTo }`. */
export function emailDay(businessDate) {
  return api.post(`/day-close/${businessDate}/email`, {});
}

/** The close for one date, or its live figures and blockers when open. */
export function getDay(businessDate) {
  return api.get(`/day-close/${businessDate}`);
}

export function listDays({ from, to } = {}) {
  const search = new URLSearchParams();
  if (from) search.set('from', from);
  if (to) search.set('to', to);
  const query = search.toString();
  return api.get(`/day-close${query ? `?${query}` : ''}`);
}

export function closeDay({ businessDate, countedCashInPaise, cashCount, note, keptForTomorrowInPaise, keptForTomorrowCount, takenOutTo, takenOutBy }) {
  // P25 Part F. A count by notes and coins, totalled on the server, or the counted total.
  return api.post('/day-close', {
    businessDate,
    ...(cashCount ? { cashCount } : { countedCashInPaise }),
    note: note || null,
    // P29 Part F. What stays for tomorrow, and where the rest goes.
    ...(keptForTomorrowCount ? { keptForTomorrowCount } : keptForTomorrowInPaise !== undefined && keptForTomorrowInPaise !== null ? { keptForTomorrowInPaise } : {}),
    ...(takenOutTo ? { takenOutTo } : {}),
    ...(takenOutBy ? { takenOutBy } : {}),
  });
}

export function reopenDay(businessDate, reason) {
  return api.post(`/day-close/${businessDate}/reopen`, { reason });
}

export function getDayPrint(businessDate, width = 32) {
  return api.get(`/day-close/${businessDate}/print?width=${width}`);
}
