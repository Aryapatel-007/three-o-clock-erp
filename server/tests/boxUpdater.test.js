/**
 * P62, the cafe PC updater (box/windows/update.mjs and release.mjs). The
 * Windows steps (stopping the server task, npm ci, the health check) are
 * replaced with fakes, so the whole update, and its rollback, runs on any machine.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildManifest, signManifest } from '../../box/windows/release.mjs';
import {
  compareVersions,
  inWindow,
  moveEntries,
  parseEnvText,
  parseWindow,
  serverWideUri,
  setEnvValue,
  updateCommand,
  verifyManifest,
} from '../../box/windows/update.mjs';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
};
const KEY = pair();
const OTHER_KEY = pair();
const OLD = { commit: 'aaa1111', builtAt: '2026-10-20T10:00:00Z' };
const NEW = { commit: 'bbb2222', builtAt: '2026-10-21T10:00:00Z' };
const atHour = (hour, minute = 0) => new Date(2026, 9, 22, hour, minute);

describe('updater settings', () => {
  it('reads the window, including one that crosses midnight', () => {
    const night = parseWindow('04:00-05:00');
    assert.equal(inWindow(atHour(4, 30), night), true);
    assert.equal(inWindow(atHour(5, 0), night), false);
    assert.equal(inWindow(atHour(3, 59), night), false);
    const late = parseWindow('23:30-01:00');
    assert.equal(inWindow(atHour(23, 45), late), true);
    assert.equal(inWindow(atHour(0, 30), late), true);
    assert.equal(inWindow(atHour(12, 0), late), false);
    assert.throws(() => parseWindow('4am'), /UPDATE_WINDOW/);
    assert.throws(() => parseWindow('25:00-26:00'), /impossible/);
    assert.throws(() => parseWindow('04:00-04:00'), /same time/);
  });

  it('sets one .env line and keeps the rest, line endings included', () => {
    const text = 'PORT=80\r\nRELEASE_VERSION=old\r\n# note\r\n';
    const replaced = setEnvValue(text, 'RELEASE_VERSION', 'new');
    assert.equal(replaced, 'PORT=80\r\nRELEASE_VERSION=new\r\n# note\r\n');
    assert.equal(parseEnvText(setEnvValue('PORT=80\n', 'RELEASE_VERSION', 'x')).RELEASE_VERSION, 'x');
    assert.deepEqual(parseEnvText('A=1\n# B=2\nC= three \n'), { A: '1', C: 'three' });
  });

  it('points the snapshot at the whole server, not one database', () => {
    assert.equal(serverWideUri('mongodb://127.0.0.1:27017/restaurant-erp?replicaSet=rs0'), 'mongodb://127.0.0.1:27017/?replicaSet=rs0');
  });
});

describe('the signed manifest', () => {
  const payload = { commit: NEW.commit, builtAt: NEW.builtAt, asset: 'Dakaar.zip', size: 3, sha256: 'a'.repeat(64) };

  it('is accepted with the right key and refused with another', () => {
    const text = signManifest(payload, KEY.privatePem);
    assert.deepEqual(verifyManifest(text, KEY.publicPem), payload);
    assert.throws(() => verifyManifest(text, OTHER_KEY.publicPem), /not signed by this PC's release key/);
  });

  it('is refused when its payload was changed after signing', () => {
    const outer = JSON.parse(signManifest(payload, KEY.privatePem));
    outer.payload = outer.payload.replace(NEW.commit, 'evil999');
    assert.throws(() => verifyManifest(JSON.stringify(outer), KEY.publicPem), /not signed/);
  });

  it('is refused without a checksum, or when not JSON', () => {
    const { sha256, ...withoutSum } = payload;
    assert.ok(sha256);
    assert.throws(() => verifyManifest(signManifest(withoutSum, KEY.privatePem), KEY.publicPem), /no sha256/);
    assert.throws(() => verifyManifest('nonsense', KEY.publicPem), /not JSON/);
  });

  it('never moves a PC back to an older version', () => {
    assert.equal(compareVersions(OLD, NEW), 'newer');
    assert.equal(compareVersions(NEW, OLD), 'older');
    assert.equal(compareVersions(NEW, NEW), 'same');
    assert.equal(compareVersions({ commit: 'abc', builtAt: null }, NEW), 'newer');
  });
});

/** A Dakaar folder of one version. */
async function writeVersion(dir, version) {
  await fs.mkdir(path.join(dir, 'server'), { recursive: true });
  await fs.mkdir(path.join(dir, 'client', 'dist'), { recursive: true });
  await fs.mkdir(path.join(dir, 'box', 'windows'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'server', 'server.js'), `// ${version.commit}\n`);
  await fs.writeFile(path.join(dir, 'client', 'dist', 'index.html'), `<!-- ${version.commit} -->`);
  await fs.writeFile(path.join(dir, 'box', 'windows', 'release-public-key.pem'), KEY.publicPem);
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), version.commit);
  await fs.writeFile(path.join(dir, 'VERSION.json'), JSON.stringify(version));
  await fs.writeFile(path.join(dir, 'VERSION.txt'), `${version.commit}\n`);
}

