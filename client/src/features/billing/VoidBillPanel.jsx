import { useState } from 'react';

import { BILL_VOID_REASONS } from '../orders/cancelReasons.js';
import ReasonPicker, { isReasonComplete, reasonBody } from '../../components/ui/ReasonPicker.jsx';
import { LABELS } from '../i18n/labels.js';
import Sheet from '../../components/ui/Sheet.jsx';
import Money from '../../components/ui/Money.jsx';
import ApprovalStep, { useApproval } from '../../components/ui/ApprovalStep.jsx';

/**
 * Voiding a bill. OWNER and MANAGER, or a cashier with an owner's or manager's
 * PIN (P28, `needsApproval`), enforced on the server.
 *
 * The confirmation states the consequence, not the question: "this bill will
 * be voided, the number stays used, this much comes off today's total" —
 * spelled out with the real amount, not "Are you sure?". A cashier who reads
 * this and still means to void it has the information the sentence needed to
 * carry; one who does not can back out having actually learned what happens.
 */
/** 2026-10-22. Voiding to correct the bill keeps the table to bill again; every other reason closes it. */
const BILL_AGAIN_REASONS = new Set(['WRONG_TABLE', 'ITEMS_CHANGED', 'DISCOUNT_CHANGED']);

export default function VoidBillPanel({ bill, needsApproval = false, isBusy, error, onCancel, onConfirm }) {
  const [reason, setReason] = useState({ reasonCode: null, note: '' });
  // null: follow the reason. A person's own choice is kept when the reason changes.
  const [chosenClose, setChosenClose] = useState(null);
  const approval = useApproval(needsApproval);
  const hasMoney = bill.amountPaidInPaise > 0 || bill.status === 'ON_ACCOUNT';
  const closeOrder = !hasMoney && (chosenClose ?? !BILL_AGAIN_REASONS.has(reason.reasonCode));
  const canConfirm = isReasonComplete(reason) && approval.ready && !isBusy;
  const place = bill.orderType === 'DINE_IN' ? 'table' : 'order';

  return (
    <Sheet title={LABELS.voidBill} onCancel={onCancel}>
      <div className="mb-4 rounded-lg border border-line border-l-[3px] border-l-alert bg-surface p-3">
        <p className="type-body text-ink">
          Bill <span className="font-mono">{bill.billNumber}</span> for{' '}
          <span className="font-mono font-semibold"><Money paise={bill.grandTotalInPaise} /></span> will
          be voided.
        </p>
        <p className="mt-1 type-caption text-muted">
          The number stays used and is never reissued. This amount will no longer count toward
          today&rsquo;s sales.
          {bill.amountPaidInPaise > 0 && ' Money was already collected against this bill.'}
        </p>
      </div>

      <ReasonPicker
        reasons={BILL_VOID_REASONS}
        value={reason}
        onChange={setReason}
        noteMaxLength={500}
      />

      <fieldset className="mb-4 flex flex-col gap-2">
        <legend className="type-label mb-2">After voiding</legend>
        {[
          { value: true, label: `Close the ${place}`, detail: `The order is cancelled and the ${place} is free.` },
          { value: false, label: `Bill this ${place} again`, detail: 'The order waits for a new bill, to correct this one.' },
        ].map((option) => (
          <label
            key={String(option.value)}
            className={[
              'flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3',
              closeOrder === option.value ? 'border-ink bg-sunken' : 'border-line bg-surface',
              hasMoney && option.value ? 'cursor-not-allowed opacity-50' : '',
            ].join(' ')}
          >
            <input
              type="radio"
              name="after-void"
              className="mt-1"
              checked={closeOrder === option.value}
              disabled={hasMoney && option.value}
              onChange={() => setChosenClose(option.value)}
            />
            <span>
              <span className="type-body block font-semibold">{option.label}</span>
              <span className="type-caption block text-muted">{option.detail}</span>
            </span>
          </label>
        ))}
        {hasMoney && <p className="type-caption text-muted">Money was collected on this bill, so the {place} stays open to bill again.</p>}
      </fieldset>

      <ApprovalStep approval={approval} />

      {error && <p className="mb-3 type-caption text-alert">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="min-h-14 flex-1 rounded-lg border border-ink bg-surface type-button text-ink hover:bg-sunken"
        >
          {LABELS.keepIt}
        </button>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirm({ ...reasonBody(reason), ...approval.body, closeOrder })}
          className="min-h-14 flex-[2] rounded-lg bg-alert type-button text-on-accent disabled:opacity-50"
        >
          {isBusy ? 'Voiding…' : LABELS.voidBill}
        </button>
      </div>
    </Sheet>
  );
}
