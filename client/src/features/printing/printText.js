/**
 * Prints from the browser. P05, rebuilt in P25 Part C.
 *
 * Used for bills, KOTs and the Day Close. The server has already laid text out
 * at a fixed column width (receiptService.js, kotTicketService.js); this does
 * no wrapping, padding or column arithmetic of its own.
 *
 * Everything prints from a hidden iframe, never the whole page. The frame is
 * given the width the printer actually prints, so the content lays out
 * exactly as it will print, then its height is measured, and only then is
 * the `@page` rule written, from `pageCss` in printers.js: a page exactly the
 * bill's size, the driver's own roll from its top, or a full A4 or A5 page. With Chrome started with
 * --kiosk-printing (docs/DEPLOYMENT.md section 10) the print goes straight to
 * the default printer with no dialog; without it the print dialog opens.
 *
 * The server never talks to a printer. This is the only path to paper.
 */
import { charactersFor, contentWidthMm, monospaceFontMm, pageCss, PRINTERS, pxToMm, THERMAL_FEED_MM, THERMAL_SIDE_MM } from './printers.js';
import { readDeviceSettings } from './useDeviceSettings.js';

export { charactersFor };

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Lets the frame's content paint before measuring or printing.
 *
 * A browser runs no animation frame for a tab that is not showing, so waiting
 * on one alone hung every print from a till whose cashier had opened another
 * tab: a captain's bill sat unprinted until someone came back (Z Chaat,
 * 2026-10-19). A timer ends the wait too; layout is still worked out when
 * measured, shown or not.
 */
const nextFrame = (win) =>
  new Promise((resolve) => {
    let waited = false;
    const done = () => {
      if (waited) return;
      waited = true;
      setTimeout(resolve, 30);
    };
    win.requestAnimationFrame(done);
    setTimeout(done, 100);
  });

/** The longest a print waits for its images and fonts before measuring anyway. */
const CONTENT_WAIT_MS = 3000;

/**
 * Waits for the frame's images (the logo) and fonts before the bill is
 * measured. An image not yet decoded lays out with no height, so the page was
 * written shorter than the bill and the printer cut it off before the end: on
 * the cafe PC, slower than a developer's machine (Z Chaat, 2026-10-22). Never
 * waits more than CONTENT_WAIT_MS, so a broken image cannot stop a print.
 */
function contentLoaded(doc) {
  const images = Array.from(doc.images).map((image) => image.decode().catch(() => {}));
  const fonts = doc.fonts?.ready ?? Promise.resolve();
  const loaded = Promise.all([...images, fonts]);
  return Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, CONTENT_WAIT_MS))]);
}

/**
 * Prints an HTML body on this device's printer. `bodyHtml` is trusted markup
 * built by this folder; every value in it was escaped by its builder.
 * Resolves once print() has been called; rejects if the browser refused, so a
 * caller can say "Not printed" rather than believing it worked.
 */
// `paper`: paperLength, edgeMargin and printWidth for this print only, over This device (2026-10-22, the cafe PC's printer window).
export async function printDocument({ printer: chosen, bodyHtml, styles = '', paper = null }) {
  // P21. The browser tests record the words that would print. Only a test's init script sets this.
  if (typeof window.__E2E_PRINT__ === 'function') {
    const holder = document.createElement('div');
    holder.innerHTML = bodyHtml;
    window.__E2E_PRINT__(holder.textContent.replace(/\s+/g, ' ').trim(), chosen);
    return;
  }
  const printer = PRINTERS[chosen] ? chosen : 'THERMAL_80';
  const { paperLength, edgeMargin, printWidth } = { ...readDeviceSettings(), ...(paper ?? {}) };
  const widthMm = contentWidthMm(printer, edgeMargin, printWidth);
  /**
   * The content gets its width in millimetres, not the page's. Without it,
   * whatever paper Chrome prints on, A4 in the preview, stretched every block
   * and centred the logo across the whole sheet (Z Chaat, 2026-10-09).
   */
  const rootStyle = PRINTERS[printer].thermal
    ? `width: ${widthMm}mm; padding: 0 ${THERMAL_SIDE_MM}mm; box-sizing: border-box;`
    : `width: ${widthMm}mm;`;

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: `${widthMm}mm`,
    height: '2000mm',
    border: '0',
    visibility: 'hidden',
  });
  document.body.appendChild(frame);
  const cleanUp = () => setTimeout(() => frame.remove(), 1000);

  try {
    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8" /><title>Print</title>
<style>
  html, body { margin: 0; padding: 0; background: white; color: black; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${styles}
</style></head><body><div id="print-root" style="${rootStyle}">${bodyHtml}</div></body></html>`);
    doc.close();
    await contentLoaded(doc);
    await nextFrame(frame.contentWindow);

    // Measured after layout at the printed width, then the page is written: see pageCss.
    const heightMm = pxToMm(doc.getElementById('print-root').getBoundingClientRect().height);
    const page = doc.createElement('style');
    page.textContent = pageCss({ printer, contentHeightMm: heightMm, paperLength, edgeMargin, printWidth });
    doc.head.appendChild(page);
    await nextFrame(frame.contentWindow);

    frame.contentWindow.focus();
    frame.contentWindow.print();
  } finally {
    cleanUp();
  }
}

/** The styles for server-laid text: a roll's full width, or a large block at the top of a page. */
export function textStyles(printer) {
  const paper = PRINTERS[printer] ?? PRINTERS.THERMAL_80;
  const { edgeMargin, printWidth } = readDeviceSettings();
  return `
  pre {
    margin: 0;
    padding: ${paper.thermal ? `0 0 ${THERMAL_FEED_MM}mm` : '0'};
    /*
     * The frame loads none of the app's fonts, so these are the computer's
     * own. Consolas and Lucida Console are on every Windows computer; without
     * them Chrome fell back to Courier New, whose thin strokes printed faint
     * on thermal paper. Bold and pure black for the same reason.
     */
    font-family: Consolas, "Lucida Console", Menlo, "DejaVu Sans Mono", monospace;
    font-weight: 700;
    color: black;
    font-size: ${monospaceFontMm(printer, edgeMargin, printWidth).toFixed(2)}mm;
    line-height: 1.2;
    white-space: pre;
  }
  .review { display: flex; flex-direction: column; align-items: center; gap: 1mm; padding: 2mm 0 4mm; font: 3mm sans-serif; }
  .review svg { width: 30mm; height: 30mm; }`;
}

/**
 * Prints server-laid text: a receipt, a KOT or the Day Close. On a thermal
 * roll it fills the roll's width; on A4 or A5 it prints as one large block at
 * the top of the page. `afterHtml` (the review QR code) goes under it.
 */
export function printText(text, printer, { afterHtml = '' } = {}) {
  // P21. The browser tests record what would print instead of printing. Only a
  // test's init script ever sets this; nothing in the app does.
  if (typeof window.__E2E_PRINT__ === 'function') {
    window.__E2E_PRINT__(text, printer);
    return Promise.resolve();
  }
  return printDocument({ printer, bodyHtml: `<pre>${escapeHtml(text)}</pre>${afterHtml}`, styles: textStyles(printer) });
}

export { escapeHtml };
