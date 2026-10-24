/**
 * The printed receipt, laid out on the server.
 *
 * The client prints what it is given. It does no wrapping, no padding and no
 * column arithmetic of its own, and that is not a preference.
 *
 * A thermal printer has a fixed character width. BUILD-PLAN section 8 names a
 * long dish name wrapping and destroying the layout as a thing that bites
 * teams the week before a pilot. One server-side implementation can be snapshot
 * tested; a browser and a printer each doing their own layout will disagree,
 * and the disagreement only ever shows up on paper, in a restaurant, at 8pm.
 *
 * 32 characters is 58mm paper. 48 is 80mm.
 *
 * This is also the one place in the server that formats money for display,
 * because the layout depends on the exact character count. Everywhere else
 * hands paise to the client and lets it format.
 */
import { discountReasonText } from '../config/discountReasons.js';
import { groupBillLines } from '../utils/billLines.js';
import { paiseToIndianWords, paiseToRupees } from '../utils/money.js';
import { toIst } from '../utils/time.js';

const RULE = '-';
const DOUBLE_RULE = '=';

/** Right-aligned money, so a column of amounts lines up on the decimal point. */
function money(paise) {
  return paiseToRupees(paise);
}

export function centre(text, width) {
  const trimmed = text.slice(0, width);
  const pad = Math.max(0, Math.floor((width - trimmed.length) / 2));
  return ' '.repeat(pad) + trimmed;
}

export function rule(width, character = RULE) {
  return character.repeat(width);
}

/**
 * A label on the left and an amount on the right, filling the width.
 *
 * When the two cannot both fit, the label is truncated rather than the amount:
 * a customer can live with "Paneer Tikka Mas" and cannot live with a total
 * missing its last digit.
 */
export function row(label, amount, width) {
  const value = String(amount);
  const room = width - value.length - 1;
  const left = label.length > room ? label.slice(0, Math.max(0, room)) : label;
  return left + ' '.repeat(Math.max(1, width - left.length - value.length)) + value;
}

/**
 * Wraps a long name across lines, indenting the continuation under itself.
 *
 * Never truncates and never lets the name push the amount column out of
 * alignment. This is the function the 60-character snapshot test exists for.
 */
export function wrapName(name, width, indent = 2) {
  const words = name.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const room = lines.length === 0 ? width : width - indent;
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= room) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);
    // A single word longer than the line is cut hard: there is nowhere else
    // for it to go, and leaving it would overflow the column.
    current = word.length > width - indent ? word.slice(0, width - indent) : word;
  }
  if (current) lines.push(current);

  return lines.map((line, index) => (index === 0 ? line : ' '.repeat(indent) + line));
}

/**
 * IST, because a bill is read by a person standing in Gujarat.
 *
 * Built on utils/time.js `toIst` rather than on its own date maths, so the one
 * sanctioned UTC-to-IST conversion stays the only one. That helper returns
 * "2026-08-30 15:30:00 IST"; a receipt wants the day first and no seconds.
 */
function istStamp(date) {
  const [day, time] = toIst(date).split(' ');
  const [year, month, dayOfMonth] = day.split('-');
  return `${dayOfMonth}/${month}/${year} ${time.slice(0, 5)}`;
}

