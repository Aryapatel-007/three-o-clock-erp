/**
 * Authentication tests.
 *
 * Runs against a real in-process MongoDB, through the real middleware chain.
 *
 * M0-D moved the refresh token out of the response body and into an httpOnly
 * cookie. The `request` helper has no cookie jar, so these tests read the
 * `Set-Cookie` line off a response and thread it back by hand, which also makes
 * the cookie's flags directly checkable.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';

import { ROLES } from '../config/roles.js';
import { RefreshToken, REVOKE_REASONS } from '../models/RefreshToken.js';
import { User } from '../models/User.js';
import { issueAccessToken, refreshTokenTtlMs } from '../services/tokenService.js';
import {
  clearTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from './helpers/testDatabase.js';
import { DEFAULT_PASSWORD, nextPhone, seedFullRestaurant } from './helpers/seed.js';
import { observedResponses, request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

const login = (phone, password) => request('POST', '/api/v1/auth/login', { body: { phone, password } });

// --- cookie helpers -------------------------------------------------------

const CSRF = { 'X-Requested-With': 'test' };

function setCookieLines(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}

/** The refreshToken Set-Cookie line and its value, or null if none was set. */
function refreshCookie(response) {
  const line = setCookieLines(response).find((c) => c.startsWith('refreshToken='));
  if (!line) return null;
  return { line, value: line.slice('refreshToken='.length).split(';')[0] };
}

/** Headers that send a refresh cookie plus the CSRF header. */
const withCookie = (value) => ({ headers: { ...CSRF, Cookie: `refreshToken=${value}` } });

/** Logs in and returns { accessToken, cookie } where cookie is the raw value. */
async function signIn(phone) {
  const response = await login(phone, DEFAULT_PASSWORD);
  return { accessToken: response.body.data.accessToken, cookie: refreshCookie(response).value };
}

// ---------------------------------------------------------------------------

describe('how long a sign-in lasts', () => {
  // 2026-10-14. Render sets no REFRESH_TOKEN_TTL, so this default is what Z Chaat gets:
  // a year, renewed on every refresh, so a device in use stays signed in until Sign out.
  it('defaults to a year when REFRESH_TOKEN_TTL is not set', () => {
    const source = readFileSync(new URL('../config/env.js', import.meta.url), 'utf8');
    assert.match(source, /durationVar\('REFRESH_TOKEN_TTL', '365d'\)/);
  });
});

