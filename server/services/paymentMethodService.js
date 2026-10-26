/**
 * Payment methods. M10, built in P08. docs/API-CONTRACT.md "M10 Payments".
 *
 * Three things live here and nowhere else:
 *
 * 1. Every restaurant always has the four built-in methods. They are created by
 *    code when missing, inside provisioning and lazily before a list or a
 *    payment, so a restaurant created before P08 gets them without a migration.
 *    An existing method is never touched, so a renamed Cash stays renamed.
 *
 * 2. The four rules for which method a bill may use. The payment and the
 *    correction endpoints both ask `methodForBill`, so they cannot disagree.
 *
 * 3. What a payment freezes from its method. A report or a payout reads the
 *    payment, never the live method.
 */
import { platformByCode } from '../config/platforms.js';
import { ORDER_TYPES } from '../models/Order.js';
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHOD_KINDS,
  PaymentMethod,
} from '../models/PaymentMethod.js';
import {
  DuplicateError,
  NotFoundError,
  PaymentMethodNotAllowedError,
  ValidationError,
} from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { businessDateFor, nowUtc } from '../utils/time.js';

/** Mongo's duplicate key error. */
const DUPLICATE_KEY = 11000;

/**
 * Creates CASH, CARD, UPI and the inactive OTHER when missing. One upsert per
 * code with `$setOnInsert`, so an existing method is never overwritten and two
 * concurrent calls cannot create a second Cash: the unique index on
 * `{ restaurantId, code }` settles the race, and the loser's duplicate key
 * error means the method now exists, which is all this function promises.
 */
export async function ensureDefaultPaymentMethods(restaurantId, { branchId, session = null }) {
  for (const method of DEFAULT_PAYMENT_METHODS) {
    try {
      await PaymentMethod.updateOne(
        { restaurantId, code: method.code },
        {
          $setOnInsert: {
            restaurantId,
            branchId,
            code: method.code,
            name: method.name,
            kind: PAYMENT_METHOD_KINDS.IN_HAND,
            orderTypes: Object.values(ORDER_TYPES),
            platformCode: null,
            tallyLedgerCode: null,
            commissionBps: null,
            displayOrder: method.displayOrder,
            isActive: method.isActive,
            createdAt: nowUtc(),
            updatedAt: nowUtc(),
          },
        },
        // Without timestamps: false Mongoose stamps updatedAt on every call, so every payment
        // would change all four methods for nothing, and each change is synced (P63).
        { upsert: true, timestamps: false, ...(session ? { session } : {}) },
      );
    } catch (error) {
      if (error?.code !== DUPLICATE_KEY) throw error;
    }
  }
}

const ensureFor = (req, session = null) =>
  ensureDefaultPaymentMethods(req.restaurantId, { branchId: req.branchId, session });

/** GET /payment-methods. Active only unless asked, in display order. */
export async function listPaymentMethods(req, { includeInactive = false } = {}) {
  await ensureFor(req);
  const filter = { ...scoped(req) };
  if (!includeInactive) filter.isActive = true;
  return PaymentMethod.find(filter).sort({ displayOrder: 1, createdAt: 1 });
}

/** A commission is a platform's cut. An in-hand method has none. */
function assertCommissionFitsKind(kind, commissionBps) {
  if (kind === PAYMENT_METHOD_KINDS.IN_HAND && commissionBps !== null && commissionBps !== undefined) {
    throw new ValidationError('A commission applies only to a platform method.', {
      commissionBps: 'Leave this empty for a method where the money is already in hand.',
    });
  }
}

/** POST /payment-methods. OWNER. */
export async function createPaymentMethod(req, body) {
  await ensureFor(req);
  assertCommissionFitsKind(body.kind, body.commissionBps);

  try {
    return await PaymentMethod.create({
      ...scoped(req),
      code: body.code,
      name: body.name,
      kind: body.kind,
      orderTypes: body.orderTypes ?? Object.values(ORDER_TYPES),
      platformCode: body.platformCode ?? null,
      tallyLedgerCode: body.tallyLedgerCode ?? null,
      commissionBps: body.commissionBps ?? null,
      displayOrder: body.displayOrder ?? 0,
      terminalProvider: body.terminalProvider ?? null,
      terminalPaymentMode: body.terminalPaymentMode ?? null,
    });
  } catch (error) {
    if (error?.code === DUPLICATE_KEY) {
      throw new DuplicateError(`A payment method with the code ${body.code} already exists.`, {
        code: 'Choose a different code.',
      });
    }
    throw error;
  }
}

