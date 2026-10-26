/**
 * The changelog writer. P62 section 4.1, docs/REPLICATION.md section 3.
 *
 * Tails the local change stream for MIRROR collections and appends each change
 * to `changelog`, with a per-restaurant `seq` reserved in the same transaction.
 * No service in M0 to M21 knows it exists: a service cannot forget to write an
 * outbox entry it never had to write.
 *
 * Outside the request path. A till's write commits, returns, and only then
 * does its change reach this stream, so the writer can never slow a bill
 * (P62 section 9.7; measured in docs/PERFORMANCE-BASELINE.md).
 *
 * The resume token is saved after each batch. A crash between an entry and the
 * token reads the same event again, and the event id's unique index makes the
 * second insert fail and roll its seq back: one change, one entry.
 *
 * The first start, or a start whose token the oplog no longer holds, takes a
 * baseline: one `baseline` entry for every document already there, read
 * through the driver as P54's copy reads, after the stream has been opened, so
 * nothing written meanwhile is missed. Re-capturing a document twice is
 * harmless; the mirror's apply is an upsert.
 */
import { randomUUID } from 'node:crypto';

import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { CHANGE_OPERATIONS, ChangelogEntry } from '../../models/ChangelogEntry.js';
import { ChangelogCounter } from '../../models/ChangelogCounter.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { clusterTimeNow } from '../backup/snapshotService.js';
import { isTwoWay } from '../sync/mode.js';
import { docHash } from '../sync/hash.js';
import { getSyncDoc, isEcho, noteLocalVersion } from '../sync/syncDocs.js';
import { mirrorCollectionNames, TENANT_COLLECTION } from './collections.js';
import { writerSnapshot } from './writerState.js';

const DUPLICATE_KEY = 11000;
const WATCHED_OPERATIONS = ['insert', 'update', 'replace', 'delete'];
const QUIET_TOKEN_EVERY_MS = 60_000;
const BASELINE_BATCH = 500;

/** The restaurant a change belongs to, or null when it cannot be told. */
export async function restaurantOf(db, coll, doc, documentId) {
  if (coll === TENANT_COLLECTION) return doc?._id ?? documentId ?? null;
  if (doc?.restaurantId) return doc.restaurantId;
  const last = await db.collection('changelog').findOne({ coll, documentId }, { sort: { seq: -1 }, projection: { restaurantId: 1 } });
  return last?.restaurantId ?? null;
}

/**
 * Appends one entry, reserving its seq in the same transaction. Returns the
 * entry, or null when this event was already recorded.
 */
export async function appendEntry({ restaurantId, coll, documentId, op, doc, eventId = null, capturedAt = nowUtc() }) {
  const session = await mongoose.startSession();
  try {
    let entry = null;
    await session.withTransaction(async () => {
      const counter = await ChangelogCounter.findOneAndUpdate(
        { restaurantId },
        { $inc: { value: 1 } },
        { upsert: true, new: true, session },
      );
      [entry] = await ChangelogEntry.create(
        [{ restaurantId, seq: counter.value, epoch: writerSnapshot().epoch, coll, documentId, op, doc, capturedAt, eventId }],
        { session },
      );
    });
    return entry;
  } catch (error) {
    if (error?.code === DUPLICATE_KEY && Object.hasOwn(error.keyPattern ?? {}, 'eventId')) return null;
    throw error;
  } finally {
    await session.endSession();
  }
}

export class ChangelogWriter {
  constructor({ db = mongoose.connection.db, now = () => nowUtc() } = {}) {
    this.db = db;
    this.now = now;
    this.stream = null;
    this.captured = 0;
    this.lastTokenSavedAt = 0;
    // One pump at a time: the timer and a request (a pull or a push) both pump, and
    // two tryNext calls on one change stream at once make the driver close it.
    this.pumping = Promise.resolve();
  }

