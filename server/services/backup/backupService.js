/**
 * Backups while the server runs. P54.
 *
 * Started by server.js after the server listens, only when BACKUP_ENABLED is
 * on, and never under test (config.backupsOn). Two loops:
 *   the diary: read changes as they come, upload every 5 minutes;
 *   the clock: every minute, take a full copy when one is due, or at once
 *   when the diary lost its place, then let the diary watch on from it.
 * Nothing here can stop the restaurant: every failure is logged, recorded in
 * `backupruns`, shown on the owner's Server card, and tried again.
 */
import mongoose from 'mongoose';

import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { BACKUP_STATE_IDS, BackupState } from '../../models/BackupState.js';
import { ChangeDiary } from './journalService.js';
import { maybeRunSnapshot, runSnapshot, waitingAfterFailure } from './snapshotService.js';
import { serverStorage } from './storage.js';

const TICK_MS = 60_000;
const DIARY_PAUSE_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let diary = null;
let ticker = null;
let running = false;
let copyWanted = false;
let ticking = false;

/** What the diary has waiting, for the owner's card. */
export function diaryStatus() {
  return diary ? diary.status() : { waiting: 0, waitingBytes: 0, oldestWaitingAt: null, watching: false };
}

function context() {
  return { db: mongoose.connection.db, storage: serverStorage(), key: config.BACKUP_ENCRYPTION_KEY, release: config.RELEASE_VERSION };
}

async function diaryLoop() {
  while (running) {
    try {
      if (diary.status().watching) {
        await diary.pump();
        await diary.quietTick();
        if (diary.flushDue()) await diary.flush();
      } else {
        await sleep(DIARY_PAUSE_MS);
      }
    } catch (error) {
      if (!running) return;
      // A server error means the place is gone; anything else (the network) is retried from the saved place.
      if (error?.name === 'MongoServerError') {
        const state = await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean().catch(() => null);
        await diary.loseYourPlace(state?.lastEventAt ?? null, `the database stopped the change stream (${error.codeName ?? error.code})`).catch((inner) => logger.warn({ err: inner }, 'Backups: could not record a gap.'));
      } else {
        logger.warn({ err: error }, 'Backups: the change diary stopped reading; starting again from its saved place.');
        await sleep(10_000);
        await diary.restart().catch((inner) => logger.warn({ err: inner }, 'Backups: the change diary could not start again.'));
      }
    }
  }
}

async function tick() {
  if (ticking || !running) return;
  ticking = true;
  const ctx = context();
  try {
    const state = await BackupState.findById(BACKUP_STATE_IDS.JOURNAL).lean();
    if (copyWanted || state?.gapSince) {
      if (await waitingAfterFailure()) return;
      const copy = await runSnapshot(ctx, { reason: 'GAP' });
      if (copy?.status === 'OK') {
        await diary.recoverFrom(copy);
        copyWanted = false;
        logger.info('Backups: a full copy closed the gap, and the change diary is watching again.');
      }
    } else {
      await maybeRunSnapshot(ctx);
    }
    await diary.uploadPendingGaps();
  } catch (error) {
    logger.warn({ err: error }, 'Backups: a full copy failed; it is tried again within the hour.');
  } finally {
    ticking = false;
  }
}

/** Starts both loops. Safe to call once; a failure to start is logged, never thrown at the server. */
export async function startBackups() {
  if (!config.backupsOn || running) return;
  running = true;
  diary = new ChangeDiary(context(), { onLostPlace: () => (copyWanted = true) });
  try {
    await diary.start();
  } catch (error) {
    logger.warn({ err: error }, 'Backups: the change diary could not start; a full copy is taken instead.');
    copyWanted = true;
  }
  diaryLoop();
  tick();
  ticker = setInterval(tick, TICK_MS);
  ticker.unref?.();
  logger.info('Backups are on: a full copy every 6 hours and the change diary every 5 minutes.');
}

export async function stopBackups() {
  running = false;
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (diary) {
    // What is waiting goes up before the server stops, when storage allows.
    await diary.flush().catch(() => null);
    await diary.stop();
  }
}
