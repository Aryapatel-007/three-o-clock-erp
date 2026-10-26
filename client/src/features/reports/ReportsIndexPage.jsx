import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import EmptyState from '../../components/ui/EmptyState.jsx';
import Input from '../../components/ui/Input.jsx';
import {
  CashIcon,
  ChartIcon,
  ClockIcon,
  LockIcon,
  MenuBookIcon,
  PeopleIcon,
  ReceiptIcon,
  SearchIcon,
  TriangleIcon,
} from '../../components/ui/icons/index.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { ROLES } from '../users/roles.js';
import { GROUPS, reportPath, reportsFor } from './catalog.js';

/**
 * Every report, and every other screen with figures on it, the signed-in user
 * may open, on one page. M19, P18; P60 brought onto it the screens that lived
 * only in the side menu (Day End, Day Close history, the cash book, payouts,
 * On Hold accounts, customers, stock and labour), with a search and a jump to
 * each group. A report the role cannot open is not listed; the server refuses
 * it regardless.
 */
const GROUP_ICONS = {
  'Today and days': ClockIcon,
  Money: CashIcon,
  'Tax and accounts': ReceiptIcon,
  'Menu and people': MenuBookIcon,
  Controls: TriangleIcon,
  Bills: ReceiptIcon,
  'Day end and records': LockIcon,
  Other: ChartIcon,
};

const MANAGER_ROLES = [ROLES.OWNER, ROLES.MANAGER];

/** The screens with figures that are not M19 reports, by group. */
function recordScreens(role, features) {
  const manager = MANAGER_ROLES.includes(role);
  return [
    { group: 'Day end and records', to: '/day-end', title: 'Day End', question: 'Close today: the figures, the cash count, and the day-end message', show: manager },
    { group: 'Day end and records', to: '/day-close', title: 'Day Close history', question: 'Every closed day, its count and its difference', show: manager },
    { group: 'Day end and records', to: '/cash-book', title: 'Cash book', question: 'The drawer today: brought forward, top-ups, expenses, cash taken out', show: manager },
    { group: 'Day end and records', to: '/payouts', title: 'Payouts', question: 'Money the platforms paid in, against what they owed', show: manager },
    { group: 'Day end and records', to: '/accounts', title: 'On Hold accounts', question: 'Charge, collect and adjust the accounts that pay later', show: manager },
    { group: 'Day end and records', to: '/customers', title: 'Customers', question: 'Guests, their visits, and who agreed to offers', show: manager },
    { group: 'Other', to: '/reports/stock', title: 'Stock', question: 'What was used, and what is running low?', show: features?.inventory !== false && [...MANAGER_ROLES, ROLES.STOREKEEPER].includes(role) },
    { group: 'Other', to: '/reports/labour', title: 'Labour', question: 'Who worked how long?', show: features?.attendance !== false && manager },
  ].filter((entry) => entry.show);
}

const ALL_GROUPS = [...GROUPS, 'Day end and records', 'Other'];
const anchorOf = (group) => `group-${group.toLowerCase().replace(/[^a-z]+/g, '-')}`;

export default function ReportsIndexPage() {
  const { user, features } = useAuth();
  const [search, setSearch] = useState('');

  const entries = useMemo(
    () => [
      ...reportsFor(user?.role).map((report) => ({ group: report.group, to: reportPath(report), id: report.id, title: report.title, question: report.question })),
      ...recordScreens(user?.role, features),
    ],
    [user?.role, features],
  );

  const term = search.trim().toLowerCase();
  const shown = term ? entries.filter((entry) => `${entry.title} ${entry.question} ${entry.id ?? ''}`.toLowerCase().includes(term)) : entries;
  const groups = ALL_GROUPS.map((group) => ({ group, items: shown.filter((entry) => entry.group === group) })).filter((section) => section.items.length > 0);

  return (
    <main className="min-h-full bg-ground px-4 py-6 lg:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="type-title">Reports</h1>
            <p className="type-caption text-muted">
              {entries.length} reports and records. Every number adds up, and every number opens the bills behind it.
            </p>
          </div>
          <Input
            label="Find a report"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="GST, cash, captains…"
            leading={<SearchIcon />}
            className="w-full lg:w-80"
          />
        </header>

        {!term && groups.length > 1 && (
          <nav aria-label="Report groups" className="-mx-1 flex gap-2 overflow-x-auto px-1">
            {groups.map(({ group, items }) => (
              <a
                key={group}
                href={`#${anchorOf(group)}`}
                className="type-label flex min-h-12 flex-none items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-4 text-muted hover:bg-sunken hover:text-ink"
              >
                {group}
                <span className="type-num-meta">{items.length}</span>
              </a>
            ))}
          </nav>
        )}

        {groups.length === 0 && <EmptyState title="No report matches" description={`Nothing is called "${search.trim()}". Try another word, like sales or cash.`} />}

        {groups.map(({ group, items }) => {
          const Icon = GROUP_ICONS[group] ?? ChartIcon;
          return (
            <section key={group} id={anchorOf(group)} className="scroll-mt-4">
              <h2 className="mb-3 flex items-center gap-2 type-label text-ink">
                <Icon aria-hidden="true" className="h-5 w-5 text-muted" />
                {group}
                <span className="type-num-meta text-muted">{items.length}</span>
              </h2>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((entry) => (
                  <li key={entry.to}>
                    <ReportCard entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}

function ReportCard({ entry }) {
  return (
    <Link
      to={entry.to}
      className="group flex h-full min-h-24 flex-col gap-1 rounded-[10px] border border-line bg-surface p-4 transition hover:border-muted hover:bg-sunken focus-visible:bg-sunken"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="type-body font-semibold text-ink">{entry.title}</span>
        <span className="flex items-center gap-2">
          {entry.id && <span className="type-num-meta rounded bg-sunken px-2 text-muted group-hover:bg-surface">{entry.id}</span>}
          <span aria-hidden="true" className="text-muted transition group-hover:translate-x-0.5 group-hover:text-ink">→</span>
        </span>
      </span>
      <span className="type-caption text-muted">{entry.question}</span>
    </Link>
  );
}
