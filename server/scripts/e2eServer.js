/**
 * The server the browser tests drive. P21.
 *
 *   NODE_ENV=test node server/scripts/e2eServer.js
 *
 * An in-memory MongoDB replica set, the real app from `createApp`, serving the
 * already-built client from `client/dist`, on 127.0.0.1:5055. Beside it, on
 * 127.0.0.1:5056, a separate control listener that exists only inside this
 * script and is never part of the app:
 *
 *   POST /clock  { at }   moves the server's clock (setClockForTests)
 *   POST /reset-played    the same, with the golden day played through the API
 *   POST /reset           empties the database and sets up the golden
 *                         restaurant, without playing the day
 *   GET  /ready           answers once both listeners are up
 *
 * It refuses to start unless NODE_ENV is `test`, before it touches anything,
 * and it makes its own throwaway secrets, which it never writes to disk.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const APP_PORT = 5055;
export const CONTROL_PORT = 5056;
/** P24. A fake Razorpay, so a guest can pay and come back in the browser test. */
export const FAKE_RAZORPAY_PORT = 5057;
/** P37. A fake Meta Cloud API, so a bill paid in the browser test is sent on WhatsApp. */
export const FAKE_META_PORT = 5059;
/** P51. A fake AI model, so a guest can book a table on WhatsApp in the browser test. Not 5060 or 5061: fetch refuses those ports (SIP). */
export const FAKE_MODEL_PORT = 5062;
// P44. A fake Resend, so the day-end email can be sent and read back.
const FAKE_RESEND_PORT = FAKE_RAZORPAY_PORT + 1;
const HOST = '127.0.0.1';

if (process.env.NODE_ENV !== 'test') {
  console.error('e2eServer refuses to start: NODE_ENV must be "test". It moves the clock and empties its database.');
  process.exit(1);
}

const secret = () => randomBytes(48).toString('base64');

// Set before any server module is imported, because config/env.js reads the
// environment once, at import. dotenv never overwrites these.
Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: String(APP_PORT),
  TRUST_PROXY: 'false',
  JWT_ACCESS_SECRET: secret(),
  JWT_REFRESH_SECRET: secret(),
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  BCRYPT_ROUNDS: '10',
  CLIENT_ORIGIN: `http://${HOST}:${APP_PORT}`,
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: '15',
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '50',
  PAYMENT_SECRETS_KEY: randomBytes(32).toString('base64'),
  RAZORPAY_API_BASE: `http://${HOST}:${FAKE_RAZORPAY_PORT}`,
  RESEND_API_KEY: 're_e2e_key',
  RESEND_API_BASE: `http://${HOST}:${FAKE_RESEND_PORT}`,
});

const { MongoMemoryReplSet } = await import('mongodb-memory-server');
const replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
process.env.MONGO_URI = replicaSet.getUri('restaurant-erp-e2e');

const { default: mongoose } = await import('mongoose');
const { createApp } = await import('../server.js');
const { ALL_MODELS } = await import('../models/index.js');
const { setClockForTests } = await import('../utils/time.js');
const { startTestServer } = await import('../tests/helpers/testServer.js');
const { playGoldenDay, setupGoldenRestaurant } = await import('../tests/helpers/goldenDay.js');

await mongoose.connect(process.env.MONGO_URI);
for (const model of ALL_MODELS) await model.init();

// The golden helpers drive the API through the test server, as the API tests do.
await startTestServer();

const { startFakeRazorpay } = await import('../tests/helpers/fakeRazorpay.js');
await startFakeRazorpay({ port: FAKE_RAZORPAY_PORT, host: HOST });
const { startFakeMeta } = await import('../tests/helpers/fakeMeta.js');
const fakeMeta = await startFakeMeta({ port: FAKE_META_PORT, host: HOST });
// P51. The assistant's model, scripted by the browser test through /model.
const { startFakeModel } = await import('../tests/helpers/fakeModel.js');
const fakeModel = await startFakeModel({ port: FAKE_MODEL_PORT, host: HOST });

