/**
 * GST arithmetic. All of it. Nothing outside this file computes tax.
 *
 * This is to tax what utils/money.js is to money, and for the same reason:
 * CONVENTIONS section 13 makes GST the one place where a quiet bug costs a
 * client money, so it gets one implementation and real tests.
 *
 * The rules, all decided in docs/PROJECT-STATE.md's decision log on 2026-08-30
 * and written up in docs/DB-SCHEMA.md section 12:
 *
 *   D1  Menu prices are tax-EXCLUSIVE. Tax is computed and added on top.
 *
 *   D2  Rounding happens ONCE PER RATE SLAB. Not per line, not on the bill
 *       total. Lines are grouped by taxRateBps, each group's taxable value is
 *       summed, and that group's tax is rounded once. Rounding each line and
 *       adding gives a different answer from adding and rounding once, and
 *       BUILD-PLAN section 8 names that as how a printed bill and a report end
 *       up a rupee apart. Per slab is chosen because that is exactly how a GST
 *       invoice prints.
 *
 *   D2a A bill-level discount reduces TAXABLE VALUE, so it is apportioned
 *       across slabs before tax is computed. It cannot simply come off the
 *       grand total, or the tax is overstated.
 *
 *   D3  Intra-state only. No IGST. Each slab splits in half and CGST takes the
 *       extra paisa when the total is odd.
 */
import { applyBasisPoints, MAX_PAISE, sumPaise } from './money.js';

