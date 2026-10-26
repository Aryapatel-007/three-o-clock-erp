/**
 * What every full-page invoice theme shares. P64, API-CONTRACT P64 6.
 *
 * A theme is a pure function of the invoice data from
 * GET /bills/:billId/invoice and the layout switches in it. Nothing here
 * queries anything or works out an amount: every figure is a field of the
 * data, printed through `moneyText`, and the amount in words comes from the
 * server, spelled by `paiseToIndianWords` in server/utils/money.js.
 *
 * The mandatory core of a tax invoice (CGST Rule 46) is never behind a switch:
 * the supplier's name, address and GSTIN, TAX INVOICE, the invoice number and
 * its date, each line's value, each rate's taxable value, CGST and SGST, and
 * the bill total. A test renders every theme with every switch off and checks
 * each of them is still there.
 */
import { moneyText } from '../../../components/ui/moneyText.js';

import { escapeHtml } from '../printText.js';

export { escapeHtml };

export const ORDER_TYPE_WORDS = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** Every switch off: what a theme prints when the owner turns everything off. */
export const NOTHING_SHOWN = Object.freeze({});

export const percent = (bps) => `${bps / 100}%`;

export function money(paise) {
  return escapeHtml(moneyText(paise));
}

/** A row of the totals block. */
export const total = (label, paise, className = '') =>
  `<div class="${className}"><span>${escapeHtml(label)}</span><span class="num">${money(paise)}</span></div>`;

/**
 * The switches a theme reads: the data's own, or those the caller passes for
 * a preview. A missing switch is off, so a theme drawn with no layout at all
 * still prints the mandatory core.
 */
export function switchesFor(data, options = {}) {
  return options.show ?? data.layout?.show ?? {};
}

/** "09/10/2026 14:57" as "09/10/2026": the invoice date, printed even with the time off. */
export const dateOf = (stamp = '') => stamp.split(' ')[0];

/** The copy marking, CGST Rule 48(2): a supply of services is made out in duplicate. */
export const COPY_WORDS = Object.freeze({ RECIPIENT: 'ORIGINAL FOR RECIPIENT', SUPPLIER: 'DUPLICATE FOR SUPPLIER' });

export function copyMarking(show, options) {
  if (!show.copyMarking) return '';
  return `<div class="copy">${COPY_WORDS[options.copy] ?? COPY_WORDS.RECIPIENT}</div>`;
}

/** The supplier's own lines under its name. */
export function supplierDetails(data, show) {
  const r = data.restaurant;
  return [
    r.legalName,
    r.address,
    r.phone ? `Phone ${r.phone}` : null,
    r.gstin ? `GSTIN ${r.gstin}` : null,
    r.fssaiNumber ? `FSSAI ${r.fssaiNumber}` : null,
    show.pan && r.panNumber ? `PAN ${r.panNumber}` : null,
    show.msme && r.msmeNumber ? `Udyam number ${r.msmeNumber}` : null,
  ].filter(Boolean);
}

/** The facts box: number, date, and what the switches allow. */
export function invoiceFacts(data, show) {
  const guest = data.customer;
  const guestName = show.customerName && guest?.name ? guest.name : null;
  const guestMobile = show.customerMobileMasked && guest?.mobileLast4 ? `XXXXXX${guest.mobileLast4}` : null;
  return [
    // P29. A bill changed before payment, under the same number, says so under it.
    ['Invoice number', data.isRevised ? `${data.billNumber}, revised bill` : data.billNumber],
    show.time ? ['Time issued', data.issuedAtIst] : ['Invoice date', dateOf(data.issuedAtIst)],
    show.orderType ? ['Order type', ORDER_TYPE_WORDS[data.orderType] ?? data.orderType] : [],
    show.table ? ['Table', data.tableName] : [],
    show.captain ? ['Captain', data.captainName] : [],
    show.covers ? ['Covers', data.guestCount] : [],
    [data.platform?.name, data.platform?.orderId],
    show.cashier ? ['Cashier', data.cashierName] : [],
    ['Guest', guestName],
    ['Mobile', guestMobile],
  ].filter(([label, value]) => label && value !== null && value !== undefined && value !== '');
}

