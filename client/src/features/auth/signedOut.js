/**
 * Who just signed out on this tab, so the sign-in screen can say goodbye once.
 *
 * Only the first name, only in this tab's session storage, and cleared as soon
 * as the sign-in screen has read it. Storage can be refused in a private
 * window; then there is simply no goodbye.
 */
const KEY = 'signed-out-name';

export function rememberSignedOut(fullName) {
  try {
    window.sessionStorage.setItem(KEY, String(fullName ?? '').trim().split(/\s+/)[0] ?? '');
  } catch {
    // No goodbye, nothing else lost.
  }
}

/** The name, or '' for a sign-out without one, or null when nobody just signed out. */
export function readSignedOut() {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetSignedOut() {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
