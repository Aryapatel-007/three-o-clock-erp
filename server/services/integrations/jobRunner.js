/**
 * The queue that runs every outgoing partner call and every incoming event.
 * P25 Part G, API-CONTRACT M21 section 5.
 *
 * A slow partner never holds up a cashier: the call is queued, the person
 * carries on, and this runs it. Retries wait 30 seconds, 2 minutes, 10
 * minutes, 30 minutes, then 2 hours; after `maxAttempts` the job is DEAD and
 * raises an alert. A `dedupeKey` already used is not queued twice.
 *
 * ASSUMES ONE SERVER INSTANCE (docs/DEPLOYMENT.md). The claim is a
 * findOneAndUpdate, so two runners never run one job, but the loop itself is
 * started once per process.
 */
import { IntegrationJob, JOB_STATUSES } from '../../models/IntegrationJob.js';
import { logger } from '../../config/logger.js';
import { nowUtc } from '../../utils/time.js';
import { mayRunWriterLoops } from '../replication/writerState.js';

export const RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 600_000, 1_800_000, 7_200_000]);
/** How long a claimed job is held before another runner may take it again. */
export const LOCK_MS = 2 * 60_000;
export const LOOP_INTERVAL_MS = 5_000;

const DUPLICATE_KEY = 11000;
const handlers = new Map();

/** Registers the function that runs a job type. `fn(job)` returns a result or throws. */
export function registerJobHandler(type, fn) {
  handlers.set(type, fn);
}

/**
 * Queues a job. Returns the job, or null when its `dedupeKey` was already
 * used. `ctx` carries `restaurantId` and `branchId`.
 */
export async function enqueueJob(ctx, { connectionId, type, payload = {}, dedupeKey = null, runAfter = nowUtc(), maxAttempts, forBridge = false }, session = null) {
  try {
    const [job] = await IntegrationJob.create(
      [
        {
          restaurantId: ctx.restaurantId,
          branchId: ctx.branchId,
          connectionId,
          type,
          payload,
          dedupeKey,
          runAfter,
          forBridge,
          ...(maxAttempts ? { maxAttempts } : {}),
        },
      ],
      session ? { session } : {},
    );
    return job;
  } catch (error) {
    if (error?.code === DUPLICATE_KEY && dedupeKey) return null;
    throw error;
  }
}

/** Claims the next due job of any restaurant, or null. The one cross-restaurant read here. */
function claimNext(now) {
  return IntegrationJob.findOneAndUpdate(
    {
      forBridge: false,
      $or: [
        { status: { $in: [JOB_STATUSES.QUEUED, JOB_STATUSES.FAILED] }, runAfter: { $lte: now } },
        { status: JOB_STATUSES.RUNNING, lockedUntil: { $lte: now } },
      ],
    },
    { $set: { status: JOB_STATUSES.RUNNING, lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1 }, new: true },
  ).setOptions({ skipTenantGuard: true });
}

/** Writes a job's outcome, scoped to its own restaurant. */
function finish(job, update) {
  return IntegrationJob.updateOne({ restaurantId: job.restaurantId, _id: job._id }, update);
}

/**
 * Runs up to `limit` due jobs, one at a time. Returns what happened to each,
 * for tests and logs.
 */
export async function runDueJobs({ limit = 20, now = null } = {}) {
  const ran = [];
  for (let index = 0; index < limit; index += 1) {
    const at = now ?? nowUtc();
    const job = await claimNext(at);
    if (!job) break;

    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`Nothing runs jobs of type ${job.type}.`);
      const result = await handler(job);
      await finish(job, { $set: { status: JOB_STATUSES.DONE, lockedUntil: null, lastError: null, result: result ?? null } });
      ran.push({ id: String(job._id), type: job.type, status: JOB_STATUSES.DONE });
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 500);
      const dead = job.attempts >= job.maxAttempts;
      const delay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      await finish(job, {
        $set: {
          status: dead ? JOB_STATUSES.DEAD : JOB_STATUSES.FAILED,
          lockedUntil: null,
          lastError: message,
          ...(dead ? {} : { runAfter: new Date(at.getTime() + delay) }),
        },
      });
      ran.push({ id: String(job._id), type: job.type, status: dead ? JOB_STATUSES.DEAD : JOB_STATUSES.FAILED, error: message });
    }
  }
  return ran;
}

let loop = null;

/** Runs due jobs every 5 seconds. Started by server.js outside tests only. */
export function startJobLoop() {
  if (loop) return loop;
  let busy = false;
  loop = setInterval(async () => {
    if (busy) return;
    // P62. Only the writer sends: never a read-only mirror, never a box that
    // stood down, or the same refund would go out from two machines.
    if (!mayRunWriterLoops()) return;
    busy = true;
    try {
      await runDueJobs();
    } catch (error) {
      logger.error({ err: error }, 'The integration job loop failed a round.');
    } finally {
      busy = false;
    }
  }, LOOP_INTERVAL_MS);
  loop.unref?.();
  return loop;
}

export function stopJobLoop() {
  if (loop) clearInterval(loop);
  loop = null;
}

export default { enqueueJob, registerJobHandler, runDueJobs, startJobLoop, stopJobLoop };
