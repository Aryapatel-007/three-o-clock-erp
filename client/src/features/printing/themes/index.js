/**
 * The full-page invoice themes, by id. P64, API-CONTRACT P64 6.
 *
 * Each is `{ id, title, paper, styles, render(data, options) }`: `render` is a
 * pure function of GET /bills/:billId/invoice, and `styles` the CSS for the
 * print frame. An unknown or missing id prints CLASSIC, the invoice as it was
 * before themes existed.
 */
import classic from './classic.js';
import compact from './compact.js';
import gstDetailed from './gstDetailed.js';
import modern from './modern.js';

export const THEMES = Object.freeze([classic, gstDetailed, modern, compact]);
export const THEMES_BY_ID = Object.freeze(Object.fromEntries(THEMES.map((theme) => [theme.id, theme])));
export const THEME_IDS = Object.freeze(THEMES.map((theme) => theme.id));

export function themeFor(id) {
  return THEMES_BY_ID[id] ?? classic;
}

/**
 * The switches a theme usually wants, proposed by the settings screen when the
 * owner picks it. The owner can change any of them before saving.
 */
export const THEME_SUGGESTIONS = Object.freeze({
  CLASSIC: {},
  GST_DETAILED: { hsn: true, amountInWords: true, declaration: true, signatureLine: true, copyMarking: true },
  MODERN: {},
  COMPACT: {},
});

export default THEMES;