  #pipeline() {
    return [{ $match: { 'ns.coll': { $in: mirrorCollectionNames() }, operationType: { $in: WATCHED_OPERATIONS } } }];
  }

  #open(options) {
    this.stream = this.db.watch(this.#pipeline(), { fullDocument: 'updateLookup', maxAwaitTimeMS: 500, ...options });
  }

  /** Opens the stream from the saved token, or from now with a baseline. Gives back 'RESUMED' or 'BASELINED'. */
  async start() {
    const state = await ReplicationState.findById(REPLICATION_STATE_IDS.CHANGE_STREAM).lean();
    if (state?.resumeToken) {
      this.#open({ resumeAfter: state.resumeToken });
      try {
        await this.pump();
        return 'RESUMED';
      } catch (error) {
        logger.error({ err: error }, 'The changelog could not resume from its saved place. Taking a fresh baseline.');
        await this.close();
      }
    }
    await this.#startWithBaseline();
    return 'BASELINED';
  }

  async #startWithBaseline() {
    this.#open({ startAtOperationTime: await clusterTimeNow(this.db) });
    await this.baseline();
    await ReplicationState.updateOne(
      { _id: REPLICATION_STATE_IDS.CHANGE_STREAM },
      { $set: { baselineDoneAt: this.now() } },
      { upsert: true },
    );
    await this.pump();
    await this.#saveToken(true);
  }

  /**
   * One `baseline` entry for every document in every MIRROR collection.
   *
   * P63, two-way: a document both sides already hold as it is (its syncdocs base)
   * is left out. Taken again after a restart that could not resume, such as Render
   * waking from a night's sleep, it then records only what really changed, so the
   * changelog on the free Atlas cluster does not grow by every document each time.
   */
  async baseline() {
    const run = randomUUID();
    const twoWay = isTwoWay();
    let count = 0;
    let unchanged = 0;
    for (const coll of mirrorCollectionNames()) {
      const cursor = this.db.collection(coll).find({}, { batchSize: BASELINE_BATCH, sort: { _id: 1 } });
      for await (const doc of cursor) {
        const restaurantId = await restaurantOf(this.db, coll, doc, doc._id);
        if (!restaurantId) continue;
        if (twoWay && (await getSyncDoc(this.db, coll, doc._id))?.baseHash === docHash(doc)) {
          unchanged += 1;
          continue;
        }
        await appendEntry({ restaurantId, coll, documentId: doc._id, op: CHANGE_OPERATIONS.BASELINE, doc, eventId: `baseline:${run}:${coll}:${String(doc._id)}`, capturedAt: this.now() });
        count += 1;
      }
    }
    logger.info({ documents: count, unchanged }, 'Changelog baseline taken.');
    return count;
  }

  /**
   * Records every change available now, then saves the place. Gives back how many it read.
   * A call made while another is running waits for it, then reads what came since.
   */
  pump() {
    const run = this.pumping.then(() => this.#pumpNow());
    this.pumping = run.catch(() => {});
    return run;
  }

  async #pumpNow() {
    if (!this.stream) return 0;
    if (this.stream.closed) await this.#reopen();
    let read = 0;
    for (;;) {
      const event = await this.stream.tryNext();
      if (!event) break;
      read += 1;
      await this.capture(event);
    }
    await this.#saveToken(read > 0);
    return read;
  }

  async capture(event) {
    const coll = event.ns?.coll;
    const op = event.operationType;
    const documentId = event.documentKey?._id;
    const doc = op === 'delete' ? null : (event.fullDocument ?? null);
    // Changed and then deleted before the lookup: the delete event that follows says it.
    if (op !== 'delete' && !doc) return;
    const restaurantId = await restaurantOf(this.db, coll, doc, documentId);
    if (!restaurantId) {
      logger.warn({ coll, documentId: String(documentId), op }, 'A change with no restaurant was left out of the changelog.');
      return;
    }
    if (isTwoWay()) {
      // P63. A write made here from the other side is not sent back to it.
      if (isEcho(await getSyncDoc(this.db, coll, documentId), doc)) return;
      await noteLocalVersion(this.db, { restaurantId, coll, documentId }, doc);
    }
    const entry = await appendEntry({ restaurantId, coll, documentId, op, doc, eventId: event._id?._data ?? JSON.stringify(event._id), capturedAt: this.now() });
    if (entry) this.captured += 1;
  }

  async #saveToken(force) {
    const token = this.stream?.resumeToken;
    if (!token) return;
    const at = this.now().getTime();
    if (!force && at - this.lastTokenSavedAt < QUIET_TOKEN_EVERY_MS) return;
    await ReplicationState.updateOne(
      { _id: REPLICATION_STATE_IDS.CHANGE_STREAM },
      { $set: { resumeToken: token } },
      { upsert: true },
    );
    this.lastTokenSavedAt = at;
  }

  /** A stream the driver closed after an error opens again from the last saved place; a replayed event is one entry. */
  async #reopen() {
    const state = await ReplicationState.findById(REPLICATION_STATE_IDS.CHANGE_STREAM).lean();
    if (!state?.resumeToken) throw new Error('The change stream closed and there is no saved place to resume from.');
    logger.warn('The change stream had closed. Opening it again from its saved place.');
    this.#open({ resumeAfter: state.resumeToken });
  }

  async close() {
    await this.pumping;
    const stream = this.stream;
    this.stream = null;
    if (stream) await stream.close().catch(() => {});
  }
}
