/**
 * The cafe box's own network: which WiFi it is on, how strong, its addresses,
 * and changing it. P62 network additions, docs/STAFF-SETUP.md.
 *
 * Read from the operating system's own tools, never guessed:
 *   Linux    nmcli (NetworkManager), which the box install sets up
 *   macOS    networksetup and ipconfig
 *   Windows  netsh wlan
 *
 * Every command runs with execFile (no shell), a timeout, and arguments
 * passed as a list, so a network name with spaces or quotes is just a name.
 * A box on a cable reports itself as wired, which is the recommended set-up
 * (docs/DEPLOYMENT.md section 17): a cable cannot be joined to the wrong WiFi.
 */
import { execFile } from 'node:child_process';
import { networkInterfaces, platform } from 'node:os';

import { config } from '../../config/env.js';
import { WifiChangeFailedError, WifiControlOffError, ValidationError } from '../../utils/errors.js';

const COMMAND_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 45_000;

export const WIFI_CONTROL_ON = () => config.BOX_WIFI_CONTROL === 'on';

/** Runs a command; gives back stdout, or null when the tool is missing or fails. */
function run(file, args, { timeout = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

/** Like run, but keeps the error text, for a connect whose failure the owner must read. */
function runOrExplain(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr || error?.message || '') });
    });
  });
}

/** nmcli's terse output escapes ':' and '\' inside a field. */
export function splitNmcliLine(line) {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      i += 1;
    } else if (char === ':') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Strength in words and bars from a 0-100 signal, the same scale the devices use. */
export function signalWords(percent) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return { bars: null, word: 'Unknown' };
  if (percent >= 75) return { bars: 4, word: 'Excellent' };
  if (percent >= 55) return { bars: 3, word: 'Good' };
  if (percent >= 35) return { bars: 2, word: 'Fair' };
  if (percent > 0) return { bars: 1, word: 'Weak' };
  return { bars: 0, word: 'No signal' };
}

/** dBm to an approximate percent, the way NetworkManager does. */
export const dbmToPercent = (dbm) => Math.max(0, Math.min(100, 2 * (Number(dbm) + 100)));

/** The box's IPv4 addresses on the LAN, by adapter. */
export function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push({ interface: name, address: entry.address });
    }
  }
  return found;
}

/* ------------------------------------------------------------------------- *
 * Reading parsers, exported for the tests, which feed them real tool output.
 * ------------------------------------------------------------------------- */

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` */
export function parseNmcliDevices(text) {
  return String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [device, type, state, connection] = splitNmcliLine(line);
      return { device, type, state, connection };
    });
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` */
export function parseNmcliWifiList(text) {
  const seen = new Map();
  for (const line of String(text ?? '').split('\n').filter(Boolean)) {
    const [inUse, ssid, signal, security] = splitNmcliLine(line);
    if (!ssid) continue;
    const entry = { ssid, signalPercent: Number(signal), secured: Boolean(security && security !== '--'), inUse: inUse === '*' };
    const before = seen.get(ssid);
    if (!before || entry.inUse || entry.signalPercent > before.signalPercent) seen.set(ssid, { ...entry, inUse: entry.inUse || Boolean(before?.inUse) });
  }
  return [...seen.values()].sort((a, b) => Number(b.inUse) - Number(a.inUse) || b.signalPercent - a.signalPercent);
}

/** `netsh wlan show interfaces` */
export function parseNetshInterfaces(text) {
  const value = (label) => {
    const match = String(text ?? '').match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'mi'));
    return match ? match[1].trim() : null;
  };
  const state = value('State');
  if (!state) return null;
  const signal = value('Signal');
  return {
    interface: value('Name'),
    connected: /^connected$/i.test(state),
    ssid: value('SSID'),
    signalPercent: signal ? Number(signal.replace('%', '')) : null,
  };
}

/** `netsh wlan show networks mode=bssid` */
export function parseNetshNetworks(text) {
  const networks = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const ssid = line.match(/^SSID \d+ : (.*)$/);
    if (ssid) {
      current = { ssid: ssid[1].trim(), signalPercent: 0, secured: true, inUse: false };
      if (current.ssid) networks.push(current);
      continue;
    }
    if (!current) continue;
    const auth = line.match(/^\s*Authentication\s*:\s*(.+)$/);
    if (auth) current.secured = !/^open$/i.test(auth[1].trim());
    const signal = line.match(/^\s*Signal\s*:\s*(\d+)%/);
    if (signal) current.signalPercent = Math.max(current.signalPercent, Number(signal[1]));
  }
  return networks.sort((a, b) => b.signalPercent - a.signalPercent);
}

/** `ipconfig getsummary en0` on macOS */
export function parseMacSummary(text) {
  const ssid = String(text ?? '').match(/^\s*SSID\s*:\s*(.+)$/m);
  const name = ssid ? ssid[1].trim() : null;
  // Recent macOS hides the name from a process without Location permission.
  return name && name !== '<redacted>' ? name : null;
}

/* ------------------------------------------------------------------------- *
 * Per platform
 * ------------------------------------------------------------------------- */

