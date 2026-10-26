/**
 * The change diary. P54 Part D.
 *
 * A change stream on the whole database, `fullDocument: 'updateLookup'`,
 * leaving out the excluded three by collection name (Atlas M0 accepts only
 * names there). Each change is one EJSON line. The diary uploads what is
 * waiting every 5 minutes, or sooner at 5,000 events or 5 MB, and saves its
 * resume token only after the upload worked, so a crash uploads the same
 * events again, which a restore replays harmlessly.
 *
 * Uploads happen only when the stream has nothing more to give right now.
 * A transaction is one oplog entry, so by then all its events have arrived,
 * and one never splits across two files.
 *
 * Losing its place, because the oplog moved on, there is no token, or
 * storage failed for longer than 20 MB of waiting changes: the diary stops,
 * records the gap in `backupruns`, in `backupstate.gapSince`, and in the
 * bucket as a marker, and a full copy is taken. It starts watching again from
 * that copy's own cluster time, so nothing between the copy and the diary is
 * missed.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import mongoose from 'mongoose';

import { BACKUP_FOLDERS, BACKUP_KINDS, BACKUP_STATUSES, BackupRun } from '../../models/BackupRun.js';
import { BACKUP_STATE_IDS, BackupState } from '../../models/BackupState.js';
import { nowUtc, toIst } from '../../utils/time.js';
import {
  DIARY_ONLY_EXCLUDED,
  EXCLUDED_COLLECTIONS,
  FLUSH_AT_BYTES,
  FLUSH_AT_EVENTS,
  FLUSH_EVERY_MS,
  FLUSH_RETRY_MS,
  FORMAT_VERSION,
  MAX_WAITING_BYTES,
} from './constants.js';
import { encryptBuffer } from './crypto.js';
import { packLines } from './pack.js';
import { addForeverBytes, clusterTimeNow, plainError } from './snapshotService.js';
import { uploadBuffer, uploadFile } from './storage.js';

const { EJSON } = mongoose.mongo.BSON;
const QUIET_TOKEN_EVERY_MS = 5 * 60_000;

const pad = (number) => String(number).padStart(2, '0');
const msKeyTime = (instant) => instant.toISOString().replace(/:/g, '-');
const datePath = (at) => `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}`;

/** Where a diary file of changes from `first` to `last` goes. */
export const journalKey = (first, last) => `journal/${datePath(first)}/${msKeyTime(first)}_${msKeyTime(last)}.jrn.gz.enc`;
/** Where a gap marker goes. */
export const gapKey = (since) => `journal/${datePath(since)}/${msKeyTime(since)}.gap.enc`;

/** One change as its diary line. */
export function eventLine(event) {
  return EJSON.stringify(
    {
      op: event.operationType,
      coll: event.ns?.coll ?? null,
      _id: event.documentKey?._id ?? null,
      doc: event.fullDocument ?? null,
      clusterTime: event.clusterTime,
      wallTime: event.wallTime ?? null,
      lsid: event.lsid ?? null,
      txnNumber: event.txnNumber ?? null,
    },
    { relaxed: false },
  );
}

const atOf = (event) => event.wallTime ?? new Date(event.clusterTime.getHighBits() * 1000);
const timeWords = (at) => (at ? toIst(at) : 'the start');

export class ChangeDiary {
  /**
   * `ctx` is { db, storage, key }. `onLostPlace` is called when a full copy is
   * needed; `now` reads the clock (nowUtc in service, a fake in tests).
   */
  constructor(ctx, { onLostPlace = () => {}, now = () => nowUtc() } = {}) {
    this.ctx = ctx;
    this.onLostPlace = onLostPlace;
    this.now = now;
    this.stream = null;
    this.waiting = [];
    this.waitingBytes = 0;
    this.firstWaitingAt = null;
    this.retryAt = 0;
    this.retryCount = 0;
    this.stopped = true;
    this.lastQuietTokenAt = 0;
  }

  /** Changes waiting to be uploaded. */
  status() {
    return { waiting: this.waiting.length, waitingBytes: this.waitingBytes, oldestWaitingAt: this.waiting[0]?.at ?? null, watching: !this.stopped };
  }

