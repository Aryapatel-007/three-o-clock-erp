import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { BackIcon } from '../../components/ui/icons/index.jsx';
import Money from '../../components/ui/Money.jsx';
import Sheet, { SheetActions } from '../../components/ui/Sheet.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { getMenuTree } from '../../api/menu.js';
import { getBill } from '../../api/bills.js';
import {
  addOrderLines,
  cancelOrder,
  cancelOrderLine,
  closeOrder,
  editOrderLine,
  removeOrderLine,
  fireOrder,
  reduceOrderLine,
  undoSend,
  getOrder,
  giveNoCharge,
  markLineServed,
  moveOrderToTable,
  setKitchenNote,
  setOrderCustomer,
} from '../../api/orders.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { getKotTicket } from '../../api/kitchen.js';
import { charactersFor, printText } from '../printing/printText.js';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import { formatTimeIst } from '../../utils/formatDate.js';
import BillOrderButton from '../billing/BillOrderButton.jsx';
import SettlePanel, { PaidPanel, usePrintBill } from '../billing/SettlePanel.jsx';
import Bilingual from '../i18n/Bilingual.jsx';
import CancelPanel from './CancelPanel.jsx';
import GuestDetailsSheet from './GuestDetailsSheet.jsx';
import KitchenNoteSheet from './KitchenNoteSheet.jsx';
import { LINE_CANCEL_REASONS, ORDER_CANCEL_REASONS } from './cancelReasons.js';
import LineOptionsPanel from './LineOptionsPanel.jsx';
import MenuPicker from './MenuPicker.jsx';
import MoveTablePanel from './MoveTablePanel.jsx';
import NoChargePanel from './NoChargePanel.jsx';
import OrderLineList from './OrderLineList.jsx';
import SentLineSheet, { MADE } from './SentLineSheet.jsx';
import { errorMessage, shouldRefetch } from './errorCopy.js';
import { placeLabel } from './orderLabel.js';

import Spinner from '../../components/ui/Spinner.jsx';

/** P41. How long the Undo bar stays after a Send. Matches the server's UNDO_SEND_WINDOW_MS. */
const UNDO_SEND_MS = 60_000;

/** Only these two may cancel a whole order. The server is what enforces it. */
const CAN_CANCEL_ORDER = ['OWNER', 'MANAGER'];
/** P28. Owners and managers approve their own work; anyone else may need a PIN. */
const APPROVES_OWN = ['OWNER', 'MANAGER'];

/** A line that has been to the kitchen has to answer the wasPrepared question. */
const REACHED_KITCHEN = ['FIRED', 'READY', 'SERVED'];

const ORDER_TYPE_LABELS = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** The order's state as a chip, in the floor's words. */
function orderChip(order) {
  switch (order.status) {
    case 'READY_TO_BILL':
      return { state: 'served', word: 'Served, waiting for the cashier' };
    case 'BILLED':
      return { state: 'ok', word: 'Billed' };
    case 'CANCELLED':
      return { state: 'alert', word: 'Cancelled' };
    case 'NO_CHARGE':
      return { state: 'ok', word: 'No Charge, no bill' };
    default:
      return { state: 'open', word: 'Open' };
  }
}

/**
 * One order.
 *
 * While the order is open the menu fills the screen and the order itself sits
 * in a bar along the bottom, opening into a slide-over. Once it is waiting for
 * the cashier, or closed, the menu goes and the lines are the page.
 *
 * The thing worth understanding here is how a 409 is handled. Two waiters can
 * both have this screen open on one table. Every write carries the version this
 * screen last read, and the server rejects the second one. When that happens
 * the order is refetched and a plain sentence is shown, and nothing the waiter
 * had half-typed is thrown away: the panels hold their own state and are not
 * unmounted by a refetch.
 */
