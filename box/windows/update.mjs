/**
 * Dakaar updater for the cafe's Windows PC. P62, docs/WINDOWS-INSTALL.md section 6.
 *
 *   node box\windows\update.mjs check      is there a newer version? changes nothing
 *   node box\windows\update.mjs run        what the "Dakaar Update" task runs every
 *                                          15 minutes: acts only inside UPDATE_WINDOW
 *                                          and only while UPDATE_AUTO is on
 *   node box\windows\update.mjs now        apply the newest version now (outside service)
 *   node box\windows\update.mjs rollback   put the version before the last update back
 *
 * A version is a GitHub release made by `bash box/windows/make-package.sh --publish`:
 * Dakaar.zip and manifest.json, the manifest signed with the release key. This PC
 * trusts only a manifest signed by the key in box\windows\release-public-key.pem of
 * the version it is running, so a GitHub account alone cannot push code onto it.
 *
 * Applying one: download and check the zip, snapshot the database, stop the server,
 * move the running version aside to data\updates\previous, put the new one in place,
 * npm ci, build the indexes, start the server and wait for it to say it is the new
 * version with its database connected. Anything failing after the server stopped puts
 * the previous version back, with its own packages, and starts it again. The database
 * is never restored by this: schema changes are additive, so the old code reads it.
 *
 * Built-in modules only: npm ci replaces node_modules while this runs.
 */
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What stays where it is when one version replaces another. */
export const KEEP = new Set(['data', '.env']);
export const SERVER_TASK = 'Dakaar Server';
const DEFAULT_WINDOW = '04:00-05:00';
const HEALTH_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Settings (.env)

/** Reads KEY=value lines. Comments and blank lines are skipped; no quoting rules. */
export function parseEnvText(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

/** Sets one key, replacing its line or adding one at the end. Keeps every other line. */
export function setEnvValue(text, key, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (at >= 0) {
    lines[at] = `${key}=${value}`;
  } else {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  return lines.join(eol);
}

/** "04:00-05:00" as minutes past midnight. A window may cross midnight ("23:30-01:00"). */
export function parseWindow(text) {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) throw new Error(`UPDATE_WINDOW must look like ${DEFAULT_WINDOW}, not "${text}".`);
  const [h1, m1, h2, m2] = match.slice(1).map(Number);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new Error(`UPDATE_WINDOW has an impossible time: "${text}".`);
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  if (start === end) throw new Error('UPDATE_WINDOW starts and ends at the same time.');
  return { start, end };
}

/** Whether a moment is inside the window, in this PC's own clock (the cafe's time). */
export function inWindow(date, window) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return window.start < window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end;
}

// ---------------------------------------------------------------------------
// Versions and the signed manifest

/**
 * A manifest is { payload, signature }: payload is the JSON text that was signed,
 * so it is verified exactly as written and only then read.
 */
