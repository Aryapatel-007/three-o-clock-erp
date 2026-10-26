/**
 * M2 request schemas: tables, orders and kitchen tickets.
 *
 * Built on the primitives in common.js. Nothing here re-derives what an
 * ObjectId or a phone number is.
 *
 * Business rules are not here, and cannot be. A Zod refinement always surfaces
 * as a 400 through the validate middleware, and most M2 rules have to be 422 or
 * 409, so they are thrown in the controller. The other half of that line is
 * that Zod cannot see stored state: whether a line is already fired, whether an
 * order is still open. Those checks need the document.
 */
import { z } from 'zod';

import { LINE_CANCEL_REASON_CODES, ORDER_CANCEL_REASON_CODES } from '../config/cancelReasons.js';
import { NO_CHARGE_REASON_CODES } from '../config/noChargeReasons.js';
import { PLATFORM_CODES } from '../config/platforms.js';
import {
  MAX_GUEST_COUNT,
  MAX_LINE_QUANTITY,
  MIN_GUEST_COUNT,
  MIN_LINE_QUANTITY,
  CANCEL_REASON_MAX_LENGTH,
  CUSTOMER_NAME_MAX_LENGTH,
  KITCHEN_NOTE_MAX_LENGTH,
  LINE_NOTES_MAX_LENGTH,
  ORDER_STATUS_VALUES,
  ORDER_TYPES,
  PLATFORM_ORDER_ID_PATTERN,
} from '../models/Order.js';
import {
  FLOOR_COLUMNS,
  FLOOR_ROWS,
  MAX_SEATS,
  MAX_TABLE_SPAN,
  MIN_SEATS,
  TABLE_NAME_MAX_LENGTH,
  TABLE_SECTION_MAX_LENGTH,
  TABLE_SHAPES,
} from '../models/Table.js';
import {
  nonEmptyString,
  objectId,
  paginationQuery,
  paise,
  phoneIndia,
  reasonFields,
  requireNoteForOther,
  approval,
  businessDate,
} from './common.js';

/**
 * A boolean that arrived in a query string, matched literally.
 *
 * z.coerce.boolean() turns the string "false" into true, which is the wrong
 * answer in the most confusing possible way. Logged as a decision from M0-C.
 */
const queryBoolean = z
  .enum(['true', 'false'], { error: 'Must be true or false.' })
  .default('false')
  .transform((value) => value === 'true');

/** The same, but genuinely optional: absent means "do not filter on this". */
const optionalQueryBoolean = z
  .enum(['true', 'false'], { error: 'Must be true or false.' })
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

const displayOrder = z
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .min(0, 'Cannot be negative.');

const isActiveBody = z
  .object({ isActive: z.boolean({ error: 'Must be true or false.' }) })
  .strict('Is not a field you can set here.');

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const tableIdParam = z.object({ tableId: objectId });

const tableName = nonEmptyString.max(
  TABLE_NAME_MAX_LENGTH,
  `Cannot be longer than ${TABLE_NAME_MAX_LENGTH} characters.`,
);

const section = z
  .union([
    z
      .string()
      .trim()
      .max(TABLE_SECTION_MAX_LENGTH, `Cannot be longer than ${TABLE_SECTION_MAX_LENGTH} characters.`),
    z.null(),
  ])
  .optional();

const seats = z
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .min(MIN_SEATS, `Must seat at least ${MIN_SEATS}.`)
  .max(MAX_SEATS, `Cannot seat more than ${MAX_SEATS}.`);

export const createTableSchema = z.object({
  body: z
    .object({
      name: tableName,
      section,
      seats: seats.optional(),
      displayOrder: displayOrder.optional(),
    })
    .strict('Is not a field you can set here.'),
});