/** A bill total is rounded to the nearest whole rupee. */
const PAISE_PER_RUPEE = 100;

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be a whole number of paise, received ${value}.`);
  }
}

/**
 * round_half_away_from_zero(amount * part / whole), in exact integer maths.
 *
 * Used to give each tax slab its share of a bill-level discount. The
 * multiplication happens before the division so the only rounding is the final
 * one, the same shape as applyBasisPoints.
 */
export function proportionalShare(amount, part, whole) {
  assertInteger(amount, 'proportionalShare amount');
  assertInteger(part, 'proportionalShare part');
  assertInteger(whole, 'proportionalShare whole');

  if (whole <= 0) {
    throw new RangeError('proportionalShare needs a positive whole to divide by.');
  }
  if (amount === 0 || part === 0) return 0;

  const product = amount * part;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      `proportionalShare(${amount}, ${part}, ${whole}) overflows exact integer arithmetic.`,
    );
  }

  const whole_ = Math.floor(product / whole);
  const remainder = product % whole;

  return remainder * 2 >= whole ? whole_ + 1 : whole_;
}

/**
 * Splits one slab's tax into CGST and SGST.
 *
 * An intra-state supply splits in half. When the slab's tax is an odd number of
 * paise the halves are unequal, and CGST takes the extra paisa, always. Fixing
 * the direction means the split is deterministic and the two parts always
 * re-add to the total, which is what a test asserts.
 */
export function splitCgstSgst(taxInPaise) {
  assertInteger(taxInPaise, 'splitCgstSgst amount');
  if (taxInPaise < 0) {
    throw new RangeError('Tax cannot be negative.');
  }

  const cgstInPaise = Math.ceil(taxInPaise / 2);
  return { cgstInPaise, sgstInPaise: taxInPaise - cgstInPaise };
}

/**
 * Resolves a discount request into a whole-paise amount.
 *
 * A percentage is applied to the pre-tax subtotal, because the discount is a
 * reduction of taxable value rather than of the final amount payable.
 */
export function resolveDiscountAmount(discount, subtotalInPaise) {
  if (!discount) return 0;
  assertInteger(subtotalInPaise, 'resolveDiscountAmount subtotal');

  if (discount.kind === 'FLAT') {
    assertInteger(discount.valueInPaise, 'A flat discount');
    return discount.valueInPaise;
  }

  if (discount.kind === 'PERCENT') {
    assertInteger(discount.rateBps, 'A percentage discount');
    return applyBasisPoints(subtotalInPaise, discount.rateBps);
  }

  throw new TypeError(`Unknown discount kind: ${discount.kind}`);
}

/**
 * Gives each slab its share of a bill-level discount.
 *
 * Shares are proportional to each slab's share of the subtotal, and then
 * corrected so they add up to the discount EXACTLY: the rounding remainder,
 * which is a few paise at most, is given to the slab with the largest taxable
 * value. Without that correction the shares can miss the discount by a paisa
 * and the grand total stops reconciling with its own parts.
 */
function apportionDiscount(slabSubtotals, discountAmountInPaise, subtotalInPaise) {
  const rates = [...slabSubtotals.keys()];
  if (discountAmountInPaise === 0 || subtotalInPaise === 0) {
    return new Map(rates.map((rate) => [rate, 0]));
  }

  const shares = new Map(
    rates.map((rate) => [
      rate,
      proportionalShare(discountAmountInPaise, slabSubtotals.get(rate), subtotalInPaise),
    ]),
  );

  const allocated = sumPaise(...shares.values());
  const remainder = discountAmountInPaise - allocated;

  if (remainder !== 0) {
    // The largest slab absorbs it: it is the one where a few paise move the
    // resulting tax least, in relative terms.
    const largest = rates.reduce((best, rate) =>
      slabSubtotals.get(rate) > slabSubtotals.get(best) ? rate : best,
    );
    shares.set(largest, shares.get(largest) + remainder);
  }

  return shares;
}

/**
 * Rounds a bill total to the nearest whole rupee.
 *
 * Returns the signed adjustment, which is what the bill stores and prints.
 * A remainder of exactly 50 paise rounds up, matching the half-away-from-zero
 * rule used everywhere else in this codebase.
 */
export function roundOffFor(preRoundTotalInPaise) {
  assertInteger(preRoundTotalInPaise, 'roundOffFor total');

  const remainder = preRoundTotalInPaise % PAISE_PER_RUPEE;
  if (remainder === 0) return 0;

  return remainder >= PAISE_PER_RUPEE / 2 ? PAISE_PER_RUPEE - remainder : -remainder;
}

/**
 * The whole bill, computed from its lines and an optional discount.
 *
 * `lines` are `{ taxRateBps, lineTotalInPaise }`. Cancelled order lines must
 * already have been filtered out by the caller: a cancelled line is evidence,
 * not something anyone is paying for.
 *
 * Returns every figure a bill stores, so a bill is never assembled from two
 * different sources of arithmetic.
 */
export function computeBillTotals({ lines, discount = null }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new RangeError('A bill needs at least one line.');
  }

  const subtotalInPaise = sumPaise(...lines.map((line) => line.lineTotalInPaise));
  if (subtotalInPaise > MAX_PAISE) {
    throw new RangeError(`A bill subtotal of ${subtotalInPaise} paise is beyond the sane ceiling.`);
  }

  const discountAmountInPaise = resolveDiscountAmount(discount, subtotalInPaise);
  if (discountAmountInPaise < 0) {
    throw new RangeError('A discount cannot be negative.');
  }
  if (discountAmountInPaise > subtotalInPaise) {
    throw new RangeError('A discount cannot be larger than the subtotal.');
  }

  /**
   * Group by rate. A Map keeps insertion order, but the breakdown is sorted by
   * rate below so a bill always prints its slabs in the same order regardless
   * of what order the lines happened to be added in.
   */
  const slabSubtotals = new Map();
  for (const line of lines) {
    assertInteger(line.taxRateBps, 'A line tax rate');
    assertInteger(line.lineTotalInPaise, 'A line total');
    const running = slabSubtotals.get(line.taxRateBps) ?? 0;
    slabSubtotals.set(line.taxRateBps, running + line.lineTotalInPaise);
  }

  const shares = apportionDiscount(slabSubtotals, discountAmountInPaise, subtotalInPaise);

  const taxBreakdown = [...slabSubtotals.keys()]
    .sort((a, b) => a - b)
    .map((taxRateBps) => {
      const taxableInPaise = slabSubtotals.get(taxRateBps) - shares.get(taxRateBps);
      const taxInPaise = applyBasisPoints(taxableInPaise, taxRateBps);
      const { cgstInPaise, sgstInPaise } = splitCgstSgst(taxInPaise);

      return { taxRateBps, taxableInPaise, taxInPaise, cgstInPaise, sgstInPaise };
    });

  const totalTaxInPaise = sumPaise(...taxBreakdown.map((slab) => slab.taxInPaise));
  const preRoundTotalInPaise = subtotalInPaise - discountAmountInPaise + totalTaxInPaise;
  const roundOffInPaise = roundOffFor(preRoundTotalInPaise);

  return {
    subtotalInPaise,
    discountAmountInPaise,
    taxBreakdown,
    totalTaxInPaise,
    roundOffInPaise,
    grandTotalInPaise: preRoundTotalInPaise + roundOffInPaise,
  };
}

/* --------------------------------------------------------------------------
 * Line shares. P03.
 *
 * computeBillTotals works per tax slab, which is how a GST invoice prints. A
 * category or item report needs each LINE's part of the discount and the GST,
 * and those parts must add up exactly to the slab figures already on the bill,
 * or a report and the bill it came from disagree by a paisa. The functions
 * below read computeBillTotals' output and split it. They never change it.
 * ----------------------------------------------------------------------- */

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be a whole number, received ${value}.`);
  }
  if (value < 0) {
    throw new RangeError(`${label} cannot be negative, received ${value}.`);
  }
}

