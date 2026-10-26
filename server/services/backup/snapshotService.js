/**
 * Full copies of the database. P54 Part C.
 *
 * Every collection but the excluded three, every document as one line of
 * canonical EJSON (so ObjectIds, Dates, Decimals and Timestamps come back
 * exactly), then a manifest line; gzipped, encrypted and uploaded, streaming
 * all the way, read in batches of 500.
 *
 * Folders, by backup day, which starts at 5:30 AM India time, which is 00:00
 * UTC. The first copy of a month is the monthly one, kept forever; the first
 * of any other day is the daily one, kept 90 days; the rest are 6-hourly, kept
 * 10 days. Built differently from the prompt's "the 5:30 AM copy": Render's
 * free server sleeps from about 2:30 AM to 8:30 AM, so a copy timed for
 * exactly 5:30 AM would never run, and the first copy after it, at wake-up,
 * takes its place.
 *
 * Only one copy at a time: the RUNNING row is the claim, and a unique partial
 * index (models/BackupRun.js) refuses a second.
 */
import { rm } from 'node:fs/promises';

import mongoose from 'mongoose';

import { BACKUP_FOLDERS, BACKUP_KINDS, BACKUP_STATUSES, BackupRun } from '../../models/BackupRun.js';
import { BACKUP_STATE_IDS, BackupState, FULL_COPIES } from '../../models/BackupState.js';
import { nowUtc } from '../../utils/time.js';
import {
  COPIES_A_WEEK_EVERY_6_HOURS,
  EXCLUDED_COLLECTIONS,
  FORMAT_VERSION,
  READ_BATCH,
  SLOW_DOWN_ABOVE_BYTES,
  SNAPSHOT_RETRY_MS,
  SNAPSHOT_STALE_MS,
  SPEED_UP_BELOW_BYTES,
} from './constants.js';
import { packLines } from './pack.js';
import { uploadFile } from './storage.js';

const { EJSON } = mongoose.mongo.BSON;
const SIX_HOURS_MS = 6 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** "2026-10-14T00-00-00Z": a time as part of an object key. */
export const keyTime = (instant) => instant.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
/** The reverse, for the restore tools. */
export const parseKeyTime = (text) => new Date(text.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?Z)$/, '$1:$2:$3'));

const pad = (number) => String(number).padStart(2, '0');

/** Where a copy taken at `at` goes. */
export function snapshotKey(folder, at) {
  const y = at.getUTCFullYear();
  const m = pad(at.getUTCMonth() + 1);
  const d = pad(at.getUTCDate());
  const name = `${keyTime(at)}.snap.gz.enc`;
  return folder === BACKUP_FOLDERS.MONTHLY ? `snapshots/monthly/${y}/${m}/${name}` : `snapshots/${folder}/${y}/${m}/${d}/${name}`;
}

const dayStart = (at) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
const monthStart = (at) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/** The folder for a copy, from the copies already kept this month and today. */
export function folderFor({ hasMonthlyThisMonth, hasDailyToday }) {
  if (!hasMonthlyThisMonth) return BACKUP_FOLDERS.MONTHLY;
  if (!hasDailyToday) return BACKUP_FOLDERS.DAILY;
  return BACKUP_FOLDERS.SIX_HOURS;
}

const okCopies = { kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.OK, objectKey: { $ne: null } };

async function chooseFolder(now) {
  const [monthly, daily] = await Promise.all([
    BackupRun.exists({ ...okCopies, folder: BACKUP_FOLDERS.MONTHLY, startedAt: { $gte: monthStart(now) } }),
    BackupRun.exists({ ...okCopies, folder: { $in: [BACKUP_FOLDERS.MONTHLY, BACKUP_FOLDERS.DAILY] }, startedAt: { $gte: dayStart(now) } }),
  ]);
  return folderFor({ hasMonthlyThisMonth: Boolean(monthly), hasDailyToday: Boolean(daily) });
}

/** The newest copy that worked. */
export const lastGoodCopy = () => BackupRun.findOne(okCopies).sort({ startedAt: -1 }).lean();

