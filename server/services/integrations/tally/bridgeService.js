/**
 * The Tally bridge, server side. P25 Part K, API-CONTRACT M21 sections 9.3
 * and 9.4.
 *
 * A bridge is a small program on the accountant's computer. It is paired once
 * with an 8-character code the owner makes (10 minutes, one use), then asks
 * for work with its own token. Neither the code nor the token is stored, only
 * their SHA-256. The token opens the three bridge routes and nothing else.
 *
 * Work for a bridge is an integration job with `forBridge`: PING (which
 * companies are open), FETCH_LEDGERS (the company's ledger names) and
 * POST_VOUCHERS (one export). A post is refused, naming them, while a ledger
 * it uses is missing from the latest ledger list read after the mapping last
 * changed. A post the bridge took and never reported is never handed out
 * again: Tally may have it, so the export becomes UNKNOWN.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../../../models/AuditLog.js';
import { IntegrationConnection } from '../../../models/IntegrationConnection.js';
import { IntegrationJob, JOB_STATUSES } from '../../../models/IntegrationJob.js';
import { Restaurant } from '../../../models/Restaurant.js';
import { TallyBridge } from '../../../models/TallyBridge.js';
import { TALLY_EXPORT_HOLDING, TALLY_EXPORT_STATUSES, TallyExport } from '../../../models/TallyExport.js';
import {
  BridgeTokenInvalidError,
  BusinessRuleError,
  IntegrationNotActiveError,
  NotFoundError,
  PairingCodeInvalidError,
  TallyAlreadyExportedError,
  TallyMappingIncompleteError,
} from '../../../utils/errors.js';
import { scoped } from '../../../utils/scopedQuery.js';
import { nowUtc } from '../../../utils/time.js';
import { recordAudit } from '../../auditService.js';
import { enqueueJob } from '../jobRunner.js';
import { asIntegration } from '../systemActor.js';
import { recordTallyAnswer } from './exportService.js';
import { companyListXml, ledgerListXml, ledgersUsedIn, namesIn, parseTallyResponse } from './xml.js';

export const PAIRING_MINUTES = 10;
export const BRIDGE_JOB_LOCK_MS = 10 * 60_000;
export const BRIDGE_JOBS = Object.freeze({ PING: 'PING', FETCH_LEDGERS: 'FETCH_LEDGERS', POST_VOUCHERS: 'POST_VOUCHERS' });
const RESPONSE_KEEP = 64 * 1024;
/** No 0, O, 1, I or L: read aloud over a phone without confusion. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * A bridge by the hash of its code or its token, before the restaurant is
 * known: one of M21's three sanctioned cross-restaurant reads.
 */
function findByHash(field, hash) {
  return TallyBridge.findOne({ [field]: hash })
    .select('+pairingCodeHash +tokenHash')
    .setOptions({ skipTenantGuard: true });
}

async function tallyConnection(req) {
  const connection = await IntegrationConnection.findOne({ ...scoped(req), provider: 'TALLY' });
  if (!connection) throw new IntegrationNotActiveError('Set up Tally in Integrations first.');
  return connection;
}

const stateOf = (bridge, now) => {
  if (bridge.revokedAt) return 'REVOKED';
  if (bridge.pairedAt) return 'ACTIVE';
  return bridge.pairingExpiresAt && bridge.pairingExpiresAt > now ? 'PENDING' : 'EXPIRED';
};

function present(bridge) {
  const now = nowUtc();
  return {
    id: String(bridge._id),
    name: bridge.name,
    machineName: bridge.machineName ?? null,
    state: stateOf(bridge, now),
    pairingExpiresAt: bridge.pairedAt ? null : bridge.pairingExpiresAt,
    lastSeenAt: bridge.lastSeenAt,
    tallyVersionSeen: bridge.tallyVersionSeen,
    companiesSeen: bridge.companiesSeen ?? [],
    ledgersSeenAt: bridge.ledgersSeenAt,
    ledgerCount: (bridge.ledgersSeen ?? []).length,
    pairedAt: bridge.pairedAt,
    revokedAt: bridge.revokedAt,
  };
}

/* The owner's side. ------------------------------------------------------ */

