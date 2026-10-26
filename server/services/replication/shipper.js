/**
 * The shipper. P62 section 4.1, docs/REPLICATION.md section 4.
 *
 * Sends each restaurant's changelog to the mirror, oldest first, in batches,
 * and moves its high-water mark only on the mirror's acknowledgement. Outside
 * the request path: it reads the changelog, never a till's request.
 *
 * No connectivity detection. It just keeps trying, waiting longer after each
 * failure up to two minutes, so an outage is simply a long wait, and the first
 * try after the line comes back catches up.
 *
 * The mirror answers:
 *   200 { appliedThrough }       move the mark there
 *   409 REPLICATION_GAP          the mirror wants an earlier seq: start from it
 *                                (a wiped copy rebuilds itself from seq 1)
 *   409 STALE_EPOCH              another machine was promoted: stand down
 */
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ChangelogEntry } from '../../models/ChangelogEntry.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { EJSON_CONTENT_TYPE, SIGNATURE_HEADER, sign, toWire } from './signing.js';
import { fenceThisBox, writerSnapshot } from './writerState.js';
import { isTwoWay } from '../sync/mode.js';

export const BATCH_SIZE = 200;
export const RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000]);
export const REQUEST_TIMEOUT_MS = 20_000;

export const REPLICATION_PATH = '/api/v1/replication';

/** The wire shape of one entry. */
const wireEntry = (entry) => ({
  seq: entry.seq,
  epoch: entry.epoch,
  coll: entry.coll,
  documentId: entry.documentId,
  op: entry.op,
  doc: entry.doc,
  capturedAt: entry.capturedAt,
  ...(entry.superseded ? { superseded: true } : {}),
});

/** POSTs signed EJSON to the mirror. Gives back { status, body }. */
export async function postToMirror(path, payload, { mirrorUrl = config.MIRROR_URL, secret = config.REPLICATION_SECRET, fetchImpl = fetch } = {}) {
  const text = toWire(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${mirrorUrl}${REPLICATION_PATH}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': EJSON_CONTENT_TYPE, [SIGNATURE_HEADER]: sign(secret, text) },
      body: text,
      signal: controller.signal,
    });
    // The mirror answers in the ordinary JSON envelope; only requests carry EJSON.
    const raw = await response.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { raw };
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function shippedSeqOf(restaurantId) {
  const doc = await ReplicationState.findById(REPLICATION_STATE_IDS.shipper(restaurantId)).lean();
  return doc?.shippedSeq ?? 0;
}

async function setShipped(restaurantId, seq, extra = {}) {
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.shipper(restaurantId) },
    { $set: { shippedSeq: seq, shippedAt: nowUtc(), lastError: null, lastErrorAt: null, ...extra } },
    { upsert: true },
  );
}

async function noteError(restaurantId, message) {
  await ReplicationState.updateOne(
    { _id: REPLICATION_STATE_IDS.shipper(restaurantId) },
    { $set: { lastError: message, lastErrorAt: nowUtc() } },
    { upsert: true },
  );
}

/**
 * Ships one batch for one restaurant. Gives back 'IDLE' (nothing waiting),
 * 'SHIPPED', 'REWOUND', 'FENCED' or 'FAILED'.
 */
