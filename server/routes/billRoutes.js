/**
 * Billing routes.
 *
 * Reading one bill and its receipt is open to all six roles, because a waiter
 * carries the bill to the table. Creating one and taking payment is the
 * cashier's job.
 *
 * Discounting and voiding are NOT, and that is the whole point of this module.
 * BUILD-PLAN section 7 names voids and discounts as the events an owner is
 * losing money to, so both need a manager's credentials and both land on the
 * audit trail. Do not widen either to CASHIER to make this file look
 * consistent; the asymmetry is the feature.
 *
 * Middleware order is docs/CONVENTIONS.md section 8:
 * authenticate, tenant, permission, validate, controller.
 *
 * There is no DELETE here and there will not be one. A bill is voided, with a
 * reason and an actor, and its number stays spent.
 */
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import {
  getBill,
  getInvoice,
  getPrintQueue,
  getRefunds,
  postCancelLines,
  postReopenBill,
  postRemoveLines,
  postRefundDone,
  postPrintRequest,
  postPrinted,
  getReceipt,
  getSummary,
  listBills,
  postBill,
  postCorrectPayment,
  postDiscount,
  postPayment,
  postVoid,
} from '../controllers/billController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import {
  applyDiscountSchema,
  billSummarySchema,
  correctPaymentSchema,
  createBillSchema,
  listBillsSchema,
  readBillSchema,
  billOnlySchema,
  cancelLinesSchema,
  removeLinesSchema,
  reopenBillSchema,
  listRefundsSchema,
  refundDoneSchema,
  invoiceSchema,
  markPrintedSchema,
  printQueueSchema,
  receiptSchema,
  recordPaymentSchema,
  voidBillSchema,
} from '../validators/billValidators.js';

const router = Router();

const base = [authenticate, tenant];

/** Owner and manager. Discounting, voiding and the summary. */
const managers = [...base, requireRole(ROLES.OWNER, ROLES.MANAGER)];

/** The people who work the till. */
const till = [...base, requireRole(ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER)];

/**
 * P25 Part D. The till, and a captain, who may bill and take payment only when
 * the owner's billing settings allow; billPermissionService decides.
 */
const tillAndCaptains = [...base, requireRole(ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER, ROLES.WAITER)];

/** Everyone signed in. A waiter reads the bill they are carrying. */
const anySignedIn = [
  ...base,
  requireRole(
    ROLES.OWNER,
    ROLES.MANAGER,
    ROLES.CASHIER,
    ROLES.WAITER,
    ROLES.KITCHEN,
    ROLES.STOREKEEPER,
  ),
];

/**
 * Before /bills/:billId, or "summary" is parsed as an id and answers 404 for a
 * malformed ObjectId instead of running.
 */
router.get('/bills/summary', ...managers, validate(billSummarySchema), getSummary);
router.get('/bills/print-queue', ...till, validate(printQueueSchema), getPrintQueue);

router.post('/bills', ...tillAndCaptains, validate(createBillSchema), postBill);
router.get('/bills', ...till, validate(listBillsSchema), listBills);
router.get('/bills/:billId', ...anySignedIn, validate(readBillSchema), getBill);
router.get('/bills/:billId/receipt', ...anySignedIn, validate(receiptSchema), getReceipt);
router.get('/bills/:billId/invoice', ...anySignedIn, validate(invoiceSchema), getInvoice);

router.post('/bills/:billId/payments', ...tillAndCaptains, validate(recordPaymentSchema), postPayment);
router.post('/bills/:billId/print-request', ...anySignedIn, validate(billOnlySchema), postPrintRequest);
router.post('/bills/:billId/printed', ...anySignedIn, validate(markPrintedSchema), postPrinted);

router.post(
  '/bills/:billId/payments/:paymentId/correct',
  ...managers,
  validate(correctPaymentSchema),
  postCorrectPayment,
);

/**
 * P08: the till, not managers, because a cashier may apply a platform discount
 * when the owner allows it. billPermissionService.assertCanDiscount is the gate
 * and refuses a cashier everything else.
 */
router.post('/bills/:billId/discount', ...till, validate(applyDiscountSchema), postDiscount);
// P28. A cashier may void with an owner's or manager's PIN; the controller decides.
router.post('/bills/:billId/void', ...till, validate(voidBillSchema), postVoid);

// P25 Part E. The till and captains reach it; a CASHIER or WAITER needs a manager's PIN, checked in the service.
router.post('/bills/:billId/cancel-lines', ...tillAndCaptains, validate(cancelLinesSchema), postCancelLines);
// P26. Add items after billing: the same people and approval as cancelling.
router.post('/bills/:billId/reopen', ...tillAndCaptains, validate(reopenBillSchema), postReopenBill);
// P29. Take an item off an unpaid bill, which is revised under the same number. The same people as a line cancel.
router.post('/bills/:billId/remove-lines', ...tillAndCaptains, validate(removeLinesSchema), postRemoveLines);
router.get('/refunds', ...till, validate(listRefundsSchema), getRefunds);
router.post('/refunds/:refundId/done', ...managers, validate(refundDoneSchema), postRefundDone);

export default router;
