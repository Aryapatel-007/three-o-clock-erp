/**
 * The server itself. P30, API-CONTRACT P30.
 */
import { API_BASE_URL, api } from './client.js';
import { beginWaiting, endWaiting } from './serverWaking.js';

const WAKE_URL = `${API_BASE_URL}/wake`;

/** One call of the wake address. True when our server answered. */
async function wakeOnce(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(WAKE_URL, { cache: 'no-store', signal: controller.signal });
    // Our own JSON, even a 429, means the server is awake. Render's waking page,
    // or a 502 to 504 from the forwarding, does not.
    return /application\/json/i.test(response.headers.get('content-type') ?? '');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The heartbeat's ping. A failure is ignored: it is a hint, not a feature. */
export function pingWake() {
  return wakeOnce(30_000).catch(() => false);
}

/**
 * On first load, before the sign-in screen: if the server has not answered in
 * 2 seconds, the bar says it is starting, and the check keeps trying, every
 * 5 seconds, until it answers.
 */
export async function watchServerOnLoad() {
  let answered = false;
  let showing = false;
  const reveal = setTimeout(() => {
    if (answered) return;
    showing = true;
    beginWaiting();
  }, 2_000);

  try {
    for (;;) {
      if (await wakeOnce(30_000)) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  } finally {
    answered = true;
    clearTimeout(reveal);
    if (showing) endWaiting();
  }
}

/** GET /system/starts. OWNER only. */
export function getServerStarts(days = 7) {
  return api.get(`/system/starts?days=${days}`);
}

/** GET /system/backups. OWNER only. P54. */
export function getServerBackups() {
  return api.get('/system/backups');
}

/** GET /system/printers. The restaurant PC's installed printers. OWNER, MANAGER, CASHIER. 2026-11-03. */
export function listInstalledPrinters() {
  return api.get('/system/printers');
}
