/**
 * The fixed reasons for cancelling an item, cancelling an order and voiding a
 * bill. P04.
 *
 * Constants, not settings. Reports group by code, so a restaurant renaming a
 * code would split its own history in two. Like the role list, a closed list
 * the software depends on. Adding a reason is an append to the end of a list,
 * never a rename and never a reorder.
 *
 * The labels are what staff see on the buttons and what reports print.
 *
 * Mirrored, codes and labels only, in client/src/features/orders/cancelReasons.js.
 * A test asserts the two files hold exactly the same entries in the same order.
 */

const freezeList = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

/** Cancelling one item on an order. */
export const LINE_CANCEL_REASONS = freezeList([
  { code: 'MODIFICATION', label: 'Guest changed the order' },
  { code: 'WRONG_ITEM', label: 'Wrong item entered' },
  { code: 'DUPLICATE', label: 'Entered twice' },
  { code: 'OUT_OF_STOCK', label: 'Kitchen ran out' },
  { code: 'TOO_SLOW', label: 'Took too long' },
  { code: 'QUALITY', label: 'Quality complaint' },
  { code: 'GUEST_LEFT', label: 'Guest left' },
  // P25 Part H. Appended only.
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  // P41. Written by Undo after a Send; appended only.
  { code: 'SENT_BY_MISTAKE', label: 'Sent to the kitchen by mistake' },
  { code: 'OTHER', label: 'Other' },
]);

/** Cancelling a whole order. */
export const ORDER_CANCEL_REASONS = freezeList([
  { code: 'GUEST_LEFT', label: 'Guest left' },
  { code: 'WRONG_TABLE', label: 'Opened on the wrong table' },
  { code: 'DUPLICATE', label: 'Opened twice' },
  // P25 Part H. Appended only.
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  { code: 'OTHER', label: 'Other' },
]);

/**
 * P50. The code an order closed because it was opened by mistake keeps.
 * Written only by POST /orders/:orderId/close, on an order nothing was sent
 * from, so it is not in the list a manager's Cancel order offers or accepts.
 */
export const ORDER_OPENED_BY_MISTAKE = 'OPENED_BY_MISTAKE';

/** Voiding a bill. */
export const BILL_VOID_REASONS = freezeList([
  { code: 'WRONG_TABLE', label: 'Billed to the wrong table' },
  { code: 'ITEMS_CHANGED', label: 'Items need changing' },
  { code: 'DISCOUNT_CHANGED', label: 'Discount needs changing' },
  { code: 'DUPLICATE', label: 'Billed twice' },
  { code: 'GUEST_DISPUTE', label: 'Guest disputed the bill' },
  // P25 Part H. Appended only.
  { code: 'PLATFORM_CANCELLED', label: 'Cancelled by the platform' },
  // P59. Voids the bill and cancels the order, so the table is free. Appended only.
  { code: 'GUEST_LEFT', label: 'Guest left' },
  { code: 'OTHER', label: 'Other' },
]);

/** The code that requires a note. */
export const OTHER_REASON_CODE = 'OTHER';

export const codesOf = (list) => Object.freeze(list.map((entry) => entry.code));

export const LINE_CANCEL_REASON_CODES = codesOf(LINE_CANCEL_REASONS);
export const ORDER_CANCEL_REASON_CODES = codesOf(ORDER_CANCEL_REASONS);
export const BILL_VOID_REASON_CODES = codesOf(BILL_VOID_REASONS);

/**
 * The text an audit line carries as its `reason`: the label, then ": " and the
 * note when there is one. "Other: guest spilled it" reads on its own in a log.
 */
export function reasonText(list, code, note) {
  const label = list.find((entry) => entry.code === code)?.label ?? code;
  return note ? `${label}: ${note}` : label;
}
