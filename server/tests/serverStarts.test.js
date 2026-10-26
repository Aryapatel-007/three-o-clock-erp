/**
 * P30 Part A: the wake address and the record of server starts.
 * API-CONTRACT P30 sections 1 to 3, DB-SCHEMA section 44.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { isDatabaseConnected } from '../config/database.js';
import { WAKE_MAX_PER_MINUTE } from '../middleware/rateLimit.js';
import { BackupRun } from '../models/BackupRun.js';
import { BackupState } from '../models/BackupState.js';
import { ReplicationState } from '../models/ReplicationState.js';
import { ALL_MODELS, SERVER_MODELS } from '../models/index.js';
import { ServerStart } from '../models/ServerStart.js';
import { purgePlan } from '../scripts/purgeRestaurant.js';
import { recordServerStart, summariseStarts } from '../services/serverStartService.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ok = (response, what) => {
  assert.ok(response.status >= 200 && response.status < 300, `${what}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data;
};

describe('the wake address, with no database', () => {
  before(startTestServer);
  after(stopTestServer);

  it('answers without a database connection, never cached', async () => {
    assert.equal(isDatabaseConnected(), false);
    const response = await request('GET', '/api/v1/wake');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.ok, true);
    assert.ok(Number.isInteger(response.body.data.uptimeSeconds));
    assert.ok(!Number.isNaN(Date.parse(response.body.data.startedAt)));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('health gains startedAt and is never cached', async () => {
    const response = await request('GET', '/api/v1/health');
    assert.equal(response.status, 200);
    assert.ok(response.body.data.startedAt);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('has its own limit of 60 a minute, and never touches the sign-in limiter', async () => {
    // One wake already answered above (health is not a wake); use up the rest of the minute.
    let refused = null;
    for (let count = 2; count <= WAKE_MAX_PER_MINUTE + 1; count += 1) {
      const response = await request('GET', '/api/v1/wake');
      if (response.status === 429) {
        refused = count;
        break;
      }
    }
    assert.equal(refused, WAKE_MAX_PER_MINUTE + 1, 'the 61st request in a minute is refused');

    // The sign-in route is still answered on its own terms, not with 429.
    const login = await request('POST', '/api/v1/auth/login', { body: { phone: '9000000000', password: 'nope-nope' } });
    assert.notEqual(login.status, 429);
  });
});

describe('the record of server starts', () => {
  before(async () => {
    await startTestDatabase();
    await startTestServer();
    for (const model of ALL_MODELS) await model.init();
  });
  after(async () => {
    resetClockForTests();
    await stopTestServer();
    await stopTestDatabase();
  });

  it('starting the server writes one start, and tells a deploy from a restart', async () => {
    await ServerStart.deleteMany({});
    const first = await recordServerStart({ startedAt: new Date('2026-10-09T03:00:00Z'), release: 'aaa', nodeEnv: 'test' });
    assert.equal(await ServerStart.countDocuments({}), 1);
    assert.equal(first.reason, 'FIRST');
    const restart = await recordServerStart({ startedAt: new Date('2026-10-09T05:00:00Z'), release: 'aaa', nodeEnv: 'test' });
    const deploy = await recordServerStart({ startedAt: new Date('2026-10-09T06:00:00Z'), release: 'bbb', nodeEnv: 'test' });
    assert.equal(restart.reason, 'RESTART');
    assert.equal(deploy.reason, 'DEPLOY');

    // startServer records it once, as it starts listening.
    const source = readFileSync(path.resolve(here, '../server.js'), 'utf8');
    assert.equal(source.match(/recordServerStart\(/g)?.length, 1);
    assert.match(source, /app\.listen\([\s\S]*recordServerStart\(\)/);
  });

  it('belongs to the server: no restaurantId, and the purge tool leaves it alone', () => {
    // P54: the backups' runs and state are the server's too, on purpose. P62: so is replication's state.
    assert.deepEqual(SERVER_MODELS, [ServerStart, BackupRun, BackupState, ReplicationState]);
    assert.equal(ServerStart.schema.path('restaurantId'), undefined);
    assert.ok(purgePlan().every((step) => step.model !== ServerStart));
    const ttl = ServerStart.schema.indexes().find(([keys]) => keys.startedAt === -1);
    assert.equal(ttl[1].expireAfterSeconds, 60 * 24 * 60 * 60);
  });

  it('works out each business date from made-up starts', () => {
    const at = (iso) => new Date(iso);
    const starts = [
      // 9 Oct: a deploy at 9:00 AM IST, then three wakes during service.
      { startedAt: at('2026-10-09T03:30:00Z'), reason: 'DEPLOY' },
      { startedAt: at('2026-10-09T07:30:00Z'), reason: 'RESTART' },
      { startedAt: at('2026-10-09T09:00:00Z'), reason: 'RESTART' },
      { startedAt: at('2026-10-09T13:30:00Z'), reason: 'RESTART' },
      // 10 Oct: one wake at 4:00 AM IST, before the business day starts at 5:00, so it is 9 Oct's.
      { startedAt: at('2026-10-09T22:30:00Z'), reason: 'RESTART' },
      // 10 Oct: one wake at 8:31 AM, outside the hours below.
      { startedAt: at('2026-10-10T03:01:00Z'), reason: 'RESTART' },
    ];
    const summary = summariseStarts(starts, {
      now: at('2026-10-10T10:00:00Z'),
      days: 3,
      dayStartMinutes: 300,
      workingHours: { opensAtMinutes: 600, closesAtMinutes: 1380, fromOnlineSettings: true },
    });
    assert.deepEqual(
      summary.days.map((day) => day.businessDate),
      ['2026-10-10', '2026-10-09', '2026-10-08'],
    );
    const [today, yesterday, before] = summary.days;
    assert.deepEqual(today, { businessDate: '2026-10-10', starts: 1, startsInWorkingHours: 0, longestGapMinutes: null });
    // 3:30 to 7:30 UTC is 240 minutes; 13:30 to 22:30 is 540.
    assert.deepEqual(yesterday, { businessDate: '2026-10-09', starts: 5, startsInWorkingHours: 3, longestGapMinutes: 540 });
    assert.deepEqual(before, { businessDate: '2026-10-08', starts: 0, startsInWorkingHours: 0, longestGapMinutes: null });
    assert.deepEqual(summary.sleptInWorkingHours, ['2026-10-09']);
    assert.equal(summary.starts[0].startedAt.toISOString(), '2026-10-10T03:01:00.000Z');

    // With no hours chosen, every hour counts: today's 8:31 AM wake is now in working hours.
    const allDay = summariseStarts(starts, {
      now: at('2026-10-10T10:00:00Z'),
      days: 1,
      dayStartMinutes: 300,
      workingHours: { opensAtMinutes: 600, closesAtMinutes: 1380, fromOnlineSettings: false },
    });
    assert.equal(allDay.days[0].startsInWorkingHours, 1);
  });

  it('GET /system/starts is the owner\'s alone, and reads the starts', async () => {
    const floor = await seedFloor();
    await ServerStart.deleteMany({});
    await ServerStart.create([
      { startedAt: new Date('2026-10-10T03:01:00Z'), release: 'x', nodeEnv: 'test', reason: 'RESTART' },
      { startedAt: new Date('2026-10-08T03:00:00Z'), release: 'x', nodeEnv: 'test', reason: 'FIRST' },
    ]);
    setClockForTests(new Date('2026-10-10T10:00:00Z'));

    assert.equal((await request('GET', '/api/v1/system/starts')).status, 401);
    for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) {
      assert.equal((await request('GET', '/api/v1/system/starts', { token: floor.tokens[role] })).status, 403, role);
    }
    const data = ok(await request('GET', '/api/v1/system/starts?days=3', { token: floor.tokens.OWNER }), 'owner');
    assert.equal(data.days.length, 3);
    assert.deepEqual(data.days.map((day) => day.starts), [1, 0, 1]);
    assert.equal(data.starts.length, 2);
    assert.equal(data.starts[0].reason, 'RESTART');
    assert.equal(data.workingHours.fromOnlineSettings, false);

    assert.equal((await request('GET', '/api/v1/system/starts?days=61', { token: floor.tokens.OWNER })).status, 400);
    assert.ok(mongoose.connection.readyState === 1);
  });
});