describe('POST /auth/login', () => {
  it('returns the access token in the body and the refresh token in a cookie', async () => {
    const { phone, restaurant, branch, user } = await seedFullRestaurant();

    const response = await login(phone, DEFAULT_PASSWORD);
    const { status, body } = response;

    assert.equal(status, 200);
    assert.equal(body.success, true);

    // No refreshToken in the body any more.
    assert.deepEqual(
      Object.keys(body.data).sort(),
      ['accessToken', 'branch', 'expiresInSeconds', 'restaurant', 'user'],
    );

    const cookie = refreshCookie(response);
    assert.ok(cookie, 'login must set a refreshToken cookie');
    assert.ok(cookie.value.length > 40, 'the cookie carries the opaque token');
    assert.match(cookie.line, /HttpOnly/i);
    assert.match(cookie.line, /Secure/i);
    assert.match(cookie.line, /SameSite=Lax/i);
    assert.match(cookie.line, /Path=\/api\/v1\/auth/i);
    assert.match(cookie.line, /Max-Age=\d+/i);
    // The cookie lasts exactly as long as the stored token, from REFRESH_TOKEN_TTL.
    assert.equal(Number(cookie.line.match(/Max-Age=(\d+)/i)[1]), refreshTokenTtlMs() / 1000);

    assert.deepEqual(Object.keys(body.data.user).sort(), [
      'branchId', 'email', 'id', 'name', 'phone', 'restaurantId', 'role',
    ]);
    assert.equal(body.data.user.id, String(user._id));
    assert.equal(body.data.user.role, ROLES.OWNER);
    assert.deepEqual(body.data.restaurant, { id: String(restaurant._id), name: restaurant.name });
    assert.deepEqual(body.data.branch, { id: String(branch._id), name: 'Main' });
    assert.equal(body.data.expiresInSeconds, 900);
  });

  it('stores only the hash of the refresh token, never the token', async () => {
    const { phone } = await seedFullRestaurant();
    const response = await login(phone, DEFAULT_PASSWORD);
    const cookie = refreshCookie(response).value;

    const stored = await RefreshToken.find({}).setOptions({ skipTenantGuard: true });
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].tokenHash, cookie);
    assert.match(stored[0].tokenHash, /^[0-9a-f]{64}$/);
  });

  it('records lastLoginAt', async () => {
    const { phone, user } = await seedFullRestaurant();
    assert.equal(user.lastLoginAt, null);

    await login(phone, DEFAULT_PASSWORD);

    const reloaded = await User.findOne({ _id: user._id, restaurantId: user.restaurantId });
    assert.ok(reloaded.lastLoginAt instanceof Date);
  });

  it('returns a byte-identical 401 for all four failure reasons', async () => {
    const active = await seedFullRestaurant();

    const inactiveUser = await seedFullRestaurant();
    await User.updateOne(
      { _id: inactiveUser.user._id, restaurantId: inactiveUser.restaurant._id },
      { $set: { isActive: false } },
    );

    const inactiveRestaurant = await seedFullRestaurant();
    const { Restaurant } = await import('../models/Restaurant.js');
    await Restaurant.updateOne({ _id: inactiveRestaurant.restaurant._id }, { $set: { isActive: false } });

    const responses = {
      unknownPhone: await login(nextPhone(), DEFAULT_PASSWORD),
      wrongPassword: await login(active.phone, 'a completely wrong one'),
      inactiveUser: await login(inactiveUser.phone, DEFAULT_PASSWORD),
      inactiveRestaurant: await login(inactiveRestaurant.phone, DEFAULT_PASSWORD),
    };

    const expected = {
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Phone number or password is incorrect.' },
    };

    for (const [label, response] of Object.entries(responses)) {
      assert.equal(response.status, 401, `${label} status`);
      assert.deepEqual(response.body, expected, `${label} body`);
      assert.equal(refreshCookie(response), null, `${label} sets no cookie`);
    }

    const [first, ...rest] = Object.values(responses).map((r) => JSON.stringify(r.body));
    for (const other of rest) assert.equal(other, first);
  });

  it('never issues a session for a failed login', async () => {
    const { phone } = await seedFullRestaurant();
    await login(phone, 'wrong');

    const count = await RefreshToken.countDocuments({}).setOptions({ skipTenantGuard: true });
    assert.equal(count, 0);
  });

  it('rejects a malformed phone before it reaches the database', async () => {
    const { status, body } = await login('12345', DEFAULT_PASSWORD);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.fields.phone);
  });
});

