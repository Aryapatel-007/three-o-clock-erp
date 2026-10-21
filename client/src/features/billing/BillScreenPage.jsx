import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { BackIcon, PrintIcon } from '../../components/ui/icons/index.jsx';
import Button from '../../components/ui/Button.jsx';
import Money, { moneyText } from '../../components/ui/Money.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import {
  applyDiscount,
  correctPayment,
  getBill,
  requestBillPrint,
  recordPayment,
  applyAdvance,
  voidBill,
} from '../../api/bills.js';
import { chargeToAccount, createAccount } from '../../api/accounts.js';
import { listPaymentMethods } from '../../api/paymentMethods.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatBasisPoints } from '../../utils/formatMoney.js';
import { formatDateIst, formatTimeIst } from '../../utils/formatDate.js';
import { ROLES } from '../users/roles.js';
import Bilingual from '../i18n/Bilingual.jsx';
import BillStatusBadge from './BillStatusBadge.jsx';
import ChargeToAccountPanel from './ChargeToAccountPanel.jsx';
import CorrectPaymentPanel from './CorrectPaymentPanel.jsx';
import DiscountPanel from './DiscountPanel.jsx';
import CounterNotPrinting from './CounterNotPrinting.jsx';
import { discountReasonLabel } from './discountReasons.js';
import { errorMessage } from './errorCopy.js';
import InlinePayment from './InlinePayment.jsx';
import { methodsForBill, paymentMethodName } from './paymentMethodsForBill.js';
import { printBill } from '../printing/printBill.js';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import VoidBillPanel from './VoidBillPanel.jsx';
import AddItemsPanel from './AddItemsPanel.jsx';
import CancelItemsPanel from './CancelItemsPanel.jsx';
import RemoveItemPanel from './RemoveItemPanel.jsx';
import RevisionTimeline from './RevisionTimeline.jsx';
import { getOrder } from '../../api/orders.js';
import { BILL_VOID_REASONS, describeReason } from '../orders/cancelReasons.js';
import { placeLabel } from '../orders/orderLabel.js';

const CAN_DISCOUNT_OR_VOID = [ROLES.OWNER, ROLES.MANAGER];

/**
 * One bill. The screen a cashier looks at more than any other in this module,
 * so the total is the largest thing on it.
 *
 * Which action is primary changes with the bill's own state, and that is the
 * point: DESIGN-SYSTEM's "one primary action" rule is about what is true on
 * screen right now, not a button that is hard-coded primary regardless of
 * whether it is even the next useful thing to do. Unpaid, the primary action
 * is collecting the payment. Paid, it is printing the receipt.
 */
