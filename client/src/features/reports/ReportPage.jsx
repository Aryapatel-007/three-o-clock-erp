import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import BalanceSeal, { FilterSentence } from '../../components/ui/BalanceSeal.jsx';
import Money from '../../components/ui/Money.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import NotFoundPage from '../../components/NotFoundPage.jsx';
import { StatTile } from '../../components/charts/StatTile.jsx';
import { listAccounts } from '../../api/accounts.js';
import { listPaymentMethods } from '../../api/paymentMethods.js';
import { downloadReport, getReport } from '../../api/reportsV2.js';
import { listStations } from '../../api/stations.js';
import { businessDateToday } from '../../utils/formatDate.js';

import { DISCOUNT_REASONS } from '../billing/discountReasons.js';
import { errorMessage } from '../billing/errorCopy.js';
import { REPORTS_BY_NAME } from './catalog.js';
import { PRESETS, presetOf, presetRange, rememberedRange, rememberRange } from './dateRanges.js';
import { LABELS } from './labels.js';
import ReportChart from './ReportCharts.jsx';
import ReportTable from './ReportTable.jsx';
import { OpenDaysBanner } from './v2/reportCells.jsx';

const DATE_KEYS = ['from', 'to', 'date', 'asOf'];
const ORDER_TYPES = [
  { value: 'DINE_IN', label: 'Dine-in' },
  { value: 'TAKEAWAY', label: 'Takeaway' },
  { value: 'DELIVERY', label: 'Delivery' },
];

/**
 * One screen for every report. M19, built in P18.
 *
 * It renders whatever envelope the server sends: the filter sentence, the
 * open-day banner, the check strip, then each section's chart and table, with
 * the totals the server added up. Every filter lives in the address, so a
 * link, a refresh or a drill down opens exactly the same report. The last date
 * range used for each report is remembered on this device.
 */
export default function ReportPage() {
  const { name } = useParams();
  const report = REPORTS_BY_NAME[name];
  if (!report || report.path) return <NotFoundPage />;
  return <ReportScreen key={name} report={report} />;
}

