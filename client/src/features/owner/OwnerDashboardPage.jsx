import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { getCaSends } from '../../api/caReports.js';
import { getReport } from '../../api/reportsV2.js';
import { monthWords, sendWords } from '../settings/CaSendHistory.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Money, { moneyText } from '../../components/ui/Money.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { businessDateToday, formatTimeIst } from '../../utils/formatDate.js';
import { wholePercents } from '../../utils/wholePercents.js';
import { drillHref } from '../reports/catalog.js';
import OwnerNetworkCard from '../network/OwnerNetworkCard.jsx';
import ConnectionStatus, { LostConnectionBanner } from '../network/ConnectionStatus.jsx';
import { hourLabel, shortBusinessDate } from '../reports/formatReport.js';

/**
 * P55. The owner's dashboard: the day's important figures on one phone-sized
 * screen, outside the ERP's frame. "Open the ERP" goes to everything else.
 *
 * Its look is Rishi's design, in its own tokens under `[data-owner]`
 * (index.css), the way the public page has `[data-public]`. Every figure
 * comes from a report the owner can already open, so it adds nothing up and
 * can never disagree with them: R1 Today for the time and the unpaid count, R2
 * Day Close for the sales, order types, money, controls and checks, R4 for the
 * hours. The percents are captions only, worked out so they add up to 100.
 */
const REFRESH_MS = 60_000;
const ROW_COLOURS = ['bg-dash-1', 'bg-dash-2', 'bg-dash-3', 'bg-dash-4', 'bg-dash-5'];