/** POST /integrations/tally/bridges/pairing-code. OWNER. The code, once. */
export async function createPairingCode(req, { name }) {
  const connection = await tallyConnection(req);
  let code = '';
  for (let index = 0; index < 8; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = new Date(nowUtc().getTime() + PAIRING_MINUTES * 60_000);
  const bridge = await TallyBridge.create({
    ...scoped(req),
    connectionId: connection._id,
    name,
    pairingCodeHash: sha256(code),
    pairingExpiresAt: expiresAt,
    pairedBy: req.user.id,
  });
  return { bridgeId: String(bridge._id), code, expiresAt };
}

/** GET /integrations/tally/bridges. OWNER, MANAGER. Never a hash. */
export async function listBridges(req) {
  const connection = await IntegrationConnection.findOne({ ...scoped(req), provider: 'TALLY' });
  if (!connection) return [];
  const rows = await TallyBridge.find({ ...scoped(req), connectionId: connection._id }).sort({ createdAt: -1 });
  return rows.map(present);
}

/** POST /integrations/tally/bridges/:id/revoke. OWNER. */
export async function revokeBridge(req, id) {
  const bridge = await TallyBridge.findOne({ ...scoped(req), _id: id });
  if (!bridge) throw new NotFoundError('Tally bridge not found.');
  if (bridge.revokedAt) throw new BusinessRuleError('This bridge is already switched off.');
  await TallyBridge.updateOne(
    { ...scoped(req), _id: bridge._id },
    { $set: { revokedAt: nowUtc(), revokedBy: req.user.id, pairingCodeHash: null, pairingExpiresAt: null } },
  );
  await recordAudit(req, {
    action: AUDIT_ACTIONS.TALLY_BRIDGE_REVOKED,
    entityType: AUDIT_ENTITY_TYPES.INTEGRATION,
    entityId: bridge._id,
    entityLabel: bridge.name,
    reason: `Tally bridge "${bridge.name}" switched off`,
  });
  return present(await TallyBridge.findOne({ ...scoped(req), _id: bridge._id }));
}

/** A paired bridge that is not switched off, for the connection. */
function activeBridges(req, connectionId) {
  return TallyBridge.find({ ...scoped(req), connectionId, pairedAt: { $ne: null }, revokedAt: null });
}

/** Ledger names used by an export and missing from a fresh enough list; null when no fresh list exists. */
function missingLedgers(bridges, connection, xml) {
  const fresh = bridges.filter((bridge) => bridge.ledgersSeenAt && bridge.ledgersSeenAt >= connection.updatedAt).sort((a, b) => b.ledgersSeenAt - a.ledgersSeenAt);
  if (fresh.length === 0) return null;
  const known = new Set(fresh[0].ledgersSeen.map((name) => name.toLowerCase()));
  return ledgersUsedIn(xml).filter((name) => !known.has(name.toLowerCase()));
}

/**
 * POST /integrations/tally/exports/:id/send. OWNER, MANAGER. Queues a fresh
 * ledger list, then the post, for the bridge.
 */
export async function sendExport(req, exportId) {
  const row = await TallyExport.findOne({ ...scoped(req), _id: exportId }).select('+xml');
  if (!row) throw new NotFoundError('Tally export not found.');
  if (row.status === TALLY_EXPORT_STATUSES.STALE) throw new BusinessRuleError('This export was replaced. Send the newer one.');
  if (TALLY_EXPORT_HOLDING.includes(row.status)) throw new TallyAlreadyExportedError([row.businessDate]);

  const connection = await IntegrationConnection.findOne({ ...scoped(req), _id: row.connectionId });
  const bridges = await activeBridges(req, row.connectionId);
  if (!connection || bridges.length === 0) throw new BusinessRuleError('Pair a Tally bridge first, on the computer that runs Tally.');
  const missing = missingLedgers(bridges, connection, row.xml);
  if (missing && missing.length > 0) throw new TallyMappingIncompleteError(missing.map((name) => `${name} (not in Tally)`));

  const claimed = await TallyExport.findOneAndUpdate(
    { ...scoped(req), _id: row._id, status: { $in: [TALLY_EXPORT_STATUSES.BUILT, TALLY_EXPORT_STATUSES.FAILED] } },
    { $set: { status: TALLY_EXPORT_STATUSES.QUEUED, lineErrors: [] } },
    { new: true },
  );
  if (!claimed) throw new TallyAlreadyExportedError([row.businessDate]);

  const now = nowUtc();
  await enqueueJob(req, { connectionId: row.connectionId, type: BRIDGE_JOBS.FETCH_LEDGERS, forBridge: true, runAfter: now, maxAttempts: 1 });
  const job = await enqueueJob(req, {
    connectionId: row.connectionId,
    type: BRIDGE_JOBS.POST_VOUCHERS,
    payload: { exportId: String(row._id) },
    forBridge: true,
    runAfter: new Date(now.getTime() + 1),
    maxAttempts: 1,
  });
  await TallyExport.updateOne({ ...scoped(req), _id: row._id }, { $set: { jobId: job._id } });
  const { xml: _xml, ...rest } = claimed.toJSON();
  return { ...rest, jobId: String(job._id) };
}

/* The bridge's side. ---------------------------------------------------- */

/** POST /tally-bridge/pair. No token: the code is the credential. */
export async function pairBridge({ code, machineName = null }) {
  const hash = sha256(String(code ?? '').trim().toUpperCase());
  const found = await findByHash('pairingCodeHash', hash);
  const now = nowUtc();
  if (!found || found.revokedAt || found.pairedAt || !found.pairingExpiresAt || found.pairingExpiresAt <= now) throw new PairingCodeInvalidError();

  const token = randomBytes(32).toString('base64url');
  const claimed = await TallyBridge.findOneAndUpdate(
    { restaurantId: found.restaurantId, _id: found._id, pairingCodeHash: hash, pairingExpiresAt: { $gt: now }, revokedAt: null },
    { $set: { tokenHash: sha256(token), machineName: machineName ? String(machineName).slice(0, 60) : null, pairedAt: now, pairingCodeHash: null, pairingExpiresAt: null } },
    { new: true },
  );
  if (!claimed) throw new PairingCodeInvalidError();

  const actor = await asIntegration(found.restaurantId, found.branchId, 'Tally bridge');
  await recordAudit(actor, {
    action: AUDIT_ACTIONS.TALLY_BRIDGE_PAIRED,
    entityType: AUDIT_ENTITY_TYPES.INTEGRATION,
    entityId: claimed._id,
    entityLabel: claimed.name,
    reason: `Tally bridge "${claimed.name}" paired${claimed.machineName ? ` on ${claimed.machineName}` : ''}`,
  });
  // A first PING, so the owner sees the open companies at once.
  await enqueueJob(actor, { connectionId: claimed.connectionId, type: BRIDGE_JOBS.PING, forBridge: true, maxAttempts: 1 });
  const restaurant = await Restaurant.findById(found.restaurantId).select('name').lean();
  return { token, bridgeId: String(claimed._id), serverName: restaurant?.name ?? "Three O'Clock" };
}

/**
 * Middleware for the bridge routes: `Authorization: Bearer <token>`. Sets
 * `req.bridge`, `req.restaurantId` and `req.branchId`. Never `req.user`.
 */
export async function authenticateBridge(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new BridgeTokenInvalidError();
  const bridge = await findByHash('tokenHash', sha256(token));
  if (!bridge || bridge.revokedAt || !bridge.pairedAt) throw new BridgeTokenInvalidError();
  req.bridge = bridge;
  req.restaurantId = String(bridge.restaurantId);
  req.branchId = String(bridge.branchId);
  next();
}

const actorFor = (req) => asIntegration(req.restaurantId, req.branchId, 'Tally bridge');

/** A post the bridge took and never reported is never handed out again. */
async function settleLostPosts(req, now) {
  const lost = await IntegrationJob.find({
    ...scoped(req),
    connectionId: req.bridge.connectionId,
    forBridge: true,
    type: BRIDGE_JOBS.POST_VOUCHERS,
    status: JOB_STATUSES.RUNNING,
    lockedUntil: { $lte: now },
  });
  for (const job of lost) {
    await IntegrationJob.updateOne({ ...scoped(req), _id: job._id }, { $set: { status: JOB_STATUSES.DEAD, lockedUntil: null, lastError: 'The bridge took the vouchers and never reported back.' } });
    await TallyExport.updateOne(
      { ...scoped(req), _id: job.payload?.exportId, status: TALLY_EXPORT_STATUSES.QUEUED },
      { $set: { status: TALLY_EXPORT_STATUSES.UNKNOWN, lineErrors: ["The bridge took the vouchers and never reported back. Check Tally's Day Book before doing anything else."] } },
    );
  }
}

function claimNextJob(req, now) {
  return IntegrationJob.findOneAndUpdate(
    {
      ...scoped(req),
      connectionId: req.bridge.connectionId,
      forBridge: true,
      $or: [
        { status: { $in: [JOB_STATUSES.QUEUED, JOB_STATUSES.FAILED] }, runAfter: { $lte: now } },
        { status: JOB_STATUSES.RUNNING, lockedUntil: { $lte: now }, type: { $ne: BRIDGE_JOBS.POST_VOUCHERS } },
      ],
    },
    { $set: { status: JOB_STATUSES.RUNNING, lockedUntil: new Date(now.getTime() + BRIDGE_JOB_LOCK_MS), 'payload.bridgeId': String(req.bridge._id) }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1, _id: 1 }, new: true },
  );
}

