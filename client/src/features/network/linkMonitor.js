/**
 * This device's link to the cafe server. P62 sections 7 and the network additions.
 *
 * One monitor per browser tab, whatever screens are open. Every 5 seconds it
 * pings the server and keeps the last twelve answers; its state is what the
 * top bar draws:
 *
 *   CONNECTED      the last ping answered
 *   RECONNECTING   one or two pings in a row went unanswered
 *   UNREACHABLE    three in a row: "Cannot reach server", an alert
 *
 * Every 15 seconds, while someone is signed in, it tells the server its pings,
 * so the owner sees every device's strength on the dashboard.
 *
 * When it can reach the server it remembers the address to open and the WiFi
 * to join (`/network/setup`), so that when it cannot, it can still say where
 * to go. The device's own id and name live beside it in localStorage. Nothing
 * here is secret: no password is ever stored.
 */
import { getNetworkSetup, pingServer, reportLink } from '../../api/network.js';
import { linkQuality } from '../../utils/linkQuality.js';

export const PING_EVERY_MS = 5_000;
export const REPORT_EVERY_MS = 15_000;
const UNREACHABLE_AFTER_MISSES = 3;
const SETUP_KEY = 'pos.network.setup';
const DEVICE_KEY = 'pos.network.device';

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the device simply forgets, and asks again next time.
  }
};

/** This device's id, made once, and the name a manager gave it. */
export function deviceIdentity() {
  let identity = read(DEVICE_KEY);
  if (!identity?.id) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    identity = { id: `device-${random}`, name: '' };
    write(DEVICE_KEY, identity);
  }
  return identity;
}

export function setDeviceName(name) {
  write(DEVICE_KEY, { ...deviceIdentity(), name: String(name ?? '').trim().slice(0, 40) });
  notify();
}

/** Where to go when this device is lost: remembered from the last time it could ask. */
export function rememberedSetup() {
  return read(SETUP_KEY);
}

let state = {
  status: 'CONNECTED',
  quality: linkQuality([]),
  samples: [],
  misses: 0,
  lastAnsweredAt: null,
};
const listeners = new Set();
let pingTimer = null;
let signedIn = false;

function notify() {
  for (const listener of listeners) listener();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const snapshot = () => state;

/** The address and WiFi are asked again this often, so a box that moved WiFi is followed. */
const SETUP_REFRESH_MS = 5 * 60_000;

async function pingOnce() {
  const wasConnected = state.status === 'CONNECTED' && state.samples.length > 0;
  const ms = await pingServer();
  const samples = [...state.samples, ms].slice(-12);
  const misses = ms === null ? state.misses + 1 : 0;
  let status = 'CONNECTED';
  if (misses >= UNREACHABLE_AFTER_MISSES) status = 'UNREACHABLE';
  else if (misses > 0) status = 'RECONNECTING';
  state = { status, quality: linkQuality(samples), samples, misses, lastAnsweredAt: ms === null ? state.lastAnsweredAt : Date.now() };
  notify();
  // The first answer, coming back after being lost, or every few minutes: learn where we are again.
  const saved = rememberedSetup();
  const stale = !saved?.at || Date.now() - saved.at > SETUP_REFRESH_MS;
  if (ms !== null && (stale || !wasConnected)) {
    getNetworkSetup().then((setup) => write(SETUP_KEY, { ...setup, at: Date.now() })).catch(() => {});
  }
}

async function reportOnce() {
  if (!signedIn || state.samples.length === 0 || state.status === 'UNREACHABLE') return;
  const connection = navigator.connection ?? null;
  const identity = deviceIdentity();
  try {
    await reportLink({
      deviceId: identity.id,
      ...(identity.name ? { deviceName: identity.name } : {}),
      page: window.location.pathname.slice(0, 60),
      pingsMs: state.samples,
      ...(connection?.effectiveType ? { effectiveType: String(connection.effectiveType).slice(0, 10) } : {}),
      ...(Number.isFinite(connection?.downlink) ? { downlinkMbps: connection.downlink } : {}),
    });
  } catch {
    // A missed report is a missed dot on the owner's list, never an error for the person holding the tablet.
  }
}

/** Starts the monitor once per tab. Safe to call from every screen. */
export function startLinkMonitor() {
  if (pingTimer) return;
  pingOnce();
  pingTimer = setInterval(pingOnce, PING_EVERY_MS);
  setInterval(reportOnce, REPORT_EVERY_MS);
}

export function setSignedIn(value) {
  signedIn = Boolean(value);
}
