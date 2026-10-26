/**
 * The box's own network notes, in a file on the box. P62 network additions.
 *
 * The staff WiFi's name and password, for the setup card the manager prints.
 * In a file under BOX_DATA_DIR, not in the database: it describes this box's
 * room, it must not ship to the cloud copy, and a box restored elsewhere is in
 * another room. Readable by OWNER and MANAGER only, never on the public page.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from '../../config/env.js';
import { nowUtc } from '../../utils/time.js';

const fileFor = (dir) => path.join(dir, 'network.json');

let testDir = null;
const defaultDir = () => testDir ?? config.BOX_DATA_DIR;

/** Tests only: keep the file in a temporary folder instead of the box's data folder. */
export function setNetworkDirForTest(dir) {
  if (!config.isTest) throw new Error('Only tests may move the network notes.');
  testDir = dir;
}

export async function readNetworkNotes(dir = defaultDir()) {
  try {
    const parsed = JSON.parse(await readFile(fileFor(dir), 'utf8'));
    return { staffWifi: parsed.staffWifi ?? null, updatedAt: parsed.updatedAt ?? null };
  } catch {
    return { staffWifi: null, updatedAt: null };
  }
}

/** Saves the staff WiFi. Written to a temporary file and renamed, so a power cut never leaves half a file. */
export async function saveStaffWifi({ ssid, password }, dir = defaultDir()) {
  await mkdir(dir, { recursive: true });
  const notes = { staffWifi: { ssid: String(ssid).trim(), password: password ? String(password) : '' }, updatedAt: nowUtc().toISOString() };
  const temp = `${fileFor(dir)}.tmp`;
  await writeFile(temp, JSON.stringify(notes, null, 2), { mode: 0o600 });
  await rename(temp, fileFor(dir));
  return notes;
}
