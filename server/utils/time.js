/**
 * Time.
 *
 * Stored in UTC. Always. Converted for display, and only for display.
 *
 * This file is the server side of that conversion. The client side is
 * client/src/utils/formatDate.js. There are exactly two places that convert a
 * timestamp in this project, one per side, and neither of them is a component.
 */
import { config } from '../config/env.js';

/*
 * The clock every service reads. Tests replace it so the golden day in
 * docs/TEST-DATA.md can happen at its real times, including a payment at
 * 12:02 AM that still belongs to the day before. Token times do not read it:
 * tokenService keeps the real clock, or signed tokens break in tests. P08.
 */
const realClock = () => new Date();
let clock = realClock;

/** The current instant. Store this. Do not store a formatted string. */
export function nowUtc() {
  return clock();
}

function assertTestEnvironment(name) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${name} may only be called when NODE_ENV is test.`);
  }
}

/**
 * Sets the clock for tests. Takes a Date, an ISO string, or a function that
 * returns a Date. A fixed instant stays fixed until it is changed or reset.
 */
export function setClockForTests(fnOrDate) {
  assertTestEnvironment('setClockForTests');
  if (typeof fnOrDate === 'function') {
    clock = () => new Date(fnOrDate().getTime());
    return;
  }
  const fixed = new Date(fnOrDate);
  if (Number.isNaN(fixed.getTime())) {
    throw new TypeError('setClockForTests received a value that is not a valid date.');
  }
  clock = () => new Date(fixed.getTime());
}

/** Puts the real clock back. */
export function resetClockForTests() {
  assertTestEnvironment('resetClockForTests');
  clock = realClock;
}

/**
 * Formats an instant for display in India Standard Time.
 *
 * Server side only: logs, printed output, a receipt. An API response sends the
 * raw UTC Date and lets the client format it.
 *
 * Output looks like: 2026-08-28 20:34:12 IST
 */
export function toIst(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('toIst received a value that is not a valid date.');
  }

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} IST`;
}

/* ------------------------------------------------------------------------- *
 * THE BUSINESS DAY
 *
 * A restaurant that closes at 1am wants those sales counted under yesterday. If
 * the business day started at midnight, every late-night sale would land on the
 * wrong day and every report built on it would be wrong.
 *
 * Decided for M5 (docs/PROJECT-STATE.md decision log, D1): the boundary is
 * `restaurants.settings.businessDayStartsAtMinutes`, an integer number of
 * minutes past midnight IST, default 300 (05:00), configurable per restaurant.
 *
 * `businessDateFor` is the one place that turns an instant into the day it
 * belongs to. M5 stores its result on every attendance entry at clock-in and
 * never recomputes it. M3 and M6 will read the same function when they need a
 * day boundary. No caller does its own date arithmetic.
 * ------------------------------------------------------------------------- */

/** Minutes past midnight IST at which the business day rolls over. 05:00. */
export const DEFAULT_BUSINESS_DAY_START_MINUTES = 300;

/** IST is UTC+05:30. India does not observe daylight saving, so this is fixed. */
const IST_OFFSET_MINUTES = 330;
const MINUTE_MS = 60_000;

/** Minutes past midnight IST, 0 to 1439, for a rule about the hours of the day. P63. */
export function istMinuteOfDay(instant) {
  const value = instant instanceof Date ? instant : new Date(instant);
  return Math.floor((value.getTime() / MINUTE_MS + IST_OFFSET_MINUTES) % 1440);
}

/**
 * "9:05 PM" in the display time zone. For printed tickets and other places a
 * person reads a time of day. P05.
 */
export function formatTimeIst12(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('formatTimeIst12 received a value that is not a valid date.');
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: config.DISPLAY_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(value);
}

/**
 * The business day an instant belongs to, as a "YYYY-MM-DD" string.
 *
 * The instant is shifted into IST wall-clock time and then back past the
 * business-day boundary, and the calendar date of the result is read with the
 * UTC getters. Both offsets are applied to the epoch value, so no assumption
 * about the host machine's timezone can leak in.
 *
 * With the default 05:00 boundary, a clock-in at 2026-08-30 01:30 IST
 * (2026-08-29 20:00 UTC) returns "2026-08-29": the shift that began the
 * previous evening is counted under that evening.
 */
