/**
 * The printer this device prints to, and the page each one needs. P25 Part C.
 *
 * Pure functions only, so a server test can import this file and check them,
 * the way P01 tested the client's business date mirror.
 *
 * Why `pageCss` exists: P05 wrote `@page { size: 80mm auto }`. `auto` is not a
 * length, and `size` takes one or two lengths or a keyword, so Chrome dropped
 * the whole rule, printed on the printer's own paper (A4, or Letter in a
 * headless browser) and the receipt came out as an 80 mm strip in the top
 * left corner.
 *
 * P25 then gave a thermal page two lengths, the roll's width and the
 * receipt's measured height. On Z Chaat's Windows computer (2026-10-09) the
 * printer driver had no paper of that size, so Chrome printed on the driver's
 * own, longer paper and centred the bill on it: blank paper above and below.
 * Then a thermal page named no size, so Chrome used the driver's roll from
 * its top; but Chrome's preview, and any printer left on A4, showed the bill
 * in the corner of a whole sheet. So each device now chooses its paper length
 * (`PAPER_LENGTHS`): `BILL`, the default, a page exactly as long as the bill
 * and exactly as wide as the head prints, so the driver has nothing to centre
 * or shrink; or `ROLL`, no size, for a driver that centres a page it has no
 * paper for. docs/DEPLOYMENT.md section 10.
 *
 * `printableMm` is the width the print head reaches: 48 mm on a 58 mm roll
 * (384 dots at 203 dpi) and 72 mm on an 80 mm roll (576 dots). Laying the
 * text out to the paper's full width cut off the right-hand column. An 80 mm
 * roll's width is chosen per device (`PRINT_WIDTHS`), 78 mm by default since
 * 2026-10-10, when Z Chaat's bill at 72 mm was still cut on the right.
 */

export const PRINTERS = Object.freeze({
  THERMAL_80: Object.freeze({ label: 'Thermal, 80 mm', hint: 'A receipt printer with the wide roll. 48 characters a line.', thermal: true, widthMm: 80, printableMm: 72, characters: 48 }),
  THERMAL_58: Object.freeze({ label: 'Thermal, 58 mm', hint: 'A receipt printer with the narrow roll. 32 characters a line.', thermal: true, widthMm: 58, printableMm: 48, characters: 32 }),
  A4: Object.freeze({ label: 'A4', hint: 'An ordinary office printer. Bills print as a full-page tax invoice.', thermal: false, widthMm: 210, heightMm: 297, characters: 48 }),
  A5: Object.freeze({ label: 'A5', hint: 'Half an A4 sheet. Bills print as a full-page tax invoice.', thermal: false, widthMm: 148, heightMm: 210, characters: 48 }),
});

export const PRINTER_KEYS = Object.freeze(Object.keys(PRINTERS));

/** How long a thermal page is. See the note at the top. */
export const PAPER_LENGTHS = Object.freeze({
  BILL: Object.freeze({ label: 'As long as the bill', hint: 'The page is the bill, cut right after it. Use this first.' }),
  ROLL: Object.freeze({ label: "The printer's roll", hint: 'Only if the bill prints with blank paper above it. Set the roll as the paper size on the computer.' }),
});
export const DEFAULT_PAPER_LENGTH = 'BILL';
export const DEFAULT_PRINTER = 'THERMAL_80';

/** Space left under the last line, so the cutter never takes it. */
export const THERMAL_FEED_MM = 4;
/** Space left at the left of a roll's text. */
export const THERMAL_SIDE_MM = 1;
/** The margin of a full page, on every side. */
export const PAGE_MARGIN_MM = 12;

/** The printer for a device's saved settings. A device from before P25 saved `paperMm`. */
export function printerFor(settings = {}) {
  if (PRINTER_KEYS.includes(settings.printer)) return settings.printer;
  if (Number(settings.paperMm) === 58) return 'THERMAL_58';
  return DEFAULT_PRINTER;
}

/** Characters per line for text laid out on the server: receipts, KOTs, the Day Close. */
export function charactersFor(printer) {
  return (PRINTERS[printer] ?? PRINTERS[DEFAULT_PRINTER]).characters;
}

/** Millimetres from CSS pixels, at the 96 to the inch every browser uses for print. */
export const pxToMm = (px) => (px * 25.4) / 96;

/**
 * The `@page` rule for a printer. On a roll, `BILL` is the printed width by the
 * measured height, two lengths and never `auto`; `ROLL` names no size, so the
 * bill prints from the top of the driver's roll. A full page is the paper's
 * own size with 12 mm margins.
 */
// `widthMm`: the width the content was laid out to, when it is not `contentWidthMm` (a bill, `billWidthMm`).
export function pageCss({ printer, contentHeightMm = null, paperLength = DEFAULT_PAPER_LENGTH, edgeMargin = DEFAULT_EDGE_MARGIN, printWidth = DEFAULT_PRINT_WIDTH, widthMm = null }) {
  const paper = PRINTERS[printer];
  if (!paper) throw new Error(`Unknown printer ${printer}.`);
  if (!paper.thermal) return `@page { size: ${printer}; margin: ${PAGE_MARGIN_MM}mm; }`;
  if (paperLength === 'ROLL') return '@page { margin: 0; }';

  const height = Number(contentHeightMm);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('A page as long as the bill needs the measured height of what it prints.');
  }
  return `@page { size: ${widthMm ?? contentWidthMm(printer, edgeMargin, printWidth)}mm ${Math.ceil(height) + 1}mm; margin: 0; }`;
}

