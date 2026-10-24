/**
 * R20 CA Pack. P65, docs/API-CONTRACT.md "P65", REPORT-SPEC R20.
 *
 * A calendar month of closed days, for the restaurant's chartered accountant,
 * one sheet per section. Built from the other reports' own queries (R5, R7,
 * R8 and R10) rather than a second calculation, so every figure here is the
 * figure those reports show for the same month, to the paisa. The two figures
 * of its own, the HSN and SAC summary and the On Hold movement, are added up
 * from values frozen on the bills and the account ledger, and checked.
 *
 * Refuses a month with a day still open, a month on a copy that has not
 * received it whole (copyHolds.js), and, as R9 does, a month with a failing
 * ERROR check. Carries no guest's name or number.
 */
import { z } from 'zod';

import { Bill } from '../../../models/Bill.js';
import { CashMovement } from '../../../models/CashMovement.js';
import { DAY_STATUSES, DayClosure } from '../../../models/DayClosure.js';
import { Restaurant } from '../../../models/Restaurant.js';
import { DayNotClosedError } from '../../../utils/errors.js';
import { sumPaise } from '../../../utils/money.js';
import { scoped } from '../../../utils/scopedQuery.js';
import { splitRateTaxAcrossRows } from '../../../utils/tax.js';
import { nowUtc, toIst } from '../../../utils/time.js';
import { listAccounts } from '../../accountService.js';
import { checkC5, runRangeChecks } from '../../reconciliationService.js';
import { assertCopyHoldsPeriod } from '../copyHolds.js';
import { LABELS } from '../labels.js';
import { liveInRange } from '../../reportRangeService.js';
import cashTill from './cashTill.js';
import gst from './gst.js';
import invoiceRegister from './invoiceRegister.js';
import payments from './payments.js';
import { OWNER_ONLY } from './shared.js';

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-10" as its first and last business dates. */
export function monthRange(month) {
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The business date before `date`, as a label. */
function dayBefore(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** Printed on the cover, never left to a comment: what the pack cannot claim. */
export const NOT_COVERED = Object.freeze([
  'No purchases: nothing in this system records a purchase bill, so there is no input GST, no purchase register and no GSTR-2B reconciliation.',
  'Every sale is to an unregistered guest (B2C): On Hold accounts carry no GSTIN, so no sale here can be claimed as input credit.',
  'No credit notes: a bill voided before the return is filed shows as a cancelled number; a refund after filing needs a credit note this system does not issue.',
  'No e-invoicing: no IRN and no signed QR code.',
  "No guest's personal data: invoice numbers and amounts only.",
]);

const lineColumns = [
  { key: 'line', label: LABELS.LINE, type: 'text' },
  { key: 'detail', label: LABELS.DETAIL, type: 'text' },
];
const outwardColumns = [
  { key: 'taxRate', label: LABELS.TAX_RATE, type: 'text' },
  { key: 'netSalesInPaise', label: LABELS.NET_SALES, type: 'money' },
  { key: 'cgstInPaise', label: LABELS.CGST, type: 'money' },
  { key: 'sgstInPaise', label: LABELS.SGST, type: 'money' },
  { key: 'gstInPaise', label: LABELS.GST, type: 'money' },
];
const hsnColumns = [
  { key: 'code', label: LABELS.CODE, type: 'text' },
  { key: 'taxRate', label: LABELS.TAX_RATE, type: 'text' },
  { key: 'quantity', label: LABELS.QUANTITY, type: 'count' },
  { key: 'netSalesInPaise', label: LABELS.NET_SALES, type: 'money' },
  { key: 'cgstInPaise', label: LABELS.CGST, type: 'money' },
  { key: 'sgstInPaise', label: LABELS.SGST, type: 'money' },
];
const moneyColumns = [
  { key: 'line', label: LABELS.LINE, type: 'text' },
  { key: 'amountInPaise', label: LABELS.VALUE, type: 'money' },
];
const onHoldColumns = [
  { key: 'name', label: LABELS.ACCOUNT, type: 'text' },
  { key: 'openingInPaise', label: LABELS.OPENING, type: 'money' },
  { key: 'chargedInPaise', label: LABELS.CHARGED, type: 'money' },
  { key: 'collectedInPaise', label: LABELS.COLLECTED, type: 'money' },
  { key: 'adjustedInPaise', label: LABELS.ADJUSTED, type: 'money' },
  { key: 'closingInPaise', label: LABELS.CLOSING, type: 'money' },
];
const cashColumns = [
  { key: 'line', label: LABELS.LINE, type: 'text' },
  { key: 'count', label: LABELS.COUNT, type: 'count' },
  { key: 'amountInPaise', label: LABELS.VALUE, type: 'money' },
];
const checkColumns = [
  { key: 'check', label: LABELS.CHECK, type: 'text' },
  { key: 'status', label: LABELS.STATUS, type: 'text' },
  { key: 'detail', label: LABELS.DETAIL, type: 'text' },
];

const sumOf = (rows, key) => sumPaise(0, ...rows.map((row) => row[key] ?? 0));
const totalsOf = (rows, keys) => Object.fromEntries(keys.map((key) => [key, sumOf(rows, key)]));
const rateWords = (bps) => `${bps / 100}%`;

/** By code and rate, from each bill line's frozen code and shares. */
function hsnSummary(bills) {
  const rows = new Map();
  const slabCgst = new Map();
  const slabTax = new Map();
  for (const bill of bills) {
    for (const slab of bill.taxBreakdown) {
      slabCgst.set(slab.taxRateBps, sumPaise(slabCgst.get(slab.taxRateBps) ?? 0, slab.cgstInPaise));
      slabTax.set(slab.taxRateBps, sumPaise(slabTax.get(slab.taxRateBps) ?? 0, slab.taxInPaise));
    }
    for (const line of bill.lines) {
      const code = line.hsnCode ?? null;
      const key = `${code ?? ''}|${line.taxRateBps}`;
      const row = rows.get(key) ?? { code: code ?? 'Not recorded', taxRateBps: line.taxRateBps, quantity: 0, netSalesInPaise: 0, taxInPaise: 0 };
      row.quantity += line.quantity;
      // A line from before P03 has no shares: it counts as zero, and C5.8 says so.
      row.netSalesInPaise = sumPaise(row.netSalesInPaise, line.taxableInPaise ?? 0);
      row.taxInPaise = sumPaise(row.taxInPaise, line.taxInPaise ?? 0);
      rows.set(key, row);
    }
  }
  const list = [...rows.values()].sort((a, b) => b.taxRateBps - a.taxRateBps || String(a.code).localeCompare(String(b.code)));
  for (const rate of new Set(list.map((row) => row.taxRateBps))) {
    const ofRate = list.filter((row) => row.taxRateBps === rate);
    // Split only when the rows hold the rate's whole GST; otherwise C5.8 already fails.
    const whole = sumOf(ofRate, 'taxInPaise') === (slabTax.get(rate) ?? 0);
    const split = whole ? splitRateTaxAcrossRows(ofRate, slabCgst.get(rate) ?? 0) : ofRate.map(() => ({ cgstInPaise: null, sgstInPaise: null }));
    ofRate.forEach((row, index) => Object.assign(row, split[index]));
  }
  return list.map(({ taxInPaise: _tax, taxRateBps, ...row }) => ({ ...row, taxRate: rateWords(taxRateBps), taxRateBps }));
}

/** Each account's month: opening, charged, collected, adjusted, closing. */
async function onHoldMovement(req, from, to) {
  const [before, after] = await Promise.all([
    listAccounts(req, { includeInactive: true, asOf: dayBefore(from) }),
    listAccounts(req, { includeInactive: true, asOf: to }),
  ]);
  const earlier = new Map(before.map((account) => [String(account.id), account]));
  return after
    .map((account) => {
      const start = earlier.get(String(account.id));
      const at = (key) => start?.[key] ?? 0;
      return {
        name: account.name,
        // An opening balance set during the month is part of the opening.
        openingInPaise: sumPaise(at('outstandingInPaise'), account.openingInPaise - at('openingInPaise')),
        chargedInPaise: account.chargedInPaise - at('chargedInPaise'),
        collectedInPaise: account.collectedInPaise - at('collectedInPaise'),
        adjustedInPaise: account.adjustedInPaise - at('adjustedInPaise'),
        closingInPaise: account.outstandingInPaise,
      };
    })
    .filter((row) => Object.entries(row).some(([key, value]) => key !== 'name' && value !== 0));
}

/** Expenses by category, and cash out that is not an expense: P29's Tally heads. */
async function cashLines(req, from, to, cashResult) {
  const byCategory = new Map();
  for (const row of cashResult.sections.find((section) => section.key === 'expensesByCategory').rows) {
    const entry = byCategory.get(row.code) ?? { line: row.categoryLabel, count: 0, amountInPaise: 0 };
    entry.count += row.count;
    entry.amountInPaise = sumPaise(entry.amountInPaise, row.amountInPaise);
    byCategory.set(row.code, entry);
  }
  const [takenOut, closures] = await Promise.all([
    CashMovement.find({ ...scoped(req), businessDate: { $gte: from, $lte: to }, isVoided: false, type: 'CASH_TAKEN_OUT' }).select('destination amountInPaise').lean(),
    DayClosure.find({ ...scoped(req), businessDate: { $gte: from, $lte: to }, status: DAY_STATUSES.CLOSED, takenOutAtCloseInPaise: { $gt: 0 } })
      .select('takenOutAtCloseInPaise takenOutTo')
      .lean(),
  ]);
  const out = (destination) => {
    const moves = takenOut.filter((movement) => movement.destination === destination);
    const atClose = closures.filter((closure) => closure.takenOutTo === destination);
    return {
      count: moves.length + atClose.length,
      amountInPaise: sumPaise(0, ...moves.map((movement) => movement.amountInPaise), ...atClose.map((closure) => closure.takenOutAtCloseInPaise)),
    };
  };
  return [
    ...[...byCategory.values()].map((row) => ({ ...row, line: `Expense: ${row.line}` })),
    { line: 'Bank deposit (contra)', ...out('BANK_DEPOSIT') },
    { line: 'Drawings (cash to the owner)', ...out('OWNER') },
    { line: 'Other cash taken out', ...out('OTHER') },
  ];
}

export default {
  id: 'R20',
  name: 'ca-pack',
  title: 'CA Pack',
  roles: OWNER_ONLY,
  schema: z
    .object({
      month: z.string({ error: 'Choose a month.' }).regex(MONTH_PATTERN, 'A month like 2026-10.'),
      format: z.enum(['json', 'xlsx'], { error: 'Must be json or xlsx.' }).default('json'),
    })
    .strict('Is not a filter on this report.'),
  filters: [],
  dimensions: [],
  columns: lineColumns,
  requiresPassingChecks: true,
  sheetPerSection: true,

  prepare(_req, params) {
    return { ...params, ...monthRange(params.month) };
  },

  async query(req, baseMatch, params, ctx) {
    const { from, to } = params;
    const open = await ctx.openDays();
    if (open.length > 0) throw new DayNotClosedError(open, 'The CA pack covers whole months of closed days.');
    const closures = await DayClosure.find({ ...scoped(req), businessDate: { $gte: from, $lte: to }, status: DAY_STATUSES.CLOSED }).select('closedAt').lean();
    await assertCopyHoldsPeriod(req, closures);

    const range = { from, to };
    const live = () => ({ ...baseMatch });
    const withVoided = () => {
      const match = liveInRange(req, range).$match;
      delete match.isVoided;
      return match;
    };
    const [gstResult, register, paid, cash, bills, restaurant] = await Promise.all([
      gst.query(req, live(), range, ctx),
      invoiceRegister.query(req, withVoided(), { ...range, page: 1, limit: Number.MAX_SAFE_INTEGER }, ctx),
      payments.query(req, live(), range, ctx),
      cashTill.query(req, live(), range, ctx),
      Bill.find(live()).select('taxBreakdown lines.hsnCode lines.taxRateBps lines.quantity lines.taxableInPaise lines.taxInPaise').lean(),
      // The tenancy root, by _id from a verified token.
      Restaurant.findById(req.restaurantId).select('name legalName gstin fssaiLicenseNumber').lean(),
    ]);

    // Outward supplies: R8's rates, then the platform's 9(5) supplies on their own rows.
    const outward = [
      ...gstResult.byRate.map(({ taxRate, netSalesInPaise, cgstInPaise, sgstInPaise, gstInPaise }) => ({ taxRate, netSalesInPaise, cgstInPaise, sgstInPaise, gstInPaise })),
      ...gstResult.platformRows.map((row) => ({
        taxRate: `0%, the platform pays GST, section 9(5): ${row.platform}`,
        netSalesInPaise: row.netSalesInPaise,
        cgstInPaise: 0,
        sgstInPaise: 0,
        gstInPaise: 0,
      })),
    ];
    const hsn = hsnSummary(bills);

    // Money received: R5's month totals, by method, then On Hold, unpaid and collections.
    const days = paid.sections.find((section) => section.key === 'days');
    const collections = paid.sections.find((section) => section.key === 'collections');
    const money = [
      ...days.columns.filter((column) => column.type === 'money').map((column) => ({ line: column.label, amountInPaise: days.totals[column.key] })),
      { line: LABELS.COLLECTION, amountInPaise: collections.totals.amountInPaise },
    ];

    const checks = [
      ...(await runRangeChecks(req, range, ['C1', 'C3', 'C4', 'C6', 'C13'])),
      checkC5(7, outward, 'netSalesInPaise', gstResult.wholeNetSalesInPaise),
      checkC5(8, hsn, 'netSalesInPaise', gstResult.wholeNetSalesInPaise),
    ];

    const onHold = await onHoldMovement(req, from, to);

    const cover = [
      { line: 'Restaurant', detail: restaurant?.name ?? '' },
      { line: 'Legal name', detail: restaurant?.legalName ?? 'Not set' },
      { line: 'GSTIN', detail: restaurant?.gstin ?? 'Not set' },
      { line: 'FSSAI', detail: restaurant?.fssaiLicenseNumber ?? 'Not set' },
      { line: 'Period', detail: `${from} to ${to}` },
      { line: 'Days closed', detail: `${closures.length} of ${closures.length + open.length}, every one` },
      { line: 'Built at', detail: toIst(nowUtc()) },
      ...NOT_COVERED.map((sentence) => ({ line: 'Not in this pack', detail: sentence })),
    ];

    return {
      sections: [
        { key: 'cover', title: 'Cover', columns: lineColumns, rows: cover },
        { key: 'outward', title: 'Outward supplies', columns: outwardColumns, rows: outward, totals: totalsOf(outward, ['netSalesInPaise', 'cgstInPaise', 'sgstInPaise', 'gstInPaise']) },
        { key: 'hsn', title: 'HSN and SAC summary', columns: hsnColumns, rows: hsn, totals: totalsOf(hsn, ['quantity', 'netSalesInPaise', 'cgstInPaise', 'sgstInPaise']) },
        { key: 'documents', title: 'Document series', columns: invoiceRegister.columns, rows: register.rows, totals: register.totals },
        { key: 'money', title: 'Money received', columns: moneyColumns, rows: money },
        {
          key: 'onHold',
          title: 'On Hold movement',
          columns: onHoldColumns,
          rows: onHold,
          totals: totalsOf(onHold, ['openingInPaise', 'chargedInPaise', 'collectedInPaise', 'adjustedInPaise', 'closingInPaise']),
        },
        { key: 'cash', title: 'Cash and expenses', columns: cashColumns, rows: await cashLines(req, from, to, cash) },
        {
          key: 'checks',
          title: 'Checks run',
          columns: checkColumns,
          rows: checks.map((check) => ({ check: check.id, status: check.passed ? 'Passed' : 'Failed', detail: check.message })),
        },
      ],
      checks,
    };
  },

  checks(_req, _params, result) {
    return result.checks;
  },
};
