import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { PrintIcon } from '../../components/ui/icons/index.jsx';
import Money, { moneyText } from '../../components/ui/Money.jsx';
import { createBill, requestBillPrint } from '../../api/bills.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatBasisPoints } from '../../utils/formatMoney.js';
import { billsPrintAtCounter, useDeviceSettings } from '../printing/useDeviceSettings.js';
import { ROLES } from '../users/roles.js';
import DiscountPanel from './DiscountPanel.jsx';
import { discountReasonLabel } from './discountReasons.js';
import { errorMessage, existingBillId } from './errorCopy.js';

const TILL = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];
const MANAGERS = [ROLES.OWNER, ROLES.MANAGER];

/**
 * The bill, before it is made. P57.
 *
 * PetPooja's way: the dishes above stay changeable, the discount is chosen
 * here, and the totals show before anything is saved. Nothing is made, and
 * nothing printed, until Save or Save & Print.
 *
 * Every figure is the server's: the totals are a preview of POST /bills
 * (`preview: true`), which writes nothing and uses no bill number, read again
 * whenever the order or the discount changes. The discount travels with the
 * bill in the same request, so a bill is never printed without it.
 */
export default function BillComposer({ order, onStale, withoutKot = false, onBack = null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, features } = useAuth();
  const [discount, setDiscount] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState(null);

  const isCaptain = user?.role === ROLES.WAITER;
  // 2026-10-25. A manager's or cashier's phone on the cafe PC sends the print to the counter too.
  const [device] = useDeviceSettings();
  const atCounter = isCaptain || (TILL.includes(user?.role) && billsPrintAtCounter(device, features));
  const isManager = MANAGERS.includes(user?.role);
  const cashierPlatformOnly = user?.role === ROLES.CASHIER && Boolean(features?.cashierMayApplyPlatformDiscounts);
  // A reopened order carries its last bill's discount (P26); a new one is given on the new bill.
  const canDiscount = (isManager || cashierPlatformOnly) && !order.reopenedFromBillId;

  const previewQuery = useQuery({
    queryKey: ['bill-preview', order.id, order.version, discount, withoutKot],
    // P60. Without a KOT, the preview serves the dishes not sent and rolls it all back, as the bill would.
    queryFn: () => createBill({ orderId: order.id, version: order.version, discount, preview: true, ...(withoutKot ? { withoutKot } : {}) }),
    placeholderData: keepPreviousData,
    // 2026-10-22. A preview that failed (the website's free server waking up) is asked again,
    // and never holds Save back: Save makes the bill on the server, which checks everything again.
    retry: 3,
    retryDelay: (attempt) => 2000 * (attempt + 1),
  });
  const preview = previewQuery.data;
  const previewError = previewQuery.isError ? errorMessage(previewQuery.error) : null;

  const save = useMutation({
    mutationFn: async ({ andPrint }) => {
      const bill = await createBill({ orderId: order.id, version: order.version, discount, ...(withoutKot ? { withoutKot } : {}) });
      // P25 Part D. A captain's print goes to the counter's printer. A failed request leaves Print at counter on the bill.
      if (andPrint && atCounter) await requestBillPrint(bill.id).catch(() => null);
      return bill;
    },
    onSuccess: (bill, { andPrint }) => {
      queryClient.invalidateQueries({ queryKey: ['order', order.id] });
      queryClient.invalidateQueries({ queryKey: ['tables'] });
      // The bill screen prints it on this device, then asks for the payment (P29).
      navigate(`/bills/${bill.id}`, { state: andPrint && !atCounter ? { printNow: true } : null });
    },
    onError: (mutationError) => {
      const raced = existingBillId(mutationError);
      if (raced) {
        navigate(`/bills/${raced}`);
        return;
      }
      if (mutationError?.code === 'VERSION_CONFLICT') onStale?.();
      setError(errorMessage(mutationError));
    },
  });

  const busy = save.isPending;

  return (
    <section aria-label="Bill" className="flex flex-col gap-3 border-t-2 border-ink px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="type-heading">{withoutKot ? 'Bill without KOT' : 'Bill'}</h2>
          {withoutKot && <p className="type-caption text-muted">Nothing goes to the kitchen. The dishes count as served.</p>}
        </div>
        {canDiscount && !discount && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setChoosing(true)}
            className="type-button min-h-12 rounded-lg border border-ink bg-surface px-4 hover:bg-sunken disabled:opacity-50"
          >
            Add discount
          </button>
        )}
      </div>

      {discount && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-sunken px-3 py-2">
          <p className="type-body min-w-0">
            <span className="font-semibold">Discount</span> · {discountWords(discount)}
          </p>
          <div className="flex gap-1">
            <button type="button" disabled={busy} onClick={() => setChoosing(true)} className="type-label min-h-12 rounded-lg px-3 hover:bg-surface">
              Change
            </button>
            <button type="button" disabled={busy} onClick={() => setDiscount(null)} className="type-label min-h-12 rounded-lg px-3 text-alert hover:bg-alert-tint">
              Remove
            </button>
          </div>
        </div>
      )}

      {preview ? (
        <dl aria-busy={previewQuery.isFetching} className={['flex flex-col gap-1', previewQuery.isFetching ? 'opacity-60' : ''].join(' ')}>
          <Row label="Item total" value={<Money paise={preview.subtotalInPaise} />} />
          {preview.discount && <Row label="Discount" value={`− ${moneyText(preview.discount.amountInPaise)}`} />}
          {preview.taxBreakdown.map((slab) => (
            <div key={slab.taxRateBps} className="flex flex-col gap-1">
              <Row label={`CGST @ ${formatBasisPoints(slab.taxRateBps / 2)}`} value={<Money paise={slab.cgstInPaise} />} />
              <Row label={`SGST @ ${formatBasisPoints(slab.taxRateBps / 2)}`} value={<Money paise={slab.sgstInPaise} />} />
            </div>
          ))}
          {preview.roundOffInPaise !== 0 && <Row label="Round-off" value={<Money paise={preview.roundOffInPaise} />} />}
          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 border-t border-line pt-2">
            <dt className="type-heading">Bill total</dt>
            <dd>
              <Money paise={preview.grandTotalInPaise} size="tile" />
            </dd>
          </div>
        </dl>
      ) : (
        !previewError && <p className="type-caption text-muted">Working out the total…</p>
      )}

      {(error || previewError) && <p className="type-caption text-alert">{error ?? previewError}</p>}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => save.mutate({ andPrint: false })}
          className="type-button min-h-14 rounded-lg border border-ink bg-surface px-4 hover:bg-sunken disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => save.mutate({ andPrint: true })}
          className="type-button flex min-h-14 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          <PrintIcon />
          {busy ? 'Saving…' : atCounter ? 'Save & Print at counter' : 'Save & Print'}
        </button>
      </div>

      {onBack && (
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className="type-label min-h-12 w-full rounded-lg text-ink hover:bg-sunken disabled:opacity-50"
        >
          Back to the order
        </button>
      )}

      {choosing && (
        <DiscountPanel
          billNumber={null}
          subtotalInPaise={preview?.subtotalInPaise ?? order.totals.subtotalInPaise}
          platformOnly={!isManager}
          isBusy={false}
          error={null}
          onCancel={() => setChoosing(false)}
          onConfirm={(body) => {
            setDiscount(body);
            setChoosing(false);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

/** "10% · Regular guest", or "₹50.00 · Other: birthday". */
function discountWords(discount) {
  const size = discount.kind === 'PERCENT' ? formatBasisPoints(discount.rateBps) : moneyText(discount.valueInPaise);
  const label = discountReasonLabel(discount.reasonCode);
  return `${size} · ${discount.note ? `${label}: ${discount.note}` : label}`;
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="type-body text-muted">{label}</dt>
      <dd className="type-num">{value}</dd>
    </div>
  );
}
