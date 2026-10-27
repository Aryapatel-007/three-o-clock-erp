/**
 * The full-page tax invoice, for A4 and A5, and the thermal bill. P25 Part C4.
 *
 * P64: the full page is drawn by the restaurant's theme, in themes/, and this
 * file chooses it; the thermal bill stays one layout and reads `thermalShow`.
 *
 * Laid out from GET /bills/:billId/invoice, the same data the thermal receipt
 * is laid out from on the server, so the two never print different amounts.
 * One function builds the page for both printing and the receipt preview.
 *
 * Black on white whatever the screen's theme, 12 mm margins from `pageCss`, no
 * table row cut across a page. Every value is escaped; every amount goes
 * through `moneyText`; every label is from docs/GLOSSARY.md.
 *
 * This is a printed document, not a React screen, so it draws the logo with
 * its own <img> from the data URL BrandLogo already holds. The design guard
 * names this file as the one exception, which is why the thermal bill's logo
 * markup, `thermalLogoHtml`, lives here too.
 */
import { moneyText } from '../../components/ui/moneyText.js';

import { billFontPx, DEFAULT_BILL_TEXT_SIZE } from './printers.js';
import { escapeHtml } from './printText.js';
import { CLASSIC_STYLES } from './themes/classic.js';
import { themeFor } from './themes/index.js';
import { SHARED_STYLES } from './themes/shared.js';

/** The styles of the CLASSIC page, inside the print frame or the preview frame. */
export const INVOICE_STYLES = CLASSIC_STYLES + SHARED_STYLES;

/** P64. The styles of a theme's page. */
export function invoiceStyles(themeId) {
  return themeFor(themeId).styles;
}

/**
 * The page as HTML, in the restaurant's theme (P64), or `options.theme` for a
 * preview. `qrSvg` is the review link's QR code, already an SVG string from the
 * qrcode package; `logoDataUrl` is the restaurant's logo for light grounds and
 * `signatureDataUrl` its signature image, or null; `copy` is RECIPIENT or
 * SUPPLIER; `show` replaces the data's switches for a preview.
 */
export function invoiceHtml(data, options = {}) {
  return themeFor(options.theme ?? data.layout?.theme).render(data, options);
}

/**
 * The thermal bill. 2026-10-09, at Z Chaat's request: laid out like the bill
 * their guests know from their old system, from the same data as the full
 * page, so the two never print different amounts. Printed words are from
 * docs/GLOSSARY.md section 19. Bold sans-serif in solid black, because thin
 * monospace printed faint on their Rugtek. `logoDataUrl` is already pure black
 * and white (printBill.js); `qrSvg` is the review link's code.
 */
export const THERMAL_BILL_STYLES = `
  .tb { font-family: Arial, Helvetica, "Liberation Sans", sans-serif; font-weight: 700; color: black; line-height: 1.25; }
  .tb .c { text-align: center; } .tb .r { text-align: right; }
  .tb .logo { display: block; margin: 0 auto 4mm; height: auto; }
  .tb .store { font-size: 1.1em; }
  .tb .big { font-size: 1.3em; }
  .tb hr { border: 0; border-top: 1px solid black; margin: 1.2mm 0; }
  .tb .pair { display: flex; flex-wrap: wrap; justify-content: space-between; column-gap: 2mm; }
  /* 2026-10-27. When both sides do not fit, the right one drops to its own line, so a
     cashier's name is never squeezed into a column beside a long bill number. */
  .tb .pair span:first-child { flex: 1 1 auto; }
  .tb .pair span:last-child { white-space: nowrap; text-align: right; margin-left: auto; }
  .tb table { width: 100%; border-collapse: collapse; font-size: inherit; }
  .tb th, .tb td { padding: 0.4mm 0; vertical-align: top; font-weight: 700; font-size: inherit; }
  .tb .q, .tb .p, .tb .a { padding-left: 1mm; }
  .tb th { text-align: left; }
  .tb .q { text-align: center; width: 9%; } .tb .p, .tb .a { text-align: right; width: 19%; white-space: nowrap; }
  .tb .addon { font-size: 0.9em; padding-left: 2mm; }
  .tb .review { display: flex; flex-direction: column; align-items: center; gap: 1mm; margin-top: 2mm; }
  .tb .review svg { width: 26mm; height: 26mm; }
  .tb .foot { margin-top: 2.5mm; }
  .tb .feed { height: 4mm; }`;

