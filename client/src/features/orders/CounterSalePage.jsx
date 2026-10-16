import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import { MinusIcon, PlusIcon } from '../../components/ui/icons/index.jsx';
import Money from '../../components/ui/Money.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { getMenuTree } from '../../api/menu.js';
import { createBill, recordPayment } from '../../api/bills.js';
import { createOrder, fireOrder } from '../../api/orders.js';
import { listPaymentMethods } from '../../api/paymentMethods.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { methodsForBill } from '../billing/paymentMethodsForBill.js';
import { errorMessage } from '../billing/errorCopy.js';
import { printBill } from '../printing/printBill.js';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import LineOptionsPanel from './LineOptionsPanel.jsx';
import MenuPicker from './MenuPicker.jsx';

/**
 * Counter Sale: a takeaway ordered and paid in one go, the way a cafe counter
 * works. The guest orders, pays, and waits for the drink.
 *
 * The cart lives on this screen until a payment button is tapped; nothing is
 * written before then, so a guest who changes their mind leaves no order
 * behind. One tap then runs the same five calls the long way makes by hand:
 * the takeaway, the send to the kitchen, the bill, the payment, and the print.
 * The server allows the bill before the kitchen is done only for a sent
 * takeaway with `billing.payFirstTakeaway` on, and works out every rupee: this
 * screen never previews GST, and shows the bill total once the server has it.
 *
 * If a step fails part-way, the order or bill made so far is opened, so
 * nothing is lost and the cashier finishes it the usual way.
 */

/** What a guest hands over for cash: the bill total rounded up to the next ₹100, ₹500, ₹1,000 and ₹2,000. */
function cashGivenOptions(totalInPaise) {
  const options = new Set();
  for (const step of [10_000, 50_000, 100_000, 200_000]) {
    const up = Math.ceil(totalInPaise / step) * step;
    if (up > totalInPaise) options.add(up);
  }
  return [...options].sort((a, b) => a - b);
}

/** A dish that needs no choice is added in one tap; anything else opens the options panel. */
const isPlain = (item) => item.variants.length === 0 && item.addOns.length === 0 && !item.isOpenItem;

/** The cart line's price before GST, for the cart only. The bill is the server's. */
function linePrice(item, payload) {
  const unit = payload.openItem?.priceInPaise ?? item.variants.find((variant) => variant.id === payload.variantId)?.priceInPaise ?? item.priceInPaise;
  const addOns = item.addOns.filter((addOn) => payload.addOnIds?.includes(addOn.id)).reduce((sum, addOn) => sum + addOn.priceInPaise, 0);
  const extras = (payload.extras ?? []).reduce((sum, extra) => sum + extra.priceInPaise, 0);
  return (unit + addOns + extras) * payload.quantity;
}

function lineDetail(item, payload) {
  return [
    item.variants.find((variant) => variant.id === payload.variantId)?.name,
    ...item.addOns.filter((addOn) => payload.addOnIds?.includes(addOn.id)).map((addOn) => addOn.name),
    ...(payload.extras ?? []).map((extra) => extra.name),
    payload.notes,
  ]
    .filter(Boolean)
    .join(' · ');
}

let nextKey = 1;

