/**
 * The refresh-token cookie, in one place.
 *
 * The raw refresh token used to travel in the response body, where any script
 * on the page could read it, so one XSS hole handed over a 30-day credential.
 * It is now an httpOnly cookie: unreadable by JavaScript, sent by the browser
 * only to the auth endpoints, and cleared the moment a session ends.
 *
 * Express `res.cookie` / `res.clearCookie` are built in and need no
 * cookie-parser. Reading the incoming cookie is a three-line parse of the one
 * header, so no dependency is added for that either.
 */
import { isBox } from '../config/deployment.js';
import { refreshTokenTtlMs } from '../services/tokenService.js';

export const REFRESH_COOKIE_NAME = 'refreshToken';

/**
 * Scoped to the auth routes. The browser sends the cookie to
 * `/api/v1/auth/refresh` and `/api/v1/auth/logout` and to nothing else, so a
 * `/api/v1/menu` request never carries a 30-day credential.
 */
const COOKIE_PATH = '/api/v1/auth';

/**
 * `secure` is always on. `http://localhost` is a secure context, so the cookie
 * still works in local development; production is https. `sameSite: 'lax'` is
 * one half of the CSRF defence, the `X-Requested-With` check in
 * middleware/requireCsrfHeader.js is the other.
 */
const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: COOKIE_PATH,
});

/**
 * P62. The one exception to "always Secure": the cafe box, reached over the
 * LAN as plain http://192.168.x.x. A browser drops a Secure cookie set by a
 * non-secure page that is not localhost, so every tablet would be signed out
 * on its next reload. On the box, over http only, the cookie is not Secure;
 * still httpOnly, still SameSite=Lax, still scoped to the auth paths, and
 * still behind the X-Requested-With check. Over https it is Secure as ever.
 * docs/REPLICATION.md section 10 says what this trades and how to put the box
 * on https instead.
 */
function optionsFor(res) {
  const plainHttpOnBox = isBox() && res?.req && !res.req.secure;
  return plainHttpOnBox ? { ...COOKIE_OPTIONS, secure: false } : COOKIE_OPTIONS;
}

export function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, { ...optionsFor(res), maxAge: refreshTokenTtlMs() });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, optionsFor(res));
}

/** Pulls the refresh token out of the Cookie header, or null. */
export function readRefreshCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
