/**
 * The cafe network: the box's WiFi, the devices on it, the cloud copy. P62.
 * API-CONTRACT P62 section 4.
 */
import { isBox } from '../config/deployment.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../models/AuditLog.js';
import { recordAudit } from '../services/auditService.js';
import { recordReport } from '../services/network/devicePresence.js';
import { fullStatus, publicSetup, selfStatus } from '../services/network/networkStatusService.js';
import { saveStaffWifi } from '../services/network/networkStore.js';
import { connectToWifi, listNetworks, wifiStatus } from '../services/network/wifiService.js';
import { NotFoundError } from '../utils/errors.js';
import { sendSuccess } from '../utils/response.js';

/** GET /network/ping. No sign-in, no database: the device's round trip to this server. */
export function getPing(_req, res) {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true });
}

/** GET /network/setup. No sign-in: the address to open and the WiFi to join. Never a password. */
export async function getSetup(_req, res) {
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, await publicSetup());
}

/** POST /network/report. Any signed-in person: this device's pings to the box. */
export function postReport(req, res) {
  const entry = recordReport(req, req.body);
  return sendSuccess(res, { bars: entry.bars, word: entry.word });
}

/** GET /network/self. Any signed-in person. */
export async function getSelf(req, res) {
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, await selfStatus(req));
}

/** GET /network/status. OWNER and MANAGER. */
export async function getStatus(req, res) {
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, await fullStatus(req));
}

/** GET /network/wifi/networks. OWNER. The box only. */
export async function getNetworks(_req, res) {
  if (!isBox()) throw new NotFoundError();
  return sendSuccess(res, { networks: await listNetworks() });
}

/** POST /network/wifi/connect. OWNER. The box only. Audited, never with the password. */
export async function postConnect(req, res) {
  if (!isBox()) throw new NotFoundError();
  const before = await wifiStatus();
  const after = await connectToWifi(req.body.ssid, req.body.password);
  await saveStaffWifi({ ssid: req.body.ssid, password: req.body.password });
  await recordAudit(req, {
    action: AUDIT_ACTIONS.BOX_WIFI_CHANGED,
    entityType: AUDIT_ENTITY_TYPES.SETTINGS,
    entityId: req.restaurantId,
    entityLabel: `WiFi ${req.body.ssid}`.slice(0, 100),
    reason: `Moved the cafe server from ${before.ssid ?? 'no WiFi'} to ${req.body.ssid}.`,
    details: { from: before.ssid ?? null, to: req.body.ssid },
  });
  return sendSuccess(res, { box: after });
}

/** PUT /network/staff-wifi. OWNER and MANAGER. What the setup card prints. */
export async function putStaffWifi(req, res) {
  const notes = await saveStaffWifi(req.body);
  return sendSuccess(res, { staffWifi: notes.staffWifi });
}