/**
 * Space kept clear at each side of a roll, chosen on This device. A driver
 * whose printable width is a little under the head's 72 or 48 mm cuts the
 * right-hand column off; this narrows the bill and its page together, so the
 * page still maps onto the paper exactly. 2026-10-09, for Z Chaat's Rugtek.
 */
export const EDGE_MARGINS = Object.freeze({
  NONE: Object.freeze({ label: 'None', hint: 'The full width the printer prints. Use this first.', mm: 0 }),
  SMALL: Object.freeze({ label: '2 mm each side', hint: 'If the last letters of Amount or the totals are cut off.', mm: 2 }),
  MORE: Object.freeze({ label: '4 mm each side', hint: 'If 2 mm is not enough.', mm: 4 }),
});
export const DEFAULT_EDGE_MARGIN = 'NONE';

/**
 * How wide a bill on the 80 mm roll is laid out, chosen on This device.
 * 2026-10-10: Rishi asked for 78 mm, as Z Chaat's Rugtek still cut the right
 * side of the bill at 72 mm. 72 mm, the usual head width, stays a choice. A
 * 58 mm roll always prints 48 mm.
 */
export const PRINT_WIDTHS = Object.freeze({
  WIDE: Object.freeze({ label: '78 mm', hint: 'Nearly the whole roll. Use this first.', mm: 78 }),
  STANDARD: Object.freeze({ label: '72 mm', hint: 'If the bill prints wider than the paper, or its right side is cut off at 78 mm.', mm: 72 }),
});
export const DEFAULT_PRINT_WIDTH = 'WIDE';

/** The width text is laid out to: what the print head reaches on a roll, less the edge margin, or inside the margins on a page. */
export function contentWidthMm(printer, edgeMargin = DEFAULT_EDGE_MARGIN, printWidth = DEFAULT_PRINT_WIDTH) {
  const paper = PRINTERS[printer] ?? PRINTERS[DEFAULT_PRINTER];
  if (!paper.thermal) return paper.widthMm - 2 * PAGE_MARGIN_MM;
  const edge = (EDGE_MARGINS[edgeMargin] ?? EDGE_MARGINS[DEFAULT_EDGE_MARGIN]).mm;
  const head = paper.widthMm === 80 ? (PRINT_WIDTHS[printWidth] ?? PRINT_WIDTHS[DEFAULT_PRINT_WIDTH]).mm : paper.printableMm;
  return head - 2 * edge;
}

/**
 * Extra width a thermal bill takes on the right, by edge margin. 2026-10-28,
 * Three O'Clock's cafe PC: at 72 mm with 4 mm each side the bill printed well
 * but left 5 mm blank on the right, so the bill takes those 5 mm back there.
 * The left side, KOTs and other printed text keep the edge margin as it is.
 */
export const BILL_RIGHT_GAIN_MM = Object.freeze({ MORE: 5 });

/** The width a thermal bill is laid out to: the content width, plus its gain on the right on the 80 mm roll. */
export function billWidthMm(printer, edgeMargin = DEFAULT_EDGE_MARGIN, printWidth = DEFAULT_PRINT_WIDTH) {
  const paper = PRINTERS[printer] ?? PRINTERS[DEFAULT_PRINTER];
  const width = contentWidthMm(printer, edgeMargin, printWidth);
  if (!paper.thermal || paper.widthMm !== 80) return width;
  return width + (BILL_RIGHT_GAIN_MM[edgeMargin] ?? 0);
}

/**
 * The font size that makes `characters` monospace columns fill a width, in
 * millimetres. 0.6 em is the advance width of a typical monospace glyph. Text
 * on a full page is capped at a large, readable size.
 */
export function monospaceFontMm(printer, edgeMargin = DEFAULT_EDGE_MARGIN, printWidth = DEFAULT_PRINT_WIDTH) {
  const paper = PRINTERS[printer] ?? PRINTERS[DEFAULT_PRINTER];
  // On a roll, 1 mm is left free on each side, so the last character never meets the edge of the head.
  const printable = contentWidthMm(printer, edgeMargin, printWidth) - (paper.thermal ? 2 * THERMAL_SIDE_MM : 0);
  const fitted = printable / paper.characters / 0.6;
  return paper.thermal ? fitted : Math.min(fitted, 5);
}

/**
 * The bill's text size, in CSS pixels, per roll and per This device's choice.
 * Normal on 80 mm matches Z Chaat's old bill: bold Arial at about 13 px, which
 * fills the 72 mm the head prints with the item, Qty., Price and Amount on one
 * line. Arial, not a narrow face: Arial Narrow is missing on most computers,
 * and the fallback printed smaller than the old bill (2026-10-09).
 */
export const BILL_TEXT_SIZES = Object.freeze({
  SMALL: Object.freeze({ label: 'Small', THERMAL_80: 12, THERMAL_58: 9 }),
  NORMAL: Object.freeze({ label: 'Normal', THERMAL_80: 13.5, THERMAL_58: 10 }),
  LARGE: Object.freeze({ label: 'Large', THERMAL_80: 15, THERMAL_58: 10.5 }),
});
export const DEFAULT_BILL_TEXT_SIZE = 'NORMAL';

/** The pixel size for a roll and a text size, Normal when either is unknown. */
export function billFontPx(printer, textSize = DEFAULT_BILL_TEXT_SIZE) {
  const size = BILL_TEXT_SIZES[textSize] ?? BILL_TEXT_SIZES[DEFAULT_BILL_TEXT_SIZE];
  return size[printer === 'THERMAL_58' ? 'THERMAL_58' : 'THERMAL_80'];
}