// P44. Every email the app sends lands here; the control listener reads them back.
const sentEmails = [];
const fakeResend = http.createServer((request, response) => {
  let raw = '';
  request.on('data', (chunk) => (raw += chunk));
  request.on('end', () => {
    sentEmails.push(JSON.parse(raw || '{}'));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `e2e_${sentEmails.length}` }));
  });
});
await new Promise((resolve) => fakeResend.listen(FAKE_RESEND_PORT, HOST, resolve));

const app = createApp({ serveClient: true });
const httpServer = await new Promise((resolve) => {
  const listening = app.listen(APP_PORT, HOST, () => resolve(listening));
});
// P33. The live channel, as production runs it. LIVE_CHANNEL=off for the run without it.
const { attachLiveChannel } = await import('../services/live/socketServer.js');
attachLiveChannel(httpServer);

// P25. Webhooks and partner calls are jobs, as in production; server.js starts
// this loop everywhere but tests, and the browser tests need it running.
const { startJobLoop } = await import('../services/integrations/jobRunner.js');
await import('../services/integrations/platformOrderService.js');
await import('../services/integrations/terminals/terminalService.js');
startJobLoop();

async function reset() {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  const golden = await setupGoldenRestaurant({ name: 'Golden Day Cafe', invoiceSeries: false });
  return { phones: golden.phones, password: golden.password, ids: golden.ids };
}

const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readJson = (request) =>
  new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });

const control = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/ready') return send(response, 200, { ready: true });
    if (request.method === 'POST' && request.url === '/clock') {
      const { at } = await readJson(request);
      const instant = new Date(at);
      if (Number.isNaN(instant.getTime())) return send(response, 400, { error: 'at must be an instant' });
      setClockForTests(instant);
      return send(response, 200, { at: instant.toISOString() });
    }
    // The golden day already played through the API, for e2e/mobileLayout.spec.js, which
    // measures screens with bills on them rather than walking the day through them.
    if (request.method === 'POST' && request.url === '/reset-played') {
      const { collections } = mongoose.connection;
      await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
      const golden = await playGoldenDay(await setupGoldenRestaurant({ name: 'Golden Day Cafe' }));
      return send(response, 200, { phones: golden.phones, password: golden.password, ids: golden.ids });
    }
    if (request.method === 'POST' && request.url === '/reset') {
      Object.assign(fakeMeta.state, { templates: [], messages: [], requests: [] });
      Object.assign(fakeModel.state, { queue: [], requests: [] });
      return send(response, 200, await reset());
    }
    // P37. What the fake Meta was sent, and its reviewer approving a template.
    if (request.method === 'GET' && request.url === '/meta') return send(response, 200, { url: fakeMeta.url, messages: fakeMeta.state.messages });
    if (request.method === 'POST' && request.url === '/meta/approve') {
      const { name } = await readJson(request);
      fakeMeta.approve(name);
      return send(response, 200, { approved: name });
    }
    // P51. What the fake model answers next, in order: { steps: [...] }.
    if (request.method === 'GET' && request.url === '/model') return send(response, 200, { url: fakeModel.url, waiting: fakeModel.state.queue.length });
    if (request.method === 'POST' && request.url === '/model/script') {
      const { steps } = await readJson(request);
      fakeModel.script(...(steps ?? []));
      return send(response, 200, { waiting: fakeModel.state.queue.length });
    }
    if (request.method === 'GET' && request.url === '/emails') return send(response, 200, { emails: sentEmails });
    return send(response, 404, { error: 'not found' });
  } catch (error) {
    return send(response, 500, { error: error.message });
  }
});
await new Promise((resolve) => control.listen(CONTROL_PORT, HOST, resolve));

console.log(`e2e app on http://${HOST}:${APP_PORT}, control on http://${HOST}:${CONTROL_PORT}`);

const stop = async () => {
  control.close();
  await mongoose.disconnect();
  await replicaSet.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