async function linuxStatus() {
  const devices = parseNmcliDevices(await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']));
  if (devices.length === 0) return { tool: false };
  const wifiDevice = devices.find((device) => device.type === 'wifi' && (!config.BOX_WIFI_INTERFACE || device.device === config.BOX_WIFI_INTERFACE));
  const wired = devices.some((device) => device.type === 'ethernet' && device.state === 'connected');
  let ssid = null;
  let signalPercent = null;
  if (wifiDevice?.state === 'connected') {
    const list = parseNmcliWifiList(await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no']));
    const inUse = list.find((network) => network.inUse);
    ssid = inUse?.ssid ?? wifiDevice.connection ?? null;
    signalPercent = inUse?.signalPercent ?? null;
  }
  return { tool: true, interface: wifiDevice?.device ?? null, wifiConnected: wifiDevice?.state === 'connected', ssid, signalPercent, wired };
}

async function macStatus() {
  const iface = config.BOX_WIFI_INTERFACE ?? 'en0';
  const summary = await run('ipconfig', ['getsummary', iface]);
  if (summary === null) return { tool: false };
  const ssid = parseMacSummary(summary);
  // A hidden name is still a WiFi connection: "WiFi (name hidden)" on the screen, not "Not on WiFi".
  return { tool: true, interface: iface, wifiConnected: /^\s*SSID\s*:/m.test(summary), ssid, signalPercent: null, wired: false };
}

async function windowsStatus() {
  const parsed = parseNetshInterfaces(await run('netsh', ['wlan', 'show', 'interfaces']));
  if (!parsed) return { tool: false };
  return { tool: true, interface: parsed.interface, wifiConnected: parsed.connected, ssid: parsed.connected ? parsed.ssid : null, signalPercent: parsed.signalPercent, wired: false };
}

/** What the box's WiFi is right now. Never throws. */
export async function wifiStatus() {
  const os = platform();
  let status;
  try {
    if (os === 'linux') status = await linuxStatus();
    else if (os === 'darwin') status = await macStatus();
    else if (os === 'win32') status = await windowsStatus();
    else status = { tool: false };
  } catch {
    status = { tool: false };
  }
  return {
    platform: os,
    readable: Boolean(status.tool),
    interface: status.interface ?? null,
    wifiConnected: Boolean(status.wifiConnected),
    ssid: status.ssid ?? null,
    signalPercent: Number.isFinite(status.signalPercent) ? status.signalPercent : null,
    signal: signalWords(Number.isFinite(status.signalPercent) ? status.signalPercent : null),
    wired: Boolean(status.wired),
    addresses: lanAddresses(),
    canChange: WIFI_CONTROL_ON() && (os === 'linux' || os === 'win32' || os === 'darwin'),
  };
}

/** The WiFi networks the box can see, strongest first. */
export async function listNetworks() {
  const os = platform();
  if (os === 'linux') return parseNmcliWifiList(await run('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], { timeout: 20_000 }));
  if (os === 'win32') return parseNetshNetworks(await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid']));
  return [];
}

const SSID_LIMIT = 32;
const PASSWORD_LIMIT = 63;

/**
 * Moves the box to another WiFi. Only with BOX_WIFI_CONTROL=on.
 *
 * nmcli keeps the old connection's profile, so a failed join leaves the box
 * where it was, and it tries the old one again by itself. The caller warns the
 * owner first: every tablet has to move to the same WiFi, or nothing can
 * reach the till.
 */
export async function connectToWifi(ssid, password) {
  if (!WIFI_CONTROL_ON()) throw new WifiControlOffError();
  const name = String(ssid ?? '').trim();
  if (!name || name.length > SSID_LIMIT) throw new ValidationError('Choose a WiFi name.', { ssid: `Between 1 and ${SSID_LIMIT} characters.` });
  if (password && String(password).length > PASSWORD_LIMIT) throw new ValidationError('That password is too long.', { password: `At most ${PASSWORD_LIMIT} characters.` });

  const os = platform();
  let outcome;
  if (os === 'linux') {
    const args = ['device', 'wifi', 'connect', name];
    if (password) args.push('password', String(password));
    if (config.BOX_WIFI_INTERFACE) args.push('ifname', config.BOX_WIFI_INTERFACE);
    outcome = await runOrExplain('nmcli', args, CONNECT_TIMEOUT_MS);
  } else if (os === 'darwin') {
    const args = ['-setairportnetwork', config.BOX_WIFI_INTERFACE ?? 'en0', name];
    if (password) args.push(String(password));
    outcome = await runOrExplain('networksetup', args, CONNECT_TIMEOUT_MS);
    if (outcome.ok && /could not|error/i.test(outcome.out)) outcome.ok = false;
  } else if (os === 'win32') {
    // Windows joins only a network it has a profile for: one made once by hand on the box.
    outcome = await runOrExplain('netsh', ['wlan', 'connect', `name=${name}`], CONNECT_TIMEOUT_MS);
  } else {
    throw new WifiControlOffError('This server cannot change its WiFi from here.');
  }
  if (!outcome.ok) throw new WifiChangeFailedError();
  return wifiStatus();
}