function Card({ title, aside = null, children }) {
  return (
    <section className="rounded-xl border border-dash-line bg-dash-card p-4">
      {title && (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A number that fits its card: full size when there is room, smaller for a
 * lakh-sized amount, never cut off. Mono digits are about 0.6em wide.
 */
const fitSize = (text) => ({ fontSize: `min(1.25rem, ${(100 / (Math.max(String(text).length, 1) * 0.62)).toFixed(1)}cqi)` });

function SmallCard({ label, value, valueText, note, warn = false }) {
  return (
    <div className="@container flex min-w-0 flex-col justify-between rounded-xl border border-dash-line bg-dash-card p-3">
      <span className={`text-[11px] font-semibold uppercase tracking-wide ${warn ? 'text-dash-warn' : 'text-dash-muted'}`}>{label}</span>
      <span className={`my-1 whitespace-nowrap font-mono font-semibold leading-tight ${warn ? 'text-dash-warn' : ''}`} style={fitSize(valueText ?? value)}>
        {value}
      </span>
      <span className={`text-[11px] leading-tight ${warn ? 'text-dash-warn' : 'text-dash-muted'}`}>{note}</span>
    </div>
  );
}

/** A named amount that opens its bills when there are any. */
function Named({ href, children, className = '' }) {
  return href ? (
    <Link to={href} className={`underline-offset-2 hover:underline ${className}`}>
      {children}
    </Link>
  ) : (
    <span className={className}>{children}</span>
  );
}

const lineOf = (section, line) => section?.rows.find((row) => row.line === line);
const sectionOf = (envelope, key) => envelope?.sections?.find((entry) => entry.key === key);
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export default function OwnerDashboardPage() {
  const { name: restaurantName } = useTheme();
  const date = businessDateToday();
  const read = (name, params) => ({
    queryKey: ['owner-dashboard', name, date],
    queryFn: () => getReport(name, params).then((result) => result.data),
    refetchInterval: REFRESH_MS,
  });
  const today = useQuery(read('today', {}));
  const day = useQuery(read('day-close', { date }));
  const hours = useQuery(read('hours', { from: date, to: date }));

  const failed = [today, day, hours].find((query) => query.isError);
  const ready = today.data && day.data && hours.data;

  return (
    <div data-owner className="min-h-dvh bg-dash-page text-dash-ink">
      <LostConnectionBanner />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 pb-8 pt-4">
        <header className="flex flex-col pt-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="size-2 shrink-0 rounded-full bg-dash-ok" aria-hidden="true" />
              <span className="truncate text-[11px] font-semibold uppercase leading-none tracking-widest text-dash-muted">{restaurantName}</span>
            </div>
            <span className="flex items-center gap-2">
              {/* P62. This device's connection to the cafe server, as in the ERP's top bar. */}
              <ConnectionStatus />
              <span className="rounded-full border border-dash-line bg-dash-card px-3 py-1 text-xs font-medium">{shortBusinessDate(date)}</span>
            </span>
          </div>
          <div className="pt-3">
            <h1 className="text-2xl font-bold leading-tight tracking-tight">Today</h1>
            {ready && (
              <p className="mt-1 text-xs text-dash-muted">
                {(day.data.openDays ?? []).includes(date)
                  ? `Day open · figures to ${formatTimeIst(today.data.extra?.asAt ?? new Date())}`
                  : 'Day closed'}
              </p>
            )}
          </div>
        </header>

        {failed && <ErrorMessage error={failed.error} />}
        {!failed && !ready && <p className="py-12 text-center text-sm text-dash-muted">Reading today&apos;s figures…</p>}
        {ready && <Figures date={date} today={today.data} day={day.data} hours={hours.data} />}

        {/* P65. Last month's CA pack, when it did not go. */}
        <CaPackNotice />

        {/* P62. The WiFi the system runs on, the devices connected, the cloud copy. */}
        <OwnerNetworkCard />

        <Link to="/dashboard" className="mt-1 flex min-h-12 items-center justify-center rounded-xl border border-dash-line bg-dash-card text-sm font-medium hover:bg-dash-track">
          Open the ERP
        </Link>
      </main>
    </div>
  );
}

function Figures({ date, today, day, hours }) {
  const sales = sectionOf(day, 'sales');
  const bills = lineOf(sales, 'Bills')?.count ?? 0;
  const covers = lineOf(sales, 'Covers')?.count ?? 0;

  // R1's unpaid row, known by where it links rather than by its words.
  const unpaid = sectionOf(today, 'money')?.rows.find((row) => row.drill?.amountInPaise?.query?.status === 'UNPAID');
  const unpaidPaise = unpaid?.amountInPaise ?? 0;

  const orderTypes = (sectionOf(day, 'orderTypes')?.rows ?? []).filter((row) => row.amountInPaise > 0);
  const orderPercents = wholePercents(orderTypes.map((row) => row.amountInPaise));

  // R2's money rows: each money-in-hand method, the platforms as one "Platform money" row,
  // On Hold by account, and Unpaid. The total closes the list.
  const moneySection = sectionOf(day, 'money');
  const moneyAll = moneySection?.rows ?? [];
  const inHandEnd = moneyAll.findIndex((row) => row.line === 'Money in hand');
  const platformEnd = moneyAll.findIndex((row) => row.line === 'Platform money');
  const moneyTotal = lineOf(moneySection, 'Total');
  const inHand = moneyAll.slice(0, Math.max(0, inHandEnd)).map((row, index) => ({ ...row, colour: ROW_COLOURS[Math.min(index, 2)] }));
  const platform = platformEnd >= 0 ? [{ ...moneyAll[platformEnd], colour: 'bg-dash-4' }] : [];
  const afterPlatform = moneyAll.slice(platformEnd + 1).filter((row) => row.line !== 'Total');
  const onHold = afterPlatform.filter((row) => row.line.startsWith('On Hold')).map((row) => ({ ...row, colour: 'bg-dash-5' }));
  const unpaidRow = afterPlatform.filter((row) => row.line === 'Unpaid').map((row) => ({ ...row, colour: 'bg-dash-warn', isUnpaid: true }));
  const moneyRows = [...inHand, ...platform, ...onHold, ...unpaidRow].filter((row) => row.amountInPaise > 0);
  const moneyPercents = wholePercents(moneyRows.map((row) => row.amountInPaise));

  // Every hour from the first bill to the last, quiet hours as zeros.
  const allHours = sectionOf(hours, 'byHour')?.rows ?? [];
  const first = allHours.findIndex((row) => row.billCount > 0);
  const last = allHours.findLastIndex((row) => row.billCount > 0);
  const byHour = first === -1 ? [] : allHours.slice(first, last + 1);
  const peak = Math.max(0, ...byHour.map((row) => row.netSalesInPaise));
  const busiest = byHour.find((row) => row.netSalesInPaise === peak && peak > 0);

  const controls = sectionOf(day, 'controls');
  const watch = [
    { label: 'Discounts', row: lineOf(controls, 'Discounts'), unit: ['bill', 'bills'] },
    { label: 'Voided bills', row: lineOf(controls, 'Voided bills'), unit: ['bill', 'bills'] },
    { label: 'No Charge', row: lineOf(controls, 'No Charge'), unit: ['order', 'orders'] },
    // P56. Whole cancellations only, in place of single dishes.
    { label: 'Orders cancelled', row: lineOf(controls, 'Orders cancelled'), unit: ['order', 'orders'] },
  ].filter((entry) => entry.row);

  const checks = day.checks ?? [];
  const failedChecks = checks.filter((check) => !check.passed);
  const errors = failedChecks.filter((check) => check.severity === 'ERROR');

  return (
    <>
      <section className="rounded-xl border border-dash-line bg-dash-card p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-dash-muted">Bill total</div>
        <div className="my-2 font-mono text-3xl font-semibold leading-none">
          <Money paise={lineOf(sales, 'Bill total')?.amountInPaise} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-dash-muted">
          <span>
            Net sales <Money paise={lineOf(sales, 'Net sales')?.amountInPaise} className="font-semibold text-dash-ink" />
          </span>
          <span className="text-dash-4" aria-hidden="true">/</span>
          <span>
            GST <Money paise={lineOf(sales, 'GST')?.amountInPaise} className="font-semibold text-dash-ink" />
          </span>
        </div>
      </section>

      <section aria-label="Bills, covers and unpaid" className="grid grid-cols-3 gap-3">
        <SmallCard label="Bills" value={bills} note={<>(average <Money paise={lineOf(sales, 'Average bill')?.amountInPaise} className="font-semibold" />)</>} />
        <SmallCard label="Covers" value={covers} note={<>(<Money paise={lineOf(sales, 'Average per cover')?.amountInPaise} className="font-semibold" /> each)</>} />
        <SmallCard
          label="Unpaid"
          value={<Money paise={unpaidPaise} />}
          valueText={moneyText(unpaidPaise)}
          note={`(${plural(unpaid?.count ?? 0, 'bill', 'bills')})`}
          warn={unpaidPaise > 0}
        />
      </section>

      <Card title="Where the sales came from">
        {orderTypes.length === 0 ? (
          <p className="text-xs text-dash-muted">No bills yet today.</p>
        ) : (
          <ul className="flex flex-col">
            {orderTypes.map((row, index) => (
              <li key={row.line} className="flex flex-col border-t border-dash-line py-3 first:border-t-0 first:pt-0 last:pb-0">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <Named href={drillHref(row.drill?.count)} className="font-medium">
                    {row.line.replace(', ', ' · ')}
                  </Named>
                  <Money paise={row.amountInPaise} className="font-semibold" />
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-dash-track" aria-hidden="true">
                  <div className={`h-full rounded-full ${ROW_COLOURS[Math.min(index, 2)]}`} style={{ width: `${orderPercents[index]}%` }} />
                </div>
                <span className="mt-2 text-[11px] leading-none text-dash-muted">
                  {orderPercents[index]}% of total · {plural(row.count, 'bill', 'bills')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Where the money went">
        {moneyRows.length === 0 ? (
          <p className="text-xs text-dash-muted">No money yet today.</p>
        ) : (
          <>
            <div className="mb-4 flex h-2 w-full overflow-hidden rounded-full bg-dash-5" aria-hidden="true">
              {moneyRows.map((row, index) => (
                <div key={row.line} className={`h-full ${row.colour}`} style={{ width: `${moneyPercents[index]}%` }} />
              ))}
            </div>
            <ul className="flex flex-col text-xs">
              {moneyRows.map((row) => (
                <li key={row.line} className="flex items-center justify-between gap-3 border-t border-dash-line py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`size-2.5 shrink-0 rounded-sm ${row.colour}`} aria-hidden="true" />
                    <Named href={drillHref(row.drill?.amountInPaise)} className={`truncate font-medium ${row.isUnpaid ? 'text-dash-warn' : ''}`}>
                      {row.line}
                    </Named>
                  </span>
                  <Money paise={row.amountInPaise} className={`font-semibold ${row.isUnpaid ? 'text-dash-warn' : ''}`} />
                </li>
              ))}
              {moneyTotal && (
                <li className="flex items-center justify-between border-t border-dash-line pt-2 font-semibold">
                  <span>Total</span>
                  <Money paise={moneyTotal.amountInPaise} />
                </li>
              )}
            </ul>
          </>
        )}
      </Card>

      <Card title="By hour" aside={busiest && <span className="text-xs text-dash-muted">Busiest {hourLabel(busiest.hour)}</span>}>
        {byHour.length === 0 ? (
          <p className="text-xs text-dash-muted">No bills yet today.</p>
        ) : (
          <>
            <div className="flex h-28 items-end justify-between border-b border-dash-line pb-1 pt-2" role="img" aria-label="Net sales per hour">
              {byHour.map((row) => {
                const share = peak > 0 ? row.netSalesInPaise / peak : 0;
                const colour = share === 1 ? 'bg-dash-1' : share >= 0.4 ? 'bg-dash-2' : 'bg-dash-5';
                return (
                  <div key={row.hour} className="flex h-full flex-1 flex-col items-center justify-end px-0.5">
                    <div className={`w-full rounded-t-sm ${colour}`} style={{ height: `${Math.round(share * 100)}%` }} title={`${hourLabel(row.hour)}: ${row.billCount} bills`} />
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between pt-2">
              {byHour.map((row) => (
                <span key={row.hour} className={`flex-1 text-center font-mono text-[10px] font-semibold ${row === busiest ? 'text-dash-ink' : 'text-dash-muted'}`}>
                  {hourLabel(row.hour).replace(/(am|pm)$/, '')}
                </span>
              ))}
            </div>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-dash-muted">Show as a table</summary>
              <table className="mt-2 w-full">
                <thead>
                  <tr className="text-dash-muted">
                    <th className="text-left font-normal">Hour</th>
                    <th className="text-right font-normal">Bills</th>
                    <th className="text-right font-normal">Net sales</th>
                  </tr>
                </thead>
                <tbody>
                  {byHour.map((row) => (
                    <tr key={row.hour} className="border-t border-dash-line">
                      <td className="py-1">{hourLabel(row.hour)}</td>
                      <td className="py-1 text-right font-mono">{row.billCount}</td>
                      <td className="py-1 text-right">
                        <Money paise={row.netSalesInPaise} tabular />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </Card>

      <Card title="Watch list">
        <ul className="flex flex-col text-xs">
          {watch.map(({ label, row, alert, unit }) => (
            <li key={label} className="flex items-center justify-between gap-3 border-t border-dash-line py-3 first:border-t-0 first:pt-0">
              <span className="flex items-center gap-2">
                <Named href={drillHref(row.drill?.count ?? row.drill?.amountInPaise)} className="font-medium">
                  {label}
                </Named>
                {unit && <span className="text-dash-muted">({plural(row.count ?? 0, ...unit)})</span>}
              </span>
              <Money paise={row.amountInPaise} className={`font-semibold ${alert && row.amountInPaise > 0 ? 'text-dash-alert' : ''}`} />
            </li>
          ))}
        </ul>
      </Card>

      {checks.length > 0 &&
        (failedChecks.length === 0 ? (
          <section aria-label="Checks" className="flex items-center gap-3 rounded-xl border border-dash-ok-line bg-dash-ok-tint px-4 py-3">
            <TickCircle />
            <span className="text-xs font-semibold text-dash-ok">All {checks.length} balance checks passed</span>
          </section>
        ) : (
          <Link
            to={`/reports/day-close?from=${date}&to=${date}`}
            aria-label="Checks"
            className={`flex items-center gap-3 rounded-xl border bg-dash-card px-4 py-3 text-xs font-semibold ${errors.length ? 'border-dash-alert text-dash-alert' : 'border-dash-warn text-dash-warn'}`}
          >
            <span aria-hidden="true">▲</span>
            {errors.length ? `${plural(errors.length, 'check does', 'checks do')} not balance. Open the day's report.` : `Balanced, with ${plural(failedChecks.length, 'note', 'notes')}. Open the day's report.`}
          </Link>
        ))}

      <Link to="/day-end" className="mt-1 flex min-h-12 w-full items-center justify-center rounded-xl bg-dash-1 text-sm font-medium text-dash-card hover:bg-dash-1-hover">
        Day Close
      </Link>
    </>
  );
}

function TickCircle() {
  return (
    <svg aria-hidden="true" className="size-4 shrink-0 text-dash-ok" fill="none" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="7.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.8 8.2L7 10.4L11.2 5.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * P65. The most recent month's CA pack, shown only when it was not sent: a day
 * still open, a check failing, or the email service refusing it. Nothing when
 * the send is off or the month went.
 */
function CaPackNotice() {
  const sends = useQuery({ queryKey: ['ca-sends'], queryFn: getCaSends, refetchInterval: REFRESH_MS * 5 });
  const latest = sends.data?.ca?.enabled ? sends.data.sends[0] : null;
  if (!latest || !['REFUSED', 'FAILED'].includes(latest.status)) return null;
  return (
    <Link to="/settings/ca-reports" className="flex flex-col gap-1 rounded-xl border border-dash-line bg-dash-card px-4 py-3 hover:bg-dash-track">
      <span className="text-sm font-semibold">The CA pack for {monthWords(latest.period)} was not sent</span>
      <span className="text-xs text-dash-muted">{sendWords(latest)}</span>
    </Link>
  );
}
