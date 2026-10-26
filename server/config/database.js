/**
 * MongoDB connection.
 *
 * The server does not listen until this succeeds. A half-connected API that
 * returns 500s looks the same as a broken one to a restaurant, but is harder
 * to diagnose.
 */
import mongoose from 'mongoose';

import { config } from './env.js';
import { logger } from './logger.js';

const MAX_CONNECT_ATTEMPTS = 5;
const FIRST_RETRY_DELAY_MS = 500;
const SERVER_SELECTION_TIMEOUT_MS = 5000;

// A filter that references a field the schema does not have is a mistake, not
// a silent match-everything. Same instinct as the tenant guard.
mongoose.set('strictQuery', 'throw');

// In production, indexes are built deliberately during a deploy, not on the
// first query after a restart. Building them automatically on a live server
// can lock a collection at exactly the wrong moment.
mongoose.set('autoIndex', !config.isProduction);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  const connection = mongoose.connection;
  connection.on('connected', () => logger.info('Database connected.'));
  connection.on('reconnected', () => logger.info('Database reconnected.'));
  connection.on('disconnected', () => logger.warn('Database disconnected.'));
  connection.on('error', (error) => logger.error({ err: error }, 'Database error.'));
}

/** True only when the driver is connected right now. Read live, never cached. */
export function isDatabaseConnected() {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

export const NOT_A_REPLICA_SET_MESSAGE =
  'The database is not a replica set. Bills are numbered inside a transaction, and a standalone mongod cannot run one, ' +
  'so every bill would fail at the till. Add replication.replSetName to mongod.conf, restart it, run rs.initiate() once, ' +
  'and put ?replicaSet=<name> on MONGO_URI. docs/RUNBOOK.md section 2 has the steps.';

/**
 * P62. The name of the replica set behind `db`, or null for a standalone.
 *
 * `hello` is the server's own answer, so a URI that forgets `replicaSet=` but
 * reaches a member still counts, and a standalone can never pass by a typo.
 */
export async function replicaSetName(db) {
  const hello = await db.admin().command({ hello: 1 });
  return hello.setName ?? null;
}

/**
 * P62 section 2.1. Refuses a standalone at boot, with the fix, instead of a
 * 500 on the first bill of the day. Atlas is always a replica set.
 */
export async function assertReplicaSet(db) {
  const name = await replicaSetName(db);
  if (!name) {
    const error = new Error(NOT_A_REPLICA_SET_MESSAGE);
    error.code = 'NOT_A_REPLICA_SET';
    throw error;
  }
  return name;
}

/**
 * Connects, retrying with backoff. After the last attempt the process exits.
 * There is nothing useful this server can do without a database.
 */
export async function connectDatabase() {
  attachConnectionListeners();

  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(config.MONGO_URI, {
        serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
      });
      try {
        const setName = await assertReplicaSet(mongoose.connection.db);
        logger.info({ replicaSet: setName }, 'Database is a replica set.');
      } catch (error) {
        if (error.code !== 'NOT_A_REPLICA_SET') throw error;
        logger.fatal(error.message);
        process.exit(1);
      }
      return mongoose.connection;
    } catch (error) {
      const isLastAttempt = attempt === MAX_CONNECT_ATTEMPTS;

      if (isLastAttempt) {
        logger.fatal(
          { err: error, attempt, maxAttempts: MAX_CONNECT_ATTEMPTS },
          'Could not connect to the database. Giving up.',
        );
        process.exit(1);
      }

      const delayMs = FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1);
      logger.warn(
        { err: error, attempt, maxAttempts: MAX_CONNECT_ATTEMPTS, retryInMs: delayMs },
        'Database connection failed. Retrying.',
      );
      await sleep(delayMs);
    }
  }

  // Unreachable. The loop above either returns or exits.
  return mongoose.connection;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState === mongoose.ConnectionStates.disconnected) return;
  await mongoose.connection.close(false);
  logger.info('Database connection closed.');
}

/**
 * Closes the connection cleanly on SIGINT and SIGTERM.
 *
 * `beforeDisconnect` is where the caller stops accepting new requests. The
 * HTTP listener is closed first so an in-flight request is not cut off midway
 * through a database call.
 */
export function installShutdownHandlers(beforeDisconnect) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down.');
    try {
      if (typeof beforeDisconnect === 'function') await beforeDisconnect();
      await disconnectDatabase();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error, signal }, 'Shutdown did not complete cleanly.');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
