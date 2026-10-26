/**
 * The CA's month, sent by itself. P65, API-CONTRACT "P65" sections 3 and 4.
 *
 * On the 1st of each month (by business date) the previous month's pack, R20
 * and, with Tally connected and mapped, the month's Tally XML from the export
 * service, is emailed to the restaurant's CA. One ticker, started with the
 * server in P54's shape, decides on each tick whether anything is due, and
 * only where the job loop runs (`mayRunWriterLoops`).
 *
 * A month is claimed in `careportsends` before anything is built. The unique
 * index on `{ restaurantId, period }` is what makes a restart, a second machine
 * or a retry unable to send a month twice: only an insert, or a FAILED or
 * REFUSED row moved to SENDING, wins the claim. A month with a day open is
 * REFUSED rather than sent: a CA filing from half a month is worse off than a
 * CA with nothing.
 */
import { logger } from '../config/logger.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { Branch } from '../models/Branch.js';
import { CA_SEND_STATUSES, CA_SEND_TRIGGERS, CaReportSend } from '../models/CaReportSend.js';
import { Restaurant } from '../models/Restaurant.js';
import {
  AppError,
  BusinessRuleError,
  DuplicateError,
  IntegrationNotActiveError,
  TallyMappingIncompleteError,
} from '../utils/errors.js';
import { scoped } from '../utils/scopedQuery.js';
import { businessDateFor, nowUtc } from '../utils/time.js';
import { recordAudit } from './auditService.js';
import { sendEmail } from './emailService.js';
import { activeConnection } from './integrations/connectionService.js';
import { asIntegration } from './integrations/systemActor.js';
import { buildDay, datesBetween } from './integrations/tally/exportService.js';
import { profileFor } from './integrations/tally/profiles.js';
import { unbalanced } from './integrations/tally/vouchers.js';
import { toTallyXml } from './integrations/tally/xml.js';
import { mayRunWriterLoops } from './replication/writerState.js';
import caPack, { monthRange } from './reports/definitions/caPack.js';
import { runReport } from './reports/engine.js';
import { buildWorkbook } from './reports/exportXlsx.js';
import { getSettings } from './settingsService.js';

export const CA_TICK_MS = 60 * 60_000;
const HISTORY = 12;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DUPLICATE_KEY = 11000;

