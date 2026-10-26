/**
 * The fixed cancel and void reasons. P04.
 *
 * A mirror of server/config/cancelReasons.js, codes and labels only, so the
 * buttons say exactly what the reports will print. A server test loads this
 * file and checks the two hold the same entries in the same order, which is
 * why it has no imports. Never type a label again in a component: read it here.
 */

export const LINE_CANCEL_REASONS = [
  { code: 'MODIFICATION', label: 'Guest changed the order' },
  { code: 'WRONG_ITEM', label: 'Wrong item entered' },
  { code: 'DUPLICATE', label: 'Entered twice' },
  { code: 'OUT_OF_STOCK', label: 'Kitchen ran out' },
  { code: 'TOO_SLOW', label: 'Took too long' },
  { code: 'QUALITY', label: 'Quality complaint' },
  { code: 'GUEST_LEFT', label: 'Guest left' },
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  // P41. Written by Undo after a Send.
  { code: 'SENT_BY_MISTAKE', label: 'Sent to the kitchen by mistake' },
  { code: 'OTHER', label: 'Other' },
];

export const ORDER_CANCEL_REASONS = [
  { code: 'GUEST_LEFT', label: 'Guest left' },
  { code: 'WRONG_TABLE', label: 'Opened on the wrong table' },
  { code: 'DUPLICATE', label: 'Opened twice' },
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  { code: 'OTHER', label: 'Other' },
];

export const BILL_VOID_REASONS = [
  { code: 'WRONG_TABLE', label: 'Billed to the wrong table' },
  { code: 'ITEMS_CHANGED', label: 'Items need changing' },
  { code: 'DISCOUNT_CHANGED', label: 'Discount needs changing' },
  { code: 'DUPLICATE', label: 'Billed twice' },
  { code: 'GUEST_DISPUTE', label: 'Guest disputed the bill' },
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  { code: 'GUEST_LEFT', label: 'Guest left' },
  { code: 'OTHER', label: 'Other' },
];

export const OTHER_REASON_CODE = 'OTHER';

/** The label for a stored code, or null for a record from before codes existed. */
export function reasonLabel(list, code) {
  if (!code) return null;
  return list.find((entry) => entry.code === code)?.label ?? code;
}

/** "Wrong item entered: tapped the wrong pizza", or just the label, or the old free text. */
export function describeReason(list, code, note) {
  const label = reasonLabel(list, code);
  if (label && note) return `${label}: ${note}`;
  return label ?? note ?? null;
}
