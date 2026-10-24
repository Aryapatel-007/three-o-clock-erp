/**
 * Paise as rupee text: the words `Money` shows, as a plain string. P64 moved
 * them here from Money.jsx, unchanged, so a printed invoice laid out by a
 * theme can be rendered and checked outside a browser. Money.jsx re-exports
 * it; this file and Money.jsx are the only places money is formatted.
 */
const GROUPING = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function moneyText(paise, { symbol = true } = {}) {
  if (!Number.isInteger(paise)) return '';
  const sign = paise < 0 ? '-' : '';
  const rupees = GROUPING.format(Math.abs(paise) / 100);
  return symbol ? `${sign}₹${rupees}` : `${sign}${rupees}`;
}