/**
 * `isOccupied` filters on a value that is not stored anywhere.
 *
 * Occupancy is derived from open orders at request time, so the filter is
 * applied in memory after the derivation rather than in the database query.
 * Absent means no filter at all, which is why it is not the defaulting
 * queryBoolean used elsewhere.
 *
 * `includeInactive` is not in Part 4's URL example. It is here for the same
 * reason GET /categories has one: without it a deactivated table cannot be seen
 * and therefore cannot be switched back on, and the table management screen
 * exists to do exactly that. Defaults to false so the floor view, which is the
 * other caller, does not have to ask.
 */
export const listTablesSchema = z.object({
  query: z.object({
    section: z.string().trim().max(TABLE_SECTION_MAX_LENGTH).optional(),
    isOccupied: optionalQueryBoolean,
    includeInactive: queryBoolean,
  }),
});

/**
 * PATCH /tables/layout. P19. Each entry places a table on the section's 24 by
 * 16 grid, or takes it off with `layout: null`. The bounds and the LONG rule are
 * checked here, per entry; overlaps need the whole plan and are checked in the
 * controller.
 */
const cell = (max) =>
  z.number({ error: 'Must be a number.' }).int('Must be a whole number.').min(0, 'Cannot be below 0.').max(max, `Cannot be more than ${max}.`);
const span = z
  .number({ error: 'Must be a number.' })
  .int('Must be a whole number.')
  .min(1, 'Must be at least 1.')
  .max(MAX_TABLE_SPAN, `Cannot be more than ${MAX_TABLE_SPAN}.`);

const placedTable = z
  .object({
    tableId: objectId,
    x: cell(FLOOR_COLUMNS - 1),
    y: cell(FLOOR_ROWS - 1),
    w: span,
    h: span,
    shape: z.enum(TABLE_SHAPES, { error: `Must be one of: ${TABLE_SHAPES.join(', ')}.` }),
  })
  .strict('Is not a field you can set here.')
  .superRefine((entry, context) => {
    if (entry.x + entry.w > FLOOR_COLUMNS) context.addIssue({ code: 'custom', path: ['w'], message: `Runs past the right edge of the ${FLOOR_COLUMNS}-column grid.` });
    if (entry.y + entry.h > FLOOR_ROWS) context.addIssue({ code: 'custom', path: ['h'], message: `Runs past the bottom of the ${FLOOR_ROWS}-row grid.` });
    if (entry.shape === 'LONG' && entry.w === entry.h) context.addIssue({ code: 'custom', path: ['shape'], message: 'A long table has a different width and height.' });
  });

const unplacedTable = z.object({ tableId: objectId, layout: z.null() }).strict('Is not a field you can set here.');

export const saveLayoutSchema = z.object({
  body: z
    .object({
      section: z.string({ error: 'Name the section.' }).trim().min(1, 'Name the section.').max(TABLE_SECTION_MAX_LENGTH),
      tables: z
        .array(z.union([unplacedTable, placedTable], { error: 'Each table needs a place on the grid, or layout: null.' }))
        .min(1, 'Send at least one table.')
        .max(200, 'At most 200 tables.')
        .refine((entries) => new Set(entries.map((entry) => entry.tableId)).size === entries.length, 'Each table appears once.'),
    })
    .strict('Is not a field you can set here.'),
});

/** `isActive` is refused rather than ignored: it has its own endpoint. */
export const updateTableSchema = z.object({
  params: tableIdParam,
  body: z
    .object({
      name: tableName.optional(),
      section,
      // null clears the seat count from the table setup's edit sheet.
      seats: z.union([seats, z.null()]).optional(),
      displayOrder: displayOrder.optional(),
      isActive: z.never({ error: 'Has its own endpoint: PATCH /tables/:tableId/status' }).optional(),
    })
    .strict('Is not a field you can change here.')
    .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change.'),
});

export const setTableStatusSchema = z.object({
  params: tableIdParam,
  body: isActiveBody,
});

/** API-CONTRACT 11.6. No body. */
export const deleteTableSchema = z.object({ params: tableIdParam });