export async function shipOnce(restaurantId, options = {}) {
  const from = await shippedSeqOf(restaurantId);
  let entries = await ChangelogEntry.find({ restaurantId, seq: { $gt: from } })
    .sort({ seq: 1 })
    .limit(options.batchSize ?? BATCH_SIZE)
    .lean();
  if (entries.length === 0) return 'IDLE';

  // P63. Two-way: say how far this box has pulled, so the cloud knows its own versions arrived,
  // and flag what the cloud already has newer of, so it is never put back there.
  const twoWay = isTwoWay();
  if (twoWay) {
    const { flagSuperseded } = await import('../sync/exchange.js');
    const { default: mongoose } = await import('mongoose');
    entries = await flagSuperseded(mongoose.connection.db, entries);
  }
  const payload = { restaurantId, epoch: writerSnapshot().epoch, entries: entries.map(wireEntry) };
  if (twoWay) {
    const { seenPeerSeqFor } = await import('../sync/exchange.js');
    payload.seenPeerSeq = await seenPeerSeqFor(restaurantId);
  }
  let answer;
  try {
    answer = await postToMirror('/batches', payload, options);
  } catch (error) {
    await noteError(restaurantId, `The mirror could not be reached: ${error.message}`);
    return 'FAILED';
  }

  const { status, body } = answer;
  if (status === 200 && Number.isInteger(body?.data?.appliedThrough)) {
    if (twoWay) {
      // The cloud now has these versions: they are the base for the next merge here.
      const { markSeenByPeer } = await import('../sync/exchange.js');
      const { default: mongoose } = await import('mongoose');
      await markSeenByPeer(mongoose.connection.db, restaurantId, entries.filter((entry) => entry.seq <= body.data.appliedThrough && !entry.superseded));
    }
    await setShipped(restaurantId, body.data.appliedThrough);
    return 'SHIPPED';
  }
  const code = body?.error?.code;
  if (status === 409 && code === 'REPLICATION_GAP' && Number.isInteger(body.error.expectedSeq)) {
    // The copy is behind where we thought: a wiped or restored mirror. Start where it asks.
    const expected = body.error.expectedSeq;
    if (expected - 1 < from) {
      logger.warn({ restaurantId: String(restaurantId), from, expected }, 'The mirror asked for earlier changelog entries. Shipping again from there.');
      await setShipped(restaurantId, expected - 1);
      return 'REWOUND';
    }
    // It wants a seq after ours: an entry is missing here. Never skip; say so.
    await noteError(restaurantId, `The mirror expects entry ${expected}, after ${from}: the changelog has a gap. docs/RUNBOOK.md section 7.`);
    return 'FAILED';
  }
  if (status === 409 && code === 'STALE_EPOCH') {
    await fenceThisBox(body.error.currentEpoch, `The cloud copy holds epoch ${body.error.currentEpoch}.`);
    await noteError(restaurantId, 'Another machine holds a higher epoch. This box stood down.');
    return 'FENCED';
  }
  await noteError(restaurantId, `The mirror answered ${status}${code ? ` ${code}` : ''}.`);
  return 'FAILED';
}

/** The restaurants with a changelog on this box. */
function restaurantsWithChangelog() {
  return ChangelogEntry.distinct('restaurantId', { restaurantId: { $exists: true } });
}

/** Whether any restaurant has changelog entries the other side has not acknowledged. P63. */
export async function hasUnshippedChanges() {
  for (const restaurantId of await restaurantsWithChangelog()) {
    const newest = await ChangelogEntry.findOne({ restaurantId }).sort({ seq: -1 }).select('seq').lean();
    if ((newest?.seq ?? 0) > (await shippedSeqOf(restaurantId))) return true;
  }
  return false;
}

export class Shipper {
  constructor(options = {}) {
    this.options = options;
    this.failures = 0;
    this.nextAt = 0;
    this.running = false;
  }

  /** One pass over every restaurant, honouring the backoff. Gives back what happened. */
  async tick(now = Date.now()) {
    if (this.running || now < this.nextAt) return null;
    this.running = true;
    try {
      const outcomes = [];
      for (const restaurantId of await restaurantsWithChangelog()) {
        let outcome;
        // Catch up in a burst while it is working, then let the timer pace it.
        for (let round = 0; round < 50; round += 1) {
          outcome = await shipOnce(restaurantId, this.options);
          if (outcome !== 'SHIPPED' && outcome !== 'REWOUND') break;
        }
        outcomes.push(outcome);
      }
      const failed = outcomes.some((outcome) => outcome === 'FAILED');
      this.failures = failed ? this.failures + 1 : 0;
      this.nextAt = failed ? Date.now() + RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)] : 0;
      return outcomes;
    } finally {
      this.running = false;
    }
  }
}

/**
 * How far behind the mirror is, per restaurant: entries waiting and the age of
 * the oldest. Measured, never guessed: the status chips and the owner's
 * "figures as of" read this.
 */
export async function shippingLag(restaurantId, now = nowUtc()) {
  const shipped = await ReplicationState.findById(REPLICATION_STATE_IDS.shipper(restaurantId)).lean();
  const shippedSeq = shipped?.shippedSeq ?? 0;
  const newest = await ChangelogEntry.findOne({ restaurantId }).sort({ seq: -1 }).select('seq capturedAt').lean();
  const oldestWaiting = await ChangelogEntry.findOne({ restaurantId, seq: { $gt: shippedSeq } }).sort({ seq: 1 }).select('seq capturedAt').lean();
  const lastShippedEntry = shippedSeq > 0 ? await ChangelogEntry.findOne({ restaurantId, seq: shippedSeq }).select('capturedAt').lean() : null;
  return {
    newestSeq: newest?.seq ?? 0,
    shippedSeq,
    entriesWaiting: Math.max((newest?.seq ?? 0) - shippedSeq, 0),
    secondsBehind: oldestWaiting ? Math.max(Math.round((now.getTime() - new Date(oldestWaiting.capturedAt).getTime()) / 1000), 0) : 0,
    syncedThrough: lastShippedEntry?.capturedAt ?? null,
    shippedAt: shipped?.shippedAt ?? null,
    lastError: shipped?.lastError ?? null,
    lastErrorAt: shipped?.lastErrorAt ?? null,
  };
}
