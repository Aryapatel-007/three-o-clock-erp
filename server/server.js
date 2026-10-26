/**
 * Server entry.
 *
 * Boot order: validate the environment, connect to the database, then listen.
 * Never listen before the database is up. An API that accepts requests it
 * cannot serve is harder to diagnose than one that is plainly not running.
 *
 * The middleware order below is the order in docs/CONVENTIONS.md section 8.
 * It is not arbitrary. Security headers before anything writes a response,
 * body parsing before anything reads a body, logging before the rate limiter
 * so a blocked request still appears in the log, and the error handler last so
 * it catches everything in front of it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import cors from 'cors';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';

import { connectDatabase, installShutdownHandlers } from './config/database.js';
import { config } from './config/env.js';
import { httpLogger, logger } from './config/logger.js';
import { describeTrustProxy } from './config/trustProxy.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { writerGate } from './middleware/writerGate.js';
import { isBox } from './config/deployment.js';
import { LOGO_UPLOAD_PATH } from './routes/brandRoutes.js';
import { PHOTO_UPLOAD_PATH } from './routes/paymentRoutes.js';
import hookRoutes, { HOOKS_PATH } from './routes/hookRoutes.js';
import tallyBridgeRoutes, { TALLY_BRIDGE_PATH } from './routes/tallyBridgeRoutes.js';
import routes from './routes/index.js';
import replicationRoutes, { REPLICATION_ROUTES_PATH } from './routes/replicationRoutes.js';
import { startReplication, stopReplication } from './services/replication/runtime.js';
import { startBackups, stopBackups } from './services/backup/backupService.js';
import { startJobLoop } from './services/integrations/jobRunner.js';
import { startCaSends, stopCaSends } from './services/caPackService.js';
import { attachLiveChannel, closeLiveChannel } from './services/live/socketServer.js';
import { recordServerStart } from './services/serverStartService.js';
import { describeKey, findMissingIndexes } from './services/indexService.js';

export const API_PREFIX = '/api/v1';

/** P24. Razorpay signs its webhook over the raw body, so this path keeps it. */
const WEBHOOK_PATH = /^\/api\/v1\/public\/[^/]+\/payments\/webhook\/?$/;

/**
 * The built client, found from this file's own location, never from the
 * working directory: a host may start the process from anywhere. P12.
 */
export const CLIENT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'dist');

export const CLIENT_NOT_BUILT_MESSAGE = 'The client has not been built. Run npm run build, then start again.';

/** True when the built client's index.html is where production will serve it from. */
export function isClientBuilt(clientDist = CLIENT_DIST) {
  return existsSync(path.join(clientDist, 'index.html'));
}

/**
 * Serves the built client from the same address as the API. P12.
 *
 * One address means the Secure refresh cookie and the single CORS origin just
 * work. Vite names every file under /assets/ by its content hash, so those are
 * cached for a year; index.html is never cached, so a new deploy is picked up
 * on the next page load. Any other GET that is not under /api/ gets index.html,
 * so a reload of /day-close lands in the React router. Anything under /api/
 * that no route matched falls through to the JSON 404, never to the HTML.
 */
function serveClient(app, clientDist) {
  const indexFile = path.join(clientDist, 'index.html');
  const assetsDir = `${path.sep}assets${path.sep}`;

  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders(res, filePath) {
        res.set(
          'Cache-Control',
          filePath.includes(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );

  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/api' || req.path.startsWith('/api/')) {
      return next();
    }
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexFile);
  });
}

/**
 * P62. Helmet as before, except on the cafe box, which staff reach over the
 * LAN as plain http://192.168.x.x: there `upgrade-insecure-requests` would send
 * every script and font to an https:// that does not exist, and the page would
 * come up blank. HSTS is ignored over http anyway and is left out with it.
 */
export function helmetOptions() {
  if (!isBox()) return {};
  return { contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } }, strictTransportSecurity: false };
}

/**
 * A price, a name and a few ids. Nothing this API accepts is large, and a
 * generous limit is free capacity for someone else.
 */
const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the app without starting it.
 *
 * Exported so tests can drive the real middleware chain without a database or
 * an open port. The app is exactly the one that runs in production.
 */
/**
 * `serveClient` and `clientDist` exist so a test can point the static files at
 * a temporary folder; by default the client is served in production only.
 * Development keeps Vite on its own port, proxying /api to this server.
 */