const finishJob = (req, job, update) => IntegrationJob.updateOne({ ...scoped(req), _id: job._id }, { $set: { lockedUntil: null, ...update } });

/**
 * GET /tally-bridge/jobs/next. The next job's XML for Tally, or null. A post
 * whose ledgers are missing, or unchecked, is refused here and the next job
 * is offered instead.
 */
export async function nextJob(req) {
  const now = nowUtc();
  await TallyBridge.updateOne({ ...scoped(req), _id: req.bridge._id }, { $set: { lastSeenAt: now } });
  await settleLostPosts(req, now);
  const connection = await IntegrationConnection.findOne({ ...scoped(req), _id: req.bridge.connectionId });
  if (!connection) return null;
  const companyName = connection.config?.companyName ?? null;

  for (;;) {
    const job = await claimNextJob(req, now);
    if (!job) return null;
    if (job.type === BRIDGE_JOBS.PING) return { jobId: String(job._id), type: job.type, xml: companyListXml(), companyName };
    if (job.type === BRIDGE_JOBS.FETCH_LEDGERS) return { jobId: String(job._id), type: job.type, xml: ledgerListXml(companyName), companyName };

    const row = await TallyExport.findOne({ ...scoped(req), _id: job.payload?.exportId }).select('+xml');
    if (!row || row.status !== TALLY_EXPORT_STATUSES.QUEUED) {
      await finishJob(req, job, { status: JOB_STATUSES.DONE, result: { skipped: 'The export is no longer queued.' } });
      continue;
    }
    const bridge = await TallyBridge.findOne({ ...scoped(req), _id: req.bridge._id });
    const missing = missingLedgers([bridge], connection, row.xml);
    if (missing === null || missing.length > 0) {
      const message = missing === null ? "Tally's ledger list could not be read, so nothing was posted. Check that Tally is open with the company, then send again." : `Not in Tally, so nothing was posted: ${missing.join(', ')}. Create these ledgers in Tally, then send again.`;
      await TallyExport.updateOne({ ...scoped(req), _id: row._id }, { $set: { status: TALLY_EXPORT_STATUSES.FAILED, lineErrors: [message] } });
      await finishJob(req, job, { status: JOB_STATUSES.DONE, result: { refused: missing ?? 'no ledger list' } });
      continue;
    }
    return { jobId: String(job._id), type: job.type, xml: row.xml, companyName };
  }
}

