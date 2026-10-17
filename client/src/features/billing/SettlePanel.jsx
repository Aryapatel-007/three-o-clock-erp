import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import Money from '../../components/ui/Money.jsx';
import { createBill, recordPayment } from '../../api/bills.js';
import { listPaymentMethods } from '../../api/paymentMethods.js';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { printBill } from '../printing/printBill.js';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import { errorMessage } from './errorCopy.js';
import { methodsForBill } from './paymentMethodsForBill.js';

/**
 * Settling an order on the order's own page: print the bill, and take the
 * money in one tap per method. The bill is made when either is first tapped,
 * and the server works out every rupee. Used by the table's page once
 * everything is served, and by Counter Sale for a takeaway.
 *
 * The bill page is not part of service any more. It stays behind Bills, for
 * a discount, a void, a payment taken by the wrong method or a refund.
 */

/** The quick buttons: what this order may use, less a card machine (it has its own wait) and Other (it asks how). */
export function useQuickMethods(orderType, platform = null) {
  const query = useQuery({ queryKey: ['payment-methods'], queryFn: () => listPaymentMethods() });
  const methods = useMemo(
    () =>
      methodsForBill(query.data ?? [], { orderType, platform })
        .filter((method) => !method.terminalProvider && method.code !== 'OTHER')
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [query.data, orderType, platform],
  );
  return { methods, isLoaded: query.isSuccess };
}

/** Prints a bill on this device's printer, with the restaurant's logo. */
export function usePrintBill() {
  const [device] = useDeviceSettings();
  const { brand } = useTheme();
  return {
    autoPrint: Boolean(device.printBillOnCreate),
    print: (billId) => printBill(billId, { printer: device.printer, logoDataUrl: brand.logos?.LIGHT_GROUND?.dataUrl ?? null }),
  };
}

/** What a guest hands over for cash: the bill total rounded up to the next ₹100, ₹500, ₹1,000 and ₹2,000. */
function cashGivenOptions(totalInPaise) {
  const options = new Set();
  for (const step of [10_000, 50_000, 100_000, 200_000]) {
    const up = Math.ceil(totalInPaise / step) * step;
    if (up > totalInPaise) options.add(up);
  }
  return [...options].sort((a, b) => a - b);
}

/** The pay buttons, three to a row. */
export function PayButtons({ methods, disabled, paying, onPay }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {methods.map((method) => (
        <button
          key={method.code}
          type="button"
          disabled={disabled}
          onClick={() => onPay(method)}
          className="type-button min-h-16 rounded-lg bg-accent px-2 text-on-accent hover:brightness-110 disabled:opacity-40"
        >
          {paying === method.code ? 'Paying…' : method.name}
        </button>
      ))}
    </div>
  );
}

/**
 * The table's settle panel. `bill` is the order's bill when one was made
 * already (printed, or added to), else null.
 */