export default function CounterSalePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { features } = useAuth();
  const { brand } = useTheme();
  const [device] = useDeviceSettings();
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState([]);
  const [callName, setCallName] = useState('');
  const [picking, setPicking] = useState(null);
  const [paying, setPaying] = useState(null);
  const [done, setDone] = useState(null);
  const [toast, setToast] = useState(null);

  const menuQuery = useQuery({
    queryKey: ['menu', { includeUnavailable: false }],
    queryFn: () => getMenuTree({ includeUnavailable: false }),
    staleTime: 60_000,
  });
  const methodsQuery = useQuery({ queryKey: ['payment-methods'], queryFn: () => listPaymentMethods() });
  // The counter's buttons: what a takeaway may use, less a card machine (it has its own wait) and Other (it asks how).
  const methods = useMemo(
    () =>
      methodsForBill(methodsQuery.data ?? [], { orderType: 'TAKEAWAY', platform: null })
        .filter((method) => !method.terminalProvider && method.code !== 'OTHER')
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [methodsQuery.data],
  );

  // A plain dish is one cart line, stepped up and down from its card.
  const simpleLines = useMemo(() => new Map(cart.filter((line) => isPlain(line.item)).map((line) => [line.item.id, line])), [cart]);
  const pendingCounts = useMemo(() => {
    const counts = new Map();
    for (const line of cart) counts.set(line.item.id, (counts.get(line.item.id) ?? 0) + line.payload.quantity);
    return counts;
  }, [cart]);
  const itemCount = cart.reduce((sum, line) => sum + line.payload.quantity, 0);
  const itemTotal = cart.reduce((sum, line) => sum + linePrice(line.item, line.payload), 0);

  const add = (item, payload) => {
    setDone(null);
    setCart((lines) => [...lines, { key: nextKey++, item, payload, quantity: payload.quantity }]);
  };
  const step = (line, quantity) =>
    setCart((lines) => lines.map((each) => (each.key === line.key ? { ...each, quantity, payload: { ...each.payload, quantity } } : each)));
  const remove = (line) => setCart((lines) => lines.filter((each) => each.key !== line.key));

  const pay = async (method) => {
    setPaying(method.code);
    let order = null;
    let bill = null;
    try {
      order = await createOrder({
        orderType: 'TAKEAWAY',
        lines: cart.map((line) => line.payload),
        ...(callName.trim() ? { customerName: callName.trim() } : {}),
      });
      const fired = await fireOrder(order.id, order.version);
      bill = await createBill({ orderId: order.id, version: fired.order.version });
      const paid = await recordPayment(bill.id, { method: method.code, amountInPaise: bill.grandTotalInPaise });
      let printed = false;
      if (device.printBillOnCreate) {
        try {
          await printBill(paid.id, { printer: device.printer, logoDataUrl: brand.logos?.LIGHT_GROUND?.dataUrl ?? null });
          printed = true;
        } catch {
          setToast({ tone: 'error', message: 'Paid, but the receipt did not print. Print it again below.' });
        }
      }
      setDone({ bill: paid, order, method, printed, given: null });
      setCart([]);
      setCallName('');
      queryClient.invalidateQueries({ queryKey: ['bills'] });
    } catch (error) {
      // Part-way: open what was made, so the cashier finishes it the usual way.
      if (bill) navigate(`/bills/${bill.id}`);
      else if (order) navigate(`/orders/${order.id}`);
      else setToast({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPaying(null);
    }
  };

  const reprint = async () => {
    try {
      await printBill(done.bill.id, { printer: device.printer, logoDataUrl: brand.logos?.LIGHT_GROUND?.dataUrl ?? null });
      setDone((current) => ({ ...current, printed: true }));
    } catch (error) {
      setToast({ tone: 'error', message: errorMessage(error) });
    }
  };

  if (features?.billing?.payFirstTakeaway === false) {
    return (
      <main className="v2 min-h-full bg-ground px-4 py-6 text-ink">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          <h1 className="type-title">Counter sale is off</h1>
          <p className="type-body text-muted">The owner has turned off paying before the kitchen is done, in Settings, Bills.</p>
          <Link to="/orders/takeaway" className="type-button flex min-h-12 items-center justify-center rounded-lg bg-accent px-4 text-on-accent">
            Start a takeaway instead
          </Link>
        </div>
      </main>
    );
  }

  const busy = paying !== null;

  return (
    <main className="v2 flex min-h-full flex-col gap-4 bg-ground px-4 pb-4 pt-4 text-ink lg:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="type-title">Counter sale</h1>
          <p className="type-caption text-muted">Tap the items, then how the guest pays. It goes to the kitchen, is billed and paid in one tap.</p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the menu"
          aria-label="Search the menu"
          className="type-body min-h-12 w-full rounded-lg border border-line bg-surface px-4 sm:w-72"
        />
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          <MenuPicker
            tree={menuQuery.data}
            isPending={menuQuery.isPending}
            isError={menuQuery.isError}
            search={search}
            compact
            disabled={busy}
            simpleLines={simpleLines}
            pendingCounts={pendingCounts}
            onStep={step}
            onRemove={remove}
            onOpen={(item) => (isPlain(item) && !simpleLines.has(item.id) ? add(item, { menuItemId: item.id, quantity: 1 }) : setPicking(item))}
          />
        </div>

        <aside
          aria-label="This sale"
          className="flex w-full flex-none flex-col rounded-[10px] border border-line bg-surface lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-[380px] xl:w-[420px]"
        >
          {done && cart.length === 0 ? (
            <Done done={done} onGiven={(given) => setDone((current) => ({ ...current, given }))} onPrint={reprint} onNext={() => setDone(null)} />
          ) : (
            <>
              <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
                <h2 className="type-heading">This sale</h2>
                <span className="type-caption text-muted">
                  <span className="type-num-meta text-ink">{itemCount}</span> {itemCount === 1 ? 'item' : 'items'}
                </span>
              </div>

              <ul className="min-h-24 flex-1 divide-y divide-line overflow-y-auto">
                {cart.length === 0 && <li className="type-body px-4 py-6 text-muted">Tap a dish to start.</li>}
                {cart.map((line) => (
                  <li key={line.key} className="flex items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="type-body font-semibold">{line.payload.openItem?.name ?? line.item.name}</p>
                      {lineDetail(line.item, line.payload) && <p className="type-caption text-muted">{lineDetail(line.item, line.payload)}</p>}
                      <Money paise={linePrice(line.item, line.payload)} size="num" />
                    </div>
                    <div className="flex flex-none items-center rounded-lg border border-ink">
                      <button
                        type="button"
                        aria-label={line.payload.quantity === 1 ? `Remove ${line.item.name}` : 'One fewer'}
                        disabled={busy}
                        onClick={() => (line.payload.quantity === 1 ? remove(line) : step(line, line.payload.quantity - 1))}
                        className="flex size-12 items-center justify-center rounded-lg hover:bg-sunken disabled:opacity-50"
                      >
                        <MinusIcon />
                      </button>
                      <span className="type-num min-w-6 text-center">{line.payload.quantity}</span>
                      <button
                        type="button"
                        aria-label="One more"
                        disabled={busy}
                        onClick={() => step(line, line.payload.quantity + 1)}
                        className="flex size-12 items-center justify-center rounded-lg hover:bg-sunken disabled:opacity-50"
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
                <label className="flex flex-col gap-1">
                  <span className="type-label">Name to call <span className="text-muted">(optional)</span></span>
                  <input
                    value={callName}
                    maxLength={100}
                    onChange={(event) => setCallName(event.target.value)}
                    className="type-body min-h-12 rounded-lg border border-line bg-ground px-3"
                  />
                </label>
                <div className="flex items-baseline justify-between">
                  <span className="type-label text-muted">Item total, GST added on the bill</span>
                  <Money paise={itemTotal} size="tile" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {methods.map((method) => (
                    <button
                      key={method.code}
                      type="button"
                      disabled={cart.length === 0 || busy}
                      onClick={() => pay(method)}
                      className="type-button min-h-16 rounded-lg bg-accent px-2 text-on-accent hover:brightness-110 disabled:opacity-40"
                    >
                      {paying === method.code ? 'Paying…' : method.name}
                    </button>
                  ))}
                </div>
                {methodsQuery.isSuccess && methods.length === 0 && (
                  <p className="type-caption text-alert">No payment method is set up for takeaway. Add one in Settings, Payment methods.</p>
                )}
                <p className="type-caption text-muted">Tapping how they pay sends the order, makes the bill and records the payment.</p>
              </div>
            </>
          )}
        </aside>
      </div>

      {picking && (
        <LineOptionsPanel
          item={picking}
          isBusy={busy}
          onCancel={() => setPicking(null)}
          onConfirm={(payload) => {
            add(picking, payload);
            setPicking(null);
          }}
        />
      )}

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

/** After the payment: what to say to the guest, and the change on cash. */
function Done({ done, onGiven, onPrint, onNext }) {
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
          {done.given !== null && (
            <p className="type-heading">
              Give back <Money paise={done.given - total} size="tile" />
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button type="button" onClick={onNext} className="type-button min-h-14 rounded-lg bg-accent text-on-accent hover:brightness-110">
          Next guest
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onPrint} className="type-button min-h-12 rounded-lg border border-ink bg-surface hover:bg-sunken">
            {done.printed ? 'Print again' : 'Print receipt'}
          </button>
          <Link to={`/bills/${done.bill.id}`} className="type-button flex min-h-12 items-center justify-center rounded-lg border border-ink bg-surface hover:bg-sunken">
            Open bill
          </Link>
        </div>
      </div>
    </div>
  );
}
