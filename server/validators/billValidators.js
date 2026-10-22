/**
 * Request schemas for M3 billing.
 *
 * Shapes come from docs/API-CONTRACT.md sections 14 and 15.
 *
 * The theme of this file is that a client never sends money it worked out
 * itself. It sends what it wants done — bill this order, take this much off,
 * this much was paid — and the server computes every derived figure. There is
 * no endpoint here that accepts a subtotal, a tax amount or a grand total, and
 * `.strict()` on every body is what keeps it that way.
 */
import { z } from 'zod';

import { BILL_VOID_REASON_CODES, LINE_CANCEL_REASON_CODES } from '../config/cancelReasons.js';
import {
  DISCOUNT_FUNDERS,
  DISCOUNT_FUNDER_VALUES,
  DISCOUNT_REASON_CODES,
  isPlatformDiscountReason,
} from '../config/discountReasons.js';
import { BILL_STATUS_VALUES, DISCOUNT_KINDS } from '../models/Bill.js';
import { CANCEL_REASON_MAX_LENGTH } from '../models/Order.js';
import { cashCount } from './dayCloseValidators.js';
import { REFUND_REFERENCE_MAX_LENGTH, REFUND_STATUS_VALUES } from '../models/Refund.js';
import { PAYMENT_METHOD_CODE_PATTERN } from '../models/PaymentMethod.js';
import {
  MAX_BASIS_POINTS,
  businessDate,
  nonEmptyString,
  objectId,
  paginationQuery,
  paise,
  queryBoolean,
  reasonFields,
  requireNoteForOther,
  approval,
} from './common.js';

const billIdParam = z.object({ billId: objectId });

/** The order's optimistic-concurrency version, sent on every write that moves it. */
const version = z
  .number({ error: 'Is required. Send the version you last read.' })
  .int('Must be a whole number.')
  .min(1, 'Must be 1 or more.');

const reason = nonEmptyString.max(200, 'Cannot be longer than 200 characters.');
/** P08. The discount note's ceiling, the same as the free-text reason it replaces. */
const DISCOUNT_NOTE_MAX_LENGTH = 200;

/** P08. A payment method code. Whether this bill may use it is the service's question. */
const methodCode = z
  .string({ error: 'Is required.' })
  .trim()
  .regex(PAYMENT_METHOD_CODE_PATTERN, 'Is not a payment method code.');

/**
 * P08. The reason fields every discount carries, from P04's reasonFields, plus
 * who paid for it. A platform can only fund a platform's own discount.
 */
const discountReason = {
  ...reasonFields(DISCOUNT_REASON_CODES, DISCOUNT_NOTE_MAX_LENGTH),
  fundedBy: z
    .enum(DISCOUNT_FUNDER_VALUES, { error: 'Must be RESTAURANT or PLATFORM.' })
    .default(DISCOUNT_FUNDERS.RESTAURANT),
};

function refineDiscountReason(body, context) {
  requireNoteForOther(body, context);
  if (body.fundedBy === DISCOUNT_FUNDERS.PLATFORM && !isPlatformDiscountReason(body.reasonCode)) {
    context.addIssue({
      code: 'custom',
      path: ['fundedBy'],
      message: 'Only a platform discount, like Zomato Gold, can be paid for by the platform.',
    });
  }
}
/** P04. The void note's ceiling, the same as the free-text reason it replaces. */
const VOID_NOTE_MAX_LENGTH = 500;

/**
 * POST /bills
 *
 * The order id and the version it was last read at. Nothing else: every line,
 * price and tax figure is read off the order by the server.
 */
export const createBillSchema = z.object({
  body: z
    .object({
      orderId: objectId,
      version,
      // P57. The discount chosen before the bill is made, and the totals shown before Save.
      discount: z.lazy(() => discountBody).optional(),
      preview: z.boolean({ error: 'Must be true or false.' }).optional(),
      // P60. The counter bills dishes not yet sent, without a KOT.
      withoutKot: z.boolean({ error: 'Must be true or false.' }).optional(),
    })
    .strict('Is not a field you can set here. The server bills from the order.'),
});