/**
 * Splits a whole number of paise across weights so the parts add up exactly to
 * `amount`. The largest remainder method, GLOSSARY section 3:
 *
 *   1. Each part's exact share is amount × weight ÷ total weight.
 *   2. Each part gets the whole paise of its share, rounded down.
 *   3. The paise left over go one at a time to the parts with the biggest
 *      leftover fraction. A tie goes to the earlier part.
 *
 * BigInt throughout. `amount` can be MAX_PAISE and a weight just as large, so
 * the product passes Number.MAX_SAFE_INTEGER, and comparing leftover fractions
 * as floating point would let two equal remainders compare unequal. The
 * remainders are compared as exact BigInt numerators over the same total.
 */
export function largestRemainderSplit(amount, weights) {
  assertNonNegativeInteger(amount, 'largestRemainderSplit amount');
  if (!Array.isArray(weights)) {
    throw new TypeError('largestRemainderSplit needs an array of weights.');
  }
  weights.forEach((weight, index) =>
    assertNonNegativeInteger(weight, `largestRemainderSplit weight ${index}`),
  );

  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (amount === 0 || total === 0n) return weights.map(() => 0);

  const exact = weights.map((weight) => BigInt(amount) * BigInt(weight));
  const parts = exact.map((product) => product / total);
  const remainders = exact.map((product) => product % total);

  let leftover = BigInt(amount) - parts.reduce((sum, part) => sum + part, 0n);

  const order = weights
    .map((_, index) => index)
    .sort((a, b) => {
      if (remainders[a] === remainders[b]) return a - b;
      return remainders[a] > remainders[b] ? -1 : 1;
    });

  for (const index of order) {
    if (leftover === 0n) break;
    parts[index] += 1n;
    leftover -= 1n;
  }

  return parts.map(Number);
}

/**
 * P65. A rate's CGST shared across rows of that rate, such as the HSN codes of
 * a month, in proportion to each row's GST, by `largestRemainderSplit`. Each
 * row's SGST is its GST less its CGST. `cgstTotal` is the rate's CGST from the
 * bills' own slabs, so the rows add up to exactly what the bills printed.
 *
 * `rows` are `{ taxInPaise }`; their GST must add up to the rate's GST
 * (`cgstTotal` plus the rate's SGST), which C2 guarantees for every bill with
 * line shares. Returns `{ cgstInPaise, sgstInPaise }` per row, in order.
 */
export function splitRateTaxAcrossRows(rows, cgstTotal) {
  assertNonNegativeInteger(cgstTotal, 'splitRateTaxAcrossRows cgstTotal');
  const taxes = rows.map((row, index) => {
    assertNonNegativeInteger(row.taxInPaise, `splitRateTaxAcrossRows row ${index} taxInPaise`);
    return row.taxInPaise;
  });
  const total = taxes.reduce((sum, tax) => sum + tax, 0);
  if (cgstTotal > total) throw new RangeError(`CGST ${cgstTotal} cannot be more than the rows' GST ${total}.`);
  const cgst = largestRemainderSplit(cgstTotal, taxes);
  return taxes.map((tax, index) => ({ cgstInPaise: cgst[index], sgstInPaise: tax - cgst[index] }));
}

/**
 * Each line's share of the bill's discount and GST. GLOSSARY section 3.
 *
 * `lines` are bill lines, each with `lineTotalInPaise` and `taxRateBps`.
 * `totals` is exactly what computeBillTotals returned for those lines.
 * Returns one `{ discountShareInPaise, taxableInPaise, taxInPaise }` per line,
 * in the same order.
 *
 * Inside each tax rate, separately, because computeBillTotals has already
 * shared the discount between rates (apportionDiscount) and that split is part
 * of the frozen arithmetic. Working inside each rate is what makes the line
 * figures add up to the slab figures that are already printed on the bill.
 *
 * Before returning, it checks C2 from docs/RECONCILIATION-RULES.md itself and
 * throws if the shares do not add up. That can only happen through a bug here,
 * and a bill with shares that do not balance must never be saved.
 */