function ReportScreen({ report }) {
  const [params, setParams] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const today = businessDateToday();
  const query = useMemo(() => {
    const next = Object.fromEntries(params.entries());
    const remembered = rememberedRange(report.name);
    if (report.dateMode === 'range') {
      next.from ??= remembered?.from ?? today;
      next.to ??= remembered?.to ?? next.from;
    } else if (report.dateMode === 'date') {
      next.date ??= remembered?.from ?? today;
    } else if (report.dateMode === 'asOf') {
      next.asOf ??= today;
    }
    if (report.paged) next.limit ??= '50';
    return next;
  }, [params, report, today]);

  useEffect(() => {
    if (report.dateMode === 'range') rememberRange(report.name, { from: query.from, to: query.to });
    if (report.dateMode === 'date') rememberRange(report.name, { from: query.date, to: query.date });
  }, [report, query.from, query.to, query.date]);

  const setQuery = (changes) => {
    const next = { ...query, ...changes };
    if (!('page' in changes)) delete next.page;
    for (const [key, value] of Object.entries(next)) if (value === '' || value === undefined || value === null) delete next[key];
    setParams(next);
  };

  const result = useQuery({
    queryKey: ['report', report.name, query],
    queryFn: () => getReport(report.name, query),
    enabled: !report.downloadOnly,
    placeholderData: (previous) => previous,
    refetchInterval: report.refreshMs ?? false,
    retry: (count, error) => error?.status !== 403 && count < 2,
  });

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const { page: _page, limit: _limit, ...filters } = query;
      const { blob, fileName } = await downloadReport(report.name, report.paged ? { ...filters, limit: 200 } : filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(errorMessage(error));
    } finally {
      setDownloading(false);
    }
  };

  const envelope = result.data?.data;
  const meta = result.data?.meta;
  const sections = envelope
    ? envelope.sections ?? [{ key: null, title: null, columns: envelope.columns, rows: envelope.rows, totals: envelope.totals }]
    : [];

  return (
    <main className="min-h-full bg-ground px-4 py-6 lg:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="type-label text-muted print:hidden">
              <Link to="/reports" className="inline-flex min-h-12 items-center hover:underline">
                Reports
              </Link>{' '}
              › {report.title}
            </p>
            <h1 className="type-title ">{report.title}</h1>
            <p className="type-caption text-muted print:hidden">{report.question}</p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            {!report.downloadOnly && (
              <button
                type="button"
                onClick={() => window.print()}
                disabled={!envelope}
                className="min-h-12 rounded-lg bg-surface px-4 type-caption border border-line hover:bg-sunken disabled:opacity-50"
              >
                Print
              </button>
            )}
            <button
              type="button"
              onClick={download}
              disabled={downloading}
              className={[
                'min-h-12 rounded-lg px-4 type-caption border border-line disabled:opacity-50',
                report.downloadOnly ? 'bg-accent text-on-accent' : 'bg-surface hover:bg-sunken',
              ].join(' ')}
            >
              {downloading ? 'Preparing…' : report.downloadOnly ? 'Download for Tally' : 'Excel'}
            </button>
          </div>
        </header>

        {envelope && (
          <>
            <BalanceSeal
              checks={envelope.checks}
              scope={envelope.filterSentence ? `for ${envelope.filterSentence.split('. ')[0].replace(/\.$/, '')}` : null}
              renderRefs={(check) => <CheckRefs check={check} query={query} />}
            />
            <FilterSentence>{envelope.filterSentence}</FilterSentence>
          </>
        )}

        {report.dateMode !== 'none' && (
          <section className="rounded-[10px] bg-surface p-3 border border-line print:hidden">
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              className="flex min-h-12 w-full items-center justify-between rounded-lg bg-sunken px-4 type-caption sm:hidden"
            >
              Filters <span aria-hidden>{filtersOpen ? '▴' : '▾'}</span>
            </button>
            <div className={[filtersOpen ? 'flex' : 'hidden', 'mt-3 flex-wrap items-end gap-3 sm:mt-0 sm:flex'].join(' ')}>
              <DateControls report={report} query={query} today={today} setQuery={setQuery} />
              <FilterControls report={report} query={query} setQuery={setQuery} />
            </div>
          </section>
        )}

        {downloadError && <p className="type-caption text-alert">{downloadError}</p>}

        {report.downloadOnly && (
          <p className="rounded-[10px] bg-surface p-4 type-label border border-line">
            The Tally file for the dates above. It is built only when every check passes; if one fails, the download
            names it.
          </p>
        )}

        {!report.downloadOnly && result.isPending && (
          <div className="py-12">
            <Spinner label="Working out the report" />
          </div>
        )}

        {!report.downloadOnly && result.isError && <ReportError report={report} error={result.error} onRetry={() => result.refetch()} />}

        {envelope && (
          <>
            <OpenDaysBanner openDays={envelope.openDays} />

            {envelope.headline?.wastedValueInPaise !== undefined && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <StatTile label={LABELS.WASTED_VALUE} value={<Money paise={envelope.headline.wastedValueInPaise} />} />
              </div>
            )}

            {sections.map((section) => (
              <section key={section.key ?? 'main'} className="report-section rounded-[10px] bg-surface p-4 border border-line">
                {section.title && <h2 className="mb-3 type-heading">{section.title}</h2>}
                <div className="mb-4 empty:mb-0">
                  <ReportChart reportId={envelope.report} section={section} />
                </div>
                {!(envelope.report === 'R1' && section.key === 'tiles') && (
                  <ReportTable columns={section.columns} rows={section.rows ?? []} totals={section.totals} caption={section.title ?? report.title} />
                )}
              </section>
            ))}

            {envelope.previous && (
              <section className="report-section rounded-[10px] bg-surface p-4 border border-line">
                <h2 className="mb-3 type-heading">
                  Previous period, {envelope.previous.filter.from} to {envelope.previous.filter.to}
                </h2>
                <ReportTable columns={envelope.columns} rows={envelope.previous.rows} totals={envelope.previous.totals} />
              </section>
            )}

            {meta && meta.total > meta.limit && (
              <Pager meta={meta} onPage={(page) => setQuery({ page: String(page) })} />
            )}
          </>
        )}
      </div>
    </main>
  );
}

