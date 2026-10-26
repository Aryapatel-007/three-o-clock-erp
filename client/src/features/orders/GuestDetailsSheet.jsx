import { useState } from 'react';

import Input from '../../components/ui/Input.jsx';
import Sheet from '../../components/ui/Sheet.jsx';
import { QuantityStepper } from './LineOptionsPanel.jsx';

/** The server's own ceiling, MAX_GUEST_COUNT in server/models/Order.js. */
const MAX_GUESTS = 100;
const QUICK_COUNTS = [1, 2, 3, 4, 5, 6, 7];

/**
 * P56. The guest's details, asked on a table's first Send to the kitchen.
 *
 * Moved here from seating (P27), where the captain is busiest. P59 moved the
 * number of guests here too, first: it becomes the order's covers, and average
 * per cover divides by it. With `settings.floor.requireGuestCount` on the count
 * is required and there is no Skip until the order has one (the server refuses
 * the first Send without it); otherwise everything is optional and Skip sends the dishes as they are.
 *
 * A mobile is ten digits, with a leading 91 or 0 dropped; the offers tick needs
 * one, and is ticked only when the guest says yes.
 */
export default function GuestDetailsSheet({ placeName, isBusy, initialGuestCount = null, requireCount = false, forBill = false, onCancel, onSave, onSkip }) {
  const [guestCount, setGuestCount] = useState(initialGuestCount);
  const [isMore, setIsMore] = useState(initialGuestCount != null && initialGuestCount > QUICK_COUNTS.length);
  const [guestName, setGuestName] = useState('');
  const [mobile, setMobile] = useState('');
  const [agreed, setAgreed] = useState(false);
  const digits = mobile.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  const mobileOk = digits.length === 10 && /^[6-9]/.test(digits);
  const mobileWrong = mobile.trim() !== '' && !mobileOk;
  const guest = {
    ...(guestCount != null && guestCount !== initialGuestCount ? { guestCount } : {}),
    ...(guestName.trim() ? { customerName: guestName.trim() } : {}),
    ...(mobileOk ? { customerPhone: digits } : {}),
    ...(mobileOk && agreed ? { offersConsent: true } : {}),
  };
  const hasAnything = Object.keys(guest).length > 0;
  const countMissing = requireCount && guestCount == null;
  const canSave = !countMissing && !mobileWrong && (hasAnything || guestCount != null);

  return (
    <Sheet
      title="Guest details"
      onClose={onCancel}
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={!canSave || isBusy}
            onClick={() => onSave(hasAnything ? guest : null)}
            className="type-button flex min-h-14 w-full items-center justify-center rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {isBusy ? (forBill ? 'Saving…' : 'Sending…') : countMissing ? 'Choose the number of guests' : forBill ? 'Save and bill' : 'Save and send'}
          </button>
          {/* Skip once the count the restaurant requires is on the order already, as on a seated booking. */}
          {(!requireCount || initialGuestCount != null) && (
            <button
              type="button"
              disabled={isBusy}
              onClick={onSkip}
              className="type-label min-h-12 w-full rounded-lg text-ink hover:bg-sunken disabled:opacity-50"
            >
              {forBill ? 'Skip, bill without details' : 'Skip, send without details'}
            </button>
          )}
        </div>
      }
    >
      <p className="type-caption text-muted">
        {forBill ? `Before the bill for ${placeName}.` : `Before the first KOT for ${placeName}.`}{' '}
        {requireCount ? 'The number of guests is needed; the rest is optional.' : 'Optional. Builds your customer list, and brings back their visits next time.'}
      </p>

      <h3 className="type-heading mt-4">How many guests?</h3>
      <p className="type-caption text-muted">Counted as covers on the bill.</p>
      <div className="mt-3 grid grid-cols-4 gap-2" role="group" aria-label="How many guests?">
        {QUICK_COUNTS.map((count) => (
          <CountButton
            key={count}
            label={String(count)}
            isActive={!isMore && guestCount === count}
            onClick={() => {
              setIsMore(false);
              setGuestCount(count);
            }}
          />
        ))}
        <CountButton
          label="More"
          isActive={isMore}
          onClick={() => {
            setIsMore(true);
            setGuestCount((current) => Math.max(QUICK_COUNTS.length + 1, current ?? QUICK_COUNTS.length + 1));
          }}
        />
      </div>
      {isMore && (
        <div className="mt-3 flex items-center justify-between">
          <span className="type-label text-muted">Guests</span>
          <QuantityStepper value={guestCount} min={QUICK_COUNTS.length + 1} max={MAX_GUESTS} onChange={setGuestCount} />
        </div>
      )}

      <div className="mt-6 grid gap-3">
        <Input label="Guest name" autoComplete="off" maxLength={100} value={guestName} onChange={(event) => setGuestName(event.target.value)} />
        <Input
          label="Mobile number"
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          maxLength={14}
          value={mobile}
          error={mobileWrong ? 'A 10-digit Indian mobile number.' : undefined}
          onChange={(event) => {
            setMobile(event.target.value);
            if (!event.target.value.trim()) setAgreed(false);
          }}
        />
        <label className={['flex items-start gap-3', mobileOk ? '' : 'opacity-50'].join(' ')}>
          <input
            type="checkbox"
            checked={agreed}
            disabled={!mobileOk}
            onChange={(event) => setAgreed(event.target.checked)}
            className="mt-1 h-5 w-5 rounded border border-line focus:ring-2 focus:ring-accent"
          />
          <span>
            <span className="type-body block">The guest agrees to offers and news by SMS or WhatsApp</span>
            <span className="type-caption block text-muted">Tick only if the guest says yes.</span>
          </span>
        </label>
      </div>
    </Sheet>
  );
}

function CountButton({ label, isActive, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={[
        'flex min-h-14 items-center justify-center rounded-lg border transition-colors',
        label === 'More' ? 'type-button' : 'type-num-tile',
        isActive ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
