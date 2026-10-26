/**
 * The error handler. Last in the chain, catches everything.
 *
 * Two audiences, two different amounts of detail.
 *
 * The server log gets the whole error, with the restaurantId and the route, so
 * a problem can be traced to one tenant and one request.
 *
 * The client gets the standard failure envelope and nothing else. No stack
 * trace, no database error text, no field names it did not already send.
 */
import { ZodError } from 'zod';

import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';

const MONGO_DUPLICATE_KEY = 11000;

/**
 * Maps the errors we did not raise ourselves.
 *
 * Anything not recognised here falls through to a generic 500, which is the
 * right default: an error we have not thought about is an error whose message
 * we have not checked for anything sensitive.
 */
function toAppShape(error) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      fields: error.fields,
      details: error.details,
    };
  }

  // A Zod error here means a schema ran outside the validate middleware.
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Some of the information sent was not valid.',
    };
  }

  // Mongo unique index violation. The field name is useful to the client, the
  // value is not, and the value is often personal data.
  if (error?.code === MONGO_DUPLICATE_KEY) {
    const field = Object.keys(error.keyPattern ?? {})[0];
    return {
      statusCode: 409,
      code: ERROR_CODES.DUPLICATE,
      message: 'That already exists.',
      fields: field ? { [field]: 'Already in use.' } : undefined,
    };
  }

  // Mongoose schema validation, for anything that slipped past Zod.
  if (error?.name === 'ValidationError' && error?.errors) {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Some of the information sent was not valid.',
      fields: Object.fromEntries(
        Object.keys(error.errors).map((key) => [key, 'Is not valid.']),
      ),
    };
  }

  // A malformed id that reached the database.
  if (error?.name === 'CastError') {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Some of the information sent was not valid.',
    };
  }

  // body-parser. Both are the caller mistake, not ours, so neither is a 500.
  if (error?.type === 'entity.too.large') {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'That request was too large.',
    };
  }
  if (error?.type === 'entity.parse.failed') {
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'The request body was not valid JSON.',
    };
  }

  return null;
}

/** P62. The three 503s whose words a person needs to read. */
const P62_REFUSALS = Object.freeze([ERROR_CODES.MIRROR_READ_ONLY, ERROR_CODES.CLOCK_BEHIND, ERROR_CODES.WRITER_FENCED]);

export function errorHandler(error, req, res, _next) {
  const mapped = toAppShape(error);
  const statusCode = mapped?.statusCode ?? 500;

  const log = req.log ?? logger;
  const context = {
    err: error,
    statusCode,
    route: `${req.method} ${req.originalUrl}`,
    restaurantId: req.restaurantId ?? null,
    userId: req.user?.id ?? null,
  };

  if (statusCode >= 500) {
    log.error(context, 'Request failed.');
  } else {
    log.warn(context, 'Request rejected.');
  }

  // Express has already started writing. Nothing useful left to say.
  if (res.headersSent) return;

  // P24. A 502 we raised on purpose names the payment gateway's failure in a
  // sentence a guest can act on ("try again in a moment"), so it is shown.
  const isGatewayFailure = statusCode === 502 && error?.isOperational === true;
  // P62. A 503 we raised on purpose (the read-only mirror, the box's clock, a
  // box that stood down) says what to do in plain words, so it is shown too.
  const isPlannedRefusal = statusCode === 503 && error?.isOperational === true && P62_REFUSALS.includes(mapped?.code);

  if (statusCode >= 500 && !isGatewayFailure && !isPlannedRefusal) {
    /**
     * Every 500 looks the same from outside, including the ones we raised
     * deliberately. A 500 means we got something wrong, and the details of how
     * are for the log, not for whoever is holding the tablet.
     */
    const body = {
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our end. The team has been notified.',
      },
    };

    // Outside production, name the error so a developer is not left guessing.
    // Still not a stack trace, and still never in production.
    if (!config.isProduction) {
      body.error.debug = { name: error?.name ?? 'Error', message: error?.message ?? '' };
    }

    res.status(500).json(body);
    return;
  }

  const payload = { code: mapped.code, message: mapped.message };
  if (mapped.fields) payload.fields = mapped.fields;

  /**
   * M2. A few errors carry a value the client acts on rather than displays:
   * TABLE_OCCUPIED carries the id of the order already open, VERSION_CONFLICT
   * carries the version the order really has. The contract names both at the
   * top level of `error`, beside code and message, so they are merged in here.
   *
   * Only ever reached from an AppError constructed with `details`, so nothing
   * unexpected can arrive this way. Assigned before code and message would be
   * overwritten? No: spread last would let a stray `code` key shadow the real
   * one, so the two known keys are written over the top instead.
   */
  if (mapped.details) Object.assign(payload, mapped.details, { code: mapped.code });

  res.status(statusCode).json({ success: false, error: payload });
}