export function verifyManifest(manifestText, publicKeyPem) {
  let outer;
  try {
    outer = JSON.parse(manifestText);
  } catch {
    throw new Error('The release manifest is not JSON.');
  }
  if (typeof outer?.payload !== 'string' || typeof outer?.signature !== 'string') {
    throw new Error('The release manifest has no payload or signature.');
  }
  const key = createPublicKey(publicKeyPem);
  const good = verify(null, Buffer.from(outer.payload, 'utf8'), key, Buffer.from(outer.signature, 'base64'));
  if (!good) throw new Error('The release manifest is not signed by this PC\'s release key. Not installing it.');
  const payload = JSON.parse(outer.payload);
  for (const field of ['commit', 'builtAt', 'sha256', 'size', 'asset']) {
    if (payload[field] === undefined || payload[field] === null) throw new Error(`The release manifest has no ${field}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(payload.sha256)) throw new Error('The release manifest\'s checksum is malformed.');
  if (Number.isNaN(Date.parse(payload.builtAt))) throw new Error('The release manifest\'s build time is malformed.');
  return payload;
}

/** What this PC runs: VERSION.json from the package, else the older VERSION.txt. */
export async function readInstalled(root) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, 'VERSION.json'), 'utf8'));
    return { commit: parsed.commit ?? null, builtAt: parsed.builtAt ?? null };
  } catch {
    // fall through
  }
  try {
    const commit = (await fs.readFile(path.join(root, 'VERSION.txt'), 'utf8')).trim();
    return { commit: commit || null, builtAt: null };
  } catch {
    return { commit: null, builtAt: null };
  }
}

/**
 * newer, same or older. By build time, so a release re-marked "latest" on GitHub
 * can never move this PC back to an older signed version.
 */
export function compareVersions(installed, payload) {
  if (installed.commit && installed.commit === payload.commit) return 'same';
  if (!installed.builtAt) return 'newer';
  return Date.parse(payload.builtAt) > Date.parse(installed.builtAt) ? 'newer' : 'older';
}

// ---------------------------------------------------------------------------
// GitHub

function githubHeaders(token, accept) {
  const headers = { Accept: accept, 'User-Agent': 'cafe-pos-updater', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The newest release's manifest and zip. A private repository needs a read-only token. */
export async function findLatestRelease({ repo, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('UPDATE_REPO must be owner/name, for example Aryapatel-007/three-o-clock-erp.');
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(token, 'application/vnd.github+json'),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    throw new Error(token
      ? `No release found in ${repo}, or UPDATE_TOKEN cannot read it.`
      : `No release found in ${repo}. A private repository needs UPDATE_TOKEN in .env.`);
  }
  if (response.status === 401) throw new Error('GitHub refused UPDATE_TOKEN: it is wrong or has expired.');
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for the latest release.`);
  const release = await response.json();
  const manifest = release.assets?.find((asset) => asset.name === 'manifest.json');
  if (!manifest) throw new Error(`Release ${release.tag_name} has no manifest.json.`);
  return { tag: release.tag_name, manifestUrl: manifest.url, assets: release.assets };
}

async function downloadAsset({ url, token, dest, fetchImpl = fetch }) {
  // The API answers with a redirect to storage; fetch drops Authorization on the way.
  const response = await fetchImpl(url, {
    headers: githubHeaders(token, 'application/octet-stream'),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`Downloading ${path.basename(dest)} failed: ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// Swapping one version for another

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** rename, tried a few times: Windows refuses while anything still holds a file open. */
async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 1000 * attempt); });
    }
  }
}

/**
 * Moves every top-level entry of `from` into `to`, except those in `keep`. All or
 * nothing: if one move fails, the ones already moved go back before it throws.
 */
export async function moveEntries(from, to, keep = new Set()) {
  await fs.mkdir(to, { recursive: true });
  const names = (await fs.readdir(from)).filter((name) => !keep.has(name));
  const moved = [];
  try {
    for (const name of names) {
      if (await exists(path.join(to, name))) throw new Error(`${path.join(to, name)} is in the way.`);
      await renameWithRetry(path.join(from, name), path.join(to, name));
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse()) {
      await renameWithRetry(path.join(to, name), path.join(from, name)).catch(() => {});
    }
    throw error;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Steps that touch Windows, the database and the server. Replaced in tests.

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        const tail = `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-8).join('\n');
        reject(new Error(`${path.basename(command)} ${args.join(' ')} failed${tail ? `:\n${tail}` : '.'}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function npm(root, args) {
  // execFile cannot start npm.cmd directly since Node 20.12; cmd.exe can.
  return process.platform === 'win32'
    ? run('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: root })
    : run('npm', args, { cwd: root });
}

function powershell(command) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command]);
}

/** The snapshot reads the whole server with --oplog, so its address names no database. */
export function serverWideUri(mongoUri) {
  const url = new URL(mongoUri);
  url.pathname = '/';
  return url.toString();
}

export function systemSteps({ root, env }) {
  const port = Number(env.PORT || 80);
  const base = port === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${port}`;
  return {
    extract: (zip, dir) => run('tar', ['-xf', zip, '-C', dir]),
    snapshot: () => run(process.execPath, [path.join('server', 'scripts', 'localSnapshot.js')], {
      cwd: root,
      env: { ...process.env, MONGO_URI: serverWideUri(env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0') },
    }),
    stopServer: async () => {
      await powershell(`Stop-ScheduledTask -TaskName '${SERVER_TASK}' -ErrorAction SilentlyContinue; `
        + 'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | '
        + 'Where-Object { $_.CommandLine -like \'*server\\server.js*\' } | '
        + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }');
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
    },
    startServer: () => powershell(`Start-ScheduledTask -TaskName '${SERVER_TASK}'`),
    installPackages: () => npm(root, ['ci', '--omit=dev', '--no-audit', '--no-fund']),
    buildIndexes: () => npm(root, ['run', 'db:indexes']),
    waitHealthy: async (release, timeoutMs = HEALTH_TIMEOUT_MS) => {
      const until = Date.now() + timeoutMs;
      let last = 'no answer';
      while (Date.now() < until) {
        try {
          const response = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(3000) });
          const body = await response.json();
          const data = body?.data ?? {};
          if (response.ok && data.database === 'connected' && data.release === release) return;
          last = `release ${data.release}, database ${data.database}`;
        } catch (error) {
          last = error.message;
        }
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
      }
      throw new Error(`The server did not come up as ${release} within ${timeoutMs / 1000} seconds (${last}).`);
    },
  };
}

// ---------------------------------------------------------------------------
// Applying a version

async function writeEnvRelease(root, release) {
  const envFile = path.join(root, '.env');
  const text = await fs.readFile(envFile, 'utf8');
  await fs.writeFile(envFile, setEnvValue(text, 'RELEASE_VERSION', release ?? ''));
}

/**
 * Puts the unpacked version in `newRoot` in place of the one running in `root`.
 * Returns { ok: true } or { ok: false, rolledBack, reason }. Throws only when the
 * server was never stopped, so nothing changed.
 */
export async function applyVersion({ root, newRoot, release, oldRelease, steps, log }) {
  const updates = path.join(root, 'data', 'updates');
  const previous = path.join(updates, 'previous');
  const failed = path.join(updates, 'failed');

  log('Taking a snapshot of the database first.');
  await steps.snapshot();

  log('Stopping the server.');
  await steps.stopServer();

  await fs.rm(previous, { recursive: true, force: true });
  try {
    await moveEntries(root, previous, KEEP);
  } catch (error) {
    log(`Could not move the running version aside: ${error.message}`);
    await steps.startServer();
    return { ok: false, rolledBack: true, reason: error.message };
  }
  try {
    await moveEntries(newRoot, root);
  } catch (error) {
    log(`Could not put the new version in place: ${error.message}`);
    return rollBack({ root, previous, failed, oldRelease, steps, log, reason: error.message });
  }

  try {
    await writeEnvRelease(root, release);
    log('Installing the app packages (npm ci).');
    await steps.installPackages();
    log('Building the database indexes.');
    await steps.buildIndexes();
    log('Starting the server.');
    await steps.startServer();
    await steps.waitHealthy(release);
  } catch (error) {
    log(`The new version failed: ${error.message}`);
    return rollBack({ root, previous, failed, oldRelease, steps, log, reason: error.message });
  }
  return { ok: true };
}

async function rollBack({ root, previous, failed, oldRelease, steps, log, reason }) {
  log('Putting the previous version back.');
  await steps.stopServer().catch(() => {});
  await fs.rm(failed, { recursive: true, force: true });
  await moveEntries(root, failed, KEEP);
  await moveEntries(previous, root);
  await writeEnvRelease(root, oldRelease);
  await steps.startServer();
  try {
    await steps.waitHealthy(oldRelease ?? null);
    log('The previous version is running again.');
  } catch (error) {
    log(`The previous version did not come back either: ${error.message}`);
    return { ok: false, rolledBack: false, reason: `${reason}; then ${error.message}` };
  }
  return { ok: false, rolledBack: true, reason };
}

/** `rollback`: swap the running version with data\updates\previous. */
export async function rollbackToPrevious({ root, steps, log }) {
  const updates = path.join(root, 'data', 'updates');
  const previous = path.join(updates, 'previous');
  if (!(await exists(path.join(previous, 'server', 'server.js')))) throw new Error('There is no previous version to go back to.');
  const going = await readInstalled(previous);
  const current = await readInstalled(root);
  const parked = path.join(updates, 'rolled-back');
  await steps.stopServer();
  await fs.rm(parked, { recursive: true, force: true });
  await moveEntries(root, parked, KEEP);
  await moveEntries(previous, root);
  // The version just left becomes "previous", so a second rollback undoes the first.
  await renameWithRetry(parked, previous);
  const release = going.commit;
  await writeEnvRelease(root, release);
  await steps.startServer();
  await steps.waitHealthy(release ?? null);
  log(`Rolled back from ${current.commit} to ${release}.`);
}

// ---------------------------------------------------------------------------
// The commands

async function takeLock(file) {
  try {
    const handle = await fs.open(file, 'wx');
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}`);
    await handle.close();
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const { mtimeMs } = await fs.stat(file);
    if (Date.now() - mtimeMs < LOCK_STALE_MS) return false;
    await fs.rm(file, { force: true });
    return takeLock(file);
  }
}

export async function updateCommand({ command, root, now = new Date(), fetchImpl = fetch, steps: givenSteps, print = console.log }) {
  const envText = await fs.readFile(path.join(root, '.env'), 'utf8').catch(() => '');
  const env = parseEnvText(envText);
  const updates = path.join(root, 'data', 'updates');
  const logFile = path.join(root, 'data', 'logs', 'update.log');
  await fs.mkdir(updates, { recursive: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    print(stamped);
    return fs.appendFile(logFile, `${stamped}\n`).catch(() => {});
  };
  const steps = givenSteps ?? systemSteps({ root, env });
  const status = (fields) => fs.writeFile(path.join(updates, 'status.json'), JSON.stringify({ at: new Date().toISOString(), ...fields }, null, 2));

  if (command === 'run') {
    if ((env.UPDATE_AUTO || 'on').toLowerCase() !== 'on') return { skipped: 'UPDATE_AUTO is off' };
    if (!inWindow(now, parseWindow(env.UPDATE_WINDOW || DEFAULT_WINDOW))) return { skipped: 'outside the update window' };
    // No token yet: updates are simply not set up, which is not worth a log line every night.
    if (!env.UPDATE_TOKEN) return { skipped: 'no UPDATE_TOKEN' };
  }

  if (!(await takeLock(path.join(updates, 'lock')))) {
    print('Another update is running. Try again in a few minutes.');
    return { skipped: 'locked' };
  }
  try {
    if (command === 'rollback') {
      await rollbackToPrevious({ root, steps, log });
      await status({ result: 'rolled back by hand' });
      return { ok: true };
    }

    const installed = await readInstalled(root);
    const publicKeyPem = await fs.readFile(path.join(root, 'box', 'windows', 'release-public-key.pem'), 'utf8');
    const release = await findLatestRelease({ repo: env.UPDATE_REPO, token: env.UPDATE_TOKEN, fetchImpl });
    const download = path.join(updates, 'download');
    await fs.rm(download, { recursive: true, force: true });
    await fs.mkdir(download, { recursive: true });
    const manifestFile = path.join(download, 'manifest.json');
    await downloadAsset({ url: release.manifestUrl, token: env.UPDATE_TOKEN, dest: manifestFile, fetchImpl });
    const payload = verifyManifest(await fs.readFile(manifestFile, 'utf8'), publicKeyPem);
    const comparison = compareVersions(installed, payload);
    const summary = `installed ${installed.commit ?? 'unknown'}, newest ${payload.commit} (${release.tag}, built ${payload.builtAt})`;

    if (command === 'check') {
      print(`${summary}: ${comparison === 'newer' ? 'an update is waiting' : 'up to date'}.`);
      if (payload.manual) print(`It needs a person: ${payload.manual}`);
      return { comparison, payload };
    }
    if (comparison !== 'newer') {
      if (command === 'now') print(`Up to date: ${summary}.`);
      return { skipped: 'up to date' };
    }
    if (payload.manual) {
      await log(`${summary}: not installed by itself. ${payload.manual}`);
      await status({ result: 'needs a person', commit: payload.commit, reason: payload.manual });
      return { skipped: 'manual release' };
    }

    await log(`Updating: ${summary}.`);
    const zipAsset = release.assets.find((asset) => asset.name === payload.asset);
    if (!zipAsset) throw new Error(`Release ${release.tag} has no ${payload.asset}.`);
    const zip = path.join(download, payload.asset);
    await downloadAsset({ url: zipAsset.url, token: env.UPDATE_TOKEN, dest: zip, fetchImpl });
    const { size } = await fs.stat(zip);
    if (size !== payload.size || (await sha256File(zip)) !== payload.sha256) {
      throw new Error('The downloaded package does not match its signed checksum. Not installing it.');
    }

    const staging = path.join(updates, 'staging');
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    await steps.extract(zip, staging);
    const newRoot = path.join(staging, 'Dakaar');
    const unpacked = await readInstalled(newRoot);
    if (unpacked.commit !== payload.commit
      || !(await exists(path.join(newRoot, 'server', 'server.js')))
      || !(await exists(path.join(newRoot, 'client', 'dist', 'index.html')))) {
      throw new Error('The package is not a complete Dakaar of the signed version. Not installing it.');
    }

    const result = await applyVersion({ root, newRoot, release: payload.commit, oldRelease: installed.commit, steps, log });
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(download, { recursive: true, force: true });
    if (result.ok) {
      await log(`Updated to ${payload.commit}. The version before it is kept in data\\updates\\previous.`);
      await status({ result: 'updated', commit: payload.commit, from: installed.commit });
    } else {
      await log(`Update to ${payload.commit} failed${result.rolledBack ? ', previous version running' : ''}: ${result.reason}`);
      await status({ result: 'failed', commit: payload.commit, rolledBack: result.rolledBack, reason: result.reason });
    }
    return result;
  } catch (error) {
    await log(`Update stopped: ${error.message}`);
    await status({ result: 'stopped', reason: error.message }).catch(() => {});
    return { ok: false, reason: error.message };
  } finally {
    await fs.rm(path.join(updates, 'lock'), { force: true });
  }
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  const command = process.argv[2] || 'check';
  if (!['check', 'run', 'now', 'rollback'].includes(command)) {
    console.error('Use: node box\\windows\\update.mjs check | run | now | rollback');
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  process.chdir(root);
  const result = await updateCommand({ command, root });
  process.exit(result.ok === false ? 1 : 0);
}
