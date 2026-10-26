/**
 * Cash drawer and Day Close request schemas. P10. Shapes from
 * docs/API-CONTRACT.md "M16" sections 3 and 6.
 *
 * No request sets a cash entry's business date: the server takes today's.
 */
import { z } from 'zod';

import { CASH_MOVEMENT_TYPE_VALUES, TAKEN_OUT_DESTINATIONS, TOP_UP_SOURCES } from '../models/CashMovement.js';
import { approval, businessDate, nonEmptyString, objectId, paise } from './common.js';

/** P25 Part F. A count by notes and coins. The server totals it; kind is needed only for ₹20 and ₹10. */
export const cashCount = z
  .array(
    z
      .object({
        valueInPaise: z.number({ error: 'Must be a whole number of paise.' }).int('Must be a whole number of paise.').min(1),
        kind: z.enum(['NOTE', 'COIN'], { error: 'Must be NOTE or COIN.' }).optional(),
        count: z.number({ error: 'Must be a whole number.' }).int('Must be a whole number.').min(0, 'Cannot be negative.').max(10_000),
      })
      .strict('Is not a field you can set here.'),
  )
  .max(40);

const reason = nonEmptyString.max(200, 'Cannot be longer than 200 characters.');

export const listCashSchema = z.object({
  query: z.object({ date: businessDate.optional() }).strict('Is not a filter on the cash drawer.'),
});

/** The types counted by notes and coins. P25 Part F, and P29 Part F for cash taken out and a cash check. */
const COUNTED_TYPES = ['OPENING_FLOAT', 'CASH_TAKEN_OUT', 'CASH_CHECK'];

/**
 * POST /cash-movements. API-CONTRACT M16 sections 3 and 9.2.
 *
 * P29: a top-up (PAID_IN) says its `source` or a reason; an expense (PAID_OUT)
 * its `category` or a reason, the category checked against the restaurant's
 * list in the service; cash taken out says where it went. OTHER always needs
 * a reason. A cash check may count an empty drawer, so it alone may be 0.
 * `broughtForward` confirms the cash kept at the last close as today's float.
 */
export const recordCashSchema = z.object({
  body: z
    .object({
      type: z.enum(CASH_MOVEMENT_TYPE_VALUES, { error: 'Is not a kind of cash entry.' }),
      amountInPaise: paise.optional(),
      reason: reason.optional(),
      cashCount: cashCount.optional(),
      approval: approval.optional(),
      // P29 Part F.
      source: z.enum(TOP_UP_SOURCES, { error: 'Must be OWNER, BANK, CHANGE or OTHER.' }).optional(),
      category: z.string({ error: 'Must be a category code.' }).trim().regex(/^[A-Z0-9_]{2,30}$/, 'Is not a category code.').optional(),
      destination: z.enum(TAKEN_OUT_DESTINATIONS, { error: 'Must be BANK_DEPOSIT, OWNER or OTHER.' }).optional(),
      takenBy: objectId.optional(),
      broughtForward: z.boolean({ error: 'Must be true or false.' }).optional(),
    })
    .strict('Is not a field you can set here. The business date is always today.')
    .superRefine((body, context) => {
      const issue = (path, message) => context.addIssue({ code: 'custom', path: [path], message });
      if (body.cashCount && !COUNTED_TYPES.includes(body.type)) issue('cashCount', 'Only the float, cash taken out and a cash check are counted by notes.');
      if (body.amountInPaise === undefined && !body.cashCount && !(body.type === 'OPENING_FLOAT' && body.broughtForward)) issue('amountInPaise', 'Is required.');
      if (body.amountInPaise !== undefined && body.amountInPaise <= 0 && body.type !== 'CASH_CHECK') issue('amountInPaise', 'Must be more than zero.');
      if (body.source && body.type !== 'PAID_IN') issue('source', 'Only a top-up has a source.');
      if (body.category && body.type !== 'PAID_OUT') issue('category', 'Only an expense has a category.');
      if ((body.destination || body.takenBy) && body.type !== 'CASH_TAKEN_OUT') issue('destination', 'Only cash taken out has a destination.');
      if (body.broughtForward && body.type !== 'OPENING_FLOAT') issue('broughtForward', 'Only the opening float is brought forward.');
      if (body.type === 'PAID_IN' && !body.reason && (!body.source || body.source === 'OTHER')) issue('reason', 'Say where the cash came from.');
      if (body.type === 'PAID_OUT' && !body.reason && (!body.category || body.category === 'OTHER')) issue('reason', 'Say what the cash was for.');
      if (body.type === 'CASH_TAKEN_OUT') {
        if (!body.destination) issue('destination', 'Say where the cash went: the bank, or the owner.');
        else if (body.destination === 'OTHER' && !body.reason) issue('reason', 'Say where the cash went.');
      }
    }),
});

export const voidCashSchema = z.object({
  params: z.object({ movementId: objectId }),
  body: z.object({ reason, approval: approval.optional() }).strict('Is not a field you can set here.'),
});

export const closeDaySchema = z.object({
  body: z
    .object({
      businessDate,
      countedCashInPaise: paise.optional(),
      cashCount: cashCount.optional(),
      note: z
        .union([z.string().trim().max(500, 'Cannot be longer than 500 characters.'), z.null()])
        .optional()
        .transform((value) => (value === '' || value === undefined ? null : value)),
      // P29 Part F. What stays in the drawer for tomorrow, and where the rest goes.
      keptForTomorrowInPaise: paise.optional(),
      keptForTomorrowCount: cashCount.optional(),
      takenOutTo: z.enum(TAKEN_OUT_DESTINATIONS, { error: 'Must be BANK_DEPOSIT, OWNER or OTHER.' }).optional(),
      takenOutBy: objectId.optional(),
    })
    .strict('Is not a field you can set here.')
    .refine((body) => body.countedCashInPaise !== undefined || body.cashCount, {
      path: ['countedCashInPaise'],
      message: 'Give the counted cash, or count it by notes and coins.',
    }),
});

/** GET /cash-book. P29 Part F. Default today's business date. */
export const cashBookSchema = z.object({
  query: z.object({ date: businessDate.optional() }).strict('Is not a filter on the cash book.'),
});

const dateParam = z.object({ businessDate });

export const readDaySchema = z.object({ params: dateParam });

export const listDaysSchema = z.object({
  query: z.object({ from: businessDate.optional(), to: businessDate.optional() }).strict(),
});

export const printDaySchema = z.object({
  params: dateParam,
  query: z.object({
    width: z
      .enum(['32', '48'], { error: 'Must be 32 (58mm paper) or 48 (80mm).' })
      .default('32')
      .transform(Number),
  }),
});

export const reopenDaySchema = z.object({
  params: dateParam,
  body: z.object({ reason }).strict('Is not a field you can set here.'),
});
