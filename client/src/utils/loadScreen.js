/**
 * Loads a lazy screen's code, and reloads the page once when it cannot.
 *
 * 2026-10-18. A screen away from service arrives as its own file (P32). After
 * a deploy that file has a new name, and a tablet left open still asks for the
 * old one: Vercel answers with the app's page instead, the import fails, and
 * the screen went blank. Reloading fetches the new names. Once only, within
 * ten seconds, so a device that is offline sees ScreenErrorBoundary's message
 * instead of reloading forever.
 */
const RELOADED_AT = 'screen-code-reloaded-at';
const ONCE_WITHIN_MS = 10_000;

function lastReload() {
  try {
    return Number(window.sessionStorage.getItem(RELOADED_AT)) || 0;
  } catch {
    return 0;
  }
}

export function loadScreen(load) {
  return load().catch((error) => {
    if (Date.now() - lastReload() < ONCE_WITHIN_MS) throw error;
    try {
      window.sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {
      throw error;
    }
    window.location.reload();
    // The page is going away; never settle, so nothing draws in between.
    return new Promise(() => {});
  });
}