/**
 * The slow-down rule. A week's reading is the last copy's size times 28; past
 * 4 GB, one copy a day; back to every 6 hours under 3 GB. Pure.
 */
export function fullCopiesFor(current, databaseBytes) {
  const weekly = (databaseBytes ?? 0) * COPIES_A_WEEK_EVERY_6_HOURS;
  if (current !== FULL_COPIES.DAILY && weekly > SLOW_DOWN_ABOVE_BYTES) return FULL_COPIES.DAILY;
  if (current === FULL_COPIES.DAILY && weekly < SPEED_UP_BELOW_BYTES) return FULL_COPIES.EVERY_6_HOURS;
  return current ?? FULL_COPIES.EVERY_6_HOURS;
}

/** Whether a copy is due: the last good one is from before the current slot. Pure. */
export function isDue(now, lastGoodAt, fullCopies) {
  if (!lastGoodAt) return true;
  const slot = fullCopies === FULL_COPIES.DAILY ? DAY_MS : SIX_HOURS_MS;
  return lastGoodAt.getTime() < Math.floor(now.getTime() / slot) * slot;
}

/** The current slow-down setting, applying the rule, and noting a switch in `backupruns`. */
export async function currentFullCopies(now = nowUtc()) {
  const state = await BackupState.findById(BACKUP_STATE_IDS.SNAPSHOTS).lean();
  const last = await lastGoodCopy();
  const before = state?.fullCopies ?? FULL_COPIES.EVERY_6_HOURS;
  const after = fullCopiesFor(before, last?.databaseBytes);
  if (after !== before) {
    await BackupState.updateOne({ _id: BACKUP_STATE_IDS.SNAPSHOTS }, { $set: { fullCopies: after, changedAt: now } }, { upsert: true });
    const mb = Math.round((last?.databaseBytes ?? 0) / 1024 ** 2);
    await BackupRun.create({
      kind: BACKUP_KINDS.SNAPSHOT,
      status: BACKUP_STATUSES.OK,
      startedAt: now,
      finishedAt: now,
      error:
        after === FULL_COPIES.DAILY
          ? `Full copies are now once a day: the database is ${mb} MB, and four copies a day would read more than 4 GB a week from Atlas.`
          : `Full copies are back to every 6 hours: the database is ${mb} MB.`,
    });
  }
  return after;
}

/** The database's own time, from a ping. */
export async function clusterTimeNow(db) {
  const answer = await db.command({ ping: 1 });
  return answer.operationTime;
}

