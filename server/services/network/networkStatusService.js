/**
 * What the dashboard and every device's top bar show about the network and the
 * cloud copy. P62 sections 7 and the network additions.
 *
 *   self    for any signed-in person: is this server the writer, is its clock
 *           right, is the cloud copy keeping up. Staff see "Synced" or
 *           "12 waiting to upload"; only OWNER and MANAGER see the backup
 *           alert, the reconciliation result and the reason.
 *   status  for OWNER and MANAGER: the box's WiFi and addresses, the staff
 *           setup details, every connected device with its strength, and the
 *           whole sync picture.
 *   setup   for anyone, no sign-in: the address to open and the WiFi to join,
 *           never a password. The /connect page and a lost tablet read this.
 */
import { hostname } from 'node:os';

import { config } from '../../config/env.js';
import { currentRole, ROLES } from '../../config/deployment.js';
import { ROLES as STAFF_ROLES } from '../../config/roles.js';
import { REPLICATION_STATE_IDS, ReplicationState } from '../../models/ReplicationState.js';
import { nowUtc } from '../../utils/time.js';
import { clockSnapshot } from '../replication/clockGuard.js';
import { mirrorPosition } from '../replication/receiver.js';
import { shippingLag } from '../replication/shipper.js';
import { writerSnapshot } from '../replication/writerState.js';
import { listDevices } from './devicePresence.js';
import { readNetworkNotes } from './networkStore.js';
import { lanAddresses, wifiStatus } from './wifiService.js';

/** Past this, "not synced" is a backup problem the owner must see. P62 section 7. */
export const NOT_SYNCED_ALERT_AFTER_SECONDS = 3 * 60 * 60;
/** Past this, the mirror's figures carry a warning beside their "as of". */
export const MIRROR_FIGURES_STALE_AFTER_SECONDS = 15 * 60;

const MANAGERS = new Set([STAFF_ROLES.OWNER, STAFF_ROLES.MANAGER]);

/** The sync state in one word the top bar can draw. */
export function syncState(lag, { shipping }) {
  if (!shipping) return 'LOCAL_ONLY';
  if (lag.entriesWaiting === 0) return 'SYNCED';
  if (lag.secondsBehind >= NOT_SYNCED_ALERT_AFTER_SECONDS) return 'NOT_SYNCED';
  return 'WAITING';
}

async function boxSync(restaurantId) {
  const shipping = Boolean(config.MIRROR_URL && config.REPLICATION_SECRET);
  const lag = await shippingLag(restaurantId);
  const reconcile = await ReplicationState.findById(REPLICATION_STATE_IDS.reconcile(restaurantId)).lean();
  return {
    state: syncState(lag, { shipping }),
    entriesWaiting: lag.entriesWaiting,
    secondsBehind: lag.secondsBehind,
    syncedThrough: lag.syncedThrough,
    lastError: lag.lastError,
    lastErrorAt: lag.lastErrorAt,
    reconcile: reconcile ? { status: reconcile.status, checkedAt: reconcile.checkedAt, mismatches: reconcile.mismatches ?? [] } : null,
  };
}

async function mirrorSync(restaurantId) {
  const position = await mirrorPosition(restaurantId);
  const ageSeconds = position.figuresAsOf ? Math.max(Math.round((nowUtc().getTime() - new Date(position.figuresAsOf).getTime()) / 1000), 0) : null;
  return {
    state: position.gap ? 'GAP' : 'MIRROR',
    figuresAsOf: position.figuresAsOf,
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > MIRROR_FIGURES_STALE_AFTER_SECONDS,
    gap: position.gap,
  };
}

/** For every signed-in person. */
export async function selfStatus(req) {
  const role = currentRole();
  const writer = writerSnapshot();
  const manager = MANAGERS.has(req.user?.role);
  const view = {
    role,
    serverTime: nowUtc(),
    writer: { epoch: writer.epoch, fenced: writer.fenced, readOnly: role === ROLES.MIRROR && !writer.promoted, promoted: writer.promoted },
    clock: { refusing: role === ROLES.BOX && clockSnapshot().refusing },
    sync: null,
  };
  if (role === ROLES.BOX) {
    const sync = await boxSync(req.restaurantId);
    view.sync = manager
      ? sync
      : { state: sync.state === 'NOT_SYNCED' ? 'WAITING' : sync.state, entriesWaiting: sync.entriesWaiting };
  } else if (role === ROLES.MIRROR) {
    view.sync = await mirrorSync(req.restaurantId);
  }
  return view;
}

/** 10.x, 172.16-31.x and 192.168.x: the addresses a cafe router hands out. */
export function isPrivateLan(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** WiFi and wired adapters first, then anything else; never VPNs, Docker or link-local. */
const ADAPTER_RANK = [/^(en|eth|wlan|wlp|wl|enp|eno)/i, /^(Wi-?Fi|Ethernet)/i];
const rankOf = (name) => {
  const found = ADAPTER_RANK.findIndex((pattern) => pattern.test(name));
  return found === -1 ? ADAPTER_RANK.length : found;
};

/**
 * The addresses staff open, worked out from the network the box is on right
 * now. P62. When the box joins another WiFi its address changes with it, so
 * nothing has to be edited: the setup card, its QR code and the "Cannot reach
 * server" banner follow by themselves. BOX_PUBLIC_URL and BOX_LOCAL_NAME_URL
 * still win when set, for a box whose router reserves it a fixed address.
 */
export function lanUrls({ port = config.PORT, addresses = lanAddresses(), host = hostname(), fixedUrl = config.BOX_PUBLIC_URL, fixedName = config.BOX_LOCAL_NAME_URL } = {}) {
  const portPart = Number(port) === 80 ? '' : `:${port}`;
  const candidates = addresses
    .filter((entry) => isPrivateLan(entry.address))
    .sort((a, b) => rankOf(a.interface) - rankOf(b.interface) || a.interface.localeCompare(b.interface));
  const found = candidates.map((entry) => `http://${entry.address}${portPart}`);
  const boxUrl = fixedUrl ?? found[0] ?? null;
  const name = String(host ?? '').replace(/\.local$/i, '');
  const localNameUrl = fixedName ?? (name ? `http://${name}.local${portPart}` : null);
  return { boxUrl, localNameUrl, otherUrls: found.filter((url) => url !== boxUrl), addressFixed: Boolean(fixedUrl) };
}

function urls() {
  return lanUrls();
}

/** For OWNER and MANAGER: everything the network card shows. */
export async function fullStatus(req) {
  const [self, notes, box] = await Promise.all([selfStatus(req), readNetworkNotes(), currentRole() === ROLES.BOX ? wifiStatus() : null]);
  return {
    ...self,
    box,
    ...urls(),
    staffWifi: notes.staffWifi,
    devices: listDevices(req.restaurantId),
  };
}

/** For anyone. No password, ever. */
export async function publicSetup() {
  const notes = await readNetworkNotes();
  // The WiFi the box is on now wins over the saved note, which may be from before a move.
  const live = currentRole() === ROLES.BOX ? (await wifiStatus()).ssid : null;
  return { role: currentRole(), ...urls(), wifiName: live ?? notes.staffWifi?.ssid ?? null };
}
