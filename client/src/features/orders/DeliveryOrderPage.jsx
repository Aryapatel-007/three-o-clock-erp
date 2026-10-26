import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';

import { TickIcon } from '../../components/ui/icons/index.jsx';
import Money from '../../components/ui/Money.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { getMenuTree } from '../../api/menu.js';
import { createOrder, fireOrder } from '../../api/orders.js';
import Bilingual from '../i18n/Bilingual.jsx';
import { errorMessage } from './errorCopy.js';
import MenuSearch from './MenuSearch.jsx';
import LineOptionsPanel from './LineOptionsPanel.jsx';
import MenuPicker from './MenuPicker.jsx';
import { PLATFORMS } from './platforms.js';

const PLATFORM_ORDER_ID = /^[A-Za-z0-9]{3,40}$/;

/**
 * A new Zomato or Swiggy order, typed in by hand from the platform's tablet.
 * P06, one screen.
 *
 * Platform, the platform's order number, then the dishes, all before anything
 * is saved. The order is a draft held on this screen until "Send to kitchen",
 * which creates the order with its lines in one request and then fires it.
 * Nothing exists on the server until then, so Clear really does throw it away,
 * and a number already entered is refused at that moment with a link to the
 * order that has it.
 *
 * The prices on the summary are the menu's, shown for reading out. The server
 * prices every line from the menu when the order is created, and decides the
 * GST when the bill is made: a platform order is frozen at 0% when the
 * platform pays the GST, a setting pending the CA's confirmation.
 */
