import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { closeDay } from '../../api/dayClose.js';
import { TriangleIcon } from '../../components/ui/icons/index.jsx';
import Input from '../../components/ui/Input.jsx';
import Money from '../../components/ui/Money.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { paiseToInput } from '../../utils/formatMoney.js';
import { formatBusinessDate } from '../../utils/formatDate.js';
import { errorMessage } from '../billing/errorCopy.js';
import { toCashCount } from '../cash/cashCount.js';
import AmountOrCount, { amountOf, emptyAmount } from './cashbook/AmountOrCount.jsx';

const DESTINATIONS = [
  ['BANK_DEPOSIT', 'Bank deposit'],
  ['OWNER', 'Given to the owner'],
  ['OTHER', 'Other'],
];

/**
 * P61. Closing the day on one screen, for the owner, the manager and the
 * cashier: what stops the close, each with Open; the cash in the drawer; Close
 * the day. Orders nothing was sent from are listed as closing themselves.
 *
 * Keeping some cash for tomorrow and taking the rest out are optional; left
 * alone, the whole count stays in the drawer as tomorrow's float. A note is
 * asked only when the server says the count needs one, and the server never
 * tells a blind manager or a cashier by how much it differs.
 */
export default function SimpleClose({ day, businessDate }) {
  const queryClient = useQueryClient();
  const { features } = useAuth();
  const denominations = features?.cash?.denominations ?? [];
  const usualFloatInPaise = features?.cash?.usualFloatInPaise ?? 200000;

  const [count, setCount] = useState(emptyAmount(false));
  const [takingOut, setTakingOut] = useState(false);
  const [kept, setKept] = useState({ byNotes: false, typed: '', counts: {}, touched: false });
  const [takenOutTo, setTakenOutTo] = useState('BANK_DEPOSIT');
  const [note, setNote] = useState('');
  const [noteRequired, setNoteRequired] = useState(false);

  const counted = amountOf(count, denominations);
  // Without "Taking cash out", the whole count stays. With it, the usual float until the person types their own.
  const proposed = counted === null ? null : Math.min(usualFloatInPaise, counted);
  const keptInPaise = !takingOut ? counted : kept.touched ? amountOf(kept, denominations) : proposed;
  const takenOut = counted !== null && keptInPaise !== null ? counted - keptInPaise : null;
  const tooMuch = takenOut !== null && takenOut < 0;

  const close = useMutation({
    mutationFn: () =>
      closeDay({
        businessDate,
        ...(count.byNotes ? { cashCount: toCashCount(count.counts, denominations) } : { countedCashInPaise: counted }),
        note: note.trim(),
        ...(takingOut && kept.touched && kept.byNotes
          ? { keptForTomorrowCount: toCashCount(kept.counts, denominations) }
          : { keptForTomorrowInPaise: keptInPaise }),
        ...(takenOut > 0 ? { takenOutTo } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['day-close'] });
      queryClient.invalidateQueries({ queryKey: ['day-end-message'] });
    },
    onError: (error) => {
      if (error?.details?.noteRequired || error?.noteRequired) setNoteRequired(true);
      // The day changed under the screen: read it again so the list is current.
      if (error?.code === 'DAY_NOT_READY') queryClient.invalidateQueries({ queryKey: ['day-close', businessDate] });
    },
  });

  const blockers = day.blockers ?? [];
  const closesOnClose = day.closesOnClose ?? [];
  const { sales, money } = day.figures;
  const canClose = blockers.length === 0 && counted !== null && counted >= 0 && keptInPaise !== null && !tooMuch && !(noteRequired && !note.trim());
  // Why Close is not pressable, said under it.
  const whyNot =
    blockers.length > 0
      ? 'Sort out the items in Before you close, then close.'
      : counted === null
        ? 'Type the cash in the drawer first. Type 0 if there is none.'
        : tooMuch
          ? null
          : noteRequired && !note.trim()
            ? 'Write the note above, saying why the cash is different, then close.'
            : null;

  return (
    <div className="flex flex-col gap-4">
      {/* The day in one line, then money by payment method. */}
      <section aria-label="Today" className="rounded-[10px] border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="type-label text-muted">Bill total</p>
            <Money paise={sales.billTotalInPaise} size="tile" />
          </div>
          <p className="type-body text-muted">
            <span className="type-num-meta text-ink">{sales.billCount}</span> {sales.billCount === 1 ? 'bill' : 'bills'}
          </p>
        </div>
        {money.methods.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-3">
            {money.methods.map((row) => (
              <li key={row.method} className="type-body">
                <span className="text-muted">{row.methodName}</span> <Money paise={row.amountInPaise} />
              </li>
            ))}
            {money.unpaidInPaise > 0 && (
              <li className="type-body text-alert">
                Unpaid <Money paise={money.unpaidInPaise} />
              </li>
            )}
          </ul>
        )}
      </section>

      {(blockers.length > 0 || closesOnClose.length > 0) && (
        <section aria-label="Before you close" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
          <h2 className="type-heading">Before you close</h2>
          {blockers.length > 0 && (
            <ul className="flex flex-col divide-y divide-line">
              {blockers.map((blocker) => {
                const to = blocker.kind === 'OPEN_ORDER' ? `/orders/${blocker.ref}` : blocker.kind === 'UNPAID_BILL' ? `/bills/${blocker.ref}` : null;
                return (
                  <li key={`${blocker.kind}-${blocker.ref}`} className="flex items-center justify-between gap-3 py-2">
                    <span className="type-body flex items-center gap-2 text-alert">
                      <TriangleIcon />
                      {blocker.message}
                    </span>
                    <span className="flex flex-none gap-2">
                      {to && (
                        <Link to={to} className="type-button flex min-h-12 items-center rounded-lg border border-ink px-4 hover:bg-sunken">
                          Open
                        </Link>
                      )}
                      {/* The manager's Cancel order: a reason, a PIN for a cashier, and it shows in the cancellations report. */}
                      {blocker.kind === 'OPEN_ORDER' && (
                        <Link
                          to={`/orders/${blocker.ref}?cancel=1`}
                          className="type-button flex min-h-12 items-center rounded-lg px-4 text-alert hover:bg-alert-tint"
                        >
                          Cancel order
                        </Link>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {closesOnClose.length > 0 && (
            <div className="rounded-lg bg-sunken p-3">
              <p className="type-label">These close by themselves. Nothing was sent to the kitchen, so they count nowhere.</p>
              <ul className="type-body mt-1 text-muted">
                {closesOnClose.map((order) => (
                  <li key={order.orderId}>
                    {order.tableName ?? `Order ${order.orderNumber}`} ·{' '}
                    {order.dishesNotSent === 0 ? 'nothing added' : `${order.dishesNotSent} ${order.dishesNotSent === 1 ? 'dish' : 'dishes'} not sent`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section aria-label="Cash in the drawer" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
        <h2 className="type-heading">Cash in the drawer</h2>
        <AmountOrCount value={count} onChange={setCount} denominations={denominations} title="Cash in the drawer" />

        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            checked={takingOut}
            onChange={(event) => setTakingOut(event.target.checked)}
            className="h-5 w-5 rounded border border-line focus:ring-2 focus:ring-accent"
          />
          <span className="type-body">Taking cash out of the drawer?</span>
        </label>
        {!takingOut && counted !== null && (
          <p className="type-caption text-muted">
            All <Money paise={counted} /> stays in the drawer for tomorrow.
          </p>
        )}
        {takingOut && (
          <div className="flex flex-col gap-3 rounded-lg bg-sunken p-3">
            <AmountOrCount
              key={kept.touched ? 'own' : `proposed-${proposed}`}
              value={kept.touched ? kept : { ...kept, typed: proposed !== null ? paiseToInput(proposed) : '' }}
              onChange={(next) => setKept({ ...next, touched: true })}
              denominations={denominations}
              title="Keep for tomorrow"
            />
            {tooMuch ? (
              <p className="type-body text-alert">You cannot keep more than you counted.</p>
            ) : (
              <p className="type-body">
                Taken out: <Money paise={takenOut > 0 ? takenOut : 0} />
              </p>
            )}
            {takenOut > 0 && (
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Where it goes">
                {DESTINATIONS.map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={takenOutTo === code}
                    onClick={() => setTakenOutTo(code)}
                    className={['type-label min-h-12 rounded-lg border px-3', takenOutTo === code ? 'border-2 border-ink bg-surface' : 'border-line bg-surface'].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {noteRequired && (
          <Input
            label="The count is not what the drawer should hold. Say why."
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </section>

      {/* 2026-10-22. Every refusal in words, the note included: a silent grey button read as the day refusing to close. */}
      {close.isError && <p className="type-body text-alert">{errorMessage(close.error)}</p>}
      {!close.isPending && whyNot && <p className="type-body text-alert">{whyNot}</p>}

      <button
        type="button"
        disabled={!canClose || close.isPending}
        onClick={() => close.mutate()}
        className="type-button min-h-14 w-full rounded-lg bg-accent px-6 text-on-accent hover:brightness-110 disabled:opacity-50 sm:w-auto sm:self-start"
      >
        {close.isPending ? 'Closing…' : `Close ${formatBusinessDate(businessDate)}`}
      </button>
    </div>
  );
}