export default function OrderScreenPage() {
  const { orderId } = useParams();
  const queryClient = useQueryClient();
  const { user, features } = useAuth();
  // P48. KOT & Print prints on this device's printer.
  const [device] = useDeviceSettings();
  const approvals = features.approvals ?? { lineCancel: true, paidIn: true, managerTasks: true };
  const approvesOwn = APPROVES_OWN.includes(user?.role);

  const [toast, setToast] = useState(null);
  // The payment just taken on this page, for the paid view: total, change and print.
  const [paidDone, setPaidDone] = useState(null);
  const billPrinter = usePrintBill();
  const [search, setSearch] = useState('');
  const [pickingItem, setPickingItem] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const navigate = useNavigate();
  const [isReviewing, setIsReviewing] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  // P26. Opened from a bill's Add items, the menu shows at once.
  const [searchParams] = useSearchParams();
  const [addingMore, setAddingMore] = useState(() => searchParams.get('add') === '1');
  // P42. The sent dish being changed, and the dish a swap is replacing, for the menu's banner.
  const [changingLine, setChangingLine] = useState(null);
  const [swapFor, setSwapFor] = useState(null);
  /**
   * P40. A manager's approval for adding to a printed bill, kept in memory for
   * this visit once a dish has gone on with it, so the next dishes need no
   * second PIN. Never stored on the device; leaving the screen forgets it.
   */
  const [printedBillApproval, setPrintedBillApproval] = useState(null);
  /**
   * P56. The note for all dishes being edited, and the guest's details asked
   * on a table's first Send. `askingGuest` holds the send waiting for them;
   * Skip is remembered for this visit to the screen.
   */
  const [isNotingAll, setIsNotingAll] = useState(false);
  const [askingGuest, setAskingGuest] = useState(null);
  const [guestSkipped, setGuestSkipped] = useState(false);
  /**
   * P41. The last Send, for its Undo bar. The server allows the undo for 60
   * seconds and only while nothing is ready; the bar shows for the same minute
   * and the server has the last word.
   */
  const [lastSendAt, setLastSendAt] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lastSendAt) return undefined;
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current - lastSendAt >= UNDO_SEND_MS) setLastSendAt(null);
    }, 1000);
    return () => clearInterval(tick);
  }, [lastSendAt]);

  const orderQuery = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => getOrder(orderId),
  });

  const menuQuery = useQuery({
    queryKey: ['menu', { includeUnavailable: false }],
    // The ordering screen's read: only what can actually be sold right now.
    queryFn: () => getMenuTree({ includeUnavailable: false }),
    staleTime: 60_000,
  });

  const order = orderQuery.data;

  // P29. An order with a bill nothing is paid on takes more dishes, which revise that bill.
  const billQuery = useQuery({
    queryKey: ['bill', order?.billId],
    queryFn: () => getBill(order.billId),
    enabled: Boolean(order?.billId),
  });

  /**
   * Every write goes through here so the version handling exists once.
   *
   * On any failure the order is refetched when the code says our copy is stale,
   * which covers both a version conflict and a line someone else removed. The
   * refetch replaces the data, not the screen, so an open panel keeps whatever
   * was typed into it.
   */
  const write = useMutation({
    mutationFn: ({ run }) => run(),
    onSuccess: (updated, variables) => {
      // Fire returns { kots, kot, order }; everything else returns the order itself.
      const next = updated?.order ?? updated;
      queryClient.setQueryData(['order', orderId], next);
      queryClient.invalidateQueries({ queryKey: ['tables'] });
      queryClient.invalidateQueries({ queryKey: ['kots'] });
      if (next?.billId) queryClient.invalidateQueries({ queryKey: ['bill', next.billId] });

      if (variables.successMessage) {
        setToast({ tone: 'success', message: variables.successMessage });
      }
      variables.onDone?.();
    },
    onError: (error, variables) => {
      if (shouldRefetch(error)) orderQuery.refetch();
      setToast({ tone: 'error', message: errorMessage(error) });
      variables.onFailed?.(error);
    },
  });

  const run = (options) => write.mutate(options);

  /**
   * Unsent lines grouped by dish, for the menu cards. A "simple" line has no
   * size, extras or note, so another tap on the same dish can just raise its
   * quantity.
   */
  const { simpleLines, pendingCounts } = useMemo(() => {
    const simple = new Map();
    const counts = new Map();
    for (const line of order?.lines ?? []) {
      if (line.status !== 'PENDING') continue;
      counts.set(line.menuItemId, (counts.get(line.menuItemId) ?? 0) + line.quantity);
      // P46. Two open items are two dishes, whatever their card: never merged.
      const isSimple = !line.variantId && line.addOns.length === 0 && !line.notes && !line.isOpenItem;
      // P29. With a bill, a line changes only through the bill, so a tap adds a new line.
      if (isSimple && !order.billId && !simple.has(line.menuItemId)) simple.set(line.menuItemId, line);
    }
    return { simpleLines: simple, pendingCounts: counts };
  }, [order]);

  if (orderQuery.isPending) {
    return <Shell><Spinner label="Loading the order" /></Shell>;
  }

  if (orderQuery.isError) {
    return (
      <Shell>
        <p className="type-body text-alert">{errorMessage(orderQuery.error)}</p>
        <Link to="/floor" className="mt-3 inline-block type-caption underline">
          Back to the tables
        </Link>
      </Shell>
    );
  }

  const liveLines = order.lines.filter((line) => line.status !== 'CANCELLED');
  const itemCount = liveLines.reduce((sum, line) => sum + line.quantity, 0);
  const pendingCount = order.lines.filter((line) => line.status === 'PENDING').length;
  const isOpen = order.status === 'OPEN';
  // P26. A served table, with no bill yet, can order more: the menu shows again.
  // P29. So can one whose bill nothing is paid on yet: the dishes revise that bill.
  const hasBill = Boolean(order.billId);
  // P39. A captain changes nothing on an order whose bill has printed: the counter does.
  const captainLockedOut = user?.role === 'WAITER' && hasBill && (billQuery.data?.printCount ?? 0) > 0;
  const canAddMore = order.status === 'READY_TO_BILL' && (!hasBill || Boolean(billQuery.data?.revisable)) && !captainLockedOut;
  const showMenu = (isOpen || (canAddMore && addingMore)) && !captainLockedOut;
  /**
   * Once everything is served, the money is taken here, beside the dishes:
   * no separate bill page in service. The till, or a captain the owner lets
   * take payment. A platform delivery is billed the old way.
   */
  const takesPayment =
    ['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role) ||
    (user?.role === 'WAITER' && Boolean(features?.billing?.captainsMayBill) && Boolean(features?.billing?.captainsMayTakePayment));
  const settleHere = takesPayment && order.orderType !== 'DELIVERY' && order.status === 'READY_TO_BILL' && !addingMore;
  // P40. A dish going onto a printed bill needs a manager, unless one already approved this visit.
  const addsToPrintedBill =
    !approvesOwn && hasBill && !billQuery.data?.isVoided && (approvals.revisePrintedBill ?? true) && (billQuery.data?.printCount ?? 0) > 0;
  const addNeedsApproval = addsToPrintedBill && !printedBillApproval;
  // P28. A cashier may too, with a PIN, when the owner allows it.
  const canCancelOrder = CAN_CANCEL_ORDER.includes(user?.role) || (user?.role === 'CASHIER' && approvals.managerTasks);
  const canMove = isOpen && order.orderType === 'DINE_IN';
  // P50. Nothing ever sent to the kitchen: anyone who takes orders closes it, opened by mistake.
  const canClose = isOpen && !hasBill && order.lines.every((line) => !line.firedAt && ['PENDING', 'CANCELLED'].includes(line.status));
  const placeName = order.orderType === 'DINE_IN' ? order.tableName ?? 'this table' : `order #${order.orderNumber}`;
  // Takeaway and delivery have no table, so on a wide screen the order is a
  // ledger beside the menu rather than a bar and a slide-over.
  // P48. The till's computer gets PetPooja's counter screen for every order: menu beside the order.
  const isTill = ['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role);
  const isCounter = order.orderType !== 'DINE_IN' || isTill;

  const changeQuantity = (line, quantity) =>
    run({
      run: () => editOrderLine(order.id, line.id, { version: order.version, quantity }),
    });

  /** P49. A dish not sent yet: gone at once, with no reason and nothing kept. */
  const removeDraft = (line) =>
    run({
      run: () => removeOrderLine(order.id, line.id, order.version),
      successMessage: `${line.itemName} removed.`,
    });

  /**
   * P56. A table's first Send asks for the guest's details, unless the order
   * has them (a seated booking does) or this screen skipped them already.
   */
  const needsGuestDetails =
    order.orderType === 'DINE_IN' &&
    !hasBill &&
    !order.customerName &&
    !order.customerPhone &&
    !guestSkipped &&
    order.lines.every((line) => !line.firedAt);
  const askGuestThen = (send) => (needsGuestDetails ? setAskingGuest({ send }) : send(null));

  /** P56. The guest's details first, when given, then the Send on the version they leave. */
  const sendToKitchen = async (guest) => {
    let { version } = order;
    if (guest) ({ version } = await setOrderCustomer(order.id, { version, ...guest }));
    return fireOrder(order.id, version);
  };
  const afterGuestFailed = () => {
    setAskingGuest(null);
    orderQuery.refetch();
  };

  const fire = (guest = null) =>
    run({
      run: () => sendToKitchen(guest),
      onDone: () => {
        setIsReviewing(false);
        setAskingGuest(null);
        // P41. The bar says "Sent to the kitchen." with its Undo, instead of a toast.
        setToast(null);
        setNow(Date.now());
        setLastSendAt(Date.now());
      },
      onFailed: afterGuestFailed,
    });

  /** P48. KOT & Print: send, then print each new ticket on this device's printer. */
  const fireAndPrint = (guest = null) =>
    run({
      run: async () => {
        const result = await sendToKitchen(guest);
        try {
          for (const kot of result.kots ?? [result.kot]) {
            const { text } = await getKotTicket(kot.id, { width: charactersFor(device.printer), ...(result.round ? { round: result.round } : {}) });
            await printText(text, device.printer);
          }
        } catch {
          setToast({ tone: 'error', message: 'Sent to the kitchen, but the KOT did not print. Reprint it from the kitchen screen.' });
        }
        return result;
      },
      onDone: () => {
        setIsReviewing(false);
        setAskingGuest(null);
        setNow(Date.now());
        setLastSendAt(Date.now());
      },
      onFailed: afterGuestFailed,
    });

  /** P56. One note for every dish; null clears it. */
  const saveKitchenNote = (kitchenNote) =>
    run({
      run: () => setKitchenNote(order.id, { version: order.version, kitchenNote }),
      successMessage: kitchenNote ? 'Note saved for all dishes.' : 'Note cleared.',
      onDone: () => setIsNotingAll(false),
    });
  const canNoteAll = isOpen || order.status === 'READY_TO_BILL';

  const undoLastSend = () =>
    run({
      run: () => undoSend(order.id, order.version),
      successMessage: 'Taken back from the kitchen. The dishes are on the order, not sent.',
      onDone: () => setLastSendAt(null),
      onFailed: () => setLastSendAt(null),
    });

  const details = (
    <OrderDetails
      order={order}
      isOpen={isOpen}
      locked={hasBill}
      readyMeansServed={features.kitchen?.readyMeansServed ?? true}
      isBusy={write.isPending}
      pendingCount={pendingCount}
      canCancelOrder={canCancelOrder}
      onChangeQuantity={changeQuantity}
      onServeLine={(line) =>
        run({
          run: () => markLineServed(order.id, line.id, order.version),
          successMessage: 'Marked served.',
        })
      }
      onCancelLine={(line) => setCancelling({ kind: 'line', line })}
      onRemoveDraft={removeDraft}
      onChangeSentLine={(line) => setChangingLine(line)}
      onFire={() => askGuestThen(fire)}
      onFireAndPrint={isTill ? () => askGuestThen(fireAndPrint) : null}
      onCancelOrder={() => setCancelling({ kind: 'order' })}
      onCloseOrder={canClose ? () => setCancelling({ kind: 'close' }) : null}
      closeLabel={order.orderType === 'DINE_IN' ? 'Close table' : 'Close order'}
      onNoCharge={() => setCancelling({ kind: 'noCharge' })}
    />
  );

  return (
    <Shell>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/floor"
            aria-label="Back to the floor"
            className="flex size-12 flex-none items-center justify-center rounded-lg border border-line bg-surface hover:bg-sunken"
          >
            <BackIcon />
          </Link>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="type-title">{placeLabel(order)}</h1>
              <StateChip {...orderChip(order)} size="sm" />
            </div>
            <p className="type-caption text-muted">
              {ORDER_TYPE_LABELS[order.orderType]}
              {order.guestCount != null && ` · ${order.guestCount} ${order.guestCount === 1 ? 'guest' : 'guests'}`}
              {' · '}
              <span className="type-num-meta">#{order.orderNumber}</span>
              {order.openedAt && (
                <>
                  {' · opened '}
                  <span className="type-num-meta">{formatTimeIst(order.openedAt)}</span>
                </>
              )}
              {order.customerName && ` · ${order.customerName}`}
            </p>
            {/* P56. The note for all dishes, while set. */}
            {order.kitchenNote && (
              <p className="type-caption mt-1">
                <span className="font-semibold">For all dishes:</span> {order.kitchenNote}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-2 sm:max-w-xl">
          {showMenu && (
            <label className="relative block w-full max-w-sm">
              <span className="sr-only">Search the menu</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search dishes"
                className="type-body min-h-12 w-full rounded-lg border border-muted bg-surface px-4 text-ink placeholder:text-muted"
              />
            </label>
          )}
          {canNoteAll && (
            <button
              type="button"
              disabled={write.isPending}
              onClick={() => setIsNotingAll(true)}
              className="type-button min-h-12 whitespace-nowrap rounded-lg border border-ink bg-surface px-4 hover:bg-sunken disabled:opacity-50"
            >
              Note for all dishes
            </button>
          )}
          {canMove && (
            <button
              type="button"
              disabled={write.isPending}
              onClick={() => setIsMoving(true)}
              className="type-button min-h-12 whitespace-nowrap rounded-lg border border-ink bg-surface px-4 hover:bg-sunken disabled:opacity-50"
            >
              Switch table
            </button>
          )}
          {canAddMore && !addingMore && (
            <button
              type="button"
              onClick={() => setAddingMore(true)}
              className="type-button min-h-12 whitespace-nowrap rounded-lg border border-ink bg-surface px-4 hover:bg-sunken"
            >
              {hasBill ? 'Add to this bill' : 'Add more dishes'}
            </button>
          )}
          {(!isOpen || hasBill) && !settleHere && !paidDone && <BillOrderButton order={order} />}
        </div>
        {captainLockedOut && (
          <p className="type-caption mt-2 rounded-lg bg-sunken px-3 py-2 text-muted">This bill has been printed. Only the counter or a manager can change it now.</p>
        )}
      </header>

      {showMenu ? (
        <div className={isCounter ? 'flex flex-1 flex-col gap-4 lg:flex-row lg:items-start' : 'contents'}>
          <div className={isCounter ? 'flex min-w-0 flex-1 flex-col gap-4' : 'contents'}>
          {/* P42. A swap: the old dish is off, the replacement is picked here and sent. */}
          {swapFor && (
            <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-line border-l-[3px] border-l-open bg-surface px-4 py-2">
              <p className="type-body">
                Pick the replacement for <span className="font-semibold">{swapFor}</span>, then send it.
              </p>
              <button type="button" onClick={() => setSwapFor(null)} className="type-label min-h-12 flex-none px-2 text-muted hover:text-ink">
                Dismiss
              </button>
            </div>
          )}
          <MenuPicker
            tree={menuQuery.data}
            isPending={menuQuery.isPending}
            isError={menuQuery.isError}
            search={search}
            compact={isCounter}
            disabled={write.isPending}
            simpleLines={simpleLines}
            pendingCounts={pendingCounts}
            onStep={changeQuantity}
            onRemove={removeDraft}
            onOpen={(item) => setPickingItem(item)}
          />

          <div
            className={[
              'sticky bottom-4 z-20 mx-auto mt-auto w-full max-w-5xl',
              isCounter ? 'lg:hidden' : '',
            ].join(' ')}
          >
            <div className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface p-2 pl-4 shadow-float">
              <button
                type="button"
                onClick={() => setIsReviewing(true)}
                className="flex min-h-12 min-w-0 flex-col items-start rounded-lg text-left"
              >
                <span className="flex items-baseline gap-2">
                  <span className="type-label">
                    <span className="type-num">{itemCount}</span> {itemCount === 1 ? 'item' : 'items'}
                  </span>
                  <Money paise={order.totals.subtotalInPaise} size="num" />
                </span>
                <span className="type-caption text-muted">
                  Item total, before GST
                  {pendingCount > 0 && ` · ${pendingCount} not sent`}
                </span>
              </button>

              <div className="flex flex-none items-center gap-2">
                {/* Shown on a phone too: it is the way to the sent dishes and their Change (P42). */}
                <button
                  type="button"
                  onClick={() => setIsReviewing(true)}
                  className="type-button flex min-h-12 items-center rounded-lg border border-ink px-3 hover:bg-sunken md:border-transparent md:px-4"
                >
                  Review<span className="hidden md:inline">&nbsp;order</span>
                </button>
                <button
                  type="button"
                  disabled={pendingCount === 0 || write.isPending}
                  onClick={() => askGuestThen(fire)}
                  className="min-h-14 rounded-lg bg-accent px-4 text-on-accent hover:brightness-110 disabled:opacity-50 sm:px-8"
                >
                  {pendingCount === 0 ? (
                    <span className="type-button">Nothing to send</span>
                  ) : (
                    <Bilingual k="sendToKitchen" en={`Send ${pendingCount} to kitchen`} keep align="center" />
                  )}
                </button>
              </div>
            </div>
          </div>
          </div>

          {isCounter && (
            <aside
              aria-label="This order"
              className="sticky top-4 hidden max-h-[calc(100vh-2rem)] w-[360px] flex-none flex-col overflow-hidden rounded-[10px] border border-line bg-surface lg:flex xl:w-[420px]"
            >
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <div>
                  <h2 className="type-heading">Current order</h2>
                  <p className="type-caption text-muted">
                    {placeLabel(order)}
                    {order.customerName && ` · ${order.customerName}`}
                    {order.customerPhone && ` · ${order.customerPhone}`}
                  </p>
                </div>
                <span className="type-num-meta text-muted">#{order.orderNumber}</span>
              </div>
              {details}
            </aside>
          )}
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 lg:flex-row lg:items-start lg:justify-center">
          <section aria-label="This order" className="w-full max-w-3xl rounded-[10px] bg-surface border border-line lg:flex-1">
            {details}
          </section>
          {paidDone ? (
            <aside aria-label="Paid" className="w-full flex-none rounded-[10px] border border-line bg-surface lg:w-[380px]">
              <PaidPanel
                done={paidDone}
                nextLabel={order.orderType === 'DINE_IN' ? 'Back to the floor' : 'Done'}
                onGiven={(given) => setPaidDone((current) => ({ ...current, given }))}
                onPrint={() =>
                  billPrinter
                    .print(paidDone.bill.id)
                    .then(() => setPaidDone((current) => ({ ...current, printed: true })))
                    .catch((error) => setToast({ tone: 'error', message: errorMessage(error) }))
                }
                onNext={() => navigate('/floor')}
              />
            </aside>
          ) : (
            settleHere && (!order.billId || billQuery.data) && (
              <div className="w-full flex-none lg:w-[380px]">
                <SettlePanel order={order} bill={order.billId ? (billQuery.data ?? null) : null} onPaid={(done) => setPaidDone({ ...done, given: null })} />
              </div>
            )
          )}
        </div>
      )}

      {isOpen && isReviewing && (
        <Sheet title={placeLabel(order)} subtitle={`#${order.orderNumber}`} onClose={() => setIsReviewing(false)}>
          {details}
        </Sheet>
      )}

      {pickingItem && (
        <LineOptionsPanel
          item={pickingItem}
          isBusy={write.isPending}
          needsApproval={addNeedsApproval}
          onCancel={() => setPickingItem(null)}
          onConfirm={(line, approvalBody) => {
            const approval = addsToPrintedBill ? (approvalBody.approval ?? printedBillApproval) : undefined;
            run({
              run: () => addOrderLines(order.id, { version: order.version, lines: [line], approval }),
              onDone: () => {
                if (approval) setPrintedBillApproval(approval);
                setPickingItem(null);
                setSwapFor(null);
              },
              // A refused PIN is forgotten, so the next dish asks again.
              onFailed: (error) => {
                if (error?.status === 401 || error?.status === 403) setPrintedBillApproval(null);
              },
            });
          }}
        />
      )}

      {isMoving && (
        <MoveTablePanel
          order={order}
          isBusy={write.isPending}
          onCancel={() => setIsMoving(false)}
          onConfirm={(table) =>
            run({
              run: () => moveOrderToTable(order.id, { version: order.version, tableId: table.id }),
              successMessage: `Moved to ${table.name}.`,
              onDone: () => setIsMoving(false),
            })
          }
        />
      )}

      {/* P42. Change a sent dish: fewer, a new note, remove it, or swap it. */}
      {changingLine && (
        <SentLineSheet
          key={changingLine.id}
          line={changingLine}
          needsApproval={!approvesOwn && approvals.lineCancel}
          isBusy={write.isPending}
          onClose={() => setChangingLine(null)}
          onSave={({ quantity, notes, ...answers }) =>
            run({
              run: async () => {
                let current = order;
                if (quantity !== undefined) current = await reduceOrderLine(order.id, changingLine.id, { version: current.version, quantity, ...answers });
                if (notes !== undefined) current = await editOrderLine(order.id, changingLine.id, { version: current.version, notes });
                return current;
              },
              successMessage: `${changingLine.itemName} changed. The kitchen can see it.`,
              onDone: () => setChangingLine(null),
            })
          }
          onRemove={(answers) =>
            run({
              run: () => cancelOrderLine(order.id, changingLine.id, { version: order.version, ...answers }),
              successMessage: `${changingLine.itemName} removed. The kitchen can see it.`,
              onDone: () => setChangingLine(null),
            })
          }
          onSwap={(answers) =>
            run({
              run: () => cancelOrderLine(order.id, changingLine.id, { version: order.version, ...answers }),
              onDone: () => {
                setSwapFor(changingLine.itemName);
                setChangingLine(null);
                setIsReviewing(false);
                setAddingMore(true);
              },
            })
          }
        />
      )}

      {cancelling?.kind === 'line' && (
        <CancelPanel
          title={`Cancel ${cancelling.line.itemName}`}
          reasons={LINE_CANCEL_REASONS}
          description="It stays on the order, marked cancelled, with the reason."
          needsWasPrepared={REACHED_KITCHEN.includes(cancelling.line.status)}
          needsApproval={!approvesOwn && approvals.lineCancel && MADE.includes(cancelling.line.status)}
          approvalWhenMade={!approvesOwn && approvals.lineCancel}
          isBusy={write.isPending}
          onCancel={() => setCancelling(null)}
          onConfirm={(answers) =>
            run({
              run: () =>
                cancelOrderLine(order.id, cancelling.line.id, {
                  version: order.version,
                  ...answers,
                }),
              successMessage: 'Line cancelled.',
              onDone: () => setCancelling(null),
            })
          }
        />
      )}

      {cancelling?.kind === 'order' && (
        <CancelPanel
          title={`Cancel order #${order.orderNumber}`}
          reasons={ORDER_CANCEL_REASONS}
          description="Every line goes with it. Nothing is deleted."
          needsWasPrepared={order.lines.some((line) => REACHED_KITCHEN.includes(line.status))}
          needsApproval={!approvesOwn}
          isBusy={write.isPending}
          onCancel={() => setCancelling(null)}
          onConfirm={(answers) =>
            run({
              run: () => cancelOrder(order.id, { version: order.version, ...answers }),
              successMessage: 'Order cancelled.',
              onDone: () => {
                setCancelling(null);
                setIsReviewing(false);
              },
            })
          }
        />
      )}

      {cancelling?.kind === 'close' && (
        <Sheet
          title={`Close ${placeName}?`}
          subtitle="It was opened by mistake. Nothing has gone to the kitchen, so nothing is recorded."
          onClose={() => setCancelling(null)}
          footer={
            <SheetActions
              cancelLabel="Keep it open"
              onCancel={() => setCancelling(null)}
              confirmLabel={order.orderType === 'DINE_IN' ? 'Close table' : 'Close order'}
              disabled={write.isPending}
              onConfirm={() =>
                run({
                  run: () => closeOrder(order.id, order.version),
                  onDone: () => {
                    setCancelling(null);
                    navigate('/floor');
                  },
                })
              }
            />
          }
        >
          {order.lines.some((line) => line.status === 'PENDING') && (
            <p className="type-body text-muted">The dishes not sent go with it.</p>
          )}
        </Sheet>
      )}

      {cancelling?.kind === 'noCharge' && (
        <NoChargePanel
          order={order}
          needsApproval={!approvesOwn}
          isBusy={write.isPending}
          onCancel={() => setCancelling(null)}
          onConfirm={(answers) =>
            run({
              run: () => giveNoCharge(order.id, { version: order.version, ...answers }),
              successMessage: 'No Charge given. The table is free.',
              onDone: () => {
                setCancelling(null);
                setIsReviewing(false);
              },
            })
          }
        />
      )}

      {isNotingAll && (
        <KitchenNoteSheet current={order.kitchenNote} isBusy={write.isPending} onCancel={() => setIsNotingAll(false)} onSave={saveKitchenNote} />
      )}

      {askingGuest && (
        <GuestDetailsSheet
          placeName={placeLabel(order)}
          isBusy={write.isPending}
          onCancel={() => setAskingGuest(null)}
          onSave={(guest) => askingGuest.send(guest)}
          onSkip={() => {
            setGuestSkipped(true);
            askingGuest.send(null);
          }}
        />
      )}

      {/* P41. Undo for a minute after a Send. */}
      {lastSendAt && (
        <div
          role="status"
          className="v2 fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-xl items-center gap-3 rounded-[10px] border border-line border-l-[3px] border-l-ok bg-surface px-4 py-3 text-ink shadow-float sm:inset-x-auto sm:bottom-5 sm:left-1/2 sm:w-[36rem] sm:-translate-x-1/2"
        >
          <p className="type-body flex-1">
            Sent to the kitchen.{' '}
            <span className="type-caption text-muted">
              Undo for <span className="type-num-meta">{Math.max(0, Math.ceil((UNDO_SEND_MS - (now - lastSendAt)) / 1000))}</span> s
            </span>
          </p>
          <button
            type="button"
            disabled={write.isPending}
            onClick={undoLastSend}
            className="type-button min-h-12 flex-none rounded-lg bg-accent px-5 text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            Undo
          </button>
          <button type="button" onClick={() => setLastSendAt(null)} className="type-label min-h-12 flex-none px-2 text-muted hover:text-ink">
            Dismiss
          </button>
        </div>
      )}

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </Shell>
  );
}

/**
 * The lines and what can be done to the order as a whole. Rendered inside the
 * slide-over while the order is open, and as the page once it is not.
 */
function OrderDetails({
  order,
  isOpen,
  locked = false,
  readyMeansServed = false,
  isBusy,
  pendingCount,
  canCancelOrder,
  onChangeQuantity,
  onServeLine,
  onCancelLine,
  onRemoveDraft,
  onChangeSentLine,
  onFire,
  // P48. The till's KOT & Print.
  onFireAndPrint = null,
  onCancelOrder,
  onNoCharge,
  // P50. Close an order nothing was sent from; null when something was.
  onCloseOrder = null,
  closeLabel = 'Close table',
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {locked && order.status !== 'BILLED' && (
          <p className="type-caption px-4 pt-3 text-muted">This table has a bill. Remove items from the bill.</p>
        )}
        <OrderLineList
          lines={order.lines}
          locked={locked}
          readyMeansServed={readyMeansServed}
          isBusy={isBusy}
          onChangeQuantity={onChangeQuantity}
          onServeLine={onServeLine}
          onCancelLine={onCancelLine}
          onRemoveDraft={onRemoveDraft}
          onChangeSentLine={onChangeSentLine}
        />
      </div>

      <footer className="flex flex-col gap-2 border-t border-line px-4 py-4">
        <div className="flex items-baseline justify-between">
          <span className="type-label text-muted">Item total</span>
          <Money paise={order.totals.subtotalInPaise} size="tile" />
        </div>

        {isOpen && (
          <button
            type="button"
            disabled={pendingCount === 0 || isBusy}
            onClick={onFire}
            className="type-button min-h-14 w-full rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {pendingCount === 0 ? 'Nothing new to send' : `Send ${pendingCount} to the kitchen`}
          </button>
        )}
        {isOpen && onFireAndPrint && pendingCount > 0 && (
          <button
            type="button"
            disabled={isBusy}
            onClick={onFireAndPrint}
            className="type-button min-h-12 w-full rounded-lg border border-ink bg-surface hover:bg-sunken disabled:opacity-50"
          >
            KOT & Print
          </button>
        )}

        {/* P08. Manager work, on an open order or one waiting for the cashier. */}
        {canCancelOrder && (isOpen || order.status === 'READY_TO_BILL') && (
          <button
            type="button"
            disabled={isBusy}
            onClick={onNoCharge}
            className="type-button min-h-12 w-full rounded-lg border border-ink bg-surface hover:bg-sunken disabled:opacity-50"
          >
            No Charge
          </button>
        )}

        {onCloseOrder && (
          <button
            type="button"
            disabled={isBusy}
            onClick={onCloseOrder}
            className="type-button min-h-12 w-full rounded-lg border border-ink bg-surface hover:bg-sunken disabled:opacity-50"
          >
            {closeLabel}
          </button>
        )}

        {isOpen && canCancelOrder && !onCloseOrder && (
          <button
            type="button"
            disabled={isBusy}
            onClick={onCancelOrder}
            className="type-button min-h-12 w-full rounded-lg text-alert hover:bg-alert-tint"
          >
            Cancel the whole order
          </button>
        )}
      </footer>
    </div>
  );
}

function Shell({ children }) {
  return (
    <main className="v2 flex min-h-full flex-col gap-4 bg-ground px-4 pb-4 pt-4 text-ink lg:px-6">{children}</main>
  );
}
