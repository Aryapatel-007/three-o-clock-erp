import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { startTerminalPayment } from '../../api/terminalPayments.js';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import { errorMessage } from './errorCopy.js';
import TerminalWaiting from './TerminalWaiting.jsx';

import Money, { moneyText } from '../../components/ui/Money.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import CashCounter from '../cash/CashCounter.jsx';
import { countedTotal, keyOf, suggestChange, toCashCount } from '../cash/cashCount.js';
import NumericKeypad from '../../components/ui/NumericKeypad.jsx';
import { paiseToInput, parseRupeesToPaise } from '../../utils/formatMoney.js';
import Bilingual from '../i18n/Bilingual.jsx';
import { LABELS } from '../i18n/labels.js';
import MethodButtons from './MethodButtons.jsx';

/**
 * Taking a payment on the bill screen itself, beside the bill, instead of in a
 * slide-over. The cashier sees the bill while choosing a method and typing an
 * amount. The amount starts as everything still owed, so the common case is
 * one tap on a method and one on Record payment. Methods are the restaurant's
 * configured ones this bill may use, passed in; the server still decides.
 */
/** P43. Used only before /auth/me carries the restaurant's own list (P47). Anything else is typed. */
const FALLBACK_OTHER_MODES = ['Swiggy Dineout', 'Zomato Dineout', 'EazyDiner', 'Cheque', 'Bank transfer', 'Coupon'];

