/**
 * The printed kitchen ticket, laid out on the server. M18, built in P05.
 *
 * A sibling of receiptService.js, sharing its wrapping and centring, for the
 * same reason the receipt is laid out here: one layout can be snapshot tested,
 * and a browser and a printer each doing their own will disagree on paper.
 *
 * No prices, anywhere. A kitchen ticket that shows money is a leak of
 * information the kitchen has no use for.
 *
 * 32 characters is 58mm paper. 48 is 80mm.
 */
import { ORDER_TYPES } from '../models/Order.js';
import { formatTimeIst12 } from '../utils/time.js';
import { centre, rule, wrapName } from './receiptService.js';

/** Item lines are indented under the quantity, so they read as one block. */
const DETAIL_INDENT = 4;

/** A detail line (variant, add-on, note), wrapped and indented under the item. */
function detail(text, width) {
  const wrapped = wrapName(text, width - DETAIL_INDENT, 2);
  return wrapped.map((line) => ' '.repeat(DETAIL_INDENT) + line);
}

/**
 * Who the ticket is for: the table and covers, TAKEAWAY, or the delivery
 * platform and its order number (P06).
 */
function destination({ kot, order }) {
  if (kot.orderType === ORDER_TYPES.DINE_IN) {
    const covers = order?.guestCount ? `  ${order.guestCount} guests` : '';
    return [`${kot.tableName ?? 'TABLE'}${covers}`];
  }

  if (kot.orderType === ORDER_TYPES.DELIVERY) {
    const platform = order?.platform;
    const lines = [
      platform ? `DELIVERY  ${platform.code} ${platform.orderId}` : 'DELIVERY',
    ];
    if (order?.customerName) lines.push(order.customerName);
    return lines;
  }

  // P23. An online takeaway carries its reference and pickup time, so the
  // kitchen knows when it is wanted, and only the guest's first name.
  if (order?.origin?.kind === 'ONLINE_ORDER') {
    const pickup = order.origin.pickupAt ? `  PICKUP ${formatTimeIst12(order.origin.pickupAt).toUpperCase()}` : '';
    const lines = [`ONLINE  ${order.origin.reference}${pickup}`];
    const firstName = order.customerName?.split(/\s+/)[0];
    if (firstName) lines.push(firstName);
    return lines;
  }

  const lines = ['TAKEAWAY'];
  if (order?.customerName) lines.push(order.customerName);
  return lines;
}

/**
 * Renders a KOT as plain text at a fixed width.
 *
 * Nothing is fetched here. The caller passes the ticket, the order fields the
 * header needs, and the name of whoever fired it, so this can be tested
 * without a database.
 */
export function renderKotTicket({ kot, order = null, firedByName = null, width = 32, reprint = false }) {
  const lines = [];
  const push = (text = '') => lines.push(text);

  // 2026-11-03. The whole KOT says ALL SECTIONS whenever its dishes have sections, apart from each section's slip.
  const sections = new Set((kot.lines ?? []).map((line) => line.stationName).filter(Boolean));
  const heading = kot.stationName ?? (sections.size > 0 ? 'All sections' : 'Kitchen');
  push(centre(heading.toUpperCase(), width));
  push(rule(width, '='));

  // P36. A later round prints as its own slip, under the same KOT number.
  const left = kot.round > 1 ? `KOT ${kot.kotNumber}  ROUND ${kot.round}` : `KOT ${kot.kotNumber}`;
  const right = formatTimeIst12(kot.firedAt);
  push(left + ' '.repeat(Math.max(1, width - left.length - right.length)) + right);

  // A header line that fits is printed as written, keeping its spacing;
  // only one too long for the paper is wrapped.
  for (const line of destination({ kot, order })) {
    if (line.length <= width) push(line);
    else for (const part of wrapName(line, width)) push(part);
  }
  // P56. One note for every dish, where the cook reads it before the dishes.
  if (kot.kitchenNote) {
    for (const part of wrapName(`FOR ALL ITEMS: ${kot.kitchenNote}`, width)) push(part);
  }
  if (firedByName) {
    for (const part of wrapName(`By ${firedByName}`, width)) push(part);
  }

  push(rule(width));

  for (const line of kot.lines) {
    const cancelled = line.status === 'CANCELLED';
    const head = `${line.quantity} x ${line.itemName}${cancelled ? ' (CANCELLED)' : ''}`;
    for (const part of wrapName(head, width, DETAIL_INDENT)) push(part);

    if (line.variantName) for (const part of detail(line.variantName, width)) push(part);
    for (const addOn of line.addOnNames ?? []) {
      for (const part of detail(`+ ${addOn}`, width)) push(part);
    }
    if (line.notes) for (const part of detail(`Note: ${line.notes}`, width)) push(part);
  }

  push(rule(width));
  if (reprint) push(centre('REPRINT', width));
  push('');

  return lines.join('\n');
}

export default { renderKotTicket };
