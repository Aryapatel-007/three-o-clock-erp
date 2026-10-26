/**
 * CLASSIC: the full-page tax invoice as it printed before P64 (P25 Part C4).
 *
 * With the switches at their defaults it prints exactly what P25's
 * `invoiceHtml` printed, byte for byte; a test compares it with pages saved
 * from that function for every golden day bill. A switch adds or removes a
 * part, never moves a figure. Black on white whatever the screen's theme, no
 * table row cut across a page.
 */
import {
  amountInWords,
  copyMarking,
  declaration,
  escapeHtml,
  invoiceFacts,
  lineExtras,
  money,
  nameOf,
  percent,
  reviewCode,
  rowsOf,
  settlement,
  SHARED_STYLES,
  signatureBlock,
  supplierDetails,
  switchesFor,
  terms,
  total,
} from './shared.js';

export const CLASSIC_STYLES = `
  .invoice { font: 10pt/1.35 "Anek Latin", system-ui, sans-serif; color: black; }
  .invoice h1 { font-size: 16pt; margin: 0; }
  .invoice .muted { color: dimgray; }
  .invoice .head { display: flex; justify-content: space-between; gap: 6mm; align-items: flex-start; }
  .invoice .logo { max-height: 18mm; max-width: 50mm; display: block; margin-bottom: 2mm; }
  .invoice .box { border: 0.3mm solid black; padding: 2mm 3mm; min-width: 50mm; }
  .invoice .box div { display: flex; justify-content: space-between; gap: 4mm; }
  .invoice .title { text-align: center; font-weight: 700; letter-spacing: 0.08em; margin: 4mm 0 2mm; }
  .invoice .duplicate { text-align: center; font-weight: 700; border: 0.3mm solid black; padding: 1mm; margin-bottom: 3mm; }
  .invoice table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  .invoice th, .invoice td { padding: 1.2mm 1.5mm; border-bottom: 0.2mm solid darkgray; text-align: left; vertical-align: top; }
  .invoice th { border-bottom: 0.4mm solid black; font-weight: 600; }
  .invoice .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .invoice tr { break-inside: avoid; page-break-inside: avoid; }
  .invoice .totals { margin-left: auto; width: 60%; margin-top: 3mm; break-inside: avoid; }
  .invoice .totals div { display: flex; justify-content: space-between; padding: 0.8mm 0; }
  .invoice .grand { border-top: 0.4mm solid black; border-bottom: 0.4mm solid black; font-size: 14pt; font-weight: 700; margin-top: 1mm; }
  .invoice .foot { margin-top: 6mm; text-align: center; break-inside: avoid; }
  .invoice .review { display: flex; flex-direction: column; align-items: center; gap: 1mm; margin-top: 3mm; }
  .invoice .review svg { width: 28mm; height: 28mm; }
  .invoice .voided { text-align: center; font-weight: 700; font-size: 14pt; margin: 3mm 0; }
`;

/**
 * The page as HTML. `qrSvg` is the review link's QR code, an SVG string;
 * `logoDataUrl` the logo for light grounds and `signatureDataUrl` the
 * signature image, each a data URL or null; `copy` is RECIPIENT or SUPPLIER;
 * `show`, when given, replaces the data's own switches (a preview).
 * `rootClass` and `band` are for the themes built on this page.
 */
export function renderClassic(
  data,
  { qrSvg = null, logoDataUrl = null, signatureDataUrl = null, copy = 'RECIPIENT', show: preview, rootClass = 'invoice', band = '' } = {},
) {
  const show = switchesFor(data, { show: preview });
  const r = data.restaurant;
  const details = supplierDetails(data, show);
  const facts = invoiceFacts(data, show);
  const hsn = Boolean(show.hsn);

  // P35. The server's item rows: the same dish ordered in two rounds prints once.
  const lineRows = rowsOf(data)
    .map((line) => {
      const code = hsn ? `<td>${escapeHtml(line.hsnCode ?? '')}</td>` : '';
      return `<tr><td>${escapeHtml(nameOf(line))}${lineExtras(line, show)}</td>${code}<td class="num">${line.quantity}</td><td class="num">${money(line.unitPriceInPaise)}</td><td class="num">${money(line.lineTotalInPaise)}</td></tr>`;
    })
    .join('');

  const taxRows = data.taxRows
    .map(
      (row) =>
        `<tr><td>${percent(row.taxRateBps)}</td><td class="num">${money(row.netSalesInPaise)}</td><td class="num">${money(row.cgstInPaise)}</td><td class="num">${money(row.sgstInPaise)}</td></tr>`,
    )
    .join('');

  const { payments, account, balance } = settlement(data, show);

  // MODERN and COMPACT draw this page with a class and a band of their own (P64).
  return `<div class="${rootClass}">${band}
  ${copyMarking(show, { copy })}${data.isDuplicate ? '<div class="duplicate">DUPLICATE</div>' : ''}
  <div class="head">
    <div>
      ${logoDataUrl ? `<img class="logo" src="${escapeHtml(logoDataUrl)}" alt="" />` : ''}
      ${r.headerAbove ? `<div class="muted">${escapeHtml(r.headerAbove)}</div>` : ''}
      <h1>${escapeHtml(r.name)}</h1>
      ${r.headerLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      ${details.map((line) => `<div class="muted">${escapeHtml(line)}</div>`).join('')}
    </div>
    <div class="box">${facts.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
  </div>
  <div class="title">TAX INVOICE</div>
  ${data.isVoided ? '<div class="voided">VOIDED</div>' : ''}
  <table>
    <thead><tr><th>Item</th>${hsn ? '<th>HSN/SAC</th>' : ''}<th class="num">Quantity</th><th class="num">Rate</th><th class="num">Line total</th></tr></thead>
    <tbody>${lineRows}</tbody>
  </table>
  <table>
    <thead><tr><th>Tax rate</th><th class="num">Net sales</th><th class="num">CGST</th><th class="num">SGST</th></tr></thead>
    <tbody>${taxRows}</tbody>
  </table>
  <div class="totals">
    ${total('Item total', data.itemTotalInPaise)}
    ${data.discount ? total(data.discount.label, -data.discount.amountInPaise) : ''}
    ${data.discount?.reason ? `<div class="muted"><span>${escapeHtml(data.discount.reason)}</span></div>` : ''}
    ${total('CGST', data.cgstInPaise)}
    ${total('SGST', data.sgstInPaise)}
    ${data.roundOffInPaise !== 0 ? total('Round-off', data.roundOffInPaise) : ''}
    ${total('Bill total', data.billTotalInPaise, 'grand')}${amountInWords(data, show)}
    ${payments}
    ${account}${balance}
  </div>
  <div class="foot">
    <div>${escapeHtml(data.footerText ?? 'Thank you')}</div>
    ${reviewCode(show, qrSvg)}${terms(data, show)}${declaration(show)}${signatureBlock(data, show, signatureDataUrl)}
  </div>
</div>`;
}

export default {
  id: 'CLASSIC',
  title: 'Classic',
  paper: ['A4', 'A5'],
  styles: CLASSIC_STYLES + SHARED_STYLES,
  render: renderClassic,
};
