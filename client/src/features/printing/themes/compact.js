/**
 * COMPACT: the same content as CLASSIC, A5 first, with tighter leading and
 * padding so a long bill still fits a half sheet. P64.
 */
import { renderClassic, CLASSIC_STYLES } from './classic.js';
import { SHARED_STYLES } from './shared.js';

const COMPACT_STYLES = `
  .invoice.compact { font-size: 8.5pt; line-height: 1.2; }
  .invoice.compact h1 { font-size: 13pt; }
  .invoice.compact .logo { max-height: 12mm; }
  .invoice.compact .head { gap: 3mm; }
  .invoice.compact .box { padding: 1mm 2mm; min-width: 40mm; }
  .invoice.compact .title { margin: 2mm 0 1mm; }
  .invoice.compact table { margin-top: 1.5mm; }
  .invoice.compact th, .invoice.compact td { padding: 0.6mm 1mm; }
  .invoice.compact .totals { width: 70%; margin-top: 1.5mm; }
  .invoice.compact .totals div { padding: 0.4mm 0; }
  .invoice.compact .grand { font-size: 11pt; }
  .invoice.compact .foot { margin-top: 3mm; }
  .invoice.compact .review svg { width: 22mm; height: 22mm; }
`;

export const renderCompact = (data, options = {}) => renderClassic(data, { ...options, rootClass: 'invoice compact' });

export default {
  id: 'COMPACT',
  title: 'Compact',
  paper: ['A5', 'A4'],
  styles: CLASSIC_STYLES + SHARED_STYLES + COMPACT_STYLES,
  render: renderCompact,
};
