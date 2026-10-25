/**
 * Billing API calls.
 *
 * Every fetch for M3's billing screens lives here. Components call these and
 * never touch the network themselves.
 *
 * Shapes come from docs/API-CONTRACT.md sections 14 and 15.
 *
 * The rule running through this file, same as api/orders.js: the client never
 * sends a computed figure. It sends what it wants done — bill this order, take
 * this off, this was paid — and reads back whatever the server worked out.
 * There is no function here that takes a subtotal, a tax amount or a grand
 * total.
 */
import { api, requestWithMeta } from './client.js';

function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/**
 * Creates the bill for an order. The order's current version, from the order screen.
 * P57: with the discount chosen before Save, and `preview` for the totals shown before it.
 */
export function createBill({ orderId, version, discount, preview, withoutKot }) {
  return api.post('/bills', {
    orderId,
    version,
    ...(discount ? { discount } : {}),
    ...(preview ? { preview: true } : {}),
    // P60. The counter bills dishes not yet sent, without a KOT.
    ...(withoutKot ? { withoutKot: true } : {}),
  });
}

export function getBill(billId) {
  return api.get(`/bills/${billId}`);
}

/**
 * The day's bills, with a running total for the whole matched range in
 * `meta.totals`, not just the current page. Defaults to today's business day.
 */
export function listBills({ from, to, status, includeVoided, page, limit } = {}) {
  return requestWithMeta(`/bills${toQuery({ from, to, status, includeVoided, page, limit })}`);
}

/** P48. Recall Bill: the bills with this number after the series, any date, newest first. */
export function findBillsByNumber(number) {
  return requestWithMeta(`/bills${toQuery({ number, limit: 10 })}`);
}

/**
 * `kind` is 'FLAT' or 'PERCENT'. P08: a fixed reason code, an optional note
 * (required for OTHER), and who paid for it. OWNER and MANAGER, plus a CASHIER
 * for platform reasons when the owner allows it; the server decides.
 */
export function applyDiscount(billId, { kind, valueInPaise, rateBps, reasonCode, note, fundedBy }) {
  const body = { kind, reasonCode, note: note || null, fundedBy: fundedBy ?? 'RESTAURANT' };
  if (kind === 'FLAT') body.valueInPaise = valueInPaise;
  if (kind === 'PERCENT') body.rateBps = rateBps;
  return api.post(`/bills/${billId}/discount`, body);
}

export function recordPayment(billId, { method, amountInPaise, reference, tender, terminalBypassReason }) {
  const body = { method, amountInPaise };
  if (reference) body.reference = reference;
  // P25 Part F. The notes handed over and the change, on a cash payment.
  if (tender) body.tender = tender;
  // P25 Part I. A card-machine method typed in by an owner or manager, with why.
  if (terminalBypassReason) body.terminalBypassReason = terminalBypassReason;
  return api.post(`/bills/${billId}/payments`, body);
}

/** P08. Changes only the method of one payment, with a reason. OWNER and MANAGER. */
export function correctPayment(billId, paymentId, { method, reason }) {
  return api.post(`/bills/${billId}/payments/${paymentId}/correct`, { method, reason });
}

/**
 * OWNER and MANAGER only on the server. The number stays spent, never reissued.
 * A fixed reason code plus an optional note, required for OTHER (P04).
 */
/** P24. Puts the order's online advance on the bill. Any leftover is refunded by the server. */
export function applyAdvance(billId) {
  return api.post(`/bills/${billId}/apply-advance`, {});
}

export function voidBill(billId, { reasonCode, note, approval, closeOrder }) {
  // P28. A cashier's void carries an owner's or manager's PIN. 2026-10-22: closeOrder frees the table too.
  return api.post(`/bills/${billId}/void`, {
    reasonCode,
    note: note || null,
    ...(approval ? { approval } : {}),
    ...(typeof closeOrder === 'boolean' ? { closeOrder } : {}),
  });
}

/** width is 32 (58mm) or 48 (80mm). The server lays it out; the client only prints it. */
export function getReceipt(billId, width = 32) {
  return api.get(`/bills/${billId}/receipt?width=${width}`);
}

/**
 * P25 Part E. Cancels items on a bill: voids it and re-bills what is left.
 * With `preview: true` it answers the same numbers and changes nothing.
 */
export function cancelBillLines(billId, body) {
  return api.post(`/bills/${billId}/cancel-lines`, body);
}

/**
 * P29 Part B. Takes items off a bill nothing has been paid on; the same bill,
 * revised. With `preview: true` it answers the new total and changes nothing.
 */
export function removeBillLines(billId, body) {
  return api.post(`/bills/${billId}/remove-lines`, body);
}

/** P25 Part E. Records money returned to a guest outside the system. */
export function markRefundDone(refundId, reference) {
  return api.post(`/refunds/${refundId}/done`, { reference });
}

/** P25 Part D. Ask for the bill to print on the counter's printer. */
export function requestBillPrint(billId) {
  return api.post(`/bills/${billId}/print-request`, {});
}

/** P25 Part D. Every print, from any device, records itself, so the next one says Duplicate. */
export function markBillPrinted(billId, { forRequestAt } = {}) {
  return api.post(`/bills/${billId}/printed`, forRequestAt ? { forRequestAt } : {});
}

/** P25 Part D. The bills captains asked the counter to print, oldest first. */
export function getPrintQueue() {
  return api.get('/bills/print-queue');
}

/** P25. The bill as data for a full A4 or A5 tax invoice, from the same builder as the receipt. */
export function getInvoice(billId) {
  return api.get(`/bills/${billId}/invoice`);
}

export function getBillsSummary({ from, to }) {
  return api.get(`/bills/summary${toQuery({ from, to })}`);
}

/** P26. Voids a bill so the table can order more; the next bill carries its payments. */
export function reopenBill(billId, body = {}) {
  return api.post(`/bills/${billId}/reopen`, body);
}
