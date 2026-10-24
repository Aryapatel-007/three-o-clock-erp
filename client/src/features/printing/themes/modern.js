/**
 * MODERN: CLASSIC with a band in the restaurant's accent and lighter rules.
 * P64. The same content and the same figures; the accent comes from the
 * invoice data (`layout.accent`, checked by utils/colour.js on the server),
 * and black is used when the restaurant has not chosen to draw it.
 */
import { renderClassic, CLASSIC_STYLES } from './classic.js';
import { escapeHtml, SHARED_STYLES } from './shared.js';

const MODERN_STYLES = `
  .invoice.modern { --accent: black; }
  .invoice.modern .band { height: 3mm; background: var(--accent); margin-bottom: 4mm; }
  .invoice.modern h1 { color: var(--accent); }
  .invoice.modern .box { border: 0; border-left: 1mm solid var(--accent); }
  .invoice.modern th { border-bottom: 0.2mm solid var(--accent); }
  .invoice.modern th, .invoice.modern td { border-bottom-width: 0.1mm; border-bottom-color: lightgray; }
  .invoice.modern .title { color: var(--accent); }
  .invoice.modern .grand { border-top: 0.2mm solid var(--accent); border-bottom: 0.2mm solid var(--accent); }
`;

export function renderModern(data, options = {}) {
  const accent = data.layout?.accent;
  const style = accent ? ` style="--accent: ${escapeHtml(accent)}"` : '';
  return renderClassic(data, { ...options, rootClass: 'invoice modern', band: `<div class="band"${style}></div>` }).replace(
    '<div class="invoice modern">',
    `<div class="invoice modern"${style}>`,
  );
}

export default {
  id: 'MODERN',
  title: 'Modern',
  paper: ['A4', 'A5'],
  styles: CLASSIC_STYLES + SHARED_STYLES + MODERN_STYLES,
  render: renderModern,
};