describe('updating the cafe PC', () => {
  let tmp;
  let root;
  let releaseDir;
  let zip;
  let calls;
  let healthy;
  let fetched;

  /** A fake GitHub serving one release: the manifest and the "zip". */
  function fakeGithub({ manifestText, zipBytes }) {
    return (url) => {
      fetched.push(url);
      if (url.endsWith('/releases/latest')) {
        return Promise.resolve(Response.json({
          tag_name: 'cafepos-test',
          assets: [{ name: 'manifest.json', url: 'https://api/asset/1' }, { name: 'Dakaar.zip', url: 'https://api/asset/2' }],
        }));
      }
      if (url === 'https://api/asset/1') return Promise.resolve(new Response(manifestText));
      if (url === 'https://api/asset/2') return Promise.resolve(new Response(zipBytes));
      return Promise.resolve(new Response('', { status: 404 }));
    };
  }

  /** Fake Windows: "extract" copies the release folder, the health check is a switch. */
  const steps = () => ({
    extract: async (zipFile, dir) => { calls.push('extract'); await fs.cp(releaseDir, path.join(dir, 'Dakaar'), { recursive: true }); },
    snapshot: () => { calls.push('snapshot'); return Promise.resolve(); },
    stopServer: () => { calls.push('stop'); return Promise.resolve(); },
    startServer: () => { calls.push('start'); return Promise.resolve(); },
    installPackages: async () => {
      calls.push('npm ci');
      await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'fresh');
    },
    buildIndexes: () => { calls.push('indexes'); return Promise.resolve(); },
    waitHealthy: (release) => {
      calls.push(`healthy? ${release}`);
      return healthy(release) ? Promise.resolve() : Promise.reject(new Error(`${release} did not answer`));
    },
  });

  const read = (...parts) => fs.readFile(path.join(...parts), 'utf8');

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cafepos-update-'));
    root = path.join(tmp, 'Dakaar');
    releaseDir = path.join(tmp, 'release', 'Dakaar');
    await writeVersion(root, OLD);
    await writeVersion(releaseDir, NEW);
    await fs.mkdir(path.join(root, 'data', 'snapshots'), { recursive: true });
    await fs.writeFile(path.join(root, 'data', 'snapshots', 'keep.gz'), 'orders');
    await fs.writeFile(path.join(root, '.env'), 'PORT=80\nUPDATE_REPO=owner/repo\nUPDATE_TOKEN=t\nUPDATE_WINDOW=04:00-05:00\nRELEASE_VERSION=aaa1111\n');
    zip = path.join(tmp, 'Dakaar.zip');
    await fs.writeFile(zip, 'pretend zip bytes');
    calls = [];
    fetched = [];
    healthy = () => true;
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function publish({ key = KEY.privatePem, version = NEW, manual = null } = {}) {
    const manifestText = await buildManifest({ zip, commit: version.commit, builtAt: version.builtAt, manual, privateKeyPem: key });
    return fakeGithub({ manifestText, zipBytes: await fs.readFile(zip) });
  }

  it('puts the new version in place, keeping the data and settings', async () => {
    const result = await updateCommand({ command: 'run', root, now: atHour(4, 15), fetchImpl: await publish(), steps: steps(), print: () => {} });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['extract', 'snapshot', 'stop', 'npm ci', 'indexes', 'start', `healthy? ${NEW.commit}`]);
    assert.match(await read(root, 'server', 'server.js'), /bbb2222/);
    assert.match(await read(root, 'data', 'updates', 'previous', 'server', 'server.js'), /aaa1111/);
    assert.equal(await read(root, 'data', 'snapshots', 'keep.gz'), 'orders');
    const env = parseEnvText(await read(root, '.env'));
    assert.equal(env.RELEASE_VERSION, NEW.commit);
    assert.equal(env.UPDATE_TOKEN, 't');
    assert.equal(JSON.parse(await read(root, 'data', 'updates', 'status.json')).result, 'updated');
    assert.match(await read(root, 'data', 'logs', 'update.log'), /Updated to bbb2222/);
  });

  it('puts the previous version back, with its own packages, when the new one does not start', async () => {
    healthy = (release) => release === OLD.commit;
    const result = await updateCommand({ command: 'now', root, fetchImpl: await publish(), steps: steps(), print: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(await read(root, 'server', 'server.js'), /aaa1111/);
    assert.equal(await read(root, 'node_modules', 'pkg', 'index.js'), OLD.commit);
    assert.match(await read(root, 'data', 'updates', 'failed', 'server', 'server.js'), /bbb2222/);
    assert.equal(parseEnvText(await read(root, '.env')).RELEASE_VERSION, OLD.commit);
    assert.equal(await read(root, 'data', 'snapshots', 'keep.gz'), 'orders');
    assert.deepEqual(calls.slice(-3), ['stop', 'start', `healthy? ${OLD.commit}`]);
  });

  it('touches nothing when the download does not match its signed checksum', async () => {
    const fetchImpl = await publish();
    await fs.writeFile(zip, 'something else');
    const result = await updateCommand({
      command: 'now',
      root,
      fetchImpl: async (url) => (url === 'https://api/asset/2' ? new Response(await fs.readFile(zip)) : fetchImpl(url)),
      steps: steps(),
      print: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /does not match its signed checksum/);
    assert.deepEqual(calls, []);
    assert.match(await read(root, 'server', 'server.js'), /aaa1111/);
  });

  it('refuses a release signed by any other key, before downloading it', async () => {
    const result = await updateCommand({ command: 'now', root, fetchImpl: await publish({ key: OTHER_KEY.privatePem }), steps: steps(), print: () => {} });
    assert.match(result.reason, /not signed by this PC's release key/);
    assert.deepEqual(calls, []);
    assert.equal(fetched.includes('https://api/asset/2'), false);
  });

  it('does nothing outside the window, or with UPDATE_AUTO off, without asking GitHub', async () => {
    const fetchImpl = await publish();
    assert.deepEqual(await updateCommand({ command: 'run', root, now: atHour(20), fetchImpl, steps: steps(), print: () => {} }), { skipped: 'outside the update window' });
    await fs.appendFile(path.join(root, '.env'), 'UPDATE_AUTO=off\n');
    assert.deepEqual(await updateCommand({ command: 'run', root, now: atHour(4, 30), fetchImpl, steps: steps(), print: () => {} }), { skipped: 'UPDATE_AUTO is off' });
    assert.deepEqual(fetched, []);
  });

  it('stays quiet at night when no token has been set yet', async () => {
    await fs.writeFile(path.join(root, '.env'), 'PORT=80\nUPDATE_REPO=owner/repo\nUPDATE_TOKEN=\n');
    const result = await updateCommand({ command: 'run', root, now: atHour(4, 30), fetchImpl: await publish(), steps: steps(), print: () => {} });
    assert.deepEqual(result, { skipped: 'no UPDATE_TOKEN' });
    assert.deepEqual(fetched, []);
    await assert.rejects(fs.access(path.join(root, 'data', 'logs', 'update.log')));
  });

  it('leaves a release marked manual, and an older one, for a person', async () => {
    const manual = await updateCommand({ command: 'run', root, now: atHour(4, 30), fetchImpl: await publish({ manual: 'Run Install Dakaar.' }), steps: steps(), print: () => {} });
    assert.deepEqual(manual, { skipped: 'manual release' });
    const older = await updateCommand({ command: 'now', root, fetchImpl: await publish({ version: { commit: 'ccc0000', builtAt: '2026-10-01T00:00:00Z' } }), steps: steps(), print: () => {} });
    assert.deepEqual(older, { skipped: 'up to date' });
    assert.deepEqual(calls, []);
  });

  it('rolls back by hand, and a second rollback undoes the first', async () => {
    await updateCommand({ command: 'now', root, fetchImpl: await publish(), steps: steps(), print: () => {} });
    await updateCommand({ command: 'rollback', root, steps: steps(), print: () => {} });
    assert.match(await read(root, 'server', 'server.js'), /aaa1111/);
    assert.equal(parseEnvText(await read(root, '.env')).RELEASE_VERSION, OLD.commit);
    await updateCommand({ command: 'rollback', root, steps: steps(), print: () => {} });
    assert.match(await read(root, 'server', 'server.js'), /bbb2222/);
    assert.equal(await read(root, 'data', 'snapshots', 'keep.gz'), 'orders');
  });

  it('moves a whole version or nothing', async () => {
    const target = path.join(tmp, 'target');
    await fs.mkdir(path.join(target, 'server'), { recursive: true });
    await assert.rejects(moveEntries(root, target, new Set(['data', '.env'])), /in the way/);
    assert.match(await read(root, 'server', 'server.js'), /aaa1111/);
    assert.match(await read(root, 'client', 'dist', 'index.html'), /aaa1111/);
  });
});
