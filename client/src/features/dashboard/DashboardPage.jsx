import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { getCurrentUser } from '../../api/authApi.js';
import { listTables } from '../../api/orders.js';
import { getDashboard } from '../../api/reports.js';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { formatDateIst, formatTimeIst } from '../../utils/formatDate.js';

import UnclosedDayWarning from '../settlement/UnclosedDayWarning.jsx';
import Money, { moneyText } from '../../components/ui/Money.jsx';

import Spinner from '../../components/ui/Spinner.jsx';
import { useLiveInterval } from '../../api/live.js';

/**
 * Home. Every figure here is read from the server, none is drawn for show: the
 * day's totals from the M6 dashboard read (back-office roles only), the seated
 * tables from the floor read (roles that take orders). A role that cannot read
 * a block simply does not see it.
 */
function greetingFor(now) {
  const hour = Number(formatTimeIst(now).split(':')[0]);
  const isPm = /pm/i.test(formatTimeIst(now));
  const h24 = (hour % 12) + (isPm ? 12 : 0);
  if (h24 < 12) return 'Good morning';
  if (h24 < 17) return 'Good afternoon';
  return 'Good evening';
}

function Card({ className = '', children }) {
  return <div className={`rounded-[10px] bg-surface border border-line ${className}`}>{children}</div>;
}

