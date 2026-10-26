/**
 * P63. When the cafe PC syncs with the website, so Render's free server is
 * awake only while the cafe is open. docs/DEPLOYMENT.md section 19.
 *
 *   inside SYNC_HOURS   every SYNC_EVERY_SECONDS
 *   outside them        only with changes waiting to go up, at most every 15 minutes
 *   the first round     always, so a PC that comes back gets the website's bills at once
 *
 * Render sleeps after 15 minutes without a request, so a quiet night costs no hours.
 */
import { istMinuteOfDay } from '../../utils/time.js';

export const QUIET_EVERY_MS = 15 * 60_000;

/** "08:30-02:30" as minutes past midnight, or null for "always". */
export function parseSyncHours(text) {
  if (!text || text === 'always') return null;
  const [from, to] = text.split('-').map((part) => {
    const [hours, minutes] = part.split(':').map(Number);
    return hours * 60 + minutes;
  });
  return { from, to };
}

/** Whether a minute of the day falls inside the hours; a span past midnight wraps. */
export function insideHours(minute, hours) {
  if (!hours) return true;
  if (hours.from === hours.to) return true;
  return hours.from < hours.to ? minute >= hours.from && minute < hours.to : minute >= hours.from || minute < hours.to;
}

/** Whether to run a round now. `lastAt` is 0 before the first round. */
export function shouldExchange({ now, lastAt, waiting, everyMs, hours }) {
  if (!lastAt) return true;
  const since = now.getTime() - lastAt;
  if (insideHours(istMinuteOfDay(now), hours)) return since >= everyMs;
  return waiting && since >= QUIET_EVERY_MS;
}
