/**
 * The local snapshot. P62 section 4.2, docs/REPLICATION.md section 9.
 *
 * `mongodump --oplog` of the whole box, gzipped into one archive, on the
 * box's own disk. Always with --oplog: without it collections are read at
 * different moments, and a dump can hold a bill whose payment is missing.
 * Always restored with --oplogReplay.
 *
 * Kept: hourly for a day, daily for a month, monthly for a year. The
 * off-site copy is P54's, to Backblaze, independent of this and of the
 * shipper. Atlas's own backups are a third layer, not a substitute.
 *
 * Run every hour by the box's systemd timer (box/systemd/cafezza-snapshot.timer),
 * not by the server, so a server that is down still gets its snapshot.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { nowUtc } from '../../utils/time.js';

export const KEEP = Object.freeze({ hourly: 24, daily: 31, monthly: 12 });

const pad = (number) => String(number).padStart(2, '0');
const stampOf = (at) => `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}-${pad(at.getUTCMinutes())}Z`;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${file} failed: ${String(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`;
        reject(error);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

/** Which tiers this moment's snapshot belongs to: always hourly, the first of a day daily, the first of a month monthly. */
export async function tiersFor(dir, at) {
  const tiers = ['hourly'];
  const day = stampOf(at).slice(0, 10);
  const month = day.slice(0, 7);
  const has = async (tier, prefix) => (await listArchives(dir, tier)).some((name) => name.startsWith(prefix));
  if (!(await has('daily', day))) tiers.push('daily');
  if (!(await has('monthly', month))) tiers.push('monthly');
  return tiers;
}

export async function listArchives(dir, tier) {
  try {
    return (await readdir(path.join(dir, tier))).filter((name) => name.endsWith('.archive.gz')).sort();
  } catch {
    return [];
  }
}

/** Takes one snapshot into each tier it belongs to, then trims each tier. Gives back the files written. */
export async function takeSnapshot({ uri, dir, at = nowUtc(), mongodump = 'mongodump' }) {
  const tiers = await tiersFor(dir, at);
  const name = `${stampOf(at)}.archive.gz`;
  const first = path.join(dir, tiers[0], name);
  await mkdir(path.dirname(first), { recursive: true });
  await run(mongodump, [`--uri=${uri}`, '--oplog', '--gzip', `--archive=${first}`]);
  const written = [first];
  for (const tier of tiers.slice(1)) {
    const target = path.join(dir, tier, name);
    await mkdir(path.dirname(target), { recursive: true });
    await run(process.platform === 'win32' ? 'cmd' : 'cp', process.platform === 'win32' ? ['/c', 'copy', first, target] : [first, target]);
    written.push(target);
  }
  for (const tier of Object.keys(KEEP)) {
    const archives = await listArchives(dir, tier);
    for (const old of archives.slice(0, Math.max(archives.length - KEEP[tier], 0))) await rm(path.join(dir, tier, old), { force: true });
  }
  return written;
}

/** Restores an archive into an empty server, replaying the oplog the dump captured. */
export async function restoreSnapshot({ uri, archive, mongorestore = 'mongorestore' }) {
  await run(mongorestore, [`--uri=${uri}`, '--oplogReplay', '--gzip', `--archive=${archive}`, '--drop']);
}

/** Bytes kept, per tier, for the status line. */
export async function snapshotUsage(dir) {
  const usage = {};
  for (const tier of Object.keys(KEEP)) {
    let bytes = 0;
    const archives = await listArchives(dir, tier);
    for (const name of archives) bytes += (await stat(path.join(dir, tier, name))).size;
    usage[tier] = { count: archives.length, bytes, newest: archives.at(-1) ?? null };
  }
  return usage;
}