  #open(options) {
    this.stream = this.ctx.db.watch([{ $match: { 'ns.coll': { $nin: [...EXCLUDED_COLLECTIONS, ...DIARY_ONLY_EXCLUDED] } } }], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1000, ...options });
    this.stopped = false;
  }

  async #close() {
    const stream = this.stream;
    this.stream = null;
    this.stopped = true;
    if (stream) await stream.close().catch(() => {});
  }

  /** Starts, from the saved token. Gives back 'WATCHING', 'FIRST', or 'LOST'. */
  async start() {
    const state = await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean();
    if (!state) {
      const from = await clusterTimeNow(this.ctx.db);
      await BackupState.updateOne({ _id: BACKUP_STATE_IDS.JOURNAL }, { $setOnInsert: { lastEventClusterTime: null } }, { upsert: true });
      this.#open({ startAtOperationTime: from });
      await this.pump();
      await this.#saveToken();
      return 'FIRST';
    }
    if (state.gapSince) {
      // Still waiting for its full copy, from before a restart.
      this.onLostPlace();
      return 'LOST';
    }
    if (!state.resumeToken) {
      await this.loseYourPlace(state.lastEventAt ?? state.lastFlushAt ?? null, 'there was no saved place to resume from');
      return 'LOST';
    }
    this.#open({ resumeAfter: state.resumeToken });
    try {
      await this.pump();
    } catch (error) {
      await this.loseYourPlace(state.lastEventAt ?? state.lastFlushAt ?? null, `the database could not resume from its saved place (${plainError(error)})`);
      return 'LOST';
    }
    return 'WATCHING';
  }

  /** Reads every change available now. Throws a server error up, for the caller to treat as losing its place. */
  async pump() {
    if (!this.stream) return 0;
    let read = 0;
    for (;;) {
      const event = await this.stream.tryNext();
      if (!event) return read;
      read += 1;
      const line = eventLine(event);
      this.waiting.push({ line, token: event._id, clusterTime: event.clusterTime, at: atOf(event) });
      this.waitingBytes += Buffer.byteLength(line);
      if (!this.firstWaitingAt) this.firstWaitingAt = this.now().getTime();
      if (this.waitingBytes > MAX_WAITING_BYTES) {
        await this.#overflow();
        return read;
      }
    }
  }

  /** Whether the waiting changes should go now. */
  flushDue() {
    if (this.waiting.length === 0 || this.now().getTime() < this.retryAt) return false;
    return this.waiting.length >= FLUSH_AT_EVENTS || this.waitingBytes >= FLUSH_AT_BYTES || this.now().getTime() - this.firstWaitingAt >= FLUSH_EVERY_MS;
  }

  /** Uploads what is waiting. Gives back the run, or null when nothing waited. */
  async flush() {
    if (this.waiting.length === 0) return null;
    const events = this.waiting.slice();
    const first = events[0];
    const last = events.at(-1);
    const objectKey = journalKey(first.at, last.at);
    const startedAt = nowUtc();
    let packed = null;
    try {
      packed = await packLines(
        events.map((event) => event.line),
        this.ctx.key,
      );
      await uploadFile(this.ctx.storage, objectKey, packed);
    } catch (error) {
      const wait = FLUSH_RETRY_MS[Math.min(this.retryCount, FLUSH_RETRY_MS.length - 1)];
      this.retryCount += 1;
      this.retryAt = this.now().getTime() + wait;
      await BackupRun.create({ kind: BACKUP_KINDS.JOURNAL, status: BACKUP_STATUSES.FAILED, startedAt, finishedAt: nowUtc(), folder: BACKUP_FOLDERS.JOURNAL, eventCount: events.length, error: `Upload failed, trying again in ${Math.round(wait / 1000)} seconds: ${plainError(error)}` });
      if (packed) await rm(packed.path, { force: true });
      return null;
    }

    this.waiting = this.waiting.slice(events.length);
    this.waitingBytes = this.waiting.reduce((sum, event) => sum + Buffer.byteLength(event.line), 0);
    this.firstWaitingAt = this.waiting.length ? this.now().getTime() : null;
    this.retryAt = 0;
    this.retryCount = 0;
    await BackupState.updateOne(
      { _id: BACKUP_STATE_IDS.JOURNAL },
      { $set: { resumeToken: last.token, lastFlushAt: nowUtc(), lastEventClusterTime: last.clusterTime, lastEventAt: last.at } },
      { upsert: true },
    );
    const run = await BackupRun.create({
      kind: BACKUP_KINDS.JOURNAL,
      status: BACKUP_STATUSES.OK,
      startedAt,
      finishedAt: nowUtc(),
      folder: BACKUP_FOLDERS.JOURNAL,
      objectKey,
      bytes: packed.bytes,
      sha256: packed.sha256,
      fromClusterTime: first.clusterTime,
      toClusterTime: last.clusterTime,
      eventCount: events.length,
    });
    await addForeverBytes(packed.bytes);
    await rm(packed.path, { force: true });
    await this.uploadPendingGaps();
    return run.toObject();
  }

  /** While quiet, keep the saved place fresh, so a quiet spell never loses it. */
  async #saveToken() {
    if (!this.stream?.resumeToken || this.waiting.length) return;
    await BackupState.updateOne({ _id: BACKUP_STATE_IDS.JOURNAL }, { $set: { resumeToken: this.stream.resumeToken } }, { upsert: true });
    this.lastQuietTokenAt = this.now().getTime();
  }

  async quietTick() {
    if (this.waiting.length === 0 && this.now().getTime() - this.lastQuietTokenAt >= QUIET_TOKEN_EVERY_MS) await this.#saveToken();
  }

  async #overflow() {
    const since = this.waiting[0]?.at ?? null;
    this.waiting = [];
    this.waitingBytes = 0;
    this.firstWaitingAt = null;
    await this.loseYourPlace(since, 'storage failed for longer than 20 MB of changes could wait');
  }

  /** Stops, records the gap everywhere, and asks for a full copy. */
  async loseYourPlace(since, why) {
    await this.#close();
    const now = nowUtc();
    const gapSince = since ?? now;
    await BackupState.updateOne(
      { _id: BACKUP_STATE_IDS.JOURNAL },
      { $set: { gapSince, resumeToken: null }, $push: { pendingGapMarkers: gapSince } },
      { upsert: true },
    );
    await BackupRun.create({
      kind: BACKUP_KINDS.JOURNAL,
      status: BACKUP_STATUSES.FAILED,
      startedAt: now,
      finishedAt: now,
      folder: BACKUP_FOLDERS.JOURNAL,
      error: `The change diary lost its place between ${timeWords(since)} and ${timeWords(now)}, because ${why}; a full copy was taken to start again.`,
    });
    await this.uploadPendingGaps();
    this.onLostPlace();
  }

  /** Writes any gap markers not yet in the bucket. A failure leaves them for next time. */
  async uploadPendingGaps() {
    const state = await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean();
    for (const since of state?.pendingGapMarkers ?? []) {
      try {
        const body = encryptBuffer(Buffer.from(JSON.stringify({ format: FORMAT_VERSION, since: since.toISOString(), recordedAt: nowUtc().toISOString() })), this.ctx.key);
        await uploadBuffer(this.ctx.storage, gapKey(since), body, createHash('md5').update(body).digest('base64'));
        await BackupState.updateOne({ _id: BACKUP_STATE_IDS.JOURNAL }, { $pull: { pendingGapMarkers: since } });
      } catch {
        return;
      }
    }
  }

  /** After the full copy a gap asked for: watch again from that copy's own time. */
  async recoverFrom(snapshotRun) {
    await this.#close();
    this.#open({ startAtOperationTime: snapshotRun.fromClusterTime });
    await BackupState.updateOne({ _id: BACKUP_STATE_IDS.JOURNAL }, { $set: { gapSince: null } }, { upsert: true });
    await this.pump();
    await this.#saveToken();
  }

  /** After a network failure: read again from the saved place; what was waiting is read again too. */
  async restart() {
    await this.#close();
    this.waiting = [];
    this.waitingBytes = 0;
    this.firstWaitingAt = null;
    return this.start();
  }

  async stop() {
    await this.#close();
  }
}
