/**
 * Paise shown as rupees. DESIGN-SYSTEM section 9: the only place a
 * component formats money.
 *
 * Plex Mono, Indian grouping, two decimals, a minus sign and `alert` when
 * negative. The figure is a label and never goes back into arithmetic: a
 * screen adds paise and shows the sum, never the reverse.
 *
 * `moneyText` is the same words as plain text, for the few places a string is
 * required rather than an element: an aria-label, a confirmation sentence
 * passed to a toast, a button whose label is one sentence.
 */
import { moneyText } from './moneyText.js';

export { moneyText };

/**
 * A short rupee label for an axis tick, in Indian units.
 *
 * Lakh and crore rather than K and M, because this reads to a restaurant
 * owner in Ahmedabad and "1.2L" is the form they already use. Rounded hard on
 * purpose: an axis tick is orientation, not a figure anyone should quote. The
 * exact number is in the tooltip and in the table view underneath.
 */
export function compactMoneyText(paise) {
  if (!Number.isInteger(paise)) return '';
  const rupees = paise / 100;
  const sign = rupees < 0 ? '-' : '';
  const value = Math.abs(rupees);

  if (value >= 10_000_000) return `${sign}₹${(value / 10_000_000).toFixed(1)}Cr`;
  if (value >= 100_000) return `${sign}₹${(value / 100_000).toFixed(1)}L`;
  if (value >= 1_000) return `${sign}₹${(value / 1_000).toFixed(1)}K`;
  return `${sign}₹${Math.round(value)}`;
}

const STYLES = {
  num: 'type-num',
  tile: 'type-num-tile',
  hero: 'type-num-hero',
  meta: 'type-num-meta',
  inherit: 'font-mono',
};

/**
 * `size`: `num` for rows, `tile` on tiles, `hero` for a bill total or a
 * keypad display, `meta` for small figures, `inherit` to keep the caller's size.
 * `tabular` lines a column of figures up; a standalone hero figure leaves it off.
 * `blank` is shown when there is no figure, rather than an empty gap.
 */
export default function Money({ paise, size = 'inherit', tabular = false, symbol = true, signed = true, blank = '—', className = '' }) {
  if (!Number.isInteger(paise)) {
    return <span className={`${STYLES[size] ?? STYLES.inherit} text-muted ${className}`}>{blank}</span>;
  }
  const negative = signed && paise < 0;
  return (
    <span
      className={[
        STYLES[size] ?? STYLES.inherit,
        // P22. A price never wraps onto a second line.
        'whitespace-nowrap',
        tabular ? 'tabular-nums' : '',
        negative ? 'text-alert' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {moneyText(paise, { symbol })}
    </span>
  );
}
