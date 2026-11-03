import { useState } from 'react';

import { recordPayment } from '../../api/bills.js';
import Input from '../../components/ui/Input.jsx';
import Money from '../../components/ui/Money.jsx';
import { parseRupeesToPaise } from '../../utils/formatMoney.js';
import { errorMessage } from './errorCopy.js';

/**
 * Part payment, 2026-11-03: one bill paid some by cash, some by UPI, some another way.
 * Every method the bill may use is listed with an amount box; Done records one
 * payment per amount typed, in turn, through the same POST /bills/:id/payments a
 * single payment uses, so the server checks each. A method on the card machine is
 * left out: its payment is sent to the machine, from the usual payment.
 *
 * If one payment is refused part way, those already recorded stay recorded (they
 * are on the bill) and the rest is shown to try again.
 */
export default function PartPayment({ billId, methods, outstandingInPaise, onRecorded, onCancel }) {
  const usable = methods.filter((method) => !method.terminalProvider);
  const [amounts, setAmounts] = useState({});
  const [modes, setModes] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const entries = usable
    .map((method) => ({ method, paise: amounts[method.code] ? parseRupeesToPaise(amounts[method.code]) : 0 }))
    .filter((entry) => entry.paise !== 0);
  const invalid = entries.some((entry) => entry.paise === null || entry.paise < 0);
  const totalInPaise = invalid ? 0 : entries.reduce((sum, entry) => sum + entry.paise, 0);
  const leftInPaise = outstandingInPaise - totalInPaise;
  const missingMode = entries.some((entry) => entry.method.code === 'OTHER' && !(modes.OTHER ?? '').trim());
  const canSave = !busy && entries.length > 0 && !invalid && leftInPaise >= 0 && !missingMode;

  const save = async () => {
    setBusy(true);
    setError(null);
    let latest = null;
    try {
      for (const { method, paise } of entries) {
        latest = await recordPayment(billId, {
          method: method.code,
          amountInPaise: paise,
          reference: method.code === 'OTHER' ? modes.OTHER.trim() : null,
        });
        // Recorded: never sent twice if a later one is refused.
        setAmounts((now) => ({ ...now, [method.code]: '' }));
      }
      onRecorded(latest);
    } catch (saveError) {
      setError(errorMessage(saveError));
      if (latest) onRecorded(latest, { partial: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Part payment" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-heading">Part payment</h2>
        <span className="type-label text-muted">
          To collect <Money paise={outstandingInPaise} size="num" className="text-ink" />
        </span>
      </div>
      <p className="type-caption text-muted">Type how much came by each way of paying. Leave the others empty.</p>

      <div className="flex flex-col gap-2">
        {usable.map((method) => (
          <div key={method.code} className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_9rem] items-center gap-3">
              <label htmlFor={`part-${method.code}`} className="type-label">
                {method.name}
              </label>
              <input
                id={`part-${method.code}`}
                inputMode="decimal"
                placeholder="₹ 0"
                value={amounts[method.code] ?? ''}
                onChange={(event) => setAmounts((now) => ({ ...now, [method.code]: event.target.value }))}
                className="type-num block min-h-12 w-full rounded-lg border border-muted bg-surface px-3 text-right text-ink placeholder:text-muted"
              />
            </div>
            {method.code === 'OTHER' && amounts.OTHER && (
              <Input
                label="Mode of payment"
                placeholder="Like Cheque, or Swiggy Dineout"
                value={modes.OTHER ?? ''}
                onChange={(event) => setModes({ OTHER: event.target.value })}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <div className="flex justify-between">
          <span className="type-body text-muted">Typed</span>
          <Money paise={totalInPaise} size="num" />
        </div>
        <div className="flex justify-between">
          <span className={`type-body ${leftInPaise < 0 ? 'text-alert' : 'text-muted'}`}>{leftInPaise < 0 ? 'More than the bill' : 'Left to collect'}</span>
          <Money paise={Math.abs(leftInPaise)} size="num" className={leftInPaise < 0 ? 'text-alert' : ''} />
        </div>
      </div>

      {invalid && <p className="type-caption text-alert">Type each amount in rupees, like 250 or 250.50.</p>}
      {missingMode && <p className="type-caption text-alert">Say how the Other payment was made.</p>}
      {error && <p className="type-caption text-alert">{error}</p>}

      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="type-label min-h-12 rounded-lg px-4 text-ink hover:bg-sunken disabled:opacity-50">
          Back
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="type-button min-h-12 flex-1 rounded-lg bg-accent px-4 text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'Recording…' : 'Done'}
        </button>
      </div>
    </section>
  );
}