/** One date, a range with presets, or R17's "as of" date and statement range. */
function DateControls({ report, query, today, setQuery }) {
  const field = 'min-h-12 rounded-lg bg-sunken px-4 type-num-meta ';
  const labelText = 'flex items-center gap-2 type-label text-muted';

  if (report.dateMode === 'date') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {['today', 'yesterday'].map((key) => {
          const range = presetRange(key, today);
          const active = query.date === range.from;
          return (
            <PresetButton key={key} active={active} onClick={() => setQuery({ date: range.from })}>
              {PRESETS.find((preset) => preset.key === key).label}
            </PresetButton>
          );
        })}
        <label className={labelText}>
          Date
          <input type="date" value={query.date} max={today} onChange={(event) => setQuery({ date: event.target.value })} className={field} />
        </label>
      </div>
    );
  }

  if (report.dateMode === 'asOf') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label className={labelText}>
          As of
          <input type="date" value={query.asOf} max={today} onChange={(event) => setQuery({ asOf: event.target.value })} className={field} />
        </label>
        {query.accountId && (
          <>
            <label className={labelText}>
              Statement from
              <input type="date" value={query.from ?? ''} onChange={(event) => setQuery({ from: event.target.value })} className={field} />
            </label>
            <label className={labelText}>
              To
              <input type="date" value={query.to ?? ''} onChange={(event) => setQuery({ to: event.target.value })} className={field} />
            </label>
          </>
        )}
      </div>
    );
  }

  const current = presetOf({ from: query.from, to: query.to });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => (
        <PresetButton key={preset.key} active={current === preset.key} onClick={() => setQuery(presetRange(preset.key, today))}>
          {preset.label}
        </PresetButton>
      ))}
      <PresetButton active={current === 'custom'} onClick={() => {}}>
        Custom
      </PresetButton>
      <label className={labelText}>
        From
        <input type="date" value={query.from} max={today} onChange={(event) => setQuery({ from: event.target.value })} className={field} />
      </label>
      <label className={labelText}>
        To
        <input type="date" value={query.to} max={today} onChange={(event) => setQuery({ to: event.target.value })} className={field} />
      </label>
    </div>
  );
}

function PresetButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'min-h-12 rounded-lg px-3 type-caption transition-colors',
        '',
        active ? 'bg-ink text-surface' : 'bg-sunken text-muted hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** The report's own filters, from the contract, as simple pickers. */
