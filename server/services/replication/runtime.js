/**
 * Replication's timers, started once by server.js. P62.
 *
 *   every role  the writer state, read every 10 seconds
 *   BOX         the clock check (boot, then every minute)
 *               the changelog writer (every half second)
 *               with MIRROR_URL: the shipper (every second, backing off on
 *               failure), the intake puller (every 3 seconds, backing off),
 *               and reconciliation (every 30 minutes)
 *   MIRROR      nothing more: it answers the box
 *
 * P63, SYNC_MODE=TWO_WAY:
 *   BOX         the clock check and the changelog writer as above, then per
 *               restaurant: pull the cloud's changes, then push its own, every
 *               SYNC_EVERY_SECONDS inside SYNC_HOURS, and outside them only with
 *               changes waiting (sync/pacing.js). No intake puller (the cloud takes online orders itself)
 *               and no reconciliation (two writers differ for seconds by design)
 *   CLOUD       the changelog writer; it answers the box's pulls and pushes
 *
 * None of it is in a request's path. A failed round is logged and the next
 * one tries again; nothing here can stop the till.
 */
import mongoose from 'mongoose';

import { currentRole, ROLES } from '../../config/deployment.js';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { businessDateFor, nowUtc } from '../../utils/time.js';
import { pullIntakeOnce } from '../intake/boxIntake.js';
import { pullOnce } from '../sync/exchange.js';
import { parseSyncHours, shouldExchange } from '../sync/pacing.js';
import { isTwoWay } from '../sync/mode.js';
import { ChangelogWriter } from './changelogWriter.js';
import { CLOCK_CHECK_EVERY_MS, checkClock } from './clockGuard.js';
import { reconcileOnce } from './reconcile.js';
import { hasUnshippedChanges, RETRY_DELAYS_MS, Shipper } from './shipper.js';
import { loadWriterState, startWriterStateRefresh, stopWriterStateRefresh } from './writerState.js';

export const WRITER_PUMP_MS = 500;
export const SHIP_EVERY_MS = 1_000;
export const PULL_EVERY_MS = 3_000;
export const RECONCILE_EVERY_MS = 30 * 60_000;
/** P63. How often the box looks whether a two-way round is due; the pace itself is SYNC_EVERY_SECONDS. */
export const TWO_WAY_TICK_MS = 5_000;
const PULL_BACKOFF_MS = Object.freeze([3_000, 10_000, 30_000, 60_000]);

const timers = [];
let writer = null;

function every(ms, name, fn) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (error) {
      logger.warn({ err: error }, `${name} failed a round.`);
    } finally {
      busy = false;
    }
  }, ms);
  timer.unref?.();
  timers.push(timer);
}

async function localRestaurantIds() {
  const docs = await mongoose.connection.db.collection('restaurants').find({}, { projection: { _id: 1 } }).toArray();
  return docs.map((doc) => doc._id);
}

/** Records what the change stream has waiting now. The appliers call it first. */
export async function pumpChangelog() {
  if (writer) await writer.pump();
}

async function startChangelogWriter() {
  writer = new ChangelogWriter();
  logger.info({ start: await writer.start() }, 'Changelog writer started.');
  every(WRITER_PUMP_MS, 'The changelog writer', () => writer.pump());
}

/**
 * P63. The box's round: pull then push, for every restaurant, paced by SYNC_EVERY_SECONDS
 * and SYNC_HOURS (sync/pacing.js) and backing off when the cloud is away.
 */
// The box's shipper, and the round in progress: the timer and Sync now share them, one round at a time.
let boxShipper = null;
let roundInFlight = null;
let syncFailures = 0;
let syncNextAt = 0;

/** One two-way round: pull everything waiting, then push. Gives back whether any step failed. */
async function exchangeRound() {
  let failed = false;
  for (const restaurantId of await localRestaurantIds()) {
    for (let round = 0; round < 50; round += 1) {
      const outcome = await pullOnce(restaurantId, { pump: pumpChangelog });
      if (outcome === 'FAILED') failed = true;
      if (outcome !== 'PULLED') break;
    }
  }
  await writer?.pump();
  const shipped = await boxShipper.tick();
  if (shipped?.some((outcome) => outcome === 'FAILED')) failed = true;
  syncFailures = failed ? syncFailures + 1 : 0;
  syncNextAt = failed ? Date.now() + RETRY_DELAYS_MS[Math.min(syncFailures - 1, RETRY_DELAYS_MS.length - 1)] : 0;
  return { failed };
}

