/**
 * The cafe network. P62, API-CONTRACT P62 section 4.
 *
 * `ping` and `setup` go straight to fetch, not through the API client: they
 * must work with no session, must never trigger a token refresh, and a ping
 * that waits for a retry would measure the retry, not the link.
 */
import { API_BASE_URL, api } from './client.js';

/** One round trip to the server, in milliseconds, or null when it did not answer in time. */
export async function pingServer(timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${API_BASE_URL}/network/ping`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return null;
    await response.text();
    return Math.round(performance.now() - started);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /network/setup. No sign-in: the address to open and the WiFi to join. */
export async function getNetworkSetup() {
  const response = await fetch(`${API_BASE_URL}/network/setup`, { cache: 'no-store' });
  if (!response.ok) throw new Error('The server did not answer.');
  return (await response.json()).data;
}

/** POST /network/report. Any signed-in person. */
export function reportLink(body) {
  return api.post('/network/report', body);
}

/** GET /network/self. Any signed-in person. */
export function getNetworkSelf() {
  return api.get('/network/self');
}

/** GET /network/status. OWNER and MANAGER. */
export function getNetworkStatus() {
  return api.get('/network/status');
}

/** GET /network/wifi/networks. OWNER, on the box. */
export function getWifiNetworks() {
  return api.get('/network/wifi/networks');
}

/** POST /network/wifi/connect. OWNER, on the box. */
export function connectWifi(body) {
  return api.post('/network/wifi/connect', body);
}

/** PUT /network/staff-wifi. OWNER and MANAGER: what the setup card prints. */
export function saveStaffWifi(body) {
  return api.put('/network/staff-wifi', body);
}