/** The rows a theme lists: the server's item rows, the same dish once (P35). */
export const rowsOf = (data) => data.itemRows ?? data.lines;

export const nameOf = (line) => line.itemName + (line.variantName ? ` (${line.variantName})` : '');

/** A row's notes, from an item row's list or a line's single note. */
export function notesOf(line) {
  if (Array.isArray(line.notes)) return line.notes;
  return line.notes ? [line.notes] : [];
}

/** Under a dish's name: its extras, and its note when the switch is on. */
export function lineExtras(line, show) {
  const addOns = line.addOnNames.length ? `<div class="muted">+ ${escapeHtml(line.addOnNames.join(', '))}</div>` : '';
  const notes = show.itemNote && notesOf(line).length ? `<div class="muted note">${escapeHtml(notesOf(line).join('; '))}</div>` : '';
  return addOns + notes;
}

/** Payment lines, the On Hold account, and the account's balance, under the switches. */
export function settlement(data, show) {
  const payments = show.paymentBreakdown ? data.payments.map((payment) => total(payment.methodName, payment.amountInPaise)).join('') : '';
  const account = data.accountName ? `<div><span>On Hold</span><span>${escapeHtml(data.accountName)}</span></div>` : '';
  const balance =
    show.onHoldOutstanding && Number.isInteger(data.onHoldOutstandingInPaise) ? total('Account balance', data.onHoldOutstandingInPaise) : '';
  return { payments, account, balance };
}

export const amountInWords = (data, show) =>
  show.amountInWords && data.billTotalInWords ? `<div class="words">${escapeHtml(data.billTotalInWords)}</div>` : '';

export const DECLARATION_TEXT =
  'We declare that this invoice shows the actual price of the goods and services described and that all particulars are true and correct.';

export const declaration = (show) => (show.declaration ? `<div class="declaration">${DECLARATION_TEXT}</div>` : '');

export function signatureBlock(data, show, signatureDataUrl) {
  if (!show.signatureLine) return '';
  const image = signatureDataUrl ? `<img class="signature" src="${escapeHtml(signatureDataUrl)}" alt="" />` : '';
  return `<div class="sign">${image}<div class="sign-line"></div><div>For ${escapeHtml(data.restaurant.legalName || data.restaurant.name)}</div><div>Authorised signatory</div></div>`;
}

export const terms = (data, show) =>
  show.terms && data.restaurant.termsText
    ? `<div class="terms"><div><strong>Terms and conditions</strong></div><div>${escapeHtml(data.restaurant.termsText)}</div></div>`
    : '';

export const reviewCode = (show, qrSvg) => (show.reviewQr && qrSvg ? `<div class="review">${qrSvg}<div>Scan to review us</div></div>` : '');

/** The styles the P64 additions need, shared by every theme. */
export const SHARED_STYLES = `
  .invoice .copy { text-align: right; font-weight: 700; font-size: 8pt; letter-spacing: 0.06em; margin-bottom: 2mm; }
  .invoice .note { font-style: italic; }
  .invoice .words { margin-top: 2mm; font-style: italic; }
  .invoice .declaration { margin-top: 4mm; font-size: 8pt; text-align: left; }
  .invoice .sign { margin: 6mm 0 0 auto; width: 60mm; text-align: center; break-inside: avoid; }
  .invoice .signature { max-height: 16mm; max-width: 50mm; display: block; margin: 0 auto 1mm; }
  .invoice .sign-line { border-top: 0.3mm solid black; margin-bottom: 1mm; }
  .invoice .terms { margin-top: 4mm; font-size: 8pt; text-align: left; white-space: pre-line; break-inside: avoid; }
`;