/** POST /tally-bridge/jobs/:jobId/result. What Tally answered; only the server decides what it means. */
export async function submitResult(req, jobId, { ok, httpStatus = null, body = '', reached = true, tallyVersion = null, companies = null }) {
  const job = await IntegrationJob.findOne({ ...scoped(req), _id: jobId, connectionId: req.bridge.connectionId, forBridge: true, status: JOB_STATUSES.RUNNING });
  if (!job) throw new NotFoundError('That job is not waiting for this bridge.');
  const now = nowUtc();
  const bridgeUpdate = { lastSeenAt: now, ...(tallyVersion ? { tallyVersionSeen: String(tallyVersion).slice(0, 60) } : {}) };
  let outcome = { ok };

  if (job.type === BRIDGE_JOBS.PING) {
    const seen = Array.isArray(companies) && companies.length > 0 ? companies : ok ? namesIn(body, 'COMPANY') : null;
    if (seen) bridgeUpdate.companiesSeen = seen.map((name) => String(name).slice(0, 100)).slice(0, 50);
  } else if (job.type === BRIDGE_JOBS.FETCH_LEDGERS) {
    if (ok) {
      bridgeUpdate.ledgersSeen = namesIn(body, 'LEDGER').slice(0, 20_000);
      bridgeUpdate.ledgersSeenAt = now;
      outcome = { ok, ledgers: bridgeUpdate.ledgersSeen.length };
    }
  } else {
    const row = await TallyExport.findOne({ ...scoped(req), _id: job.payload?.exportId });
    let status;
    let lineErrors = [];
    if (reached === false) {
      status = TALLY_EXPORT_STATUSES.FAILED;
      lineErrors = [String(body || 'Tally could not be reached.').slice(0, 500)];
    } else if (!ok && httpStatus === null) {
      status = TALLY_EXPORT_STATUSES.UNKNOWN;
      lineErrors = ["Tally did not answer in time. Check Tally's Day Book before doing anything else."];
    } else {
      const parsed = parseTallyResponse(body, row?.voucherCount ?? 0);
      status = parsed.status;
      lineErrors = parsed.lineErrors;
    }
    if (row) await recordTallyAnswer(await actorFor(req), row._id, { status, lineErrors, response: String(body ?? '').slice(0, RESPONSE_KEEP) });
    outcome = { ok, status };
  }

  await TallyBridge.updateOne({ ...scoped(req), _id: req.bridge._id }, { $set: bridgeUpdate });
  await finishJob(req, job, { status: JOB_STATUSES.DONE, result: outcome });
  return outcome;
}

/** For Tally's test connection with BRIDGE delivery: is any bridge paired? */
export async function hasActiveBridge(connection) {
  const count = await TallyBridge.countDocuments({ restaurantId: connection.restaurantId, connectionId: connection._id, pairedAt: { $ne: null }, revokedAt: null });
  return count > 0;
}

export default { authenticateBridge, createPairingCode, hasActiveBridge, listBridges, nextJob, pairBridge, revokeBridge, sendExport, submitResult };