function runRound(round) {
  if (!roundInFlight) roundInFlight = round().finally(() => { roundInFlight = null; });
  return roundInFlight;
}

/**
 * 2026-10-22. Sync now, from the Sync page. On the box: a whole round at once,
 * outside the pace and any wait after a failure (two-way), or a push (one-way).
 * On the cloud: its own latest changes go into the changelog, ready for the
 * box's next pull. Gives back what this side could do.
 */
export async function syncNow() {
  if (currentRole() === ROLES.BOX && boxShipper) {
    if (!isTwoWay()) {
      await writer?.pump();
      const shipped = await boxShipper.tick();
      return { did: 'PUSHED', failed: Boolean(shipped?.some((outcome) => outcome === 'FAILED')) };
    }
    const { failed } = await runRound(exchangeRound);
    return { did: 'PULLED_AND_PUSHED', failed };
  }
  if (writer) {
    await writer.pump();
    return { did: 'READY_FOR_THE_PC', failed: false };
  }
  return { did: 'NOTHING', failed: false };
}

function startTwoWayExchange() {
  boxShipper = new Shipper();
  const everyMs = config.SYNC_EVERY_SECONDS * 1_000;
  const hours = parseSyncHours(config.SYNC_HOURS);
  let lastAt = 0;
  every(TWO_WAY_TICK_MS, 'The two-way sync', async () => {
    if (Date.now() < syncNextAt) return;
    await writer?.pump();
    if (!shouldExchange({ now: nowUtc(), lastAt, waiting: await hasUnshippedChanges(), everyMs, hours })) return;
    lastAt = nowUtc().getTime();
    await runRound(exchangeRound);
  });
}

export async function startReplication() {
  await loadWriterState();
  startWriterStateRefresh();
  if (isTwoWay() && currentRole() === ROLES.CLOUD) {
    await startChangelogWriter();
    logger.info('Two-way sync: this cloud writes and keeps a changelog for the cafe PC to pull.');
    return;
  }
  if (currentRole() !== ROLES.BOX) return;

  await checkClock();
  every(CLOCK_CHECK_EVERY_MS, 'The clock check', () => checkClock());

  await startChangelogWriter();

  if (!config.MIRROR_URL || !config.REPLICATION_SECRET) {
    logger.warn('MIRROR_URL is not set: the changelog is kept on this box and nothing is shipped. docs/REPLICATION.md section 5.');
    return;
  }

  if (isTwoWay()) {
    startTwoWayExchange();
    logger.info({ cloud: config.MIRROR_URL }, 'Two-way sync with the cloud started.');
    return;
  }

  boxShipper = new Shipper();
  every(SHIP_EVERY_MS, 'The shipper', () => boxShipper.tick());

  let pullFailures = 0;
  let pullAfter = 0;
  every(PULL_EVERY_MS, 'The intake puller', async () => {
    if (Date.now() < pullAfter) return;
    try {
      await pullIntakeOnce();
      pullFailures = 0;
    } catch (error) {
      pullFailures += 1;
      pullAfter = Date.now() + PULL_BACKOFF_MS[Math.min(pullFailures - 1, PULL_BACKOFF_MS.length - 1)];
      throw error;
    }
  });

  every(RECONCILE_EVERY_MS, 'Reconciliation', async () => {
    const today = businessDateFor(nowUtc());
    for (const restaurantId of await localRestaurantIds()) await reconcileOnce(restaurantId, { businessDate: today });
  });
}

export async function stopReplication() {
  for (const timer of timers.splice(0)) clearInterval(timer);
  await roundInFlight?.catch(() => {});
  boxShipper = null;
  syncFailures = 0;
  syncNextAt = 0;
  stopWriterStateRefresh();
  if (writer) {
    // What the stream has waiting goes into the changelog before the database closes.
    await writer.pump().catch(() => {});
    await writer.close();
    writer = null;
  }
}
