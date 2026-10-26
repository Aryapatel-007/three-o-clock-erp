/**
 * Which devices are connected to the cafe box, and how well. P62 network additions.
 *
 * Each signed-in device reports every 15 seconds: its own id and name, and its
 * last pings to the box. The box keeps the latest report per device in memory,
 * per restaurant. Nothing is written to the database: this is the room as it
 * is now, it means nothing after a restart, and a tablet writing a row every
 * 15 seconds would be most of the changelog.
 *
 * A device that has not reported for 45 seconds is shown as not connected,
 * and after 10 minutes it is forgotten.
 */
import { nowUtc } from '../../utils/time.js';
import { linkQuality } from './linkQuality.js';

export const SEEN_RECENTLY_MS = 45_000;
export const FORGET_AFTER_MS = 10 * 60_000;
const MAX_DEVICES_PER_RESTAURANT = 100;

const byRestaurant = new Map();

const clean = (text, limit) => String(text ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, limit);

/** A short, readable guess at the device from its user agent, used when it has no name. */
export function describeUserAgent(userAgent) {
  const ua = String(userAgent ?? '');
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

export function recordReport(req, body, now = nowUtc()) {
  const restaurantKey = String(req.restaurantId);
  let devices = byRestaurant.get(restaurantKey);
  if (!devices) {
    devices = new Map();
    byRestaurant.set(restaurantKey, devices);
  }
  const deviceId = clean(body.deviceId, 64);
  const quality = linkQuality(body.pingsMs);
  const entry = {
    deviceId,
    name: clean(body.deviceName, 40) || describeUserAgent(req.get?.('user-agent')),
    userName: req.user?.name ?? null,
    role: req.user?.role ?? null,
    address: req.ip ?? null,
    page: clean(body.page, 60) || null,
    ...quality,
    effectiveType: clean(body.effectiveType, 10) || null,
    downlinkMbps: Number.isFinite(body.downlinkMbps) ? body.downlinkMbps : null,
    lastSeenAt: now,
  };
  devices.set(deviceId, entry);
  if (devices.size > MAX_DEVICES_PER_RESTAURANT) {
    const oldest = [...devices.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    devices.delete(oldest.deviceId);
  }
  return entry;
}

/** Every device seen in the last 10 minutes, connected ones first, weakest first among them. */
export function listDevices(restaurantId, now = nowUtc()) {
  const devices = byRestaurant.get(String(restaurantId));
  if (!devices) return [];
  const list = [];
  for (const [id, entry] of devices) {
    const age = now.getTime() - entry.lastSeenAt.getTime();
    if (age > FORGET_AFTER_MS) {
      devices.delete(id);
      continue;
    }
    const connected = age <= SEEN_RECENTLY_MS;
    list.push({ ...entry, connected, secondsSinceSeen: Math.round(age / 1000), ...(connected ? {} : { bars: 0, word: 'Not connected' }) });
  }
  return list.sort((a, b) => Number(b.connected) - Number(a.connected) || a.bars - b.bars || a.name.localeCompare(b.name));
}

/** Tests only. */
export function clearDevicesForTest() {
  byRestaurant.clear();
}