/** The address as one line, for the full page. */
function addressLine(address = {}) {
  return [address.line1, address.line2, [address.city, address.pincode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
}

/** "Discount (10%)" or "Discount", the same words on paper and on the page. */
function discountLabel(discount) {
  return discount.kind === 'PERCENT' ? `Discount (${discount.rateBps / 100}%)` : 'Discount';
}

/**
 * The bill as the data every printed form of it is laid out from. P25 C4,
 * API-CONTRACT M3 section 16.1.
 *
 * `renderReceipt` lays this out as fixed-width text for a thermal roll, and
 * GET /bills/:billId/invoice returns it as it is for a full A4 or A5 page. One
 * object, so the two can never print different amounts. `receipt` is
 * `settings.receipt`; a missing one prints the name, GSTIN and FSSAI, and no
 * header or footer lines.
 */
export function buildInvoiceData({ restaurant, bill, receipt = {}, lineNotes = null }) {
  const showGstin = receipt.showGstin ?? true;
  const showFssai = receipt.showFssai ?? true;
  const printCount = bill.printCount ?? 0;
  // P29 Part B. A print after a revision is a new print, because its content changed.
  const revision = bill.revision ?? 0;

  return {
    restaurant: {
      name: restaurant.name,
      legalName: restaurant.legalName || null,
      address: addressLine(restaurant.address ?? {}) || null,
      addressLines: [
        restaurant.address?.line1,
        restaurant.address?.line2,
        [restaurant.address?.city, restaurant.address?.pincode].filter(Boolean).join(' '),
      ].filter(Boolean),
      phone: restaurant.contactPhone || null,
      gstin: showGstin ? restaurant.gstin || null : null,
      fssaiNumber: showFssai ? restaurant.fssaiLicenseNumber || null : null,
      headerAbove: receipt.headerLine1 || null,
      headerLines: [receipt.headerLine2].filter(Boolean),
      // P64. Printed on the full page only, each under its own switch.
      panNumber: restaurant.panNumber || null,
      msmeNumber: restaurant.msmeNumber || null,
      termsText: receipt.termsText || null,
    },
    billId: String(bill._id ?? bill.id),
    billNumber: bill.billNumber,
    isVoided: Boolean(bill.isVoided),
    printCount,
    isDuplicate: isDuplicatePrint(bill),
    revision,
    isRevised: revision > 0,
    issuedAt: bill.billedAt,
    issuedAtIst: istStamp(bill.billedAt),
    businessDate: bill.businessDate,
    orderType: bill.orderType ?? null,
    tableName: bill.tableName ?? null,
    captainName: receipt.showServerName ? bill.captainName ?? null : null,
    guestCount: bill.guestCount ?? null,
    platform: bill.platform?.code ? { code: bill.platform.code, name: bill.platform.name, orderId: bill.platform.orderId } : null,
    taxTreatment: bill.taxTreatment ?? 'NORMAL',
    lines: bill.lines.map((line) => ({
      itemName: line.itemName,
      variantName: line.variantName ?? null,
      addOnNames: [...(line.addOnNames ?? [])],
      quantity: line.quantity,
      unitPriceInPaise: line.unitPriceInPaise,
      lineTotalInPaise: line.lineTotalInPaise,
      taxRateBps: line.taxRateBps,
      // P64. Frozen on the line; null on a bill from before P64.
      hsnCode: line.hsnCode ?? null,
      notes: noteOf(lineNotes, line.orderLineId),
    })),
    // P35. The same dish once: what every printed bill lists. Computed, never stored.
    itemRows: groupBillLines(bill.lines).map(({ orderLineIds, ...row }) => ({
      ...row,
      orderLineIds,
      // P64. Each line's note once.
      notes: [...new Set(orderLineIds.map((id) => noteOf(lineNotes, id)).filter(Boolean))],
    })),
    itemTotalInPaise: bill.subtotalInPaise,
    discount: bill.discount
      ? {
          label: discountLabel(bill.discount),
          reason: discountReasonText(bill.discount) || null,
          amountInPaise: bill.discount.amountInPaise,
        }
      : null,
    taxRows: bill.taxBreakdown.map((slab) => ({
      taxRateBps: slab.taxRateBps,
      netSalesInPaise: slab.taxableInPaise,
      cgstInPaise: slab.cgstInPaise,
      sgstInPaise: slab.sgstInPaise,
    })),
    cgstInPaise: bill.taxBreakdown.reduce((sum, slab) => sum + slab.cgstInPaise, 0),
    sgstInPaise: bill.taxBreakdown.reduce((sum, slab) => sum + slab.sgstInPaise, 0),
    gstInPaise: bill.totalTaxInPaise,
    roundOffInPaise: bill.roundOffInPaise,
    billTotalInPaise: bill.grandTotalInPaise,
    // P64. Spelled by money.js, never by a theme.
    billTotalInWords: paiseToIndianWords(bill.grandTotalInPaise),
    payments: (bill.payments ?? []).map((payment) => ({
      methodName: payment.methodName ?? payment.method,
      amountInPaise: payment.amountInPaise,
    })),
    accountName: bill.account?.accountName ?? null,
    footerText: receipt.footerText || null,
    reviewLinkUrl: receipt.reviewLinkUrl || null,
  };
}

/** An order line's note, from a map of order line id to note, or null. */
function noteOf(lineNotes, orderLineId) {
  if (!lineNotes || orderLineId === null || orderLineId === undefined) return null;
  return lineNotes.get(String(orderLineId)) || null;
}

/**
 * Renders a bill as plain text at a fixed column width, from
 * `buildInvoiceData`. `restaurant` and `bill` are documents. Nothing is
 * fetched here: the caller has both already, and a formatter that reaches for
 * the database is a formatter that cannot be tested without one.
 *
 * The review link's QR code is drawn by the client under this text; the text
 * only says "Scan to review us" is coming.
 */
export function renderReceipt({ restaurant, bill, width = 32, receipt = {} }) {
  return layoutReceipt(buildInvoiceData({ restaurant, bill, receipt }), width);
}

/**
 * P29 Part B. Whether the next print of this bill is a duplicate: it has been
 * printed before, and nothing on it changed since. A bill printed before P29
 * has no `lastPrintedRevision`, which reads as revision 0.
 */
export function isDuplicatePrint(bill) {
  if ((bill.printCount ?? 0) < 1) return false;
  return (bill.lastPrintedRevision ?? 0) === (bill.revision ?? 0);
}

/** Fixed-width text from the invoice data. */
export function layoutReceipt(data, width = 32) {
  const lines = [];
  const push = (text = '') => lines.push(text);
  const header = data.restaurant;

  if (data.isDuplicate) push(centre('*** DUPLICATE ***', width));
  if (header.headerAbove) push(centre(header.headerAbove, width));
  push(centre(header.name.toUpperCase(), width));
  for (const extra of header.headerLines) push(centre(extra, width));
  if (header.legalName) push(centre(header.legalName, width));
  for (const part of header.addressLines) push(centre(part, width));
  if (header.phone) push(centre(`Ph: ${header.phone}`, width));
  if (header.gstin) push(centre(`GSTIN: ${header.gstin}`, width));
  if (header.fssaiNumber) push(centre(`FSSAI: ${header.fssaiNumber}`, width));

  push(rule(width, DOUBLE_RULE));
  push(centre('TAX INVOICE', width));
  push(row('Bill', data.billNumber, width));
  if (data.isRevised) push(centre('Revised bill', width));
  push(row('Date', data.businessDate, width));
  push(row('Time', data.issuedAtIst, width));
  if (data.tableName) push(row('Table', data.tableName, width));
  if (data.captainName) push(row('Captain', data.captainName, width));
  if (data.platform) push(row(data.platform.name, data.platform.orderId, width));
  push(rule(width));

  // Quantity and amount share the right-hand side, so the name gets the rest.
  push(row('Item', 'Amount', width));
  push(rule(width));

  // P35. One row per dish at one price, so two rounds of Roti print once.
  for (const line of data.itemRows ?? data.lines) {
    const wrapped = wrapName(line.itemName + (line.variantName ? ` (${line.variantName})` : ''), width);
    for (const part of wrapped.slice(0, -1)) push(part);

    const last = wrapped[wrapped.length - 1];
    push(row(last, money(line.lineTotalInPaise), width));
    push(`  ${line.quantity} x ${money(line.unitPriceInPaise)}`);

    for (const addOn of line.addOnNames) push(`  + ${addOn}`.slice(0, width));
  }

  push(rule(width));
  push(row('Subtotal', money(data.itemTotalInPaise), width));

  if (data.discount) {
    push(row(data.discount.label, `-${money(data.discount.amountInPaise)}`, width));
    if (data.discount.reason) for (const part of wrapName(`  ${data.discount.reason}`, width, 2)) push(part);
  }

  for (const slab of data.taxRows) {
    const percent = slab.taxRateBps / 100;
    push(row(`CGST @ ${percent / 2}%`, money(slab.cgstInPaise), width));
    push(row(`SGST @ ${percent / 2}%`, money(slab.sgstInPaise), width));
  }

  if (data.roundOffInPaise !== 0) {
    const sign = data.roundOffInPaise > 0 ? '' : '-';
    push(row('Round off', `${sign}${money(Math.abs(data.roundOffInPaise))}`, width));
  }

  push(rule(width, DOUBLE_RULE));
  push(row('TOTAL', money(data.billTotalInPaise), width));
  push(rule(width, DOUBLE_RULE));

  for (const payment of data.payments) {
    push(row(payment.methodName, money(payment.amountInPaise), width));
  }
  if (data.accountName) push(row(`On Hold: ${data.accountName}`, '', width).trimEnd());

  if (data.isVoided) {
    push('');
    push(centre('*** VOIDED ***', width));
  }

  push('');
  for (const part of wrapName(data.footerText ?? 'Thank you', width, 0)) push(centre(part, width));
  if (data.reviewLinkUrl) push(centre('Scan to review us', width));
  push('');

  return lines.join('\n');
}

export default { buildInvoiceData, layoutReceipt, renderReceipt };