/** P48. A table's day; today's business date when no date is sent. */
export const tableHistorySchema = z.object({ params: tableIdParam, query: z.object({ date: businessDate.optional() }) });

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const orderIdParam = z.object({ orderId: objectId });
const orderLineParams = z.object({ orderId: objectId, lineId: objectId });

/**
 * The version the client last read. Required on every write to an order.
 *
 * Not optional and not defaulted. A client that does not send one has not read
 * the order, and letting it write anyway is the lost update this field exists
 * to prevent.
 */
const version = z
  .number({ error: 'Is required. Send the version you last read.' })
  .int('Must be a whole number.')
  .min(1, 'Must be 1 or more.');

const notes = z
  .union([
    z.string().trim().max(LINE_NOTES_MAX_LENGTH, `Cannot be longer than ${LINE_NOTES_MAX_LENGTH} characters.`),
    z.null(),
  ])
  .optional();

/**
 * One line as the client is allowed to describe it: ids and a quantity.
 *
 * `.strict()` is the security control on this object, not a tidiness
 * preference. The server looks the menu item up and writes every price itself,
 * so a body carrying unitPriceInPaise or taxRateBps is either a bug or
 * someone pricing their own dinner. Either way it fails loudly with a 400
 * naming the field, rather than being quietly stripped and looking like it
 * worked.
 */
const lineRequest = z
  .object({
    menuItemId: objectId,
    variantId: objectId.optional(),
    quantity: z
      .number({ error: 'Must be a number.' })
      .int('Must be a whole number.')
      .min(MIN_LINE_QUANTITY, 'Must be at least 1.')
      .max(MAX_LINE_QUANTITY, `Cannot be more than ${MAX_LINE_QUANTITY}.`),
    addOnIds: z.array(objectId).optional(),
    notes,
    /**
     * P46. Only for an open item: the dish's name and price, typed by staff.
     * The one place a client names a price, and only for a dish marked open.
     */
    openItem: z
      .object({
        name: z.string({ error: 'Is required.' }).trim().min(1, 'Type the dish\'s name.').max(80, 'Cannot be longer than 80 characters.'),
        priceInPaise: paise.refine((value) => value >= 1, 'Must be more than zero.'),
      })
      .strict('Is not a field you can set on an open item.')
      .optional(),
    // P48. Extras typed at the table, each with its own price, taxed at the dish's rate.
    extras: z
      .array(
        z
          .object({
            name: z.string({ error: 'Is required.' }).trim().min(1, "Type the extra's name.").max(40, 'Cannot be longer than 40 characters.'),
            priceInPaise: paise.refine((value) => value >= 1, 'Must be more than zero.'),
          })
          .strict('Is not a field you can set on an extra.'),
      )
      .max(5, 'At most 5 extras on one dish.')
      .optional(),
  })
  .strict('Is not a field you can set on a line. The server prices the line itself.');

const lines = z.array(lineRequest);

/**
 * Create, as a discriminated union so the conditional fields are enforced by
 * the schema rather than by an if-statement in the controller.
 *
 * A dine-in order names a table and may count guests. A takeaway names neither
 * and may carry a customer instead. Each branch refuses the other's fields
 * outright, so "TAKEAWAY with a tableId" is a validation error naming the
 * field, not a silently ignored value that leaves the caller thinking they
 * booked a table.
 */
