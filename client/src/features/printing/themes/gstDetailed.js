/**
 * GST_DETAILED: the invoice a chartered accountant asks for. P64.
 *
 * An HSN or SAC column (under `show.hsn`), each line's GST rate, a rate
 * summary with the taxable value and the CGST and SGST rate and amount per
 * slab, the amount in words, the declaration and a signature line, each under
 * its own switch so the owner can still take one off. Every figure is a field
 * of the invoice data: the summary's rows are the bill's own `taxRows`, and its
 * last row the bill's own CGST and SGST, never a sum worked out here.
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

const GST_STYLES = `
  .invoice { font: 9.5pt/1.35 "Anek Latin", system-ui, sans-serif; color: black; }
  .invoice h1 { font-size: 15pt; margin: 0; }
  .invoice .muted { color: dimgray; }
  .invoice .title { text-align: center; font-weight: 700; letter-spacing: 0.1em; font-size: 12pt; border: 0.4mm solid black; padding: 1.5mm; margin-bottom: 3mm; }
  .invoice .duplicate { text-align: center; font-weight: 700; margin-bottom: 2mm; }
  .invoice .voided { text-align: center; font-weight: 700; font-size: 14pt; margin: 3mm 0; }
  .invoice .parties { display: grid; grid-template-columns: 1fr minmax(62mm, auto); border: 0.3mm solid black; }
  .invoice .parties > div { padding: 2mm 3mm; }
  .invoice .parties > div + div { border-left: 0.3mm solid black; }
  .invoice .logo { max-height: 16mm; max-width: 45mm; display: block; margin-bottom: 1.5mm; }
  .invoice .fact { display: flex; justify-content: space-between; gap: 4mm; }
  .invoice .fact strong { white-space: nowrap; text-align: right; }
  .invoice table { width: 100%; border-collapse: collapse; margin-top: 3mm; }
  .invoice th, .invoice td { padding: 1mm 1.5mm; border: 0.2mm solid black; text-align: left; vertical-align: top; }
  .invoice th { font-weight: 600; background: whitesmoke; }
  .invoice .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .invoice tr { break-inside: avoid; page-break-inside: avoid; }
  .invoice .caption { font-weight: 600; margin-top: 4mm; }
  .invoice .totals { margin-left: auto; width: 55%; margin-top: 3mm; break-inside: avoid; }
  .invoice .totals div { display: flex; justify-content: space-between; padding: 0.6mm 0; }
  .invoice .grand { border-top: 0.4mm solid black; border-bottom: 0.4mm solid black; font-size: 13pt; font-weight: 700; margin-top: 1mm; }
  .invoice .foot { margin-top: 5mm; text-align: center; break-inside: avoid; }
  .invoice .review { display: flex; flex-direction: column; align-items: center; gap: 1mm; margin-top: 3mm; }
  .invoice .review svg { width: 24mm; height: 24mm; }
`;

export function renderGstDetailed(data, { qrSvg = null, logoDataUrl = null, signatureDataUrl = null, copy = 'RECIPIENT', show: preview } = {}) {
  const show = switchesFor(data, { show: preview });
  const r = data.restaurant;
  const hsn = Boolean(show.hsn);

  const lineRows = rowsOf(data)
    .map((line, index) => {
      const code = hsn ? `<td>${escapeHtml(line.hsnCode ?? '')}</td>` : '';
      return `<tr><td class="num">${index + 1}</td><td>${escapeHtml(nameOf(line))}${lineExtras(line, show)}</td>${code}<td class="num">${line.quantity}</td><td class="num">${money(line.unitPriceInPaise)}</td><td class="num">${percent(line.taxRateBps)}</td><td class="num">${money(line.lineTotalInPaise)}</td></tr>`;
    })
    .join('');

  const slabRows = data.taxRows
    .map(
      (row) =>
        `<tr><td>${percent(row.taxRateBps)}</td><td class="num">${money(row.netSalesInPaise)}</td><td class="num">${percent(row.taxRateBps / 2)}</td><td class="num">${money(row.cgstInPaise)}</td><td class="num">${percent(row.taxRateBps / 2)}</td><td class="num">${money(row.sgstInPaise)}</td></tr>`,
    )
    .join('');

  const { payments, account, balance } = settlement(data, show);
  const facts = invoiceFacts(data, show);

  return `<div class="invoice gst">
  ${copyMarking(show, { copy })}
  ${data.isDuplicate ? '<div class="duplicate">DUPLICATE</div>' : ''}
  <div class="title">TAX INVOICE</div>
  ${data.isVoided ? '<div class="voided">VOIDED</div>' : ''}
  <div class="parties">
    <div>
      ${logoDataUrl ? `<img class="logo" src="${escapeHtml(logoDataUrl)}" alt="" />` : ''}
      ${r.headerAbove ? `<div class="muted">${escapeHtml(r.headerAbove)}</div>` : ''}
      <h1>${escapeHtml(r.name)}</h1>
      ${r.headerLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      ${supplierDetails(data, show).map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
    </div>
    <div>${facts.map(([label, value]) => `<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>
  </div>
  <table>
    <thead><tr><th class="num">#</th><th>Item</th>${hsn ? '<th>HSN/SAC</th>' : ''}<th class="num">Quantity</th><th class="num">Rate</th><th class="num">Tax rate</th><th class="num">Line total</th></tr></thead>
    <tbody>${lineRows}</tbody>
  </table>
  <div class="caption">Tax summary</div>
  <table>
    <thead><tr><th>Tax rate</th><th class="num">Net sales</th><th class="num">CGST rate</th><th class="num">CGST</th><th class="num">SGST rate</th><th class="num">SGST</th></tr></thead>
    <tbody>${slabRows}<tr><th colspan="3">Total</th><th class="num">${money(data.cgstInPaise)}</th><th></th><th class="num">${money(data.sgstInPaise)}</th></tr></tbody>
  </table>
  <div class="totals">
    ${total('Item total', data.itemTotalInPaise)}
    ${data.discount ? total(data.discount.label, -data.discount.amountInPaise) : ''}
    ${data.discount?.reason ? `<div class="muted"><span>${escapeHtml(data.discount.reason)}</span></div>` : ''}
    ${total('CGST', data.cgstInPaise)}
    ${total('SGST', data.sgstInPaise)}
    ${data.roundOffInPaise !== 0 ? total('Round-off', data.roundOffInPaise) : ''}
    ${total('Bill total', data.billTotalInPaise, 'grand')}
    ${payments}${account}${balance}
  </div>
  ${amountInWords(data, show)}
  ${declaration(show)}
  ${signatureBlock(data, show, signatureDataUrl)}
  ${terms(data, show)}
  <div class="foot">
    <div>${escapeHtml(data.footerText ?? 'Thank you')}</div>
    ${reviewCode(show, qrSvg)}
  </div>
</div>`;
}

export default {
  id: 'GST_DETAILED',
  title: 'GST detailed',
  paper: ['A4', 'A5'],
  styles: GST_STYLES + SHARED_STYLES,
  render: renderGstDetailed,
};