/** GET /bills/:billId */
export const readBillSchema = z.object({ params: billIdParam });

/** GET /bills */
export const listBillsSchema = z.object({
  query: paginationQuery.extend({
    from: businessDate.optional(),
    to: businessDate.optional(),
    status: z.enum(BILL_STATUS_VALUES, { error: 'Is not a bill status.' }).optional(),
    includeVoided: queryBoolean,
    // P48. Recall Bill: the number after the series, on any date.
    number: z.coerce.number({ error: 'Must be a number.' }).int('Must be a whole number.').min(1, 'Must be 1 or more.').optional(),
  }),
});

/** GET /bills/summary. Both dates required: a summary of "everything" is not a report. */
export const billSummarySchema = z.object({
  query: z.object({ from: businessDate, to: businessDate }),
});

/**
 * POST /bills/:billId/discount
 *
 * A discriminated union on `kind`, so each branch refuses the other's field
 * outright rather than silently ignoring it. A FLAT discount carrying a
 * `rateBps` is a validation error naming the field, not a value quietly
 * dropped that leaves a manager thinking they gave ten percent.
 */
const discountBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(DISCOUNT_KINDS.FLAT),
      valueInPaise: paise.refine((value) => value > 0, 'Must be more than zero.'),
      rateBps: z.never({ error: 'A flat discount is an amount, not a rate.' }).optional(),
      ...discountReason,
    })
    .strict('Is not a field you can set here.')
    .superRefine(refineDiscountReason),
  z
    .object({
      kind: z.literal(DISCOUNT_KINDS.PERCENT),
      rateBps: z
        .number({ error: 'Must be a whole number of basis points.' })
        .int('Must be a whole number. Ten percent is 1000.')
        .min(1, 'Must be more than zero.')
        .max(MAX_BASIS_POINTS, 'Cannot be more than 10000, which is one hundred percent.'),
      valueInPaise: z
        .never({ error: 'A percentage discount is a rate, not an amount.' })
        .optional(),
      ...discountReason,
    })
    .strict('Is not a field you can set here.')
    .superRefine(refineDiscountReason),
]);

export const applyDiscountSchema = z.object({
  params: billIdParam,
  body: discountBody,
});

/** POST /bills/:billId/payments */
export const recordPaymentSchema = z.object({
  params: billIdParam,
  body: z
    .object({
      method: methodCode,
      amountInPaise: paise.refine((value) => value > 0, 'Must be more than zero.'),
      /**
       * A UPI reference or the last four of a card. Never a full card number,
       * which is why this is capped short and is never required.
       */
      reference: z
        .union([z.string().trim().max(100, 'Cannot be longer than 100 characters.'), z.null()])
        .optional(),
      /**
       * P25 Part F. The cash handed over, and the change, on a cash payment.
       * `amountInPaise` is what goes on the bill, never what was handed over.
       */
      tender: z
        .object({
          cashCount: cashCount.optional(),
          tenderedInPaise: paise,
          changeInPaise: paise,
        })
        .strict('Is not a field you can set here.')
        .optional(),
      // P25 Part I. Why a card-machine method is typed in: the machine is down. Owner and manager only.
      terminalBypassReason: z.string().trim().min(1, 'Say why.').max(200).optional(),
    })
    .strict('Is not a field you can set here.')
    .refine((body) => !body.tender || body.method === 'CASH', { path: ['tender'], message: 'Only a cash payment has notes and change.' }),
});

/** POST /bills/:billId/payments/:paymentId/correct. P08. Only the method changes. */
export const correctPaymentSchema = z.object({
  params: z.object({ billId: objectId, paymentId: objectId }),
  body: z
    .object({ method: methodCode, reason })
    .strict('Is not a field you can set here. Only the method of a payment can change.'),
});