export const createOrderSchema = z.object({
  body: z.discriminatedUnion('orderType', [
    z
      .object({
        orderType: z.literal(ORDER_TYPES.DINE_IN),
        tableId: objectId,
        guestCount: z
          .number({ error: 'Must be a number.' })
          .int('Must be a whole number.')
          .min(MIN_GUEST_COUNT, 'Must be at least 1.')
          .max(MAX_GUEST_COUNT, `Cannot be more than ${MAX_GUEST_COUNT}.`)
          .optional(),
        // P27. A seated guest's details, for the customer list.
        customerName: nonEmptyString
          .max(CUSTOMER_NAME_MAX_LENGTH, `Cannot be longer than ${CUSTOMER_NAME_MAX_LENGTH} characters.`)
          .optional(),
        customerPhone: phoneIndia.optional(),
        offersConsent: z.boolean({ error: 'Must be true or false.' }).optional(),
        platform: z.never({ error: 'Only a delivery order has a platform.' }).optional(),
        lines: lines.optional(),
      })
      .strict('Is not a field you can set here.'),

    z
      .object({
        orderType: z.literal(ORDER_TYPES.TAKEAWAY),
        tableId: z.never({ error: 'A takeaway order has no table.' }).optional(),
        guestCount: z.never({ error: 'A takeaway order has no guest count.' }).optional(),
        customerName: nonEmptyString
          .max(CUSTOMER_NAME_MAX_LENGTH, `Cannot be longer than ${CUSTOMER_NAME_MAX_LENGTH} characters.`)
          .optional(),
        customerPhone: phoneIndia.optional(),
        offersConsent: z.boolean({ error: 'Must be true or false.' }).optional(),
        platform: z.never({ error: 'Only a delivery order has a platform.' }).optional(),
        lines: lines.optional(),
      })
      .strict('Is not a field you can set here.'),

    // P06. A Zomato or Swiggy order typed in by hand. No table, no guests.
    z
      .object({
        orderType: z.literal(ORDER_TYPES.DELIVERY),
        tableId: z.never({ error: 'A delivery order has no table.' }).optional(),
        guestCount: z.never({ error: 'A delivery order has no guest count.' }).optional(),
        platform: z
          .object(
            {
              code: z.enum(PLATFORM_CODES, { error: `Must be one of: ${PLATFORM_CODES.join(', ')}.` }),
              orderId: z
                .string({ error: 'The platform order number is required.' })
                .trim()
                .regex(PLATFORM_ORDER_ID_PATTERN, 'Must be 3 to 40 letters and digits.'),
            },
            { error: 'A delivery order needs its platform and the platform order number.' },
          )
          .strict('Is not a field you can set here.'),
        customerName: nonEmptyString
          .max(CUSTOMER_NAME_MAX_LENGTH, `Cannot be longer than ${CUSTOMER_NAME_MAX_LENGTH} characters.`)
          .optional(),
        customerPhone: phoneIndia.optional(),
        offersConsent: z.boolean({ error: 'Must be true or false.' }).optional(),
        lines: lines.optional(),
      })
      .strict('Is not a field you can set here.'),
  ]).refine((body) => !body.offersConsent || Boolean(body.customerPhone), {
    path: ['offersConsent'],
    message: "Add the guest's mobile number to record that they agreed to offers.",
  }),
});

/**
 * `status` accepts a comma-separated list, for example "OPEN,READY_TO_BILL".
 *
 * Split here rather than in the controller so the controller receives an array
 * of checked values and never sees the raw string. An unknown value fails
 * rather than being dropped: a client asking for a status that does not exist
 * has a bug, and quietly returning everything would hide it.
 */
const orderStatusList = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value === undefined || value === '' ? undefined : value.split(',').map((part) => part.trim()),
  )
  .pipe(z.array(z.enum(ORDER_STATUS_VALUES, { error: 'Is not an order status.' })).min(1).optional());

export const listOrdersSchema = z.object({
  query: paginationQuery.extend({
    status: orderStatusList,
    orderType: z.enum(Object.values(ORDER_TYPES), { error: 'Is not an order type.' }).optional(),
    tableId: objectId.optional(),
  }),
});

export const readOrderSchema = z.object({ params: orderIdParam });