export default function BillScreenPage() {
  const { billId } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, features } = useAuth();

  const [toast, setToast] = useState(null);
  const [panel, setPanel] = useState(null); // 'payment' | 'discount' | 'void' | 'correct' | null
  const [correcting, setCorrecting] = useState(null); // the payment whose method is being changed
  const [printing, setPrinting] = useState(false);
  const [justPaid, setJustPaid] = useState(false);
  // P29. The bill line being taken off.
  const [removing, setRemoving] = useState(null);
  // P29 Part D. "Take payment without printing", for a guest who wants no paper.
  const [payWithoutPrint, setPayWithoutPrint] = useState(false);
  const location = useLocation();
  const autoPrinted = useRef(false);

  const billQuery = useQuery({
    queryKey: ['bill', billId],
    queryFn: () => getBill(billId),
    // P29 Part D. A captain waiting on the counter's print sees it land.
    refetchInterval: (query) => (waitingAtCounter(query.state.data) ? 5_000 : false),
  });

  const bill = billQuery.data;

  /**
   * P29. The order behind the bill: each line's kitchen status, for "Was it
   * already made?", and whether dishes added to the bill are still cooking.
   */
  const orderQuery = useQuery({
    queryKey: ['order', bill?.orderId],
    queryFn: () => getOrder(bill.orderId),
    enabled: Boolean(bill?.orderId) && !bill?.isVoided,
    refetchInterval: (query) => (query.state.data?.status === 'OPEN' ? 10_000 : false),
  });
  const order = orderQuery.data;

  // P08. The restaurant's configured methods, filtered to the ones this bill may use.
  const methodsQuery = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => listPaymentMethods(),
    staleTime: 60_000,
  });
  const allowedMethods = bill && methodsQuery.data ? methodsForBill(methodsQuery.data, bill) : [];

  const invalidate = (updated) => {
    queryClient.setQueryData(['bill', billId], updated);
    queryClient.invalidateQueries({ queryKey: ['bills'] });
    queryClient.invalidateQueries({ queryKey: ['tables'] });
    if (bill?.orderId) queryClient.invalidateQueries({ queryKey: ['order', bill.orderId] });
  };

  const discountMutation = useMutation({
    mutationFn: (body) => applyDiscount(billId, body),
    onSuccess: (updated) => {
      invalidate(updated);
      setPanel(null);
      setToast({ tone: 'success', message: 'Discount applied.' });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  const paymentMutation = useMutation({
    mutationFn: (body) => recordPayment(billId, body),
    onSuccess: (updated) => {
      invalidate(updated);
      setPanel(null);
      // DESIGN-SYSTEM section 10: the one moment of celebration.
      if (updated.status === 'PAID') setJustPaid(true);
      setToast({
        tone: 'success',
        message: updated.status === 'PAID' ? 'Payment recorded. Bill paid in full.' : 'Payment recorded.',
      });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  // P24. The advance paid online goes on the bill first, with one tap.
  const advanceMutation = useMutation({
    mutationFn: () => applyAdvance(billId),
    onSuccess: (updated) => {
      invalidate(updated);
      if (updated.status === 'PAID') setJustPaid(true);
      const refunded = updated.advanceRefundedInPaise > 0 ? ` ${moneyText(updated.advanceRefundedInPaise)} of the advance was refunded to the guest.` : '';
      setToast({
        tone: 'success',
        message: (updated.status === 'PAID' ? 'Online advance applied. Bill paid in full.' : 'Online advance applied. Collect the rest.') + refunded,
      });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  const correctMutation = useMutation({
    mutationFn: ({ paymentId, body }) => correctPayment(billId, paymentId, body),
    onSuccess: (updated) => {
      invalidate(updated);
      setPanel(null);
      setCorrecting(null);
      setToast({ tone: 'success', message: 'Payment method changed.' });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  const chargeMutation = useMutation({
    mutationFn: (accountId) => chargeToAccount(billId, accountId),
    onSuccess: (updated) => {
      invalidate(updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setPanel(null);
      setToast({ tone: 'success', message: `On Hold on ${updated.account.accountName}. The table is free.` });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  /** "Add account" inside the charge panel. Returns the new account, or null. */
  const addAccount = async (name) => {
    try {
      return await createAccount({ name });
    } catch (error) {
      setToast({ tone: 'error', message: errorMessage(error) });
      return null;
    }
  };

  const voidMutation = useMutation({
    mutationFn: (reason) => voidBill(billId, reason),
    onSuccess: (updated, reason) => {
      invalidate(updated);
      setPanel(null);
      // P59. Guest left: the order is closed and the table free, so back to the floor.
      if (reason?.reasonCode === 'GUEST_LEFT') {
        queryClient.invalidateQueries({ queryKey: ['tables'] });
        navigate('/floor', { replace: true });
        return;
      }
      setToast({ tone: 'success', message: 'Bill voided.' });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  // P25 Part D. A captain's phone has no printer: the counter prints it.
  const printRequest = useMutation({
    mutationFn: () => requestBillPrint(billId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bill', billId] });
      setToast({ tone: 'success', message: 'Sent to the counter. It prints there.' });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  // P05. The printer belongs to this device, not to whoever signs in.
  const [device] = useDeviceSettings();
  const { brand } = useTheme();

  const print = async () => {
    setPrinting(true);
    try {
      // P25. A thermal receipt, or a full A4 or A5 tax invoice, by this device's printer.
      await printBill(billId, { printer: device.printer, logoDataUrl: brand.logos?.LIGHT_GROUND?.dataUrl ?? null });
      // P29 Part D. The print is recorded, so the payment can be asked for next.
      queryClient.invalidateQueries({ queryKey: ['bill', billId] });
    } catch (error) {
      setToast({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPrinting(false);
    }
  };

  /**
   * P57. Save & Print on the order screen: the bill just made prints here, on
   * this device, once. Save prints nothing. A captain's goes to the counter's
   * queue instead, sent before arriving here.
   */
  const printNow = Boolean(location.state?.printNow);
  const tillRole = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER].includes(user?.role);
  useEffect(() => {
    if (!printNow || autoPrinted.current || !bill || !tillRole) return;
    if ((bill.printCount ?? 0) > 0 || bill.isVoided) return;
    autoPrinted.current = true;
    navigate(location.pathname, { replace: true, state: null });
    print();
    // print reads the device's printer; whether to print at all is decided by the values above.
  }, [printNow, bill, tillRole]);

  if (billQuery.isPending) {
    return (
      <main className="v2 flex min-h-full items-center justify-center bg-ground">
        <Spinner label="Loading the bill" />
      </main>
    );
  }

  if (billQuery.isError) {
    return (
      <main className="v2 flex min-h-full flex-col items-start gap-3 bg-ground px-4 py-6">
        <p className="type-body text-alert">{errorMessage(billQuery.error)}</p>
        <Link to="/floor" className="type-caption underline">
          Back to the floor
        </Link>
      </main>
    );
  }

  const outstandingInPaise = bill.grandTotalInPaise - bill.amountPaidInPaise;
  const canManage = CAN_DISCOUNT_OR_VOID.includes(user?.role);
  const isTill = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER].includes(user?.role);
  // P25 Part D. A captain takes payment only when the owner allows both billing settings.
  const isCaptain = user?.role === ROLES.WAITER;
  // P39. Once the bill has printed, a captain changes no item on it; the counter does.
  const captainLockedOut = isCaptain && (bill.printCount ?? 0) > 0;
  // P59. While the counter has not printed the captain's request, a second tap would only print it again.
  const sentToCounter = waitingAtCounter(bill);
  const captainMayTakePayment =
    isCaptain && features?.billing?.captainsMayBill && features?.billing?.captainsMayTakePayment && bill.orderType !== 'DELIVERY';
  const canTakePayment = isTill || Boolean(captainMayTakePayment);
  const isSettleable = !bill.isVoided && bill.status === 'UNPAID' && outstandingInPaise > 0;
  // P09. Managers can put what is still owed on an On Hold account.
  const canCharge = canManage && isSettleable;
  // P08: a cashier sees the panel only when the owner allows platform discounts.
  const cashierPlatformOnly =
    user?.role === ROLES.CASHIER && Boolean(features?.cashierMayApplyPlatformDiscounts);
  const canDiscount =
    (canManage || cashierPlatformOnly) &&
    !bill.isVoided &&
    bill.status === 'UNPAID' &&
    bill.amountPaidInPaise === 0;
  const canCorrect = canManage && !bill.isVoided && bill.status === 'PAID';
  // P28. A cashier may void with an owner's or manager's PIN, when the owner allows it.
  const canVoid = (canManage || (user?.role === ROLES.CASHIER && (features.approvals?.managerTasks ?? true))) && !bill.isVoided;
  // P25 Part E. The till, and a captain when captains may bill; a cashier or captain needs a manager's PIN.
  const canCancelItems =
    !bill.isVoided &&
    !(bill.orderType === 'DELIVERY' && bill.platform?.code) &&
    (isTill || (isCaptain && Boolean(features?.billing?.captainsMayBill) && !captainLockedOut));

  /**
   * P29 Part B. A bill nothing is paid on is revised, not voided: each item can
   * be removed here, and dishes are added on the order. Otherwise the P25 and
   * P26 flows, which void and re-bill, stay as they are.
   */
  const revisable = Boolean(bill.revisable);
  const canRemove = revisable && (isTill || (isCaptain && !captainLockedOut)) && bill.lines.length > 1;
  const orderLineStatus = (orderLineId) => order?.lines.find((line) => line.id === orderLineId)?.status ?? 'SERVED';
  /**
   * P35. The bill lists the server's item rows: the same dish ordered in two
   * rounds is one row. A bill read before P35 has none, so each line is its own.
   */
  const itemRows = bill.itemRows ?? bill.lines.map((line) => ({ ...line, orderLineIds: [line.orderLineId] }));
  const rowChoices = (row) =>
    row.orderLineIds.map((orderLineId) => ({
      line: bill.lines.find((line) => line.orderLineId === orderLineId),
      status: orderLineStatus(orderLineId),
      firedAt: order?.lines.find((line) => line.id === orderLineId)?.firedAt ?? null,
    }));
  const removeNeedsApproval = (line) => {
    if (canManage) return false;
    const sentToKitchen = ['FIRED', 'READY', 'SERVED'].includes(orderLineStatus(line.orderLineId));
    const kitchenRule = (features?.approvals?.lineCancel ?? true) && sentToKitchen;
    const printedRule = (features?.approvals?.revisePrintedBill ?? true) && (bill.printCount ?? 0) > 0;
    return kitchenRule || printedRule;
  };
  // Dishes added to this bill are still with the kitchen: no money until they are ready.
  const waitingForKitchen = order?.status === 'OPEN' && order?.billId === bill.id;

  /**
   * P29 Part D. Print first, then ask how it is paid. Until the bill (or its
   * latest revision) has been printed, the one primary action is printing it;
   * the payment buttons come after. "Take payment without printing" is there
   * for a guest who wants no paper, and the server records it. A bill the
   * guest already paid online asks for no payment mode, so its advance is
   * applied first and the print stays in the bar above.
   */
  const printFirst = features?.billing?.printBeforePayment ?? true;
  const printedCurrent = (bill.printCount ?? 0) > 0 && (bill.lastPrintedRevision ?? 0) === (bill.revision ?? 0);
  const hasAdvance = isTill && bill.advance?.available > 0;
  const asksForPrint =
    printFirst && isSettleable && canTakePayment && !waitingForKitchen && !printedCurrent && !payWithoutPrint && !hasAdvance;
  const reprintAfterRevision = (bill.printCount ?? 0) > 0 && (bill.revision ?? 0) > 0;

  // Paid or On Hold, the next useful thing is the printed bill; unpaid, it is the payment.
  const printIsPrimary = !bill.isVoided && !isSettleable;

  return (
    <main className="v2 min-h-full bg-ground px-4 py-4 text-ink lg:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              to="/bills"
              aria-label="All bills"
              className="flex size-12 flex-none items-center justify-center rounded-lg border border-line bg-surface hover:bg-sunken"
            >
              <BackIcon />
            </Link>
            <div>
              <h1 className="type-title">{placeLabel(bill)}</h1>
              <p className="type-caption text-muted">
                Bill <span className="type-num-meta text-ink">{bill.billNumber}</span> · business date{' '}
                <span className="type-num-meta">{bill.businessDate}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canDiscount && (
              <ActionButton onClick={() => setPanel('discount')}>
                <Bilingual k="applyDiscount" />
              </ActionButton>
            )}
            {canCharge && <ActionButton onClick={() => setPanel('charge')}>Charge to account</ActionButton>}
            {isCaptain && !bill.isVoided && !asksForPrint && (
              <ActionButton primary onClick={() => printRequest.mutate()} disabled={printRequest.isPending || sentToCounter}>
                <PrintIcon />
                {sentToCounter ? 'Sent to the counter' : 'Print at counter'}
              </ActionButton>
            )}
            {!asksForPrint && (
              <ActionButton primary={printIsPrimary && !isCaptain} onClick={() => print()} disabled={printing}>
                <PrintIcon />
                {isCaptain ? 'Print here' : <Bilingual k="printReceipt" />}
              </ActionButton>
            )}
            <Link
              to={`/bills/${bill.id}/receipt`}
              className="type-label flex min-h-12 items-center rounded-lg px-3 text-accent underline-offset-4 hover:underline"
            >
              Receipt preview
            </Link>
            {isCaptain && sentToCounter && !asksForPrint && <CounterNotPrinting requestedAt={bill.printRequestedAt} />}
            {captainLockedOut && !bill.isVoided && (
              <p className="type-caption flex min-h-12 items-center px-3 text-muted">This bill has been printed. Only the counter or a manager can change it now.</p>
            )}
            {canCancelItems && (
              <button
                type="button"
                onClick={() => (revisable ? navigate(`/orders/${bill.orderId}?add=1`) : setPanel('add-items'))}
                className="flex min-h-12 items-center rounded-lg px-3 text-ink hover:bg-sunken"
              >
                {revisable ? 'Add to this bill' : 'Add items'}
              </button>
            )}
            {canCancelItems && !revisable && (
              <button
                type="button"
                onClick={() => setPanel('cancel-items')}
                className="flex min-h-12 items-center rounded-lg px-3 text-alert hover:bg-alert-tint"
              >
                Cancel an item
              </button>
            )}
            {canVoid && (
              <button
                type="button"
                onClick={() => setPanel('void')}
                className="flex min-h-12 items-center rounded-lg px-3 text-alert hover:bg-alert-tint"
              >
                <Bilingual k="voidBill" />
              </button>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
          {/* The bill, as it prints. */}
          <article className="rounded-[10px] border border-line bg-surface p-4 sm:p-6 lg:col-span-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="type-label text-muted">Tax invoice</p>
                <p className="type-num-tile">{bill.billNumber}</p>
              </div>
              <BillStatusBadge bill={bill} size="lg" />
            </div>

            <dl className="mb-4 grid grid-cols-2 gap-3 border-y border-line py-3 sm:grid-cols-3">
              <Meta label="Table or order" value={placeLabel(bill)} />
              {bill.captainName && <Meta label="Captain" value={bill.captainName} />}
              {bill.guestCount != null && <Meta label="Covers" value={String(bill.guestCount)} mono />}
              <div className="col-span-2 flex items-center justify-between sm:col-span-3">
                <dt className="type-caption text-muted">Time issued</dt>
                <dd className="type-num-meta">
                  {formatDateIst(bill.billedAt)} · {formatTimeIst(bill.billedAt)}
                </dd>
              </div>
            </dl>

            {/* P04. Why it was voided: the fixed reason's label and the note. */}
            {bill.isVoided && (
              <p className="type-body mb-4 rounded-lg border border-line border-l-[3px] border-l-alert px-3 py-2">
                Voided: {describeReason(BILL_VOID_REASONS, bill.voidReasonCode, bill.voidReason) ?? 'no reason recorded'}
              </p>
            )}

            <div className="flex justify-between pb-1 type-label text-muted">
              <span>Item</span>
              <span>Line total</span>
            </div>
            <ul className="divide-y divide-line">
              {itemRows.map((line) => (
                <li key={line.orderLineIds.join('-')} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="type-body line-clamp-2 break-words" title={line.itemName}>
                      <span className="type-num mr-2">{line.quantity}</span>
                      {line.itemName}
                      {line.variantName ? ` (${line.variantName})` : ''}
                    </p>
                    {line.addOnNames.length > 0 && <p className="type-caption pl-6 text-muted">+ {line.addOnNames.join(', ')}</p>}
                    <p className="type-num-meta pl-6 text-muted">
                      {line.quantity} × <Money paise={line.unitPriceInPaise} />
                    </p>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1">
                    <Money paise={line.lineTotalInPaise} size="num" tabular />
                    {canRemove && (
                      <button
                        type="button"
                        onClick={() => setRemoving(line)}
                        className="type-label min-h-12 rounded-lg px-3 text-alert hover:bg-alert-tint"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <dl className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
              <Row label="Item total" value={<Money paise={bill.subtotalInPaise} />} />
              {bill.discount && (
                <Row
                  label={
                    bill.discount.kind === 'PERCENT'
                      ? `Discount (${formatBasisPoints(bill.discount.rateBps)}) — ${discountText(bill.discount)}`
                      : `Discount — ${discountText(bill.discount)}`
                  }
                  value={`− ${moneyText(bill.discount.amountInPaise)}`}
                />
              )}
              {bill.taxBreakdown.map((slab) => (
                <div key={slab.taxRateBps} className="flex flex-col gap-1">
                  <Row label={`CGST @ ${formatBasisPoints(slab.taxRateBps / 2)}`} value={<Money paise={slab.cgstInPaise} />} />
                  <Row label={`SGST @ ${formatBasisPoints(slab.taxRateBps / 2)}`} value={<Money paise={slab.sgstInPaise} />} />
                </div>
              ))}
              {bill.roundOffInPaise !== 0 && <Row label="Round-off" value={<Money paise={bill.roundOffInPaise} />} />}
            </dl>

            {/* The bill total, the largest thing on this screen. */}
            <div className="mt-4 flex flex-wrap items-end justify-between gap-2 border-t-2 border-ink pt-3">
              <span className="type-heading">Bill total</span>
              <Money
                key={justPaid ? 'paid' : 'shown'}
                paise={bill.grandTotalInPaise}
                size="hero"
                className={justPaid ? 'inline-block origin-right animate-[total-settle_160ms_ease-out]' : ''}
              />
            </div>

            {/* P09. On Hold: who it is charged to, and how much. */}
            {bill.status === 'ON_ACCOUNT' && !bill.isVoided && bill.account && (
              <p className="type-body mt-3">
                On Hold on <span className="font-semibold">{bill.account.accountName}</span>:{' '}
                <Money paise={bill.chargedToAccountInPaise} tabular size="num" />
              </p>
            )}

            <RevisionTimeline revisions={bill.revisions ?? []} />

            {bill.payments.length > 0 && (
              <div className="mt-4">
                <p className="type-label mb-2 text-muted">Payments</p>
                <ul className="flex flex-col gap-2">
                  {bill.payments.map((payment) => (
                    <li key={payment.id}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="type-body">
                          {paymentMethodName(payment)}
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </span>
                        <Money paise={payment.amountInPaise} tabular size="num" />
                      </div>
                      {(payment.corrections ?? []).map((change) => (
                        <p key={`${change.at}-${change.toMethod}`} className="type-caption text-muted">
                          Changed from {change.fromMethod} to {change.toMethod}: {change.reason}
                        </p>
                      ))}
                      {canCorrect && (
                        <button
                          type="button"
                          onClick={() => {
                            setCorrecting(payment);
                            setPanel('correct');
                          }}
                          className="type-label min-h-12 text-accent underline underline-offset-4"
                        >
                          Change payment method
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>

          {/* Taking the payment, beside the bill. */}
          <div className="flex flex-col gap-4 lg:col-span-7">
            {isSettleable && waitingForKitchen ? (
              <div className="rounded-[10px] border border-line border-l-[3px] border-l-open bg-surface p-4 sm:p-6">
                <p className="type-heading">Waiting for the kitchen</p>
                <p className="type-body mt-2 text-muted">
                  Dishes added to this bill are not ready yet. Take payment once the kitchen has them ready.
                </p>
              </div>
            ) : asksForPrint ? (
              <div className="rounded-[10px] border border-line bg-surface p-4 sm:p-6">
                <p className="type-heading">{reprintAfterRevision ? 'Print the revised bill' : 'Print the bill for the guest'}</p>
                <p className="type-body mt-2 text-muted">
                  The guest checks it first. Remove an item or add to this bill now if anything is wrong, then take payment.
                </p>
                <Button
                  size="lg"
                  fullWidth
                  className="mt-4"
                  isLoading={isCaptain ? printRequest.isPending : printing}
                  disabled={isCaptain && sentToCounter}
                  onClick={() => (isCaptain ? printRequest.mutate() : print())}
                >
                  <PrintIcon />
                  {isCaptain
                    ? sentToCounter
                      ? 'Sent to the counter'
                      : 'Print at counter'
                    : reprintAfterRevision
                      ? 'Print the revised bill'
                      : 'Print bill'}
                </Button>
                {isCaptain && sentToCounter && (
                  <p className="type-caption mt-2 text-muted">Sent to the counter. Payment opens once it has printed.</p>
                )}
                {isCaptain && sentToCounter && (
                  <CounterNotPrinting requestedAt={bill.printRequestedAt} />
                )}
                <button
                  type="button"
                  onClick={() => setPayWithoutPrint(true)}
                  className="type-label mt-3 min-h-12 w-full rounded-lg text-accent underline-offset-4 hover:underline"
                >
                  Take payment without printing
                </button>
              </div>
            ) : isSettleable && isTill && bill.advance?.available > 0 ? (
              <div className="rounded-[10px] border-2 border-ok bg-surface p-4 sm:p-6">
                <p className="type-label text-ok">Paid online</p>
                <p className="mt-1 flex flex-wrap items-baseline gap-2">
                  <Money paise={bill.advance.available} size="hero" tabular />
                </p>
                <p className="type-body mt-2 text-muted">
                  The guest paid this in advance. Apply it to the bill first.
                  {bill.advance.available > outstandingInPaise
                    ? ` The bill is ${moneyText(outstandingInPaise)}, so ${moneyText(bill.advance.available - outstandingInPaise)} goes back to the guest.`
                    : bill.advance.available < outstandingInPaise
                      ? ` Then collect the remaining ${moneyText(outstandingInPaise - bill.advance.available)}.`
                      : ''}
                </p>
                <Button size="lg" fullWidth className="mt-4" isLoading={advanceMutation.isPending} onClick={() => advanceMutation.mutate()}>
                  Apply {moneyText(Math.min(bill.advance.available, outstandingInPaise))} paid online
                </Button>
              </div>
            ) : isSettleable && canTakePayment ? (
              <InlinePayment
                billId={bill.id}
                onTerminalFinished={(transaction) => {
                  queryClient.invalidateQueries({ queryKey: ['bill', billId] });
                  if (transaction.status === 'APPROVED') setToast({ tone: 'success', message: 'Approved on the card machine.' });
                }}
                methods={allowedMethods}
                outstandingInPaise={outstandingInPaise}
                isBusy={paymentMutation.isPending}
                error={paymentMutation.isError ? errorMessage(paymentMutation.error) : null}
                onConfirm={(body) => paymentMutation.mutate(body)}
              />
            ) : (
              <div className="rounded-[10px] border border-line bg-surface p-4 sm:p-6">
                <BillStatusBadge bill={bill} size="lg" />
                <p className="type-body mt-3 text-muted">
                  {bill.isVoided
                    ? 'This bill is voided.'
                    : bill.status === 'PAID'
                      ? 'This bill is paid in full. Print it for the guest.'
                      : bill.status === 'ON_ACCOUNT'
                        ? 'This bill is on an On Hold account.'
                        : 'Nothing to collect on this bill.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {panel === 'discount' && (
        <DiscountPanel
          billNumber={bill.billNumber}
          subtotalInPaise={bill.subtotalInPaise}
          platformOnly={!canManage}
          isBusy={discountMutation.isPending}
          error={discountMutation.isError ? errorMessage(discountMutation.error) : null}
          onCancel={() => setPanel(null)}
          onConfirm={(body) => discountMutation.mutate(body)}
        />
      )}

      {panel === 'charge' && (
        <ChargeToAccountPanel
          owedInPaise={outstandingInPaise}
          isBusy={chargeMutation.isPending}
          error={chargeMutation.isError ? errorMessage(chargeMutation.error) : null}
          onCancel={() => setPanel(null)}
          onConfirm={(accountId) => chargeMutation.mutate(accountId)}
          onCreate={addAccount}
        />
      )}

      {panel === 'correct' && correcting && (
        <CorrectPaymentPanel
          payment={correcting}
          methods={allowedMethods}
          isBusy={correctMutation.isPending}
          error={correctMutation.isError ? errorMessage(correctMutation.error) : null}
          onCancel={() => {
            setPanel(null);
            setCorrecting(null);
          }}
          onConfirm={(body) => correctMutation.mutate({ paymentId: correcting.id, body })}
        />
      )}

      {panel === 'cancel-items' && (
        <CancelItemsPanel
          bill={bill}
          order={order}
          needsApproval={!canManage}
          onCancel={() => setPanel(null)}
          onDone={(result) => {
            setPanel(null);
            const parts = [];
            if (result.cashToGiveBackInPaise > 0) parts.push(`Give back ${moneyText(result.cashToGiveBackInPaise)} in cash.`);
            for (const refund of result.refundsOwed) parts.push(`${moneyText(refund.amountInPaise)} is owed back on ${refund.methodName}.`);
            setToast({ tone: 'success', message: [`Bill ${result.voidedBillNumber} voided.`, ...parts].join(' ') });
            queryClient.invalidateQueries({ queryKey: ['bill'] });
            queryClient.invalidateQueries({ queryKey: ['bills'] });
            // The new bill opens, ready to print.
            if (result.bill) navigate(`/bills/${result.bill.id}`);
          }}
        />
      )}

      {removing && (
        <RemoveItemPanel
          bill={bill}
          row={removing}
          choices={rowChoices(removing)}
          needsApprovalFor={(picked) => picked.some((choice) => removeNeedsApproval(choice.line))}
          onCancel={() => setRemoving(null)}
          onDone={(updated) => {
            setRemoving(null);
            invalidate(updated);
            setToast({ tone: 'success', message: `${removing.itemName} removed. The bill is now ${moneyText(updated.grandTotalInPaise)}.` });
          }}
        />
      )}

      {panel === 'add-items' && (
        <AddItemsPanel
          bill={bill}
          needsApproval={!canManage}
          onCancel={() => setPanel(null)}
          onDone={(result) => {
            setPanel(null);
            queryClient.invalidateQueries({ queryKey: ['bill'] });
            queryClient.invalidateQueries({ queryKey: ['bills'] });
            // This screen read the order while the old bill was live; the order screen must not reuse that copy.
            queryClient.removeQueries({ queryKey: ['order', result.orderId] });
            // The order opens, with the menu, for the new dishes.
            navigate(`/orders/${result.orderId}?add=1`);
          }}
        />
      )}

      {panel === 'void' && (
        <VoidBillPanel
          bill={bill}
          needsApproval={!canManage}
          isBusy={voidMutation.isPending}
          error={voidMutation.isError ? errorMessage(voidMutation.error) : null}
          onCancel={() => setPanel(null)}
          onConfirm={(reason) => voidMutation.mutate(reason)}
        />
      )}

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

/** P08: the fixed reason's label and the note; a discount from before P08 keeps its text. */
function discountText(discount) {
  if (!discount.reasonCode) return discount.reason ?? '';
  const label = discountReasonLabel(discount.reasonCode);
  return discount.reason ? `${label}: ${discount.reason}` : label;
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="type-body text-muted">{label}</dt>
      <dd className="type-num">{value}</dd>
    </div>
  );
}

function Meta({ label, value, mono = false }) {
  return (
    <div className="min-w-0">
      <dt className="type-caption text-muted">{label}</dt>
      <dd className={['truncate', mono ? 'type-num' : 'type-body'].join(' ')}>{value}</dd>
    </div>
  );
}

/** A header action: secondary by default, the screen's one primary when `primary`. */
function ActionButton({ primary = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'type-button flex min-h-12 items-center gap-2 rounded-lg px-4 disabled:opacity-50',
        primary ? 'bg-accent text-on-accent hover:brightness-110' : 'border border-ink bg-surface hover:bg-sunken',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/** P59. A print request the counter has not printed yet. */
function waitingAtCounter(bill) {
  if (!bill?.printRequestedAt) return false;
  return !bill.lastPrintedAt || new Date(bill.lastPrintedAt) < new Date(bill.printRequestedAt);
}