const ORDER_PLACE_WORDS = { DINE_IN: 'Dine In', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };


/** "09/10/2026 14:57" as "09/10/26" and "14:57". */
function dateAndTime(stamp = '') {
  const [date = '', time = ''] = stamp.split(' ');
  const [day, month, year = ''] = date.split('/');
  return { date: day && month ? `${day}/${month}/${year.slice(-2)}` : date, time };
}

/**
 * P64. What the roll shows, from `layout.thermalShow`. A bill read before P64,
 * or a preview with no layout, shows what the roll always showed.
 */
const THERMAL_DEFAULTS = Object.freeze({
  time: true,
  cashier: true,
  covers: false,
  table: true,
  orderType: true,
  customerName: true,
  customerMobileMasked: true,
  itemNote: false,
  paymentBreakdown: true,
  onHoldOutstanding: false,
  amountInWords: false,
  reviewQr: true,
});

export function thermalBillHtml(data, { printer, logoDataUrl = null, qrSvg = null, textSize = DEFAULT_BILL_TEXT_SIZE, show: preview } = {}) {
  const show = { ...THERMAL_DEFAULTS, ...(preview ?? data.layout?.thermalShow ?? {}) };
  const r = data.restaurant;
  const plain = (paise) => moneyText(paise, { symbol: false });
  const row = (left, right, cls = '') => `<div class="pair ${cls}"><span>${left}</span><span>${right}</span></div>`;
  const { date, time } = dateAndTime(data.issuedAtIst);
  const placeWords = show.orderType ? ORDER_PLACE_WORDS[data.orderType] ?? '' : '';
  const tableWords = show.table && data.tableName ? escapeHtml(data.tableName) : '';
  const place = data.platform
    ? `${escapeHtml(data.platform.name)}: ${escapeHtml(data.platform.orderId)}`
    : `${placeWords}${tableWords ? `${show.orderType ? ': ' : ''}${tableWords}` : ''}`;

  // P35. The server's item rows, the same dish once; Total Qty below is unchanged.
  const items = (data.itemRows ?? data.lines)
    .map((line) => {
      const name = escapeHtml(line.itemName + (line.variantName ? ` (${line.variantName})` : ''));
      const each = Number.isInteger(line.lineTotalInPaise / line.quantity) ? line.lineTotalInPaise / line.quantity : line.unitPriceInPaise;
      const addOns = line.addOnNames.length ? `<div class="addon">+ ${escapeHtml(line.addOnNames.join(', '))}</div>` : '';
      const notes = Array.isArray(line.notes) ? line.notes : line.notes ? [line.notes] : [];
      const note = show.itemNote && notes.length ? `<div class="addon">${escapeHtml(notes.join('; '))}</div>` : '';
      return `<tr><td>${name}${addOns}${note}</td><td class="q">${line.quantity}</td><td class="p">${plain(each)}</td><td class="a">${plain(line.lineTotalInPaise)}</td></tr>`;
    })
    .join('');
  const totalQty = data.lines.reduce((sum, line) => sum + line.quantity, 0);

  const taxes = data.taxRows
    .map((slab) => {
      const half = slab.taxRateBps / 200;
      return row(`CGST@${half}%`, plain(slab.cgstInPaise)) + row(`SGST@${half}%`, plain(slab.sgstInPaise));
    })
    .join('');
  const roundOff = data.roundOffInPaise === 0 ? '' : row('Round off', `${data.roundOffInPaise > 0 ? '+' : ''}${plain(data.roundOffInPaise)}`);
  const guest = data.customer;
  const guestName = show.customerName ? guest?.name ?? '' : '';
  const guestMobile = show.customerMobileMasked && guest?.mobileLast4 ? ` (M: XXXXXX${escapeHtml(guest.mobileLast4)})` : '';
  const storeLines = [
    ...r.addressLines,
    r.phone ? `Mo No-${r.phone}` : null,
    r.gstin ? `GSTIN: ${r.gstin}` : null,
    r.fssaiNumber ? `FSSAI: ${r.fssaiNumber}` : null,
  ].filter(Boolean);

  return `<div class="tb" style="font-size: ${billFontPx(printer, textSize)}px">
  ${logoDataUrl ? `<img class="logo" src="${escapeHtml(logoDataUrl)}" alt="" style="width: ${printer === 'THERMAL_58' ? 30 : 45}mm" />` : ''}
  ${data.isDuplicate ? '<div class="c">*** DUPLICATE ***</div>' : ''}
  <div class="c">
    ${r.headerAbove ? `<div>${escapeHtml(r.headerAbove)}</div>` : ''}
    <div class="store">${escapeHtml(r.legalName || r.name)}</div>
    ${r.headerLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
    ${storeLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
  </div>
  <hr />
  <div class="c">TAX INVOICE</div>
  ${data.isVoided ? '<div class="c big">*** VOIDED ***</div>' : ''}
  <hr />
  ${
    guest && (guestName || guestMobile)
      ? `<div>Name: ${escapeHtml(guestName)}${guestMobile}</div><hr />`
      : ''
  }
  ${row(`Date: ${escapeHtml(date)}`, place)}
  ${show.time ? `<div>${escapeHtml(time)}</div>` : ''}
  ${row(show.cashier && data.cashierName ? `Cashier: ${escapeHtml(data.cashierName)}` : '', `Bill No.: ${escapeHtml(data.billNumber)}`)}
  ${data.isRevised ? '<div class="c">Revised bill</div>' : ''}
  ${data.captainName ? `<div>Captain: ${escapeHtml(data.captainName)}</div>` : ''}${show.covers && data.guestCount ? `<div>Covers: ${data.guestCount}</div>` : ''}
  <hr />
  <table>
    <thead><tr><th>Item</th><th class="q">Qty.</th><th class="p">Price</th><th class="a">Amount</th></tr></thead>
    <tbody><tr><td colspan="4"><hr /></td></tr>${items}</tbody>
  </table>
  <hr />
  <div class="totals">
    ${row(`Total Qty: ${totalQty}`, `Sub Total&nbsp;&nbsp;${plain(data.itemTotalInPaise)}`)}
    ${data.discount ? row(escapeHtml(data.discount.label), `-${plain(data.discount.amountInPaise)}`) : ''}
    ${data.discount?.reason ? `<div>${escapeHtml(data.discount.reason)}</div>` : ''}
    ${taxes}
    <hr />
    ${roundOff}
    ${row('Grand Total', `₹ ${plain(data.billTotalInPaise)}`, 'big')}${show.amountInWords && data.billTotalInWords ? `<div>${escapeHtml(data.billTotalInWords)}</div>` : ''}
    <hr />
    ${show.paymentBreakdown ? data.payments.map((payment) => row(`Paid: ${escapeHtml(payment.methodName)}`, plain(payment.amountInPaise))).join('') : ''}
    ${data.accountName ? `<div>On Hold: ${escapeHtml(data.accountName)}</div>` : ''}${show.onHoldOutstanding && Number.isInteger(data.onHoldOutstandingInPaise) ? row('Account balance', plain(data.onHoldOutstandingInPaise)) : ''}
  </div>
  <div class="c foot">${escapeHtml(data.footerText ?? 'Thank you')}</div>
  ${show.reviewQr && qrSvg ? `<div class="review">${qrSvg}<div>Scan to review us</div></div>` : ''}
  <div class="feed"></div>
</div>`;
}