/** The collections a copy reads, by name. */
export async function collectionsToCopy(db) {
  const all = await db.listCollections({}, { nameOnly: true }).toArray();
  return all
    .filter((entry) => (entry.type ?? 'collection') === 'collection' && !entry.name.startsWith('system.') && !EXCLUDED_COLLECTIONS.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function* snapshotLines(db, names, counts, manifest) {
  for (const name of names) {
    let count = 0;
    for await (const document of db.collection(name).find({}, { batchSize: READ_BATCH })) {
      count += 1;
      yield EJSON.stringify({ c: name, d: document }, { relaxed: false });
    }
    counts.push({ name, count });
  }
  yield EJSON.stringify({ manifest: { ...manifest, collections: counts } }, { relaxed: false });
}

/** Marks a copy that has been RUNNING too long as interrupted. */
export function markInterrupted(now = nowUtc()) {
  return BackupRun.updateMany(
    { kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.RUNNING, startedAt: { $lt: new Date(now.getTime() - SNAPSHOT_STALE_MS) } },
    { $set: { status: BACKUP_STATUSES.FAILED, finishedAt: now, error: 'Interrupted' } },
  );
}

/**
 * Takes one full copy. `ctx` is { db, storage, key, release }. Gives back the
 * run, or { skipped: 'RUNNING' } when another copy holds the claim.
 */
export async function runSnapshot(ctx, { now = nowUtc(), reason = 'SCHEDULED' } = {}) {
  await markInterrupted(now);
  let run;
  try {
    run = await BackupRun.create({ kind: BACKUP_KINDS.SNAPSHOT, status: BACKUP_STATUSES.RUNNING, startedAt: now });
  } catch (error) {
    if (error?.code === 11000) return { skipped: 'RUNNING' };
    throw error;
  }

  let packed = null;
  try {
    const folder = await chooseFolder(now);
    const fromClusterTime = await clusterTimeNow(ctx.db);
    const names = await collectionsToCopy(ctx.db);
    const counts = [];
    const manifest = { format: FORMAT_VERSION, fromClusterTime, takenAt: now, release: ctx.release ?? null, reason };
    packed = await packLines(snapshotLines(ctx.db, names, counts, manifest), ctx.key);
    const objectKey = snapshotKey(folder, now);
    await uploadFile(ctx.storage, objectKey, packed);
    const stats = await ctx.db.command({ dbStats: 1 });
    const done = await BackupRun.findOneAndUpdate(
      { _id: run._id },
      {
        $set: {
          status: BACKUP_STATUSES.OK,
          finishedAt: nowUtc(),
          folder,
          objectKey,
          bytes: packed.bytes,
          sha256: packed.sha256,
          fromClusterTime,
          collections: counts,
          databaseBytes: Number(stats.dataSize ?? 0) + Number(stats.indexSize ?? 0),
        },
      },
      { new: true },
    ).lean();
    if (folder === BACKUP_FOLDERS.MONTHLY) await addForeverBytes(packed.bytes);
    return done;
  } catch (error) {
    await BackupRun.updateOne({ _id: run._id }, { $set: { status: BACKUP_STATUSES.FAILED, finishedAt: nowUtc(), error: plainError(error) } });
    throw error;
  } finally {
    if (packed) await rm(packed.path, { force: true });
  }
}

/** Bytes kept forever: monthly copies and the diary. Their runs expire; this does not. */
export const addForeverBytes = (bytes) => BackupState.updateOne({ _id: BACKUP_STATE_IDS.STORAGE }, { $inc: { foreverBytes: bytes } }, { upsert: true });

/**
 * An error in plain words, never a secret. Backblaze names the key ID in some
 * messages ("The key '005...' is not valid"); it is not a secret, but it does
 * not belong on the owner's card, so it is taken out.
 */
export function plainError(error) {
  const text = String(error?.message ?? error ?? 'Unknown error')
    .replace(/key '[^']*'/gi, 'storage key')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 300);
}

/**
 * Whether a failed full copy was too recent to try again: 2 minutes after the
 * first failure in a row, then 10, 30, and every hour after that.
 */
export async function waitingAfterFailure(now = nowUtc()) {
  const recent = await BackupRun.find({ kind: BACKUP_KINDS.SNAPSHOT, $or: [{ status: BACKUP_STATUSES.FAILED }, { status: BACKUP_STATUSES.OK, objectKey: { $ne: null } }] })
    .sort({ startedAt: -1 })
    .limit(SNAPSHOT_RETRY_MS.length)
    .lean();
  const failures = recent.findIndex((run) => run.status !== BACKUP_STATUSES.FAILED);
  const inARow = failures === -1 ? recent.length : failures;
  if (inARow === 0) return false;
  const wait = SNAPSHOT_RETRY_MS[Math.min(inARow, SNAPSHOT_RETRY_MS.length) - 1];
  const failedAt = recent[0].finishedAt ?? recent[0].startedAt;
  return now.getTime() - failedAt.getTime() < wait;
}

/** The scheduler's tick: takes a copy when one is due. */
export async function maybeRunSnapshot(ctx, { now = nowUtc() } = {}) {
  if (await waitingAfterFailure(now)) return null;
  const fullCopies = await currentFullCopies(now);
  const last = await lastGoodCopy();
  if (!isDue(now, last?.startedAt ?? null, fullCopies)) return null;
  return runSnapshot(ctx, { now, reason: last ? 'SCHEDULED' : 'START' });
}
