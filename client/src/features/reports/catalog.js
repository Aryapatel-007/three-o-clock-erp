/**
 * Every report, as the screens know it. M19, P18.
 *
 * The server owns every figure, label and column; this file only says which
 * screen controls a report needs, which group it sits in on the index, and the
 * one-line question from docs/REPORT-SPEC.md section 2. Roles mirror the
 * contract's permission table so the index can hide what a role cannot open;
 * the server refuses them regardless.
 *
 * `dateMode`: 'none' (R1, always today), 'date' (one business date), 'range'
 * (from and to), or 'asOf' (R17: a date the accounts are read as of, plus an
 * optional range for one account's statement).
 */
import { ROLES } from '../users/roles.js';

const MANAGERS = [ROLES.OWNER, ROLES.MANAGER];
const OWNER = [ROLES.OWNER];

export const GROUPS = [
  'Today and days',
  'Money',
  'Tax and accounts',
  'Menu and people',
  'Controls',
  'Bills',
];

export const REPORTS = [
  { id: 'R1', name: 'today', title: 'Today', group: 'Today and days', question: 'How is today going, right now?', roles: MANAGERS, dateMode: 'none', refreshMs: 60_000 },
  { id: 'R2', name: 'day-close', title: 'Day Close', group: 'Today and days', question: 'Did the day add up, and where is the money?', roles: MANAGERS, dateMode: 'date' },
  { id: 'R3', name: 'sales-by-day', title: 'Sales by Day', group: 'Today and days', question: 'How did each day do across a range?', roles: MANAGERS, dateMode: 'range', filters: ['orderType', 'compare'] },
  { id: 'R4', name: 'hours', title: 'Hours and Weekdays', group: 'Today and days', question: 'When are we busy?', roles: MANAGERS, dateMode: 'range', filters: ['orderType'] },
  { id: 'R5', name: 'payments', title: 'Payments', group: 'Money', question: 'How was each day paid?', roles: OWNER, dateMode: 'range' },
  { id: 'R6', name: 'platform-money', title: 'Platform Money', group: 'Money', question: 'What do Zomato, Swiggy and the dining apps owe us, and did they pay?', roles: MANAGERS, dateMode: 'range', filters: ['method'] },
  { id: 'R7', name: 'cash-till', title: 'Cash Till', group: 'Money', question: 'Did the cash drawer match?', roles: OWNER, dateMode: 'range' },
  { id: 'R17', name: 'accounts', title: 'On Hold Accounts', group: 'Money', question: 'Who owes us, and since when?', roles: MANAGERS, dateMode: 'asOf', filters: ['accountId'] },
  { id: 'R8', name: 'gst', title: 'GST', group: 'Tax and accounts', question: 'What GST do we owe, and what goes in the returns?', roles: MANAGERS, dateMode: 'range' },
  { id: 'R9', name: 'tally-export', title: 'Tally Export', group: 'Tax and accounts', question: 'The file the accountant imports', roles: MANAGERS, dateMode: 'range', downloadOnly: true },
  { id: 'R20', name: 'ca-pack', title: 'CA Pack', group: 'Tax and accounts', question: 'Everything the CA needs for the month, in one file', roles: OWNER, path: '/settings/ca-reports' },
  { id: 'R10', name: 'invoice-register', title: 'Invoice Register', group: 'Tax and accounts', question: 'Every invoice number, in order, with no gaps', roles: MANAGERS, dateMode: 'range', paged: true },
  { id: 'R11', name: 'menu', title: 'Menu Performance', group: 'Menu and people', question: 'Which categories and items earn the money?', roles: MANAGERS, dateMode: 'range', filters: ['orderType', 'categoryName'] },
  { id: 'R12', name: 'captains', title: 'Captains', group: 'Menu and people', question: "How did each captain's tables do?", roles: MANAGERS, dateMode: 'range', filters: ['orderType'] },
  { id: 'R13', name: 'tables', title: 'Tables and Table Time', group: 'Menu and people', question: 'Which tables earn, and how fast do they turn?', roles: MANAGERS, dateMode: 'range', filters: ['stationId'] },
  { id: 'R14', name: 'discounts', title: 'Discounts', group: 'Controls', question: 'Who gave what discount, and why?', roles: MANAGERS, dateMode: 'range', filters: ['discountReason'], paged: true },
  { id: 'R15', name: 'cancellations', title: 'Cancellations and Voids', group: 'Controls', question: 'What was cancelled or voided, by whom, and what was wasted?', roles: MANAGERS, dateMode: 'range', paged: true },
  { id: 'R16', name: 'no-charge', title: 'No Charge', group: 'Controls', question: 'What was given away free, and who approved it?', roles: MANAGERS, dateMode: 'range', paged: true },
  { id: 'R18', name: 'activity', title: 'Activity Log', group: 'Controls', question: 'Who did something sensitive?', roles: MANAGERS, path: '/reports/activity' },
  { id: 'R19', name: 'bills', title: 'Bill List', group: 'Bills', question: 'The bills behind any number', roles: MANAGERS, path: '/reports/bills' },
];

export const REPORTS_BY_NAME = Object.fromEntries(REPORTS.map((report) => [report.name, report]));

/** The address a report opens at. */
export const reportPath = (report) => report.path ?? `/reports/${report.name}`;

/** The reports a role may open, in index order. */
export const reportsFor = (role) => REPORTS.filter((report) => report.roles.includes(role));

/**
 * Where a drill down goes. R19 is the Bill List; an order opens its own
 * screen; any other report opens its page with the query.
 */
export function drillHref(drill) {
  if (!drill) return null;
  const search = new URLSearchParams(
    Object.entries(drill.query ?? {}).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]),
  ).toString();
  if (drill.report === 'R19') return `/reports/bills?${search}`;
  if (drill.report === 'ORDER') return drill.query?.orderId ? `/orders/${drill.query.orderId}` : null;
  // P25 Part L. An integration alert's own page, always inside the app.
  if (drill.report === 'LINK') return typeof drill.query?.to === 'string' && drill.query.to.startsWith('/') && !drill.query.to.startsWith('//') ? drill.query.to : null;
  const target = REPORTS.find((report) => report.id === drill.report);
  return target ? `${reportPath(target)}?${search}` : null;
}