export default function DeliveryOrderPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [platformCode, setPlatformCode] = useState(null);
  const [platformOrderId, setPlatformOrderId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState([]);
  const [pickingItem, setPickingItem] = useState(null);
  const [toast, setToast] = useState(null);
  const [existingOrderId, setExistingOrderId] = useState(null);

  const menuQuery = useQuery({
    queryKey: ['menu', { includeUnavailable: false }],
    queryFn: () => getMenuTree({ includeUnavailable: false }),
    staleTime: 60_000,
  });

  const itemsById = useMemo(() => {
    const map = new Map();
    for (const category of menuQuery.data ?? []) {
      for (const item of category.items) map.set(item.id, item);
    }
    return map;
  }, [menuQuery.data]);

  /** Draft lines with no size, extras or note, by dish, so a second tap raises the quantity. */
  const { simpleLines, pendingCounts } = useMemo(() => {
    const simple = new Map();
    const counts = new Map();
    for (const line of draft) {
      counts.set(line.menuItemId, (counts.get(line.menuItemId) ?? 0) + line.quantity);
      // P46. Two open items are two dishes, whatever their card: never merged.
      const isSimple = !line.variantId && line.addOnIds.length === 0 && !line.notes && !line.openItem && !(line.extras ?? []).length;
      if (isSimple && !simple.has(line.menuItemId)) simple.set(line.menuItemId, line);
    }
    return { simpleLines: simple, pendingCounts: counts };
  }, [draft]);

  const platform = PLATFORMS.find((entry) => entry.code === platformCode) ?? null;
  const orderIdValid = PLATFORM_ORDER_ID.test(platformOrderId.trim());
  const itemCount = draft.reduce((sum, line) => sum + line.quantity, 0);
  const itemTotal = draft.reduce((sum, line) => sum + line.unitInPaise * line.quantity, 0);

  const missing = !platform
    ? 'Choose the platform'
    : !orderIdValid
      ? 'Enter the platform order number'
      : draft.length === 0
        ? 'Add a dish'
        : null;

  const addLine = (line) => {
    const item = itemsById.get(line.menuItemId);
    const variant = item?.variants.find((entry) => entry.id === line.variantId);
    const addOns = (item?.addOns ?? []).filter((entry) => (line.addOnIds ?? []).includes(entry.id));
    // P46. An open item's price is the one typed; the menu's is not used.
    // P48. Typed extras add their own prices.
    const extrasInPaise = (line.extras ?? []).reduce((sum, extra) => sum + extra.priceInPaise, 0);
    const unitInPaise = line.openItem
      ? line.openItem.priceInPaise
      : (variant ? variant.priceInPaise : item?.priceInPaise ?? 0) + addOns.reduce((sum, addOn) => sum + addOn.priceInPaise, 0) + extrasInPaise;

    setDraft((current) => [
      ...current,
      {
        id: `${line.menuItemId}-${Date.now()}-${current.length}`,
        menuItemId: line.menuItemId,
        variantId: line.variantId ?? null,
        addOnIds: line.addOnIds ?? [],
        notes: line.notes ?? null,
        quantity: line.quantity,
        name: line.openItem?.name ?? item?.name ?? 'Dish',
        openItem: line.openItem ?? null,
        extras: line.extras ?? [],
        detail: [variant?.name, ...addOns.map((addOn) => addOn.name), ...(line.extras ?? []).map((extra) => extra.name), line.notes && `“${line.notes}”`]
          .filter(Boolean)
          .join(' · '),
        unitInPaise,
      },
    ]);
  };

  const setQuantity = (line, quantity) =>
    setDraft((current) =>
      quantity <= 0
        ? current.filter((entry) => entry.id !== line.id)
        : current.map((entry) => (entry.id === line.id ? { ...entry, quantity } : entry)),
    );

  const save = useMutation({
    mutationFn: async ({ fire }) => {
      const order = await createOrder({
        orderType: 'DELIVERY',
        platform: { code: platformCode, orderId: platformOrderId.trim() },
        ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
        lines: draft.map((line) => ({
          menuItemId: line.menuItemId,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          quantity: line.quantity,
          ...(line.addOnIds.length > 0 ? { addOnIds: line.addOnIds } : {}),
          ...(line.notes ? { notes: line.notes } : {}),
          ...(line.openItem ? { openItem: line.openItem } : {}),
          ...(line.extras?.length ? { extras: line.extras } : {}),
        })),
      });
      if (!fire) return { order, fired: false };
      try {
        await fireOrder(order.id, order.version);
        return { order, fired: true };
      } catch {
        // The order exists; its own screen shows the lines still to send.
        return { order, fired: false, fireFailed: true };
      }
    },
    onSuccess: ({ order }) => {
      queryClient.invalidateQueries({ queryKey: ['kots'] });
      navigate(`/orders/${order.id}`);
    },
    onError: (error) => {
      setExistingOrderId(error?.existingOrderId ?? null);
      setToast({ tone: 'error', message: errorMessage(error) });
    },
  });

  const clear = () => {
    setDraft([]);
    setPlatformOrderId('');
    setCustomerName('');
    setExistingOrderId(null);
  };

  return (
    <main className="v2 min-h-full bg-ground px-4 py-4 text-ink lg:px-6">
      <div className="mx-auto flex max-w-[1720px] flex-col gap-6 lg:flex-row lg:items-start">
        {/* Left: platform, number, menu. */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
            <div>
              <p className="type-label text-muted">
                <Link to="/floor" className="inline-flex min-h-12 items-center hover:text-ink">Orders</Link> ›{' '}
                <span className="text-ink">New delivery order</span>
              </p>
              <h1 className="mt-1 type-title">
                New delivery order
              </h1>
            </div>
            <span className="type-caption text-muted">Entered by hand from the platform tablet</span>
          </div>

          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Platform">
            {PLATFORMS.map((entry) => {
              const chosen = platformCode === entry.code;
              return (
                <button
                  key={entry.code}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => setPlatformCode(entry.code)}
                  className={[
                    'flex min-h-20 flex-col justify-between rounded-[10px] border p-3 text-left transition-colors',
                    chosen ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
                  ].join(' ')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="type-heading">{entry.name}</span>
                    {chosen && <TickIcon />}
                  </span>
                  <span className="type-caption text-muted">Paid by {entry.name}, settled in its payout</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-4 rounded-[10px] bg-surface p-4 border border-line md:flex-row md:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="type-label text-muted">
                Platform order number
              </span>
              <span className="relative">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={platformOrderId}
                  maxLength={40}
                  onChange={(event) => {
                    setPlatformOrderId(event.target.value);
                    setExistingOrderId(null);
                  }}
                  placeholder="249377796192385"
                  className="type-num min-h-12 w-full rounded-lg border border-muted bg-surface px-4 pr-32 placeholder:text-muted"
                />
                {orderIdValid && <StateChip state="ok" word="Looks right" size="sm" className="absolute right-2 top-3" />}
              </span>
            </label>
            <label className="flex flex-col gap-1 md:w-64">
              <span className="type-label text-muted">
                Customer name, optional
              </span>
              <input
                type="text"
                value={customerName}
                maxLength={100}
                onChange={(event) => setCustomerName(event.target.value)}
                className="type-body min-h-12 w-full rounded-lg border border-muted bg-surface px-4"
              />
            </label>
          </div>

          {existingOrderId && (
            <p className="type-body rounded-[10px] border border-line border-l-[3px] border-l-alert bg-surface px-4 py-3">
              This platform order number is already on an open order.{' '}
              <Link to={`/orders/${existingOrderId}`} className="font-semibold text-accent underline underline-offset-4">
                Open that order
              </Link>
            </p>
          )}

          <MenuSearch value={search} onChange={setSearch} />

          <MenuPicker
            tree={menuQuery.data}
            isPending={menuQuery.isPending}
            isError={menuQuery.isError}
            search={search}
            compact
            disabled={save.isPending}
            simpleLines={simpleLines}
            pendingCounts={pendingCounts}
            onStep={setQuantity}
            onRemove={(line) => setQuantity(line, 0)}
            onOpen={(item) => setPickingItem(item)}
          />
        </div>

        {/* Right: the order summary. */}
        <aside className="flex w-full flex-none flex-col lg:sticky lg:top-4 lg:w-[420px] xl:w-[460px]">
          <div className="flex flex-col gap-4 rounded-[10px] border border-line bg-surface p-4 lg:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="type-heading">Delivery order summary</h2>
                <p className="type-num-meta mt-1 text-muted">
                  {platform && orderIdValid ? `${platform.name} ${platformOrderId.trim()}` : 'Not saved yet'}
                </p>
              </div>
            </div>

            {draft.length === 0 ? (
              <p className="type-body rounded-lg bg-sunken px-4 py-8 text-muted">
                Tap a dish on the left to add it.
              </p>
            ) : (
              <ul className="flex max-h-[320px] flex-col gap-3 overflow-y-auto pr-1">
                {draft.map((line) => (
                  <li
                    key={line.id}
                    className="flex items-center justify-between gap-2 border-b border-line py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="type-body line-clamp-2 break-words font-semibold" title={line.name}>
                        {line.name}
                      </p>
                      {line.detail && <p className="type-caption truncate text-muted">{line.detail}</p>}
                      <Money paise={line.unitInPaise * line.quantity} tabular size="num" />
                    </div>
                    <div className="flex flex-none items-center rounded-lg border border-ink">
                      <button
                        type="button"
                        aria-label={line.quantity === 1 ? `Remove ${line.name}` : 'One fewer'}
                        onClick={() => setQuantity(line, line.quantity - 1)}
                        className="flex size-12 items-center justify-center rounded-lg hover:bg-sunken"
                      >
                        −
                      </button>
                      <span aria-live="polite" className="type-num w-6 text-center">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label="One more"
                        onClick={() => setQuantity(line, line.quantity + 1)}
                        className="flex size-12 items-center justify-center rounded-lg hover:bg-sunken"
                      >
                        +
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <p className="type-caption text-muted">
              <span>
                GST 0% when the platform pays the GST on this order under section 9(5), as set in
                Settings. The bill works it out.
              </span>
            </p>

            <div className="flex items-end justify-between px-1">
              <div>
                <span className="type-label block">
                  Item total, <span className="type-num">{itemCount}</span> {itemCount === 1 ? 'item' : 'items'}
                </span>
                <span className="type-caption text-muted">Before GST · the bill has the final total</span>
              </div>
              <Money paise={itemTotal} size="tile" />
            </div>

            <div className="flex flex-col gap-3">
              <button
                type="button"
                disabled={Boolean(missing) || save.isPending}
                onClick={() => save.mutate({ fire: true })}
                className="flex min-h-14 w-full items-center justify-center gap-2 rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-50"
              >
                {save.isPending ? 'Sending…' : missing ? <span className="type-button">{missing}</span> : <Bilingual k="sendToKitchen" align="center" />}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={Boolean(missing) || save.isPending}
                  onClick={() => save.mutate({ fire: false })}
                  className="type-label min-h-12 rounded-lg border border-ink bg-surface hover:bg-sunken disabled:opacity-50"
                >
                  Save without sending
                </button>
                <button
                  type="button"
                  disabled={save.isPending || (draft.length === 0 && !platformOrderId)}
                  onClick={clear}
                  className="type-label min-h-12 rounded-lg text-alert hover:bg-alert-tint disabled:opacity-50"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {pickingItem && (
        <LineOptionsPanel
          item={pickingItem}
          isBusy={false}
          onCancel={() => setPickingItem(null)}
          onConfirm={(line) => {
            addLine(line);
            setPickingItem(null);
          }}
        />
      )}

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}