export function businessDateFor(instant, startMinutes = DEFAULT_BUSINESS_DAY_START_MINUTES) {
  const value = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('businessDateFor received a value that is not a valid date.');
  }

  const shifted = new Date(value.getTime() + (IST_OFFSET_MINUTES - startMinutes) * MINUTE_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The Indian financial year an instant falls in, as "2026-27".
 *
 * Runs 1 April to 31 March, so 2026-08-30 and 2027-02-14 are both "2026-27"
 * and 2027-04-01 is "2027-28".
 *
 * Read in IST, not UTC. A bill rung up at 00:30 IST on 1 April is 19:00 UTC on
 * 31 March, and putting it in the previous financial year would be wrong on
 * the one night of the year it matters most.
 *
 * M3's bill sequence resets on this value and on nothing else, which is why it
 * lives here beside businessDateFor rather than in the billing service: no
 * caller does its own date arithmetic.
 */
export function financialYearFor(instant) {
  const value = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError('financialYearFor received a value that is not a valid date.');
  }

  const ist = new Date(value.getTime() + IST_OFFSET_MINUTES * MINUTE_MS);
  const year = ist.getUTCFullYear();
  const isBeforeApril = ist.getUTCMonth() < 3;
  const startYear = isBeforeApril ? year - 1 : year;

  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * Whole minutes between two instants, seconds dropped.
 *
 * Integer minutes for the same reason money is whole paise: fractional hours
 * accumulate rounding error and two screens that round differently disagree
 * about someone's pay.
 */
export function minutesBetween(start, end) {
  const startMs = (start instanceof Date ? start : new Date(start)).getTime();
  const endMs = (end instanceof Date ? end : new Date(end)).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new TypeError('minutesBetween received a value that is not a valid date.');
  }
  return Math.floor((endMs - startMs) / MINUTE_MS);
}

/**
 * The inverse of `businessDateFor`: the UTC instant range one business day
 * covers.
 *
 * `from` and `to` are inclusive "YYYY-MM-DD" business dates. The range
 * returned is `[start, end)` -- `end` is the instant the day AFTER `to`
 * begins, so a caller compares with `$gte` / `$lt` and never has to reason
 * about an off-by-one on the last millisecond of a day.
 *
 * Added for M4's unmapped-recipe and consumption reads, which both filter a
 * ledger of instants by a business-date range the same way M3's bill list
 * filters `businessDate` -- except those two read fired timestamps directly,
 * not a stored `businessDate` string, so they need the boundary the other
 * direction.
 */
export function businessDateRangeToUtc(from, to, startMinutes = DEFAULT_BUSINESS_DAY_START_MINUTES) {
  const parse = (dateString) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!match) {
      throw new TypeError(`businessDateRangeToUtc received "${dateString}", not a YYYY-MM-DD date.`);
    }
    const [, year, month, day] = match.map(Number);
    // IST wall-clock (year, month, day, startMinutes) shifted back to UTC.
    return new Date(Date.UTC(year, month - 1, day) + startMinutes * MINUTE_MS - IST_OFFSET_MINUTES * MINUTE_MS);
  };

  const start = parse(from);
  const dayAfterTo = parse(to);
  const end = new Date(dayAfterTo.getTime() + 24 * 60 * MINUTE_MS);

  return { start, end };
}

/* ------------------------------------------------------------------------- *
 * Wall-clock India time, for opening hours. P23 (M14).
 * ------------------------------------------------------------------------- */

/**
 * The UTC instant of an India wall-clock time: `date` is "YYYY-MM-DD", and
 * `minutes` is minutes past that date's midnight IST, and may run past 1440
 * into the next day. India has no daylight saving, so this is exact.
 */
export function istWallClockToUtc(date, minutes) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError(`istWallClockToUtc received "${date}", not a YYYY-MM-DD date.`);
  const [, year, month, day] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day) + (minutes - IST_OFFSET_MINUTES) * MINUTE_MS);
}

/** "YYYY-MM-DD" plus a number of days, as a label. No time zone is involved. */
export function addDaysToDate(date, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError(`addDaysToDate received "${date}", not a YYYY-MM-DD date.`);
  const [, year, month, day] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