export default function InlinePayment({ billId, methods, outstandingInPaise, isBusy, error, onConfirm, onTerminalFinished, onPartPayment = null }) {
  // Until one is picked, the first allowed method is selected. Derived, because
  // the methods may still be loading when this mounts.
  const [picked, setMethod] = useState(null);
  const method = methods.find((candidate) => candidate.code === picked?.code) ?? methods[0] ?? null;
  const [reference, setReference] = useState('');
  // P25 Part F. On cash, the notes handed over: the change is worked out as they are counted.
  const { user, features } = useAuth();
  // P25 Part I. A method on the card machine is sent there, from this device's machine.
  const [device] = useDeviceSettings();
  const [sent, setSent] = useState(null);
  const [byHand, setByHand] = useState(false);
  const [handReason, setHandReason] = useState('');
  const isManager = ['OWNER', 'MANAGER'].includes(user?.role);
  const toMachine = useMutation({
    mutationFn: (amount) => startTerminalPayment(billId, { method: method.code, amountInPaise: amount, terminalClientId: device.terminalClientId }),
    onSuccess: setSent,
  });
  const denominations = features?.cash?.denominations ?? [];
  const [counts, setCounts] = useState({});
  const [counting, setCounting] = useState(false);
  const [typed, setTyped] = useState(null);
  const amountInPaise = typed === null ? outstandingInPaise : parseRupeesToPaise(typed);
  const isCash = method?.code === 'CASH';
  const isOther = method?.code === 'OTHER';
  // P47. The owner's list, from Settings, Payment methods.
  const otherModes = features?.payments?.otherModes ?? FALLBACK_OTHER_MODES;
  const tenderedInPaise = countedTotal(counts, denominations);
  const changeInPaise = tenderedInPaise - (amountInPaise ?? 0);
  const change = changeInPaise > 0 ? suggestChange(changeInPaise, denominations) : null;

  return (
    <section aria-label="Take payment" className="flex flex-col gap-4">
      <div className="rounded-[10px] border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="type-heading">Payment method</h2>
          <span className="type-label text-muted">
            {LABELS.outstanding} <Money paise={outstandingInPaise} size="num" className="text-ink" />
          </span>
        </div>
        <MethodButtons methods={methods} selected={method?.code} onPick={setMethod} onPartPayment={onPartPayment} />
      </div>

      {method && (
        <div className="rounded-[10px] border border-line bg-surface p-4">
          {/* P43. Other says how it was paid, and the payment waits for it. */}
          {isOther && (
            <fieldset className="mb-4">
              <legend className="mb-1 type-label">Mode of payment</legend>
              <div className="mb-2 flex flex-wrap gap-2">
                {otherModes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={reference === mode}
                    onClick={() => setReference(mode)}
                    className={[
                      'type-label min-h-12 rounded-lg border px-4',
                      reference === mode ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
                    ].join(' ')}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <input
                type="text"
                aria-label="Mode of payment"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                maxLength={100}
                placeholder="Or type it, for example Paytm wallet"
                className="min-h-12 w-full rounded-lg border border-muted bg-surface px-4 type-body placeholder:text-muted"
              />
              {!reference.trim() && <p className="type-caption mt-1 text-muted">Pick or type how it was paid to record it.</p>}
            </fieldset>
          )}
          {method.code !== 'CASH' && !isOther && (
            <label className="mb-4 block">
              <span className="mb-1 block type-label text-muted">
                Reference (optional)
              </span>
              <input
                type="text"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                maxLength={100}
                placeholder={
                  method.code === 'UPI'
                    ? 'UPI reference'
                    : method.kind === 'PLATFORM'
                      ? 'Order or booking number'
                      : 'Last 4 digits'
                }
                className="min-h-12 w-full rounded-lg border border-muted bg-surface px-4 type-body placeholder:text-muted"
              />
            </label>
          )}

          {/* P48. Guest gave: tap the notes the guest handed over; Give back shows the change, large, and the notes to return. */}
          {!sent && isCash && denominations.length > 0 && (
            <section aria-label="Guest gave" className="mb-4 flex flex-col gap-3 border-b border-line pb-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="type-heading">Guest gave</h3>
                {tenderedInPaise > 0 && (
                  <button type="button" onClick={() => setCounts({})} className="type-label min-h-12 rounded-lg px-3 text-muted hover:bg-sunken hover:text-ink">
                    Clear
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {denominations
                  .filter((denomination) => denomination.kind === 'NOTE' && denomination.valueInPaise >= 1000)
                  .sort((a, b) => a.valueInPaise - b.valueInPaise)
                  .map((denomination) => {
                    const key = keyOf(denomination);
                    const count = counts[key] ?? 0;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setCounts((current) => ({ ...current, [key]: (current[key] ?? 0) + 1 }))}
                        className={[
                          'type-button flex min-h-14 items-center justify-center gap-1 rounded-lg border px-2',
                          count > 0 ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
                        ].join(' ')}
                      >
                        <Money paise={denomination.valueInPaise} />
                        {count > 0 && <span className="type-num-meta text-muted">× {count}</span>}
                      </button>
                    );
                  })}
              </div>
              {tenderedInPaise > 0 ? (
                <div aria-live="polite" className={['rounded-lg border-l-[3px] bg-sunken p-4', changeInPaise >= 0 ? 'border-l-ok' : 'border-l-alert'].join(' ')}>
                  <p className="type-body">
                    Guest gave <Money paise={tenderedInPaise} />
                  </p>
                  {changeInPaise >= 0 ? (
                    <p className="type-title mt-1 flex flex-wrap items-baseline gap-2">
                      Give back <Money paise={changeInPaise} size="tile" />
                    </p>
                  ) : (
                    <p className="type-title mt-1 flex flex-wrap items-baseline gap-2 text-alert">
                      <Money paise={-changeInPaise} size="tile" /> short
                    </p>
                  )}
                  {change && change.give.length > 0 && (
                    <p className="type-body mt-1 text-muted">
                      {change.give
                        .map((entry) => `${entry.count} × ${moneyText(entry.valueInPaise)} ${entry.kind === 'COIN' ? 'coin' : 'note'}`)
                        .join(', ')}
                      {change.remainderInPaise > 0 ? `, and ${moneyText(change.remainderInPaise)} more` : ''}
                    </p>
                  )}
                </div>
              ) : (
                <p className="type-caption text-muted">Tap each note the guest hands over. Nothing tapped means the exact amount.</p>
              )}
              <button
                type="button"
                aria-expanded={counting}
                onClick={() => setCounting((value) => !value)}
                className="min-h-12 self-start rounded-lg px-3 type-label text-accent underline-offset-4 hover:underline"
              >
                {counting ? 'Hide coins and small notes' : 'Coins and small notes'}
              </button>
              {counting && <CashCounter title="Handed over" denominations={denominations} counts={counts} onChange={setCounts} />}
            </section>
          )}
          {sent ? (
            <TerminalWaiting
              transaction={sent}
              onFinished={onTerminalFinished}
              onDismiss={() => {
                setSent(null);
                toMachine.reset();
              }}
            />
          ) : (
          <>
          {method.terminalProvider && !byHand && !device.terminalClientId && (
            <p className="type-body mb-3 text-alert">Choose this device&rsquo;s card machine on This device first.</p>
          )}
          {method.terminalProvider && isManager && (
            <div className="mb-3 grid gap-2">
              <button type="button" onClick={() => setByHand((value) => !value)} className="min-h-12 self-start type-label text-accent underline-offset-4 hover:underline">
                {byHand ? 'Use the card machine' : 'The machine is down? Enter it by hand'}
              </button>
              {byHand && (
                <input
                  type="text"
                  aria-label="Why it is entered by hand"
                  placeholder="Why, for example: the machine is down"
                  maxLength={200}
                  value={handReason}
                  onChange={(event) => setHandReason(event.target.value)}
                  className="min-h-12 w-full rounded-lg border border-muted bg-surface px-4 type-body"
                />
              )}
            </div>
          )}
          <NumericKeypad
            key={`${method.code}-${outstandingInPaise}`}
            title={`${LABELS.amountReceived} · ${method.name}`}
            prefix="₹"
            allowDecimal
            initialValue={paiseToInput(outstandingInPaise)}
            onChange={setTyped}
            confirmLabel={method.terminalProvider && !byHand ? 'Send to machine' : <Bilingual k="recordPayment" align="center" />}
            cancelLabel="Reset"
            busy={isBusy || toMachine.isPending}
            disabled={isOther && !reference.trim()}
            error={toMachine.isError ? errorMessage(toMachine.error) : error}
            onCancel={() => {
              setReference('');
              setCounts({});
            }}
            onConfirm={(raw) => {
              const amount = parseRupeesToPaise(raw);
              if (amount === null || amount <= 0) return;
              // P43. The server refuses Other with no mode; say so here instead of sending it.
              if (isOther && !reference.trim()) return;
              if (method.terminalProvider && !byHand) {
                if (device.terminalClientId) toMachine.mutate(amount);
                return;
              }
              if (method.terminalProvider && byHand) {
                if (!handReason.trim()) return;
                onConfirm({ method: method.code, amountInPaise: amount, reference: reference.trim() || null, terminalBypassReason: handReason.trim() });
                return;
              }
              // P48. Any note tapped under Guest gave is the tender; nothing tapped is the exact amount.
              const counted = isCash && tenderedInPaise > 0;
              // Counted short of the amount: say so rather than record a payment the notes do not cover.
              if (counted && tenderedInPaise < amount) return;
              onConfirm({
                method: method.code,
                amountInPaise: amount,
                reference: reference.trim() || null,
                ...(counted
                  ? { tender: { cashCount: toCashCount(counts, denominations), tenderedInPaise, changeInPaise: tenderedInPaise - amount } }
                  : {}),
              });
            }}
          />

          </>
          )}

        </div>
      )}
    </section>
  );
}