export function allocateLineShares(lines, totals) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new RangeError('allocateLineShares needs at least one line.');
  }

  const shares = new Array(lines.length).fill(null);

  for (const slab of totals.taxBreakdown) {
    const indexes = lines
      .map((line, index) => (line.taxRateBps === slab.taxRateBps ? index : -1))
      .filter((index) => index !== -1);

    const lineTotals = indexes.map((index) => lines[index].lineTotalInPaise);
    const rateTotal = sumPaise(...lineTotals);
    const rateDiscount = rateTotal - slab.taxableInPaise;

    const discountShares = largestRemainderSplit(rateDiscount, lineTotals);
    const taxables = lineTotals.map((total, i) => total - discountShares[i]);
    const taxShares = largestRemainderSplit(slab.taxInPaise, taxables);

    indexes.forEach((lineIndex, i) => {
      shares[lineIndex] = {
        discountShareInPaise: discountShares[i],
        taxableInPaise: taxables[i],
        taxInPaise: taxShares[i],
      };
    });

    const taxableSum = sumPaise(...taxables);
    if (taxableSum !== slab.taxableInPaise) {
      throw new Error(
        `C2 Line shares: at rate ${slab.taxRateBps} line net sales add up to ${taxableSum}, the slab says ${slab.taxableInPaise}. Difference ${taxableSum - slab.taxableInPaise}.`,
      );
    }
    const taxSum = sumPaise(...taxShares);
    if (taxSum !== slab.taxInPaise) {
      throw new Error(
        `C2 Line shares: at rate ${slab.taxRateBps} line GST adds up to ${taxSum}, the slab says ${slab.taxInPaise}. Difference ${taxSum - slab.taxInPaise}.`,
      );
    }
  }

  const unassigned = shares.findIndex((share) => share === null);
  if (unassigned !== -1) {
    throw new Error(
      `C2 Line shares: line ${unassigned} at rate ${lines[unassigned].taxRateBps} has no slab on the bill.`,
    );
  }

  const discountSum = sumPaise(...shares.map((share) => share.discountShareInPaise));
  if (discountSum !== totals.discountAmountInPaise) {
    throw new Error(
      `C2 Line shares: discount shares add up to ${discountSum}, the bill discount is ${totals.discountAmountInPaise}. Difference ${discountSum - totals.discountAmountInPaise}.`,
    );
  }

  return shares;
}


/**
 * One bill's net sales, CGST and SGST divided across the ways it was settled.
 * P15, for the Tally export's by-method block (docs/API-CONTRACT.md M19 R9).
 *
 * The parts are the bill's payments, then the amount charged to an On Hold
 * account, then any unpaid remainder. Each of net sales, CGST and SGST is split
 * across the parts separately, by the largest remainder method, weighted by
 * each part's amount. The round-off is not split: the export shows it on its
 * own row. Each split is checked to add back exactly to the bill's own figure
 * before it is returned, the same discipline as allocateLineShares.
 *
 * Caffeza's old export worked the taxable value backwards from the rounded
 * amount, which is why its two blocks disagreed. This never does.
 *
 * Returns `[{ kind, method, methodName, tallyLedgerCode, amountInPaise,
 * netSalesInPaise, cgstInPaise, sgstInPaise }]`, `kind` one of PAYMENT,
 * ON_HOLD, UNPAID.
 */
export function splitBillAcrossPayments(bill) {
  const slabs = bill.taxBreakdown ?? [];
  const netSalesInPaise = slabs.reduce((total, slab) => total + slab.taxableInPaise, 0);
  const cgstInPaise = slabs.reduce((total, slab) => total + slab.cgstInPaise, 0);
  const sgstInPaise = slabs.reduce((total, slab) => total + slab.sgstInPaise, 0);

  const parts = (bill.payments ?? []).map((payment) => ({
    kind: 'PAYMENT',
    method: payment.method,
    methodName: payment.methodName ?? payment.method,
    tallyLedgerCode: payment.tallyLedgerCode ?? null,
    amountInPaise: payment.amountInPaise,
  }));
  const charged = bill.chargedToAccountInPaise ?? 0;
  if (charged > 0) {
    parts.push({ kind: 'ON_HOLD', method: null, methodName: null, tallyLedgerCode: null, amountInPaise: charged });
  }
  const settled = parts.reduce((total, part) => total + part.amountInPaise, 0);
  const unpaid = bill.grandTotalInPaise - settled;
  if (unpaid > 0) {
    parts.push({ kind: 'UNPAID', method: null, methodName: null, tallyLedgerCode: null, amountInPaise: unpaid });
  }
  if (parts.length === 0) return [];

  const weights = parts.map((part) => part.amountInPaise);
  const net = largestRemainderSplit(netSalesInPaise, weights);
  const cgst = largestRemainderSplit(cgstInPaise, weights);
  const sgst = largestRemainderSplit(sgstInPaise, weights);

  const sum = (values) => values.reduce((total, value) => total + value, 0);
  if (sum(net) !== netSalesInPaise || sum(cgst) !== cgstInPaise || sum(sgst) !== sgstInPaise) {
    throw new Error(`splitBillAcrossPayments: the parts of bill ${bill.billNumber} do not add back to the bill.`);
  }

  return parts.map((part, index) => ({
    ...part,
    netSalesInPaise: net[index],
    cgstInPaise: cgst[index],
    sgstInPaise: sgst[index],
  }));
}

export default {
  allocateLineShares,
  computeBillTotals,
  largestRemainderSplit,
  proportionalShare,
  resolveDiscountAmount,
  roundOffFor,
  splitBillAcrossPayments,
  splitCgstSgst,
};