export default function SettlePanel({ order, bill, onPaid }) {
  const queryClient = useQueryClient();
  const { methods, isLoaded } = useQuickMethods(order.orderType, order.platform?.code ?? null);
  const printer = usePrintBill();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const refresh = (billId) => {
    queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    queryClient.invalidateQueries({ queryKey: ['tables'] });
    queryClient.invalidateQueries({ queryKey: ['bills'] });
    if (billId) queryClient.invalidateQueries({ queryKey: ['bill', billId] });
  };
  const ensureBill = () => (bill ? Promise.resolve(bill) : createBill({ orderId: order.id, version: order.version }));

  const printNow = async () => {
    setBusy('PRINT');
    setError(null);
    try {
      const made = await ensureBill();
      await printer.print(made.id);
      refresh(made.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  const pay = async (method) => {
    setBusy(method.code);
    setError(null);
    let made = null;
    try {
      made = await ensureBill();
      const owed = made.grandTotalInPaise - (made.amountPaidInPaise ?? 0);
      const paid = await recordPayment(made.id, { method: method.code, amountInPaise: owed });
      let printed = (paid.printCount ?? 0) > 0;
      if (printer.autoPrint && !printed) {
        try {
          await printer.print(paid.id);
          printed = true;
        } catch {
          // The paid view offers Print receipt.
        }
      }
      refresh(paid.id);
      onPaid({ bill: paid, order, method, printed });
    } catch (failure) {
      setError(errorMessage(failure));
      if (made) refresh(made.id);
    } finally {
      setBusy(null);
    }
  };

  const total = bill ? bill.grandTotalInPaise - (bill.amountPaidInPaise ?? 0) : null;

  return (
    <section aria-label="Settle this order" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="type-heading">Take payment</h2>
        {bill && <span className="type-caption text-muted">Bill {bill.billNumber}</span>}
      </div>
      {total !== null ? (
        <div className="flex items-baseline justify-between">
          <span className="type-label text-muted">{bill.amountPaidInPaise > 0 ? 'Still to pay' : 'Bill total, with GST'}</span>
          <Money paise={total} size="tile" />
        </div>
      ) : (
        <div className="flex items-baseline justify-between">
          <span className="type-label text-muted">Item total, GST added on the bill</span>
          <Money paise={order.totals.subtotalInPaise} size="tile" />
        </div>
      )}

      <PayButtons methods={methods} disabled={busy !== null} paying={busy} onPay={pay} />
      {isLoaded && methods.length === 0 && (
        <p className="type-caption text-alert">No payment method is set up for this kind of order. Add one in Settings, Payment methods.</p>
      )}
      <button
        type="button"
        disabled={busy !== null}
        onClick={printNow}
        className="type-button min-h-12 rounded-lg border border-ink bg-surface hover:bg-sunken disabled:opacity-50"
      >
        {busy === 'PRINT' ? 'Printing…' : (bill?.printCount ?? 0) > 0 ? 'Print the bill again' : 'Print the bill'}
      </button>
      {error && <p className="type-caption text-alert">{error}</p>}
      <p className="type-caption text-muted">Tapping how they pay makes the bill and records the payment. For a discount or a correction, open the bill from Bills.</p>
    </section>
  );
}

/** After the payment: what to say to the guest, the change on cash, and what next. */
export function PaidPanel({ done, nextLabel, onNext, onGiven, onPrint }) {
  const total = done.bill.grandTotalInPaise;
  const isCash = done.method.code === 'CASH';
  const notes = cashGivenOptions(total);
  return (
    <div className="flex flex-col gap-4 p-4" role="status">
      <div className="rounded-[10px] border border-line border-l-[3px] border-l-ok bg-ok-tint px-4 py-3">
        <p className="type-label text-muted">Paid by {done.method.name}</p>
        <Money paise={total} size="tile" />
        <p className="type-caption text-muted">
          Bill {done.bill.billNumber} · Order <span className="type-num-meta text-ink">#{done.order.orderNumber}</span>
          {done.order.tableName && ` · ${done.order.tableName}`}
          {done.order.customerName && ` · ${done.order.customerName}`}
        </p>
      </div>

      {isCash && (
        <div className="flex flex-col gap-2">
          <p className="type-label">Cash given</p>
          <div className="flex flex-wrap gap-2">
            {notes.map((note) => (
              <button
                key={note}
                type="button"
                onClick={() => onGiven(note)}
                aria-pressed={done.given === note}
                className={`type-button min-h-12 rounded-lg border px-4 ${done.given === note ? 'border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken'}`}
              >
                <Money paise={note} />
              </button>
            ))}
          </div>
          {done.given != null && (
            <p className="type-heading">
              Give back <Money paise={done.given - total} size="tile" />
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button type="button" onClick={onNext} className="type-button min-h-14 rounded-lg bg-accent text-on-accent hover:brightness-110">
          {nextLabel}
        </button>
        <button type="button" onClick={onPrint} className="type-button min-h-12 rounded-lg border border-ink bg-surface hover:bg-sunken">
          {done.printed ? 'Print again' : 'Print receipt'}
        </button>
      </div>
    </div>
  );
}
