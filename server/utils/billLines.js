/**
 * A bill's lines grouped for a person to read. P35, API-CONTRACT M3 14.2.
 *
 * A table that orders the same dish in two rounds has two order lines, and so
 * two bill lines: each round went to the kitchen on its own ticket, and each
 * bill line still traces to its order line. The bill shows the dish once,
 * "2 × Roti", from these rows. They are computed every time a bill is read and
 * never stored, so the lines themselves never change.
 *
 * Two lines join one row only when the dish, its frozen name, its size, its
 * extras (as a set), its unit price and its tax rate are all the same. A price
 * changed between the rounds, a different size or different extras stay as
 * separate rows: each round keeps what it was ordered at.
 *
 * Money is added only with `sumPaise`.
 */
import { sumPaise } from './money.js';

const asId = (value) => (value === null || value === undefined ? null : String(value));

/** Loud on a line a real bill never has: a throw here is a bug, not bad input. */
function assertLine(line, index) {
  const where = `bill line ${index + 1}`;
  if (!asId(line.orderLineId)) throw new TypeError(`${where} has no orderLineId.`);
  for (const field of ['unitPriceInPaise', 'lineTotalInPaise']) {
    if (!Number.isInteger(line[field])) throw new TypeError(`${where} ${field} must be a whole number of paise, got ${line[field]}.`);
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new TypeError(`${where} quantity must be a whole number of at least 1, got ${line.quantity}.`);
}

/** The key two lines share when they are the same dish at the same price. */
function rowKey(line) {
  const addOns = [...(line.addOnNames ?? [])].map(String).sort();
  return JSON.stringify([
    asId(line.menuItemId),
    line.itemName,
    line.variantName ?? null,
    addOns,
    line.unitPriceInPaise,
    line.taxRateBps,
    // P64. A code changed between rounds keeps the rounds apart, as a price does.
    line.hsnCode ?? null,
  ]);
}

/**
 * `lines` are bill lines, documents or plain objects. Returns the rows, in the
 * order of each row's first line.
 */
export function groupBillLines(lines) {
  const rows = new Map();
  (lines ?? []).forEach((line, index) => {
    assertLine(line, index);
    const key = rowKey(line);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, {
        itemName: line.itemName,
        variantName: line.variantName ?? null,
        addOnNames: [...(line.addOnNames ?? [])],
        quantity: line.quantity,
        unitPriceInPaise: line.unitPriceInPaise,
        taxRateBps: line.taxRateBps,
        hsnCode: line.hsnCode ?? null,
        lineTotalInPaise: line.lineTotalInPaise,
        orderLineIds: [asId(line.orderLineId)],
      });
      return;
    }
    row.quantity += line.quantity;
    row.lineTotalInPaise = sumPaise(row.lineTotalInPaise, line.lineTotalInPaise);
    row.orderLineIds.push(asId(line.orderLineId));
  });
  return [...rows.values()];
}