/** POST /bills/:billId/void */
export const voidBillSchema = z.object({
  params: billIdParam,
  body: z
    // 2026-10-22. closeOrder: cancel the order too, so the table is free (14.6).
    .object({ ...reasonFields(BILL_VOID_REASON_CODES, VOID_NOTE_MAX_LENGTH), approval: approval.optional(), closeOrder: z.boolean().optional() })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

/**
 * GET /bills/:billId/receipt
 *
 * 32 characters is 58mm paper, 48 is 80mm. Anything else is a 400 rather than a
 * silent fallback: a receipt rendered at the wrong width prints as garbage, and
 * finding that out on paper in a restaurant is expensive.
 */
/**
 * POST /bills/:billId/cancel-lines. P25 Part E. Whole lines, each with its own
 * "was it already made", one reason, and a manager's PIN for the till.
 */
export const cancelLinesSchema = z.object({
  params: billIdParam,
  body: z
    .object({
      lines: z
        .array(
          z
            .object({ lineId: objectId, wasPrepared: z.boolean({ error: 'Must be true or false.' }) })
            .strict('Is not a field you can set here.'),
        )
        .min(1, 'Pick at least one item.')
        .max(100)
        .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, 'Each item can be picked once.'),
      ...reasonFields(LINE_CANCEL_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      approval: approval.optional(),
      // The same numbers, with nothing written: for the confirmation's sentence.
      preview: z.boolean({ error: 'Must be true or false.' }).optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

/**
 * POST /bills/:billId/remove-lines. P29 Part B. `wasPrepared` follows the line
 * cancel's own rule, checked against the line's status in the service: required
 * for a line the kitchen has, refused for one never sent.
 */
export const removeLinesSchema = z.object({
  params: billIdParam,
  body: z
    .object({
      lines: z
        .array(
          z
            .object({ lineId: objectId, wasPrepared: z.boolean({ error: 'Must be true or false.' }).optional() })
            .strict('Is not a field you can set here.'),
        )
        .min(1, 'Pick at least one item.')
        .max(100)
        .refine((lines) => new Set(lines.map((line) => line.lineId)).size === lines.length, 'Each item can be picked once.'),
      ...reasonFields(LINE_CANCEL_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      approval: approval.optional(),
      preview: z.boolean({ error: 'Must be true or false.' }).optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

/** GET /refunds. P25 Part E. */
export const listRefundsSchema = z.object({
  query: paginationQuery.extend({
    status: z.enum(REFUND_STATUS_VALUES, { error: 'Is not a refund status.' }).optional(),
    from: businessDate.optional(),
    to: businessDate.optional(),
  }),
});

/** POST /refunds/:refundId/done. P25 Part E. */
export const refundDoneSchema = z.object({
  params: z.object({ refundId: objectId }),
  body: z
    .object({ reference: nonEmptyString.max(REFUND_REFERENCE_MAX_LENGTH, `Cannot be longer than ${REFUND_REFERENCE_MAX_LENGTH} characters.`) })
    .strict('Is not a field you can set here.'),
});

/** POST /bills/:billId/print-request and /printed. P25 Part D. No body. */
export const billOnlySchema = z.object({ params: billIdParam, body: z.object({}).strict().optional() });

/** POST /bills/:billId/printed. P59: a counter device claims a captain's request with its time. */
export const markPrintedSchema = z.object({
  params: billIdParam,
  body: z
    .object({ forRequestAt: z.coerce.date({ error: 'Must be the request time from the print queue.' }).optional() })
    .strict('Is not a field you can set here.')
    .optional(),
});

/** GET /bills/print-queue. P25 Part D. */
export const printQueueSchema = z.object({ query: z.object({}).strict() });

/** GET /bills/:billId/invoice. P25 C4. */
export const invoiceSchema = z.object({ params: billIdParam, query: z.object({}).strict() });

export const receiptSchema = z.object({
  params: billIdParam,
  query: z.object({
    width: z
      .enum(['32', '48'], { error: 'Must be 32 (58mm paper) or 48 (80mm).' })
      .default('32')
      .transform(Number),
  }),
});

/** P26. POST /bills/:billId/reopen: the same approval as cancelling after billing. */
export const reopenBillSchema = z.object({
  params: billIdParam,
  body: z
    .object({
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.')
    .default({}),
});