/** "2026-10" as "October 2026". */
export function monthWords(period) {
  const [year, month] = period.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

/** The month before the one `businessDate` falls in. */
export function previousMonth(businessDate) {
  const [year, month] = businessDate.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

const fileSafe = (text) => text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The month's Tally XML, built by the export service from the same closed days
 * and recorded nowhere: it is the CA's copy, not a posting. Throws when Tally is
 * not connected, a ledger is missing, or a voucher does not balance.
 */
export async function monthTallyXml(req, period) {
  const connection = await activeConnection(req, 'TALLY');
  const { from, to } = monthRange(period);
  const vouchers = [];
  const missing = new Set();
  for (const date of datesBetween(from, to)) {
    const day = await buildDay(req, connection, date, { batchId: `CA-${period}` });
    day.missing.forEach((head) => missing.add(head));
    vouchers.push(...day.vouchers);
  }
  if (missing.size > 0) throw new TallyMappingIncompleteError([...missing]);
  const off = unbalanced(vouchers);
  if (off) throw new BusinessRuleError(`Voucher ${off.number} does not balance, so no Tally file was built.`);
  return toTallyXml(vouchers, profileFor(connection.config.version), connection.config.companyName);
}

/** The pack's files. Throws the report's own refusal: a day open, a check failing, a copy behind. */
async function buildFiles(req, period) {
  const { envelope } = await runReport(req, caPack, { month: period, format: 'xlsx' });
  // Tenancy root, by _id from a verified token or the ticker's own restaurant.
  const restaurant = await Restaurant.findById(req.restaurantId).select('name').lean();
  const stem = `${fileSafe(restaurant?.name ?? 'Restaurant')}-CA-pack-${period}`;
  const files = [{ filename: `${stem}.xlsx`, content: (await buildWorkbook(envelope)).toString('base64') }];

  let tallyNote = 'The Tally XML for the month is attached, for import into Tally.';
  try {
    const xml = await monthTallyXml(req, period);
    files.push({ filename: `${stem}-Tally.xml`, content: Buffer.from(xml, 'utf8').toString('base64') });
  } catch (error) {
    if (error instanceof IntegrationNotActiveError) tallyNote = 'Tally is not connected, so no Tally file is attached.';
    else if (error instanceof TallyMappingIncompleteError) tallyNote = 'Some Tally ledgers are not mapped yet, so no Tally file is attached.';
    else if (error instanceof AppError && error.statusCode === 422) tallyNote = `No Tally file is attached: ${error.message}`;
    else throw error;
  }
  return { envelope, files, restaurantName: restaurant?.name ?? '', tallyNote };
}

function emailText(period, { restaurantName, envelope, tallyNote }) {
  const failed = envelope.checks.filter((check) => !check.passed);
  return [
    `CA pack for ${monthWords(period)}, ${restaurantName}: every business date from ${envelope.filter.from} to ${envelope.filter.to}, all closed.`,
    '',
    'The workbook has one sheet per part: the cover, outward supplies by rate, the HSN and SAC summary, the document series, money received, On Hold movement, cash and expenses, and the checks.',
    tallyNote,
    failed.length === 0 ? `All ${envelope.checks.length} checks passed.` : `${failed.length} warnings: see the Checks sheet.`,
    '',
    'Not in this pack: purchases and input GST, B2B sales, credit notes, e-invoices and any guest personal data. The cover says why.',
    '',
    'Sent by the restaurant software on the restaurant’s behalf.',
  ].join('\n');
}

/** Claims the month. Null when another send holds it, or it is already sent (automatic sends). */
async function claim(req, period, trigger, sentBy) {
  const now = nowUtc();
  const fresh = { status: CA_SEND_STATUSES.SENDING, trigger, claimedAt: now, sentBy, refusedReason: null, lastError: null, openDates: [], failedChecks: [] };
  try {
    return await CaReportSend.create({ ...scoped(req), period, attempts: 1, ...fresh });
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
  }
  // An automatic send retries only a failed or refused month; the owner's Send now also a sent one.
  const retryable = trigger === CA_SEND_TRIGGERS.MANUAL ? { $ne: CA_SEND_STATUSES.SENDING } : { $in: [CA_SEND_STATUSES.FAILED, CA_SEND_STATUSES.REFUSED] };
  return CaReportSend.findOneAndUpdate({ ...scoped(req), period, status: retryable }, { $set: fresh, $inc: { attempts: 1 } }, { new: true });
}

const settle = (row, change) => CaReportSend.findOneAndUpdate({ _id: row._id, restaurantId: row.restaurantId }, { $set: change }, { new: true });

/**
 * Builds and sends one month. Returns the send row. For the owner's Send now
 * (`MANUAL`), a refusal or a failure is also thrown, so the screen says why.
 */
export async function sendMonth(req, period, { trigger = CA_SEND_TRIGGERS.AUTO, sentBy = null } = {}) {
  const { reports } = await getSettings(req.restaurantId, { req });
  const email = reports.ca.email;
  if (!email) throw new BusinessRuleError("Add the CA's email first: the pack goes by email.");

  const row = await claim(req, period, trigger, sentBy);
  if (!row) {
    if (trigger === CA_SEND_TRIGGERS.MANUAL) throw new DuplicateError('This month is being sent right now.');
    return null;
  }

  let built;
  try {
    built = await buildFiles(req, period);
  } catch (error) {
    const refusal = error instanceof AppError && error.statusCode === 422;
    const saved = await settle(
      row,
      refusal
        ? {
            status: CA_SEND_STATUSES.REFUSED,
            refusedReason: error.message,
            openDates: error.details?.businessDates ?? [],
            failedChecks: (error.details?.checks ?? []).map((check) => check.id),
          }
        : { status: CA_SEND_STATUSES.FAILED, lastError: 'The pack could not be built.' },
    );
    if (!refusal) logger.error({ err: error, restaurantId: String(req.restaurantId), period }, 'CA pack: the pack could not be built.');
    if (trigger === CA_SEND_TRIGGERS.MANUAL || !refusal) throw error;
    return saved;
  }

  try {
    await sendEmail({
      to: [email],
      subject: `CA pack, ${monthWords(period)}, ${built.restaurantName}`,
      text: emailText(period, built),
      attachments: built.files,
    });
  } catch (error) {
    const saved = await settle(row, { status: CA_SEND_STATUSES.FAILED, lastError: error.message });
    if (trigger === CA_SEND_TRIGGERS.MANUAL) throw error;
    logger.warn({ restaurantId: String(req.restaurantId), period, reason: error.message }, 'CA pack: the email service refused it; tried again next hour.');
    return saved;
  }

  const files = built.files.map((file) => file.filename);
  const saved = await settle(row, {
    status: CA_SEND_STATUSES.SENT,
    sentAt: nowUtc(),
    to: [email],
    files,
    checks: { passed: built.envelope.checks.filter((check) => check.passed).length, failed: built.envelope.checks.filter((check) => !check.passed).length },
  });
  await recordAudit(req, {
    action: AUDIT_ACTIONS.CA_PACK_SENT,
    entityType: AUDIT_ENTITY_TYPES.REPORT,
    entityId: saved._id,
    entityLabel: period,
    reason: trigger === CA_SEND_TRIGGERS.MANUAL ? 'Sent by the owner' : 'Sent on the 1st of the month',
    details: { period, trigger, files },
  });
  return saved;
}

function present(row) {
  return {
    period: row.period,
    status: row.status,
    trigger: row.trigger,
    refusedReason: row.refusedReason,
    openDates: [...(row.openDates ?? [])],
    failedChecks: [...(row.failedChecks ?? [])],
    sentAt: row.sentAt,
    to: [...(row.to ?? [])],
    files: [...(row.files ?? [])],
    checks: { passed: row.checks?.passed ?? 0, failed: row.checks?.failed ?? 0 },
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

/** GET /reports/ca/sends. */
export async function listSends(req) {
  const { reports } = await getSettings(req.restaurantId, { req });
  const rows = await CaReportSend.find({ ...scoped(req) }).sort({ period: -1 }).limit(HISTORY).lean();
  return { ca: { enabled: reports.ca.enabled, hasEmail: Boolean(reports.ca.email) }, sends: rows.map(present) };
}

export { present as presentSend };

/**
 * One tick: every restaurant with the send on and an email, for the month
 * before today's business date. Never throws; each restaurant on its own.
 */
export async function tickCaSends() {
  if (!mayRunWriterLoops()) return [];
  // Restaurants are the tenancy root: this lists the ones that asked for the pack.
  const restaurants = await Restaurant.find({ isActive: true, 'settings.reports.ca.enabled': true, 'settings.reports.ca.email': { $nin: [null, ''] } })
    .select('_id settings.businessDayStartsAtMinutes')
    .lean();
  const results = [];
  for (const restaurant of restaurants) {
    try {
      const branch = await Branch.findOne({ restaurantId: restaurant._id }).sort({ createdAt: 1 }).select('_id').lean();
      if (!branch) continue;
      const period = previousMonth(businessDateFor(nowUtc(), restaurant.settings?.businessDayStartsAtMinutes));
      const req = await asIntegration(restaurant._id, branch._id, 'CA reports');
      results.push(await sendMonth(req, period, { trigger: CA_SEND_TRIGGERS.AUTO }));
    } catch (error) {
      logger.error({ err: error, restaurantId: String(restaurant._id) }, 'CA pack: the monthly send failed a round.');
    }
  }
  return results;
}

let ticker = null;

/** Starts the hourly tick. Safe to call once; a failing tick is logged, never thrown. */
export function startCaSends() {
  if (ticker) return ticker;
  const run = () => tickCaSends().catch((error) => logger.error({ err: error }, 'CA pack: a tick failed.'));
  ticker = setInterval(run, CA_TICK_MS);
  ticker.unref?.();
  run();
  return ticker;
}

export function stopCaSends() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

export default { listSends, monthTallyXml, sendMonth, startCaSends, stopCaSends, tickCaSends };