function FilterControls({ report, query, setQuery }) {
  const filters = report.filters ?? [];
  const needs = (name) => filters.includes(name);
  const stations = useQuery({ queryKey: ['stations'], queryFn: () => listStations(), enabled: needs('stationId') });
  const accounts = useQuery({ queryKey: ['accounts', 'all'], queryFn: () => listAccounts({ includeInactive: true }), enabled: needs('accountId') });
  const methods = useQuery({ queryKey: ['payment-methods'], queryFn: () => listPaymentMethods(), enabled: needs('method') });
  const [category, setCategory] = useState(query.categoryName ?? '');

  if (filters.length === 0) return null;
  const select = 'min-h-12 rounded-lg bg-sunken px-4 type-caption ';
  const labelText = 'flex items-center gap-2 type-label text-muted';

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needs('orderType') && (
        <label className={labelText}>
          {LABELS.ORDER_TYPE}
          <select value={query.orderType ?? ''} onChange={(event) => setQuery({ orderType: event.target.value })} className={select}>
            <option value="">All</option>
            {ORDER_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {needs('compare') && (
        <label className="flex min-h-12 items-center gap-2 rounded-lg bg-sunken px-4 type-caption">
          <input
            type="checkbox"
            checked={query.compare === 'previous'}
            onChange={(event) => setQuery({ compare: event.target.checked ? 'previous' : '' })}
            className="size-4 accent-[var(--color-ink)]"
          />
          Compare with the period before
        </label>
      )}
      {needs('method') && (
        <label className={labelText}>
          {LABELS.PLATFORM}
          <select value={query.method ?? ''} onChange={(event) => setQuery({ method: event.target.value })} className={select}>
            <option value="">All</option>
            {(methods.data ?? [])
              .filter((method) => method.kind === 'PLATFORM')
              .map((method) => (
                <option key={method.code} value={method.code}>
                  {method.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {needs('categoryName') && (
        <form
          className={labelText}
          onSubmit={(event) => {
            event.preventDefault();
            setQuery({ categoryName: category.trim() });
          }}
        >
          {LABELS.CATEGORY}
          <input
            type="search"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="All, or one category's items"
            className={`${select} w-56`}
          />
          <button type="submit" className="min-h-12 rounded-lg bg-sunken px-3 type-caption normal-case text-ink">
            Show
          </button>
        </form>
      )}
      {needs('stationId') && (
        <label className={labelText}>
          {LABELS.STATION}
          <select value={query.stationId ?? ''} onChange={(event) => setQuery({ stationId: event.target.value })} className={select}>
            <option value="">All</option>
            {(stations.data ?? []).map((station) => (
              <option key={station.id} value={station.id}>
                {station.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {needs('discountReason') && (
        <label className={labelText}>
          {LABELS.DISCOUNT_REASON}
          <select value={query.discountReason ?? ''} onChange={(event) => setQuery({ discountReason: event.target.value })} className={select}>
            <option value="">All</option>
            {DISCOUNT_REASONS.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reason.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {needs('accountId') && (
        <label className={labelText}>
          {LABELS.ACCOUNT}
          <select
            value={query.accountId ?? ''}
            onChange={(event) =>
              setQuery(event.target.value ? { accountId: event.target.value } : { accountId: '', from: '', to: '' })
            }
            className={select}
          >
            <option value="">Every account</option>
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/**
 * Links from a failed check to the records behind it: a business date opens
 * that day's Bill List, a bill number opens that bill.
 */
function CheckRefs({ check, query }) {
  const refs = (check.refs ?? []).slice(0, 5);
  if (refs.length === 0) return null;
  const from = query.from ?? query.date ?? query.asOf;
  const to = query.to ?? query.date ?? query.asOf;
  const hrefFor = (ref) =>
    /^\d{4}-\d{2}-\d{2}$/.test(ref)
      ? `/reports/bills?from=${ref}&to=${ref}`
      : `/reports/bills?from=${from}&to=${to}&billNumber=${encodeURIComponent(ref)}`;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-2">
      {refs.map((ref) => (
        <Link key={ref} to={hrefFor(ref)} className="underline">
          {ref}
        </Link>
      ))}
    </span>
  );
}

function Pager({ meta, onPage }) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.limit));
  return (
    <nav className="flex items-center justify-end gap-2 print:hidden" aria-label="Pages">
      <span className="type-caption text-muted">
        Page <span className="font-mono">{meta.page}</span> of <span className="font-mono">{pages}</span>
      </span>
      <button type="button" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} className="h-12 rounded-lg bg-sunken px-3 type-caption disabled:opacity-40">
        Previous
      </button>
      <button type="button" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)} className="h-12 rounded-lg bg-sunken px-3 type-caption disabled:opacity-40">
        Next
      </button>
    </nav>
  );
}

function ReportError({ report, error, onRetry }) {
  if (error?.status === 403 && error?.code !== 'FEATURE_DISABLED') {
    const who = report.roles.length === 1 ? 'an owner' : 'an owner or a manager';
    return (
      <p className="rounded-[10px] bg-surface p-4 type-label border border-line">
        Your role cannot open this report. It is for {who}.
      </p>
    );
  }
  return (
    <div className="rounded-[10px] bg-surface p-4 border border-line">
      <p className="type-label text-alert">{errorMessage(error)}</p>
      <button type="button" onClick={onRetry} className="mt-3 min-h-12 rounded-lg bg-sunken px-4 type-caption">
        Try again
      </button>
    </div>
  );
}