export const addOrderLinesSchema = z.object({
  params: orderIdParam,
  body: z
    .object({
      version,
      lines: lines.min(1, 'Send at least one line.'),
      // P40. Read only when the lines would revise a printed bill.
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.'),
});

/**
 * Only quantity and notes. Changing what was ordered is a cancel plus a new
 * line, not an edit, because the snapshot on a line has to stay the thing that
 * was actually ordered.
 */
export const editOrderLineSchema = z.object({
  params: orderLineParams,
  body: z
    .object({
      version,
      quantity: z
        .number({ error: 'Must be a number.' })
        .int('Must be a whole number.')
        .min(MIN_LINE_QUANTITY, 'Must be at least 1.')
        .max(MAX_LINE_QUANTITY, `Cannot be more than ${MAX_LINE_QUANTITY}.`)
        .optional(),
      notes,
    })
    .strict('Is not a field you can change on a line.')
    .refine(
      (body) => body.quantity !== undefined || body.notes !== undefined,
      'Send a quantity or a note to change.',
    ),
});



/**
 * `wasPrepared` is optional here and conditionally required in the controller.
 *
 * Whether it is required depends on the line's stored status, which Zod cannot
 * see. A PENDING line was never sent to the kitchen so the question does not
 * arise; a FIRED one has to be answered. See services/orderService.js.
 */
export const cancelOrderLineSchema = z.object({
  params: orderLineParams,
  body: z
    .object({
      version,
      ...reasonFields(LINE_CANCEL_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      wasPrepared: z.boolean({ error: 'Must be true or false.' }).optional(),
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

/** P49. Remove a dish not sent yet: the version in the query, as a DELETE has no body. */
export const removeOrderLineSchema = z.object({
  params: orderLineParams,
  query: z.object({
    version: z.coerce.number({ error: 'Is required. Send the version you last read.' }).int('Must be a whole number.').min(1, 'Must be 1 or more.'),
  }),
});

/** P42. Lower a sent line's quantity: the new quantity, and 12.6's answers for the part taken off. */
export const reduceOrderLineSchema = z.object({
  params: orderLineParams,
  body: z
    .object({
      version,
      quantity: z
        .number({ error: 'Must be a number.' })
        .int('Must be a whole number.')
        .min(MIN_LINE_QUANTITY, 'Must be at least 1.')
        .max(MAX_LINE_QUANTITY, `Cannot be more than ${MAX_LINE_QUANTITY}.`),
      ...reasonFields(LINE_CANCEL_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      wasPrepared: z.boolean({ error: 'Must be true or false.' }),
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

export const fireOrderSchema = z.object({
  params: orderIdParam,
  body: z.object({ version }).strict('Is not a field you can set here.'),
});

/** P41. Undo the last Send: the version, nothing else. */
export const undoSendSchema = fireOrderSchema;

/** P50. Close an order opened by mistake: the version, nothing else. */
export const closeOrderSchema = fireOrderSchema;

export const markLineServedSchema = z.object({
  params: orderLineParams,
  body: z.object({ version }).strict('Is not a field you can set here.'),
});

export const moveOrderTableSchema = z.object({
  params: orderIdParam,
  body: z.object({ version, tableId: objectId }).strict('Is not a field you can set here.'),
});

/** P56. One note for every dish; an empty string, like null, clears it. */
export const kitchenNoteSchema = z.object({
  params: orderIdParam,
  body: z
    .object({
      version,
      kitchenNote: z
        .string({ error: 'Must be text, or null.' })
        .trim()
        .max(KITCHEN_NOTE_MAX_LENGTH, `Cannot be longer than ${KITCHEN_NOTE_MAX_LENGTH} characters.`)
        .transform((value) => value || null)
        .nullable(),
    })
    .strict('Is not a field you can set here.'),
});

/** P56. The guest's details, set before the first KOT. */
export const orderCustomerSchema = z.object({
  params: orderIdParam,
  body: z
    .object({
      version,
      customerName: nonEmptyString
        .max(CUSTOMER_NAME_MAX_LENGTH, `Cannot be longer than ${CUSTOMER_NAME_MAX_LENGTH} characters.`)
        .optional(),
      customerPhone: phoneIndia.optional(),
      offersConsent: z.boolean({ error: 'Must be true or false.' }).optional(),
      // P59. The covers, asked with the guest's details at the first Send.
      guestCount: z
        .number({ error: 'Must be a number.' })
        .int('Must be a whole number.')
        .min(MIN_GUEST_COUNT, 'Must be at least 1.')
        .max(MAX_GUEST_COUNT, `Cannot be more than ${MAX_GUEST_COUNT}.`)
        .optional(),
    })
    .strict('Is not a field you can set here.')
    .refine((body) => body.customerName !== undefined || body.customerPhone !== undefined || body.guestCount !== undefined, {
      path: ['customerName'],
      message: "Give the guest's name, mobile or number of guests.",
    })
    .refine((body) => !body.offersConsent || Boolean(body.customerPhone), {
      path: ['offersConsent'],
      message: "Add the guest's mobile number to record that they agreed to offers.",
    }),
});

export const cancelOrderSchema = z.object({
  params: orderIdParam,
  body: z
    .object({
      version,
      ...reasonFields(ORDER_CANCEL_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      wasPrepared: z.boolean({ error: 'Must be true or false.' }).optional(),
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

/**
 * POST /orders/:orderId/no-charge. P08. The order's version, a fixed reason and
 * an optional note, required for Other.
 */
export const noChargeSchema = z.object({
  params: orderIdParam,
  body: z
    .object({
      version,
      ...reasonFields(NO_CHARGE_REASON_CODES, CANCEL_REASON_MAX_LENGTH),
      approval: approval.optional(),
    })
    .strict('Is not a field you can set here.')
    .superRefine(requireNoteForOther),
});

// ---------------------------------------------------------------------------
// Kitchen tickets
// ---------------------------------------------------------------------------

/**
 * The derived KOT statuses. Not stored on the document, so this list lives
 * here rather than on the model: it describes what a caller may ask for, and
 * the model has no field to hold it.
 */
export const KOT_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
});
export const KOT_STATUS_VALUES = Object.freeze(Object.values(KOT_STATUSES));

const kotIdParam = z.object({ kotId: objectId });
const kotLineParams = z.object({ kotId: objectId, lineId: objectId });

const kotStatusList = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value === undefined || value === '' ? undefined : value.split(',').map((part) => part.trim()),
  )
  .pipe(z.array(z.enum(KOT_STATUS_VALUES, { error: 'Is not a ticket status.' })).min(1).optional());

export const listKotsSchema = z.object({
  query: paginationQuery.extend({
    status: kotStatusList,
    // P05. A station id, or "none" for tickets that went to no station.
    stationId: z.union([z.literal('none'), objectId], {
      error: 'Must be a station id, or none.',
    }).optional(),
    // P41. Newest change first, for the kitchen's Recall list.
    sort: z.enum(['recent'], { error: 'Must be recent.' }).optional(),
  }),
});

/** GET /kots/:kotId/ticket. 32 is 58mm paper, 48 is 80mm. P05. */
export const kotTicketSchema = z.object({
  params: z.object({ kotId: objectId }),
  query: z
    .object({
      width: z
        .enum(['32', '48'], { error: 'Must be 32 or 48.' })
        .default('32')
        .transform(Number),
      reprint: queryBoolean,
      // P36. One round, and one station's dishes.
      round: z.coerce.number({ error: 'Must be a round number.' }).int('Must be a round number.').min(1, 'Must be a round number.').optional(),
      stationId: objectId.optional(),
    })
    .strict('Is not an option on a ticket.'),
});

export const readKotSchema = z.object({ params: kotIdParam });

/**
 * No `version` on either ready endpoint, deliberately.
 *
 * A kitchen ticket is append-only from the kitchen's side and two cooks marking
 * the same dish ready is harmless: the second one finds it already READY and is
 * told so. Asking the person at the pass to hold a version number would be
 * optimistic concurrency solving a problem the kitchen does not have.
 */
export const markKotLineReadySchema = z.object({ params: kotLineParams });
/** P36. `stationId` marks, or takes back, only that station's dishes on the ticket. */
export const markKotReadySchema = z.object({
  params: kotIdParam,
  query: z.object({ stationId: objectId.optional() }).strict('Is not an option here.'),
});