describe('POST /auth/login by email', () => {
  const byEmail = (email, password = DEFAULT_PASSWORD) =>
    request('POST', '/api/v1/auth/login', { body: { email, password } });

  it('signs in with the email on the account, case-insensitively', async () => {
    const { user } = await seedFullRestaurant({ ownerEmail: 'Owner.One@Example.com' });

    const response = await byEmail('owner.one@example.com');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.user.id, String(user._id));
    assert.ok(refreshCookie(response), 'a cookie is set, same as phone login');
  });

  it('is a byte-identical 401 for an unknown email and a wrong password', async () => {
    await seedFullRestaurant({ ownerEmail: 'real@example.com' });

    const unknown = await byEmail('nobody@example.com');
    const wrongPassword = await byEmail('real@example.com', 'not the password');

    const expected = {
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Phone number or password is incorrect.' },
    };
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, expected);
    assert.deepEqual(wrongPassword.body, expected);
  });

  it('rejects a body carrying both phone and email', async () => {
    const { phone } = await seedFullRestaurant({ ownerEmail: 'both@example.com' });
    const { status, body } = await request('POST', '/api/v1/auth/login', {
      body: { phone, email: 'both@example.com', password: DEFAULT_PASSWORD },
    });
    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
  });

  it('rejects a body carrying neither', async () => {
    const { status } = await request('POST', '/api/v1/auth/login', {
      body: { password: DEFAULT_PASSWORD },
    });
    assert.equal(status, 400);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates the token, revokes the old one, and sets a fresh cookie', async () => {
    const { phone } = await seedFullRestaurant();
    const first = await signIn(phone);

    const response = await request('POST', '/api/v1/auth/refresh', withCookie(first.cookie));
    const { status, body } = response;

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body.data).sort(), ['accessToken', 'expiresInSeconds']);

    const next = refreshCookie(response);
    assert.ok(next, 'refresh sets a new cookie');
    assert.notEqual(next.value, first.cookie, 'the cookie value rotates');

    const stored = await RefreshToken.find({}).sort({ createdAt: 1 }).setOptions({ skipTenantGuard: true });
    assert.equal(stored.length, 2);
    assert.ok(stored[0].revokedAt, 'the presented token should be revoked');
    assert.equal(stored[0].revokedReason, REVOKE_REASONS.ROTATED);
    assert.equal(stored[0].replacedByTokenHash, stored[1].tokenHash);
    assert.equal(stored[1].revokedAt, null);
  });

  it('issues an access token that works', async () => {
    const { phone } = await seedFullRestaurant();
    const first = await signIn(phone);

    const refreshed = (
      await request('POST', '/api/v1/auth/refresh', withCookie(first.cookie))
    ).body.data;

    const { status } = await request('GET', '/api/v1/auth/me', { token: refreshed.accessToken });
    assert.equal(status, 200);
  });

  it('rejects a request without the X-Requested-With header', async () => {
    const { phone } = await seedFullRestaurant();
    const first = await signIn(phone);

    const { status, body } = await request('POST', '/api/v1/auth/refresh', {
      headers: { Cookie: `refreshToken=${first.cookie}` },
    });

    assert.equal(status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  it('rejects a request with no cookie, and does not set one', async () => {
    const { status, body } = await request('POST', '/api/v1/auth/refresh', { headers: { ...CSRF } });

    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_REFRESH_TOKEN');
  });

  it('clears the cookie when the token is bad', async () => {
    const unknown = 'a'.repeat(86);
    const response = await request('POST', '/api/v1/auth/refresh', withCookie(unknown));

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_REFRESH_TOKEN');

    const cleared = refreshCookie(response);
    assert.ok(cleared, 'a clearing Set-Cookie is sent');
    assert.equal(cleared.value, '', 'the cookie value is emptied');
    assert.match(cleared.line, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('revokes every session for the user when a revoked token is presented again', async () => {
    const { phone, restaurant } = await seedFullRestaurant();

    const sessionOne = await signIn(phone);
    await login(phone, DEFAULT_PASSWORD);
    await login(phone, DEFAULT_PASSWORD);

    // Rotate the first one, then use its replacement too, so the original is
    // revoked and its replacement has been used: replaying it now is theft,
    // not a lost reply (2 October 2026).
    const rotated = await request('POST', '/api/v1/auth/refresh', withCookie(sessionOne.cookie));
    await request('POST', '/api/v1/auth/refresh', withCookie(refreshCookie(rotated).value));

    const before = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedAt: null });
    assert.equal(before, 3, 'two untouched sessions plus the newest replacement');

    // Replay the already-rotated token.
    const { status, body } = await request('POST', '/api/v1/auth/refresh', withCookie(sessionOne.cookie));

    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_REFRESH_TOKEN');

    const stillActive = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedAt: null });
    assert.equal(stillActive, 0, 'every session for this user must be revoked');

    const reuseRevoked = await RefreshToken.countDocuments({
      restaurantId: restaurant._id,
      revokedReason: REVOKE_REASONS.REUSE_DETECTED,
    });
    assert.equal(reuseRevoked, 3);
  });

  it('keeps a person signed in when the reply to their refresh was lost, and only then', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    // The browser sent a refresh, the server rotated, and the reply never arrived:
    // the page reloaded mid-flight. The browser still holds the original cookie.
    const lost = await request('POST', '/api/v1/auth/refresh', withCookie(session.cookie));
    assert.equal(lost.status, 200);

    const again = await request('POST', '/api/v1/auth/refresh', withCookie(session.cookie));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const fresh = refreshCookie(again).value;
    assert.ok(fresh && fresh !== session.cookie);

    // The orphaned replacement no longer works, and nothing was revoked as theft.
    assert.equal((await request('POST', '/api/v1/auth/refresh', withCookie(refreshCookie(lost).value))).status, 401);
    const theft = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedReason: REVOKE_REASONS.REUSE_DETECTED });
    assert.ok(theft > 0, 'replaying the orphan, whose replacement was issued, is theft');
  });

  it('rejects an unknown token with the same code as a revoked one', async () => {
    const { status, body } = await request('POST', '/api/v1/auth/refresh', withCookie('a'.repeat(86)));
    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_REFRESH_TOKEN');
  });

  it('rejects an expired token', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    await RefreshToken.updateOne(
      { restaurantId: restaurant._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const { status, body } = await request('POST', '/api/v1/auth/refresh', withCookie(session.cookie));
    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_REFRESH_TOKEN');
  });
});