function Stat({ label, value, hint }) {
  return (
    <Card className="@container flex min-w-0 flex-col justify-between p-4">
      <span className="type-label text-muted">{label}</span>
      <div className="mt-4">
        <span className="type-num-fit block">{value}</span>
        {hint && <p className="mt-1 type-caption text-muted">{hint}</p>}
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  // P22. The restaurant's wordmark, or the product's name; never a client's name written in.
  const { name: brandName } = useTheme();
  const role = user?.role;
  const isManager = role === 'OWNER' || role === 'MANAGER';
  const canTakeOrders = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'].includes(role);
  const canBill = ['OWNER', 'MANAGER', 'CASHIER'].includes(role);

  const profile = useQuery({ queryKey: ['me'], queryFn: getCurrentUser });
  const today = useQuery({
    queryKey: ['reports', 'dashboard'],
    queryFn: getDashboard,
    enabled: isManager,
    refetchInterval: 60_000,
  });
  const tablesInterval = useLiveInterval(15_000);
  const tables = useQuery({
    queryKey: ['tables', { includeInactive: false }],
    queryFn: () => listTables(),
    enabled: canTakeOrders,
    refetchInterval: tablesInterval,
  });

  const now = new Date();
  const firstName = profile.data?.user?.name?.split(' ')[0];
  const seated = (tables.data ?? []).filter((table) => table.occupancy.isOccupied);
  const data = today.data;

  const actions = [
    { to: '/floor', title: 'New dine-in order', note: 'Pick a table', show: canTakeOrders, primary: true },
    { to: '/orders/takeaway', title: 'Takeaway', note: 'Counter order', show: canTakeOrders },
    { to: '/orders/delivery', title: 'Delivery order', note: 'Zomato or Swiggy', show: canTakeOrders },
    { to: '/day-close', title: 'Day Close', note: 'Count the cash and lock the day', show: isManager },
    { to: '/bills', title: 'Bills', note: 'Collect payment', show: canBill && !isManager },
    { to: '/menu/availability', title: 'Availability', note: 'Mark a dish out', show: !canTakeOrders },
  ].filter((action) => action.show);

  return (
    <main className="min-h-full bg-ground">
      {/* P10. Yesterday traded and was not closed. */}
      {isManager && <UnclosedDayWarning />}

      <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 lg:p-8">
        {profile.isError && <ErrorMessage error={profile.error} />}

        <Card className="p-6 lg:p-8">
          <span className="inline-flex items-center gap-2 rounded-lg bg-sunken px-3 py-1 type-caption text-muted">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden="true" />
            {profile.data?.restaurant?.name ?? brandName}
            {profile.data?.branch ? ` · ${profile.data.branch.name}` : ''}
          </span>
          <h1 className="mt-3 type-title ">
            {greetingFor(now)}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {formatDateIst(now)} · signed in as {role?.toLowerCase()}
          </p>
          {actions.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-3">
              {actions.slice(0, 2).map((action, index) => (
                <Link
                  key={action.to}
                  to={action.to}
                  className={[
                    'type-button flex min-h-14 items-center rounded-lg px-6',
                    index === 0 ? 'bg-accent text-on-accent hover:brightness-110' : 'border border-ink bg-surface hover:bg-sunken',
                  ].join(' ')}
                >
                  {action.title}
                </Link>
              ))}
            </div>
          )}
        </Card>

        {isManager && (
          <section aria-label="Today" className={['grid gap-4 sm:grid-cols-2 lg:grid-cols-4', today.isFetching ? 'opacity-70' : ''].join(' ')}>
            {today.isError && <ErrorMessage error={today.error} />}
            {data && (
              <>
                <Stat label="Bill total today" value={<Money paise={data.sales.grossSalesInPaise} />} hint={`Business day ${data.businessDate}`} />
                <Stat label="Bills" value={data.sales.billCount} hint={`Average bill ${moneyText(data.sales.averageBillInPaise)}`} />
                <Stat
                  label="Open orders"
                  value={data.openOrders.count}
                  hint={`${moneyText(data.openOrders.runningValueInPaise)} on the floor`}
                />
                <Stat
                  label="Unpaid bills"
                  value={data.unpaidBills.count}
                  hint={data.unpaidBills.count > 0 ? `${moneyText(data.unpaidBills.amountInPaise)} outstanding` : 'Everything settled'}
                />
              </>
            )}
          </section>
        )}

        <section className="grid gap-6 lg:grid-cols-12">
          <div className="flex flex-col gap-3 lg:col-span-5">
            <h2 className="px-1 type-heading">Quick actions</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {actions.map((action) => (
                <Link
                  key={action.to}
                  to={action.to}
                  className={[
                    'flex min-h-24 flex-col justify-between rounded-[10px] border border-line bg-surface p-4 hover:bg-sunken',
                  ].join(' ')}
                >
                  <span className="type-heading">{action.title}</span>
                  <span className="type-caption text-muted">{action.note}</span>
                </Link>
              ))}
              <Link to="/kitchen" className="flex min-h-24 flex-col justify-between rounded-[10px] border border-line bg-surface p-4 hover:bg-sunken">
                <span className="type-heading">Kitchen</span>
                <span className="type-caption text-muted">Tickets at the pass</span>
              </Link>
              {isManager && (
                <Link to="/reports" className="flex min-h-24 flex-col justify-between rounded-[10px] border border-line bg-surface p-4 hover:bg-sunken">
                  <span className="type-heading">Reports</span>
                  <span className="type-caption text-muted">Sales, GST and payments</span>
                </Link>
              )}
            </div>
          </div>

          {canTakeOrders && (
            <div className="flex flex-col gap-3 lg:col-span-7">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-2">
                  <h2 className="type-heading">Tables seated</h2>
                  <span className="rounded-full bg-sunken px-2 py-1 type-num-meta text-muted">
                    {seated.length} of {tables.data?.length ?? 0}
                  </span>
                </div>
                <Link to="/floor" className="type-label inline-flex min-h-12 items-center font-semibold hover:underline">
                  Open the floor →
                </Link>
              </div>
              {tables.isPending && <Spinner label="Loading the floor" size="sm" />}
              {tables.isError && <ErrorMessage error={tables.error} />}
              {tables.data && seated.length === 0 && (
                <Card className="p-6 text-center text-sm text-muted">No table has an open order.</Card>
              )}
              <ul className="flex flex-col gap-2">
                {seated.map((table) => (
                  <li key={table.id}>
                    <Link
                      to={`/orders/${table.occupancy.orderId}`}
                      className="flex items-center justify-between gap-3 rounded-[10px] bg-surface p-4 border border-line transition hover:bg-sunken"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex min-h-12 min-w-12 items-center justify-center whitespace-nowrap rounded-lg bg-sunken px-3 font-mono text-base font-semibold">
                          {table.name}
                        </div>
                        <div className="leading-tight">
                          <p className="font-mono text-sm text-muted">Order #{table.occupancy.orderNumber}</p>
                          {table.occupancy.openedAt && (
                            <p className="type-caption text-muted">Opened {formatTimeIst(table.occupancy.openedAt)}</p>
                          )}
                        </div>
                      </div>
                      <span className="font-mono text-base font-bold">
                        <Money paise={table.occupancy.runningTotalInPaise ?? 0} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {isManager && data && (
          <section className="flex flex-col gap-3 pb-6">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="type-heading">Top sellers today</h2>
              <Link to="/reports/sales-by-day" className="type-label inline-flex min-h-12 items-center font-semibold hover:underline">
                Sales report →
              </Link>
            </div>
            {data.topItems.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted">Nothing sold yet today.</Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {data.topItems.slice(0, 4).map((item, index) => (
                  <Card key={item.itemName} className="flex flex-col justify-between p-4">
                    <span className="type-num-meta text-muted">#{index + 1}</span>
                    <h3 className="mt-2 text-base font-semibold leading-6">{item.itemName}</h3>
                    <div className="mt-4 flex items-center justify-between">
                      <span className="font-mono text-base font-bold"><Money paise={item.revenueInPaise} /></span>
                      <span className="rounded-full bg-sunken px-3 py-1 type-num-meta text-muted">
                        {item.quantity} sold
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
