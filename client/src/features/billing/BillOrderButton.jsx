import { useNavigate } from 'react-router-dom';

import { ROLES } from '../users/roles.js';
import { LABELS } from '../i18n/labels.js';

const CAN_BILL = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];

/** P25 Part D. A captain bills a dine-in or takeaway order when the owner allows it. */
export function mayBill(user, features, order) {
  if (CAN_BILL.includes(user?.role)) return true;
  return user?.role === ROLES.WAITER && Boolean(features?.billing?.captainsMayBill) && order.orderType !== 'DELIVERY';
}

/**
 * The order screen's way back to its bill, once one exists.
 *
 * P57: the bill itself is made in the Bill box under the dishes
 * (BillComposer), with its discount and the choice of Save or Save & Print.
 */
export default function BillOrderButton({ order }) {
  const navigate = useNavigate();
  if (!order.billId) return null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/bills/${order.billId}`)}
      className="flex min-h-12 items-center rounded-lg bg-accent px-4 type-button text-on-accent"
    >
      {LABELS.openBill}
    </button>
  );
}