export function createApp({ serveClient: shouldServeClient = config.isProduction, clientDist = CLIENT_DIST } = {}) {
  const app = express();

  // Do not advertise what we are running.
  app.disable('x-powered-by');

  // Explicit, from TRUST_PROXY, never guessed. Behind a host's proxy with this
  // off, every device shares the proxy's address and one mistyped password
  // rate-limits the whole cafe. `true` is refused in config/trustProxy.js,
  // because it believes a forwarded address from anyone and lets any client
  // skip the login limit. Production must set it; see config/env.js.
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(helmet(helmetOptions()));

  /**
   * P31. Compresses responses, before every route, the partners' webhooks and
   * the Tally bridge included.
   *
   * Compression only touches what the server sends back. It cannot disturb the
   * raw request bodies the Razorpay, platform and Pine Labs webhooks keep for
   * their signature checks, nor the larger bodies the logo and photo uploads
   * parse for themselves. Already-compressed bytes, the PNG, WebP and JPEG of a
   * logo or a dish photo, are left alone by content type; a test proves it.
   *
   * On Render, Cloudflare compresses on the way out as well
   * (docs/PERFORMANCE-BASELINE.md); this is for any host without that edge.
   */
  app.use(compression());

  // credentials is on for the refresh token cookie that arrives in M0 part B.
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));

  // P62. Who may write here, decided before any route: the read-only cloud
  // mirror, a box that stood down, a box whose clock went back. Before the
  // webhooks too, so nothing reaches a handler that this machine may not run.
  app.use(writerGate);
  // P62. The box's signed replication calls, with their own EJSON body, on a mirror only.
  app.use(`${API_PREFIX}${REPLICATION_ROUTES_PATH}`, replicationRoutes);

  // P25 Part G. Partners' webhooks keep their raw bytes for the signature, so
  // they are mounted before the JSON parser, with their own limiter, and end
  // the request there: the general limiter never counts them.
  app.use(`${API_PREFIX}${HOOKS_PATH}`, hookRoutes);
  // P25 Part K. The Tally bridge: its own token, body limit and limiters, before the JSON parser.
  app.use(`${API_PREFIX}${TALLY_BRIDGE_PATH}`, tallyBridgeRoutes);

  // P22. The logo upload and removal parse their own body with a larger limit,
  // in routes/brandRoutes.js. Every other path keeps this one.
  // P24. Razorpay's webhook is signed over its raw body, so that one path keeps it.
  const jsonBody = express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buffer) => {
      if (WEBHOOK_PATH.test(req.path ?? req.url)) req.rawBody = buffer.toString('utf8');
    },
  });
  // The logo and the dish photo parse their own larger bodies, after the role check.
  const ownBody = (path) => LOGO_UPLOAD_PATH.test(path) || PHOTO_UPLOAD_PATH.test(path);
  app.use((req, res, next) => (ownBody(req.path) ? next() : jsonBody(req, res, next)));
  app.use(httpLogger);
  app.use(API_PREFIX, generalLimiter);
  app.use(API_PREFIX, routes);

  if (shouldServeClient) serveClient(app, clientDist);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      if (error.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
      } else {
        reject(error);
      }
    }
  });
}

/**
 * A crash we did not predict leaves the process in an unknown state. Log it
 * and stop, rather than continuing to serve from a process that may be holding
 * a half-finished transaction.
 */
function installCrashHandlers() {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection. Stopping.');
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception. Stopping.');
    process.exit(1);
  });
}

/**
 * Refuses to start a production server whose database is missing an index.
 *
 * `autoIndex` is off in production, so nothing builds indexes on boot, and the
 * unique ones are what stop a duplicate bill number, a second open order on a
 * table and a double stock deduction. A server running without them looks
 * perfectly healthy until the day two of those collide. There is deliberately
 * no setting that skips this check. Development and test skip it only because
 * `autoIndex` builds the indexes there already.
 */
async function assertIndexesPresent() {
  if (!config.isProduction) return;

  const { missing, extra } = await findMissingIndexes();

  for (const index of extra) {
    logger.warn(
      { collection: index.collection, index: index.name },
      'Index in the database that no schema declares. Left alone.',
    );
  }

  if (missing.length === 0) return;

  for (const index of missing) {
    logger.fatal(
      { collection: index.collection, key: describeKey(index.key) },
      'Index missing from the database.',
    );
  }
  logger.fatal('Indexes are missing. Run npm run db:indexes against this database, then start again.');
  process.exit(1);
}

export async function startServer() {
  installCrashHandlers();

  logger.info(describeTrustProxy(config.TRUST_PROXY));

  // P12. Production serves the screens too, so a missing build is a refusal to
  // start, the same way a missing index is.
  if (config.isProduction && !isClientBuilt()) {
    logger.fatal(CLIENT_NOT_BUILT_MESSAGE);
    process.exit(1);
  }

  await connectDatabase();
  await assertIndexesPresent();

  const app = createApp();
  // P25 Part G. One loop per process; version 1 runs one instance.
  if (!config.isTest) startJobLoop();
  // P65. The CA's month, checked every hour wherever the job loop runs.
  if (!config.isTest) startCaSends();

  // 2026-10-17. Bound to 0.0.0.0 by name: Render's port scan looks there, and
  // with Node's default (::) a deploy timed out though the server was answering.
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info(
      { port: config.PORT, environment: config.NODE_ENV, api: API_PREFIX },
      'Server listening.',
    );
    // P30. One row per start, so the owner can see whether the server slept in
    // working hours. A failure to write it never stops the server.
    recordServerStart().catch((error) => logger.warn({ err: error }, 'Could not record this server start.'));
    // P54. Backups, when BACKUP_ENABLED is on. A failure is logged and shown to the owner, never thrown.
    startBackups().catch((error) => logger.warn({ err: error }, 'Backups could not start.'));
    // P62. The writer state everywhere; on the box, the changelog, the shipper and intake.
    startReplication().catch((error) => logger.error({ err: error }, 'Replication could not start.'));
  });

  // P33. The live channel rides the same HTTP server, ahead of Express, so no
  // limiter counts a socket. LIVE_CHANNEL=off leaves it out entirely.
  const live = attachLiveChannel(server);

  // The listener closes first so an in-flight request is not cut off partway
  // through a database call.
  installShutdownHandlers(async () => {
    closeLiveChannel(live);
    stopCaSends();
    await closeHttpServer(server);
    // P54. What the change diary has waiting goes up before the database closes.
    await stopBackups().catch((error) => logger.warn({ err: error }, 'Backups did not stop cleanly.'));
    // P62. What the change stream has waiting goes into the changelog before the database closes.
    await stopReplication().catch((error) => logger.warn({ err: error }, 'Replication did not stop cleanly.'));
  });

  return server;
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  await startServer();
}
