/**
 * Money.
 *
 * Every amount in this system is a whole number of paise. One hundred rupees
 * is 10000. There is no decimal anywhere, ever, at any point in the pipeline.
 *
 * Percentages are basis points, also whole integers. Five percent is 500,
 * eighteen percent is 1800. This is why there is no 0.18 in the codebase and
 * therefore no floating point surprise on a GST line.
 *
 * Nothing in here silently coerces. A function that quietly accepts "99.99"
 * where an integer was required is how a float reaches a bill.
 */

/** Ten lakh rupees. A sane ceiling for a single amount on a restaurant bill. */
export const MAX_PAISE = 100_000_000;

export const PAISE_PER_RUPEE = 100;
export const BASIS_POINTS_DIVISOR = 10_000;

function assertInteger(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be a whole number of paise, received ${describe(value)}.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} is too large to be represented exactly: ${value}.`);
  }
}

function describe(value) {
  if (typeof value === 'string') return `the string "${value}"`;
  if (typeof value === 'number') return `the number ${value}`;
  return `a value of type ${typeof value}`;
}

/**
 * Rupees to paise.
 *
 * Accepts a number or a string, because a price typed into a form arrives as a
 * string and converting it in two different places is how two answers appear.
 *
 * Rounds half away from zero, so 0.005 becomes 1 paisa and -0.005 becomes -1.
 * The rounding is done on the digits of the decimal string, not by multiplying
 * a float by 100, because 99.99 * 100 is 9998.999999999998 in IEEE 754.
 *
 *   rupeesToPaise("99.99")  ->  9999
 *   rupeesToPaise(100)      ->  10000
 *   rupeesToPaise("1.005")  ->  101
 *
 * Throws on anything that is not a valid amount, including an empty string,
 * a currency symbol, a thousands separator, or exponent notation.
 */
export function rupeesToPaise(rupees) {
  if (typeof rupees !== 'number' && typeof rupees !== 'string') {
    throw new TypeError(`rupeesToPaise expects a number or a string, received ${describe(rupees)}.`);
  }

  if (typeof rupees === 'number' && !Number.isFinite(rupees)) {
    throw new RangeError(`rupeesToPaise received ${rupees}, which is not a finite amount.`);
  }

  const text = typeof rupees === 'number' ? String(rupees) : rupees.trim();

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new TypeError(
      `rupeesToPaise could not read ${describe(rupees)} as an amount. Expected digits with at most one decimal point, for example "99.99".`,
    );
  }

  const [, sign, wholePart, fractionPart = ''] = match;

  const whole = Number(wholePart);
  const paiseDigits = Number(fractionPart.slice(0, 2).padEnd(2, '0'));
  let paise = whole * PAISE_PER_RUPEE + paiseDigits;

  // Round half away from zero on the third decimal place onward.
  const remainder = fractionPart.slice(2);
  if (remainder.length > 0 && Number(remainder[0]) >= 5) paise += 1;

  const signed = sign === '-' ? -paise : paise;
  assertInteger(signed, 'The converted amount');
  return signed;
}

/**
 * Paise to a rupee string, for display only.
 *
 * Never feed the result of this back into arithmetic. It is a label.
 *
 * Grouping is Indian, so 10000000 paise reads as 1,00,000.00 and not
 * 100,000.00. The rupee symbol is left off by default because thermal
 * receipt printers are unreliable with it.
 */
export function paiseToRupees(paise, { symbol = false } = {}) {
  assertInteger(paise, 'paiseToRupees expects paise, which');

  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(paise) / PAISE_PER_RUPEE);

  const sign = paise < 0 ? '-' : '';
  return symbol ? `${sign}₹${formatted}` : `${sign}${formatted}`;
}

/**
 * P44. Whole rupees with the Indian grouping and no symbol, like "4,71,154",
 * for the day-end message. Rounds half away from zero, as everything here does.
 */
export function paiseToWholeRupeesText(paise) {
  assertInteger(paise, 'paiseToWholeRupeesText expects paise, which');
  const rupees = Math.floor((Math.abs(paise) + PAISE_PER_RUPEE / 2) / PAISE_PER_RUPEE);
  const sign = paise < 0 && rupees > 0 ? '-' : '';
  return `${sign}${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0 to 99 in words. */
function underHundred(number) {
  if (number < 20) return ONES[number];
  return [TENS[Math.floor(number / 10)], ONES[number % 10]].filter(Boolean).join(' ');
}

/** A whole number in the Indian system: crore, lakh, thousand, hundred. */
function indianNumberWords(number) {
  if (number === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(number / 1_00_00_000);
  const lakh = Math.floor((number % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((number % 1_00_000) / 1_000);
  const hundred = Math.floor((number % 1_000) / 100);
  const rest = number % 100;
  if (crore) parts.push(`${indianNumberWords(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(underHundred(rest));
  return parts.join(' ');
}

/**
 * P64. An amount spelled out for a tax invoice, in the Indian system:
 * 51000 is "Rupees Five Hundred Ten Only", 82050 "Rupees Eight Hundred Twenty
 * and Fifty Paise Only". The one place a number is spelled, so no two printed
 * forms of a bill can spell it differently. Negative amounts are refused: a
 * bill total is never below zero.
 */
export function paiseToIndianWords(paise) {
  assertInteger(paise, 'paiseToIndianWords expects paise, which');
  if (paise < 0) throw new RangeError(`An amount in words cannot be negative, received ${paise} paise.`);
  const rupees = Math.floor(paise / PAISE_PER_RUPEE);
  const remainder = paise % PAISE_PER_RUPEE;
  const words = [`Rupees ${indianNumberWords(rupees)}`];
  if (remainder) words.push(`and ${underHundred(remainder)} Paise`);
  return `${words.join(' ')} Only`;
}

/**
 * Applies a rate in basis points to an amount in paise.
 *
 * This is how GST is applied. Both inputs are integers and the multiplication
 * happens before the division, so the only rounding is the final one.
 *
 *   applyBasisPoints(10000, 1800)  ->  1800     (18% of 100 rupees)
 *   applyBasisPoints(9999, 500)    ->  500      (5% of 99.99 rupees)
 *
 * Rounds half away from zero, matching rupeesToPaise. Whether GST is rounded
 * per line or on the bill total is a decision for M3, not a decision this
 * function gets to make on its own.
 */
export function applyBasisPoints(paise, basisPoints) {
  assertInteger(paise, 'applyBasisPoints amount');
  assertInteger(basisPoints, 'applyBasisPoints rate');

  if (basisPoints < 0) {
    throw new RangeError(`A rate cannot be negative, received ${basisPoints} basis points.`);
  }

  const product = paise * basisPoints;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(
      `applyBasisPoints(${paise}, ${basisPoints}) overflows exact integer arithmetic.`,
    );
  }

  const magnitude = Math.abs(product);
  const whole = Math.floor(magnitude / BASIS_POINTS_DIVISOR);
  const remainder = magnitude % BASIS_POINTS_DIVISOR;
  const rounded = remainder * 2 >= BASIS_POINTS_DIVISOR ? whole + 1 : whole;

  return product < 0 ? -rounded : rounded;
}

/**
 * Adds amounts in paise.
 *
 * Every input is checked first. Adding one silent float to a list of integers
 * produces a total that is wrong by a fraction of a paisa, which then rounds
 * into a rupee somewhere further down and makes the bill and the report
 * disagree.
 */
/**
 * An average in paise: a sum divided by a count, rounded half away from zero,
 * the same rule as rupeesToPaise and applyBasisPoints. P10.
 *
 * Always a total divided by a total, never an average of averages
 * (docs/GLOSSARY.md section 1). A zero count gives zero rather than a NaN on a
 * day with no sales.
 */
export function averagePaise(totalPaise, count) {
  assertInteger(totalPaise, 'averagePaise total');
  assertInteger(count, 'averagePaise count');
  if (count <= 0) return 0;

  const magnitude = Math.abs(totalPaise);
  const rounded = Math.floor((2 * magnitude + count) / (2 * count));
  return totalPaise < 0 ? -rounded : rounded;
}

export function sumPaise(...amounts) {
  let total = 0;
  amounts.forEach((amount, index) => {
    assertInteger(amount, `sumPaise argument ${index + 1}`);
    total += amount;
  });

  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`sumPaise total ${total} is too large to be represented exactly.`);
  }
  return total;
}

/* --------------------------------------------------------------------------
 * Counting cash by notes and coins. P25 Part F, API-CONTRACT M16 section 8.
 * ----------------------------------------------------------------------- */

/** The most of one note or coin a count may hold. */
export const MAX_CASH_COUNT = 10_000;

/** A cash count this restaurant cannot accept. Services answer it with a 422. */
export class CashCountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CashCountError';
  }
}

/**
 * Totals a count of notes and coins against the restaurant's denominations,
 * on the server, always: a total sent by a client is never trusted.
 *
 * `cashCount` is `[{ valueInPaise, kind?, count }]`; `denominations` is
 * `settings.cash.denominations`. `kind` may be left out when the value exists
 * once among the active denominations, and must be given when it is both a
 * note and a coin (₹20, ₹10). Counts are whole numbers from 0 to 10,000. Rows
 * with a count of 0 are dropped. Returns `{ totalInPaise, cashCount }`, the
 * count with every `kind` filled in, largest value first.
 */
export function sumCashCount(cashCount, denominations) {
  if (!Array.isArray(cashCount)) throw new CashCountError('A cash count is a list of notes and coins.');
  const active = (denominations ?? []).filter((entry) => entry.isActive !== false);
  const seen = new Set();
  const rows = [];

  for (const entry of cashCount) {
    const { valueInPaise, count } = entry ?? {};
    if (!Number.isInteger(count) || count < 0 || count > MAX_CASH_COUNT) {
      throw new CashCountError(`A count must be a whole number from 0 to ${MAX_CASH_COUNT}.`);
    }
    const matches = active.filter((denomination) => denomination.valueInPaise === valueInPaise && (!entry.kind || denomination.kind === entry.kind));
    if (matches.length === 0) {
      throw new CashCountError(`${paiseToRupees(Number(valueInPaise) || 0, { symbol: true })}${entry.kind ? ` ${entry.kind.toLowerCase()}` : ''} is not a note or coin this restaurant counts.`);
    }
    if (matches.length > 1) {
      throw new CashCountError(`Say whether ${paiseToRupees(valueInPaise, { symbol: true })} is a note or a coin.`);
    }
    const key = `${matches[0].kind}:${valueInPaise}`;
    if (seen.has(key)) throw new CashCountError(`${paiseToRupees(valueInPaise, { symbol: true })} is counted twice.`);
    seen.add(key);
    if (count > 0) rows.push({ valueInPaise, kind: matches[0].kind, count });
  }

  rows.sort((a, b) => b.valueInPaise - a.valueInPaise || (a.kind === 'NOTE' ? -1 : 1));
  const totalInPaise = rows.reduce((total, row) => total + row.valueInPaise * row.count, 0);
  if (!Number.isSafeInteger(totalInPaise) || totalInPaise > MAX_PAISE) {
    throw new CashCountError('That count is more cash than one drawer can hold.');
  }
  return { totalInPaise, cashCount: rows };
}

/**
 * Paise as Tally's plain decimal text: "1754.00", "-0.11". P25 Part J. Integer
 * arithmetic only, never a float, no grouping and no symbol.
 */
export function paiseToDecimalText(paise) {
  if (!Number.isSafeInteger(paise)) throw new TypeError('paiseToDecimalText takes whole paise.');
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const rupees = Math.floor(absolute / PAISE_PER_RUPEE);
  const rest = absolute % PAISE_PER_RUPEE;
  return `${sign}${rupees}.${String(rest).padStart(2, '0')}`;
}
