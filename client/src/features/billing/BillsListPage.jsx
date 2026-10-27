import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import { getBill, listBills } from '../../api/bills.js';
import { businessDateToday, formatTimeIst } from '../../utils/formatDate.js';
import { formatBasisPoints } from '../../utils/formatMoney.js';
import BillStatusBadge from './BillStatusBadge.jsx';
import { errorMessage } from './errorCopy.js';
import { paymentMethodName } from './paymentMethodsForBill.js';
import { placeLabel } from '../orders/orderLabel.js';
import Money, { moneyText } from '../../components/ui/Money.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';

const PAGE_SIZE = 50;

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'ON_ACCOUNT', label: 'On Hold' },
];

/**
 * The register ledger: the day's bills in a table, with the selected bill
 * beside it.
 *
 * OWNER, MANAGER, CASHIER, matching GET /bills on the server. The figures at
 * the top are the server's `meta.totals` over the whole business-date range,
 * not a sum of whatever page is on screen (API-CONTRACT section 14.3), so they
 * stay right however the table is filtered or paged. The unpaid count is the
 * `meta.total` of the same list asked for unpaid bills only.
 *
 * The search box narrows the rows on this page only, by bill number, table
 * and captain. It is a convenience for finding one bill, not a report.
 */
export default function BillsListPage() {
  const [from, setFrom] = useState(businessDateToday);
  const [to, setTo] = useState(businessDateToday);
  const [status, setStatus] = useState('');
  const [includeVoided, setIncludeVoided] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const query = useQuery({
    queryKey: ['bills', { from, to, status, includeVoided, page }],
    queryFn: () =>
      listBills({ from, to, status: status || undefined, includeVoided, page, limit: PAGE_SIZE }),
  });

  const unpaid = useQuery({
    queryKey: ['bills', { from, to, status: 'UNPAID', count: true }],
    queryFn: () => listBills({ from, to, status: 'UNPAID', limit: 1 }),
  });

  const bills = query.data?.data ?? [];
  const meta = query.data?.meta ?? { page: 1, limit: PAGE_SIZE, total: 0 };
  const totals = meta.totals ?? {
    grandTotalInPaise: 0,
    amountPaidInPaise: 0,
    billCount: 0,
    voidedCount: 0,
  };
  const unpaidCount = unpaid.data?.meta?.total ?? 0;

  const needle = search.trim().toLowerCase();
  const rows = needle
    ? bills.filter((bill) =>
        [bill.billNumber, placeLabel(bill), bill.captainName]
          .filter(Boolean)
          .some((text) => text.toLowerCase().includes(needle)),
      )
    : bills;

  const selected = rows.find((bill) => bill.id === selectedId) ?? rows[0] ?? null;
  const lastPage = Math.max(1, Math.ceil(meta.total / (meta.limit || PAGE_SIZE)));
  const rangeLabel = from === to ? from : `${from} – ${to}`;

  const resetPage = (setter) => (value) => {
    setter(value);
    setPage(1);
  };

  return (
    <main className="v2 text-ink min-h-full bg-ground px-4 py-6 lg:px-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6">
        <section className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <Stat label="Bill total" hint={`${rangeLabel} · voided left out`} className="col-span-2 sm:col-span-1">
            <span className="type-num-fit">
              <Money paise={totals.grandTotalInPaise} />
            </span>
          </Stat>
          <Stat label="Bills" hint="Issued and not voided">
            <span className="type-num-fit">{totals.billCount}</span>
          </Stat>
          <Stat label="Unpaid bills" hint="Waiting for payment">
            <span className="type-num-fit text-ink">
              {unpaidCount}
            </span>
            {unpaidCount > 0 && (
              <button
                type="button"
                onClick={() => resetPage(setStatus)('UNPAID')}
                className="ml-3 rounded-full bg-open-tint px-3 py-1 type-caption hover:bg-sunken"
              >
                Show them
              </button>
            )}
          </Stat>
          <Stat label="Voided" hint="Kept in the invoice register">
            <span
              className={[
                'type-num-fit',
                totals.voidedCount > 0 ? 'text-alert' : '',
              ].join(' ')}
            >
              {totals.voidedCount}
            </span>
          </Stat>
        </section>

        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <div className="flex w-full min-w-0 flex-1 flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] bg-surface p-3 border border-line">
              <div className="flex flex-wrap items-center gap-2">
                <DateField label="From" value={from} onChange={resetPage(setFrom)} />
                <DateField label="To" value={to} onChange={resetPage(setTo)} />

                <div className="flex items-center gap-1 rounded-full bg-sunken p-1" role="group" aria-label="Status">
                  {STATUS_FILTERS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={status === option.value}
                      onClick={() => resetPage(setStatus)(option.value)}
                      className={[
                        'min-h-12 rounded-lg px-4 type-caption transition-colors',
                        '',
                        status === option.value ? 'bg-sunken text-ink ring-2 ring-inset ring-ink' : 'text-muted hover:text-ink',
                      ].join(' ')}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <label className="flex min-h-12 items-center gap-2 rounded-lg bg-sunken px-3">
                  <input
                    type="checkbox"
                    checked={includeVoided}
                    onChange={(event) => resetPage(setIncludeVoided)(event.target.checked)}
                    className="size-4 accent-[var(--color-ink)]"
                  />
                  <span className="type-caption">Include voided</span>
                </label>
              </div>

              <label className="relative block w-full sm:w-64">
                <span className="sr-only">Search this page</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search bill, table, captain"
                  className="min-h-12 w-full rounded-lg border border-muted bg-surface px-4 type-caption placeholder:text-muted"
                />
              </label>
            </div>

            <div className="overflow-hidden rounded-[10px] bg-surface border border-line">
              {query.isPending && (
                <div className="p-6">
                  <Spinner label="Loading bills" />
                </div>
              )}
              {query.isError && (
                <div className="p-6">
                  <ErrorMessage error={{ message: errorMessage(query.error) }} />
                </div>
              )}

              {query.isSuccess && rows.length === 0 && (
                <EmptyState
                  className="m-4"
                  title={needle ? `No bill on this page matches “${search.trim()}”` : 'No bills in this range'}
                  description={needle ? 'Check the number, or clear the search.' : 'Choose other dates above, or bill a table from the floor.'}
                />
              )}

              {rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="bg-sunken/70 type-num-metar text-muted">
                        <th className="px-3 py-3 font-semibold sm:px-4">Invoice number</th>
                        <th className="hidden px-2 py-3 font-semibold sm:table-cell">Time issued</th>
                        <th className="hidden px-4 py-3 font-semibold sm:table-cell">Table</th>
                        <th className="hidden px-4 py-3 font-semibold xl:table-cell">Captain</th>
                        <th className="hidden px-4 py-3 font-semibold xl:table-cell">Paid with</th>
                        <th className="px-2 py-3 font-semibold">Status</th>
                        <th className="whitespace-nowrap px-3 py-3 text-right font-semibold sm:px-4">Bill total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {rows.map((bill) => {
                        const isSelected = selected?.id === bill.id;
                        const struck = bill.isVoided ? 'line-through text-muted' : '';
                        return (
                          <tr
                            key={bill.id}
                            onClick={() => setSelectedId(bill.id)}
                            className={[
                              'cursor-pointer transition-colors',
                              isSelected ? 'bg-open-tint' : 'hover:bg-sunken',
                              bill.isVoided ? 'opacity-70' : '',
                            ].join(' ')}
                          >
                            <td className="px-3 py-3 sm:px-4">
                              <button
                                type="button"
                                onClick={() => setSelectedId(bill.id)}
                                aria-pressed={isSelected}
                                className={[
                                  'flex min-h-12 items-center gap-2 whitespace-nowrap type-num-meta',
                                  struck,
                                ].join(' ')}
                              >
                                {isSelected && <span aria-hidden className="h-6 w-1 rounded-full bg-ink" />}
                                {bill.billNumber}
                              </button>
                              {/* On a phone the table and the time sit under the number, so Status and Bill total stay on screen. */}
                              <p className={`max-w-[11rem] truncate type-caption text-muted sm:hidden ${struck}`}>
                                {placeLabel(bill)}
                                {bill.billedAt ? ` · ${formatTimeIst(bill.billedAt)}` : ''}
                              </p>
                            </td>
                            <td className={`hidden whitespace-nowrap px-2 py-3 type-num-meta text-muted sm:table-cell ${struck}`}>
                              {bill.billedAt ? formatTimeIst(bill.billedAt) : ''}
                            </td>
                            <td className="hidden px-4 py-3 sm:table-cell">
                              <span className={`inline-flex max-w-[12rem] rounded-full bg-sunken px-3 py-1 type-caption break-all ${struck}`}>
                                {placeLabel(bill)}
                              </span>
                            </td>
                            <td className={`hidden px-4 py-3 type-caption xl:table-cell ${struck}`}>
                              {bill.captainName ?? '—'}
                            </td>
                            <td className={`hidden px-4 py-3 type-caption text-muted xl:table-cell ${struck}`}>
                              {(bill.payments ?? []).map(paymentMethodName).join(', ') || '—'}
                            </td>
                            <td className="px-2 py-3">
                              <BillStatusBadge bill={bill} />
                            </td>
                            <td className={`whitespace-nowrap px-3 py-3 text-right type-num sm:px-4 ${struck}`}>
                              <Money paise={bill.grandTotalInPaise} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 bg-sunken/90 px-4 py-3">
                <p className="type-num-meta">
                  <span className="font-bold">
                    {totals.billCount} bills · <Money paise={totals.grandTotalInPaise} />
                  </span>
                  <span className="mx-2 text-muted">·</span>
                  <span className="text-muted">Money received <Money paise={totals.amountPaidInPaise} /></span>
                </p>
                <div className="flex items-center gap-2">
                  <span className="type-caption text-muted">
                    Page <span className="font-mono">{page}</span> of <span className="font-mono">{lastPage}</span>
                  </span>
                  <PageButton label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    ‹
                  </PageButton>
                  <PageButton label="Next page" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
                    ›
                  </PageButton>
                </div>
              </div>
            </div>
          </div>

          {selected && <BillPreview billId={selected.id} />}
        </div>
      </div>
    </main>
  );
}

/** The selected bill, read in full, beside the ledger. Hidden below the lg breakpoint, where a tap opens the bill. */
function BillPreview({ billId }) {
  const bill = useQuery({ queryKey: ['bill', billId], queryFn: () => getBill(billId) });

  return (
    <aside className="sticky top-4 hidden w-[420px] flex-none flex-col overflow-hidden rounded-[10px] bg-surface shadow-float lg:flex">
      {bill.isPending && (
        <div className="p-6">
          <Spinner label="Loading the bill" />
        </div>
      )}
      {bill.isError && <p className="p-6 type-caption text-alert">{errorMessage(bill.error)}</p>}
      {bill.data && <PreviewBody bill={bill.data} />}
    </aside>
  );
}

function PreviewBody({ bill }) {
  const outstanding = bill.grandTotalInPaise - bill.amountPaidInPaise;
  const isUnpaid = !bill.isVoided && bill.status === 'UNPAID';

  return (
    <>
      <header className="flex items-start justify-between gap-2 bg-sunken p-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="type-body font-semibold">Bill details</h2>
            <BillStatusBadge bill={bill} />
          </div>
          <p className="mt-1 type-num-meta text-muted">
            <span className="font-bold text-ink">{bill.billNumber}</span>
            {bill.billedAt && ` · ${formatTimeIst(bill.billedAt)}`} · {placeLabel(bill)}
          </p>
        </div>
      </header>

      {isUnpaid && (
        <p className="bg-open-tint px-4 py-3 type-caption">
          Waiting for payment · <span className="font-mono"><Money paise={outstanding} /></span> outstanding
        </p>
      )}

      <ul className="flex max-h-[310px] flex-col gap-2 overflow-y-auto p-4">
        {bill.lines.map((line) => (
          <li key={line.orderLineId} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="type-label line-clamp-2 break-words" title={line.itemName}>
                {line.itemName}
                {line.variantName ? ` (${line.variantName})` : ''}
              </p>
              <p className="type-num-meta text-muted">
                {line.quantity} × <Money paise={line.unitPriceInPaise} />
                {line.addOnNames.length > 0 && ` · + ${line.addOnNames.join(', ')}`}
              </p>
            </div>
            <span className="type-num"><Money paise={line.lineTotalInPaise} /></span>
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-2 bg-sunken p-4 type-caption">
        <PreviewRow label="Item total" value={<Money paise={bill.subtotalInPaise} />} />
        {bill.discount && (
          <PreviewRow tone="text-ok" label="Discount" value={`− ${moneyText(bill.discount.amountInPaise)}`} />
        )}
        {bill.taxBreakdown.map((slab) => (
          <PreviewRow
            key={slab.taxRateBps}
            label={`GST @ ${formatBasisPoints(slab.taxRateBps)}`}
            value={<Money paise={slab.cgstInPaise + slab.sgstInPaise} />}
          />
        ))}
        {bill.roundOffInPaise !== 0 && <PreviewRow label="Round-off" value={<Money paise={bill.roundOffInPaise} />} />}
        <div className="mt-1 flex items-baseline justify-between">
          <dt className="type-body font-semibold">Bill total</dt>
          <dd className="type-num-hero"><Money paise={bill.grandTotalInPaise} /></dd>
        </div>
      </dl>

      {bill.captainName && (
        <p className="bg-sunken/60 px-4 py-3 type-caption text-muted">
          Captain: <span className="font-semibold text-ink">{bill.captainName}</span>
          {bill.guestCount != null && ` · ${bill.guestCount} covers`}
        </p>
      )}

      <div className="flex flex-col gap-2 p-4">
        <Link
          to={`/bills/${bill.id}`}
          className="flex min-h-14 items-center justify-between rounded-lg bg-accent px-6 type-button text-on-accent"
        >
          <span>{isUnpaid ? 'Take payment' : 'Open bill'}</span>
          <span className="font-mono">{isUnpaid ? `${moneyText(outstanding)} →` : '→'}</span>
        </Link>
        <Link
          to={`/bills/${bill.id}/receipt`}
          className="flex min-h-12 items-center justify-center rounded-lg type-caption hover:bg-sunken"
        >
          Receipt preview and print
        </Link>
      </div>
    </>
  );
}

function PreviewRow({ label, value, tone = 'text-muted' }) {
  return (
    <div className={`flex justify-between ${tone}`}>
      <dt>{label}</dt>
      <dd className="font-mono text-ink">{value}</dd>
    </div>
  );
}

function Stat({ label, hint, children, className = '' }) {
  return (
    <div className={`@container flex min-w-0 flex-col gap-2 rounded-[10px] bg-surface p-4 border border-line ${className}`}>
      <span className="type-caption text-muted">{label}</span>
      <div className="flex flex-wrap items-baseline gap-y-1">{children}</div>
      <span className="type-caption text-muted">{hint}</span>
    </div>
  );
}

function DateField({ label, value, onChange }) {
  return (
    <label className="flex min-h-12 items-center gap-2 rounded-lg bg-sunken px-4">
      <span className="type-caption text-muted">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-transparent type-num-meta"
      />
    </label>
  );
}

function PageButton({ label, disabled, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-12 items-center justify-center rounded-lg bg-sunken type-heading hover:bg-sunken disabled:opacity-40"
    >
      {children}
    </button>
  );
}