/** PATCH /payment-methods/:methodId. OWNER. `code` and `kind` never reach here. */
export async function updatePaymentMethod(req, methodId, changes) {
  const method = await PaymentMethod.findOne({ ...scoped(req), _id: methodId });
  if (!method) throw new NotFoundError('Payment method not found.');

  assertCommissionFitsKind(method.kind, changes.commissionBps);

  for (const [key, value] of Object.entries(changes)) {
    method[key] = value;
  }
  // P25 Part I. Checked on the result: a machine only on an in-hand method, a mode exactly with one.
  if (method.terminalProvider && method.kind === PAYMENT_METHOD_KINDS.PLATFORM) {
    throw new ValidationError('A platform\'s money never goes through the card machine.', { terminalProvider: 'Not on a platform method.' });
  }
  if (Boolean(method.terminalProvider) !== (method.terminalPaymentMode !== null && method.terminalPaymentMode !== undefined)) {
    throw new ValidationError('A card machine and its payment mode go together.', { terminalPaymentMode: 'Set both, or neither.' });
  }
  await method.save();
  return method;
}

/** One method by code, after making sure the built-ins exist. Null when there is none. P09. */
export async function methodByCode(req, code, { session = null } = {}) {
  await ensureFor(req, session);
  return PaymentMethod.findOne({ ...scoped(req), code }).setOptions(session ? { session } : {});
}

/**
 * The method a payment on this bill may use, by code. Each failure is a 422
 * `PAYMENT_METHOD_NOT_ALLOWED` naming the reason.
 *
 * 1. An active method of this restaurant.
 * 2. Allowed for the bill's order type.
 * 3. On a delivery bill from a platform, only that platform's own method.
 * 4. A platform's own method only on that platform's delivery bills.
 */
export async function methodForBill(req, bill, code, { session = null } = {}) {
  await ensureFor(req, session);

  const method = await PaymentMethod.findOne({ ...scoped(req), code }).setOptions(
    session ? { session } : {},
  );
  if (!method || !method.isActive) {
    throw new PaymentMethodNotAllowedError(`${method?.name ?? code} is not an active payment method.`);
  }

  if (!method.orderTypes.includes(bill.orderType)) {
    throw new PaymentMethodNotAllowedError(
      `${method.name} cannot be used to pay a ${orderTypeWords(bill.orderType)} bill.`,
    );
  }

  const billPlatform = bill.platform?.code ?? null;
  if (billPlatform && method.platformCode !== billPlatform) {
    const platformName = bill.platform.name ?? platformByCode(billPlatform)?.name ?? billPlatform;
    throw new PaymentMethodNotAllowedError(
      `A ${platformName} order is paid by ${platformName} only.`,
    );
  }

  if (method.platformCode && method.platformCode !== billPlatform) {
    throw new PaymentMethodNotAllowedError(
      `${method.name} is only for ${platformByCode(method.platformCode)?.name ?? method.platformCode} delivery orders.`,
    );
  }

  return method;
}

function orderTypeWords(orderType) {
  return { DINE_IN: 'dine-in', TAKEAWAY: 'takeaway', DELIVERY: 'delivery' }[orderType] ?? orderType;
}

/**
 * The fields a payment freezes from its method. `businessDate` comes from the
 * moment the money was received, through `businessDateFor`, so a payment at
 * 12:02 AM belongs to the business day before.
 */
export function frozenMethodFields(method) {
  return {
    method: method.code,
    methodName: method.name,
    methodKind: method.kind,
    tallyLedgerCode: method.tallyLedgerCode ?? null,
    commissionBps: method.kind === PAYMENT_METHOD_KINDS.PLATFORM ? (method.commissionBps ?? null) : null,
  };
}

export function paymentBusinessDate(receivedAt, startMinutes) {
  return businessDateFor(receivedAt, startMinutes);
}

export default {
  createPaymentMethod,
  ensureDefaultPaymentMethods,
  frozenMethodFields,
  listPaymentMethods,
  methodByCode,
  methodForBill,
  paymentBusinessDate,
  updatePaymentMethod,
};