describe('logout', () => {
  it('revokes only the current session and clears the cookie', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const one = await signIn(phone);
    await login(phone, DEFAULT_PASSWORD);

    const response = await request('POST', '/api/v1/auth/logout', {
      token: one.accessToken,
      headers: { ...CSRF, Cookie: `refreshToken=${one.cookie}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { loggedOut: true });

    const cleared = refreshCookie(response);
    assert.ok(cleared);
    assert.equal(cleared.value, '');

    const active = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedAt: null });
    assert.equal(active, 1, 'the other device stays signed in');
  });

  it('answers 200 for a cookie that was already revoked', async () => {
    const { phone } = await seedFullRestaurant();
    const one = await signIn(phone);

    const headers = { ...CSRF, Cookie: `refreshToken=${one.cookie}` };
    await request('POST', '/api/v1/auth/logout', { token: one.accessToken, headers });
    const second = await request('POST', '/api/v1/auth/logout', { token: one.accessToken, headers });

    assert.equal(second.status, 200);
    assert.deepEqual(second.body.data, { loggedOut: true });
  });

  it('answers 200 with no cookie at all', async () => {
    const { phone } = await seedFullRestaurant();
    const one = await signIn(phone);

    const { status } = await request('POST', '/api/v1/auth/logout', {
      token: one.accessToken,
      headers: { ...CSRF },
    });
    assert.equal(status, 200);
  });

  it('rejects a logout without the X-Requested-With header', async () => {
    const { phone } = await seedFullRestaurant();
    const one = await signIn(phone);

    const { status, body } = await request('POST', '/api/v1/auth/logout', {
      token: one.accessToken,
      headers: { Cookie: `refreshToken=${one.cookie}` },
    });
    assert.equal(status, 403);
    assert.equal(body.error.code, 'FORBIDDEN');
  });

  it('logout-all revokes every session, reports the count, and clears the cookie', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const one = await signIn(phone);
    await login(phone, DEFAULT_PASSWORD);
    await login(phone, DEFAULT_PASSWORD);

    const response = await request('POST', '/api/v1/auth/logout-all', { token: one.accessToken });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { sessionsRevoked: 3 });
    assert.equal(refreshCookie(response).value, '', 'this device is signed out too');

    const active = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedAt: null });
    assert.equal(active, 0);
  });

  it('logout-all requires a token', async () => {
    const { status, body } = await request('POST', '/api/v1/auth/logout-all');
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });
});

describe('GET /auth/me', () => {
  it('returns the documented shape, read live rather than from the token', async () => {
    const { phone, restaurant, branch, user } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });

    assert.equal(status, 200);
    // `features` added by P02, so every role knows which modules are switched off.
    // `floor` added by P19, so every role's floor screen knows its settings.
    // P47 added payments.
    assert.deepEqual(Object.keys(body.data).sort(), ['appearance', 'approvals', 'billing', 'branch', 'cash', 'discounts', 'features', 'floor', 'kitchen', 'live', 'online', 'payments', 'restaurant', 'sync', 'terminals', 'user']);
    assert.deepEqual(body.data.features, { inventory: true, attendance: true, online: false });
    // P08. The cashier platform-discount switch, default off.
    assert.deepEqual(body.data.discounts, { cashierMayApplyPlatformDiscounts: false });
    assert.deepEqual(Object.keys(body.data.user).sort(), [
      'branchId', 'email', 'id', 'lastLoginAt', 'name', 'phone', 'restaurantId', 'role',
      // P05: the station a KITCHEN user's screen opens on.
      'stationId',
    ]);
    assert.equal(body.data.user.id, String(user._id));
    assert.equal(typeof body.data.user.lastLoginAt, 'string');
    assert.deepEqual(Object.keys(body.data.restaurant).sort(), ['gstin', 'id', 'name']);
    assert.deepEqual(body.data.branch, { id: String(branch._id), name: 'Main' });
    assert.equal(body.data.restaurant.id, String(restaurant._id));
  });

  it('shows a role changed after the token was issued', async () => {
    const { phone, user, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    await User.updateOne(
      { _id: user._id, restaurantId: restaurant._id },
      { $set: { role: ROLES.MANAGER } },
    );

    const { body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(body.data.user.role, ROLES.MANAGER, 'the database wins, not the token claim');
  });

  it('rejects a deactivated user holding a still-valid token', async () => {
    const { phone, user, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    await User.updateOne({ _id: user._id, restaurantId: restaurant._id }, { $set: { isActive: false } });

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  it('rejects a token whose restaurant was deactivated', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { Restaurant } = await import('../models/Restaurant.js');
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { isActive: false } });

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  /**
   * P31. The user and restaurant reads now run together. The checks must still
   * run in the old order, the user first: these two would pass a rewrite that
   * checked the restaurant first only if they were not here.
   */
  it('still fails on the user first when the user and the restaurant are both inactive', async () => {
    const { phone, user, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);
    const before = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(before.status, 200);

    const { Restaurant } = await import('../models/Restaurant.js');
    await User.updateOne({ _id: user._id, restaurantId: restaurant._id }, { $set: { isActive: false } });
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { isActive: false } });

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    assert.equal(body.error.message, 'Your session is not valid. Please sign in again.');
  });

  it('checks the password change before the restaurant, so a changed password with an inactive restaurant is still TOKEN_EXPIRED', async () => {
    const { phone, user, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { Restaurant } = await import('../models/Restaurant.js');
    await User.updateOne({ _id: user._id, restaurantId: restaurant._id }, { $set: { passwordChangedAt: new Date(Date.now() + 60_000) } });
    await Restaurant.updateOne({ _id: restaurant._id }, { $set: { isActive: false } });

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'TOKEN_EXPIRED');
    assert.equal(body.error.message, 'Your password changed. Please sign in again.');
  });

  it('rejects a token signed for a user that does not exist', async () => {
    const { restaurant, branch } = await seedFullRestaurant();
    const orphan = issueAccessToken({
      _id: '652f00000000000000000009',
      role: ROLES.OWNER,
      restaurantId: restaurant._id,
      branchId: branch._id,
    });

    const { status } = await request('GET', '/api/v1/auth/me', { token: orphan });
    assert.equal(status, 401);
  });
});

describe('PATCH /auth/password', () => {
  const NEW_PASSWORD = 'a different long one';

  it('changes the password, ends every session, and clears the cookie', async () => {
    const { phone, restaurant } = await seedFullRestaurant();
    const session = await signIn(phone);
    await login(phone, DEFAULT_PASSWORD);

    const response = await request('PATCH', '/api/v1/auth/password', {
      token: session.accessToken,
      body: { currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { passwordChanged: true });
    assert.equal(refreshCookie(response).value, '', 'the caller must sign in again');

    const active = await RefreshToken.countDocuments({ restaurantId: restaurant._id, revokedAt: null });
    assert.equal(active, 0, 'a change that leaves sessions alive is not a password change');

    assert.equal((await login(phone, DEFAULT_PASSWORD)).status, 401);
    assert.equal((await login(phone, NEW_PASSWORD)).status, 200);
  });

  it('rejects an access token issued before the password changed', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);

    assert.equal((await request('GET', '/api/v1/auth/me', { token: session.accessToken })).status, 200);

    await request('PATCH', '/api/v1/auth/password', {
      token: session.accessToken,
      body: { currentPassword: DEFAULT_PASSWORD, newPassword: NEW_PASSWORD },
    });

    const { status, body } = await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    assert.equal(status, 401);
    assert.equal(body.error.code, 'TOKEN_EXPIRED', 'so the client tries a refresh before giving up');
  });

  it('returns 401 for a wrong current password', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { status, body } = await request('PATCH', '/api/v1/auth/password', {
      token: session.accessToken,
      body: { currentPassword: 'not the right one', newPassword: NEW_PASSWORD },
    });

    assert.equal(status, 401);
    assert.equal(body.error.code, 'INVALID_CREDENTIALS');
  });

  it('returns 422, not 400, when the new password equals the current one', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { status, body } = await request('PATCH', '/api/v1/auth/password', {
      token: session.accessToken,
      body: { currentPassword: DEFAULT_PASSWORD, newPassword: DEFAULT_PASSWORD },
    });

    assert.equal(status, 422);
    assert.equal(body.error.code, 'BUSINESS_RULE_VIOLATED');
  });

  it('returns 400 for a new password that is too short', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);

    const { status, body } = await request('PATCH', '/api/v1/auth/password', {
      token: session.accessToken,
      body: { currentPassword: DEFAULT_PASSWORD, newPassword: 'short' },
    });

    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(body.error.fields.newPassword);
  });
});

describe('the refresh token', () => {
  it('is never in any response body this suite has seen', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);
    await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    await request('POST', '/api/v1/auth/refresh', withCookie(session.cookie));

    assert.ok(observedResponses.length > 30);

    for (const seen of observedResponses) {
      assert.equal(
        'refreshToken' in (seen.body?.data ?? {}),
        false,
        `refreshToken leaked into the body of ${seen.method} ${seen.path}`,
      );
    }
  });
});

describe('passwordHash', () => {
  it('never appears in any response this suite has seen', async () => {
    const { phone } = await seedFullRestaurant();
    const session = await signIn(phone);
    await request('GET', '/api/v1/auth/me', { token: session.accessToken });
    await request('GET', '/api/v1/restaurant', { token: session.accessToken });
    await request('GET', '/api/v1/branches', { token: session.accessToken });

    assert.ok(observedResponses.length > 30, 'the suite should have exercised plenty of endpoints');

    for (const seen of observedResponses) {
      const serialised = JSON.stringify(seen.body);
      assert.equal(
        serialised.includes('passwordHash'),
        false,
        `passwordHash leaked from ${seen.method} ${seen.path}`,
      );
      assert.equal(
        /\$2[aby]\$/.test(serialised),
        false,
        `a bcrypt hash leaked from ${seen.method} ${seen.path}`,
      );
    }
  });
});
