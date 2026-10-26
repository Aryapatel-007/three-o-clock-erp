/**
 * The developer's half of the cafe PC updater. P62, docs/WINDOWS-INSTALL.md section 6.
 *
 *   node box/windows/release.mjs keygen
 *       Makes the release key once. The private half goes to
 *       ~/.cafepos/release-signing-key.pem (never the repository); the public half
 *       to box/windows/release-public-key.pem, which is committed and shipped.
 *
 *   node box/windows/release.mjs sign <CafePOS.zip> <manifest.json> --commit <sha> --built-at <iso> [--manual "<reason>"]
 *       Writes the signed manifest make-package.sh --publish uploads beside the zip.
 *       --manual marks a version the PCs must not install by themselves.
 *
 * CAFEPOS_RELEASE_KEY names another private key file.
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256File } from './update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_KEY_FILE = path.join(HERE, 'release-public-key.pem');
export const privateKeyFile = () => process.env.CAFEPOS_RELEASE_KEY || path.join(os.homedir(), '.cafepos', 'release-signing-key.pem');

/** The signed text is kept as a string, so the PC verifies exactly what was signed. */
export function signManifest(payload, privateKeyPem) {
  const text = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(text, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
  return `${JSON.stringify({ payload: text, signature }, null, 2)}\n`;
}

export async function buildManifest({ zip, commit, builtAt, manual = null, privateKeyPem }) {
  const { size } = await fs.stat(zip);
  const payload = { commit, builtAt, asset: path.basename(zip), size, sha256: await sha256File(zip) };
  if (manual) payload.manual = manual;
  return signManifest(payload, privateKeyPem);
}

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'keygen') {
      const file = privateKeyFile();
      try {
        await fs.access(file);
        throw new Error(`${file} exists already. One key is enough; a new one stops every cafe PC accepting updates until it has the new public key.`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
      await fs.writeFile(PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }));
      console.log(`Private key: ${file} (keep it; back it up somewhere safe; never commit it)`);
      console.log(`Public key:  ${PUBLIC_KEY_FILE} (commit this)`);
    } else if (command === 'sign') {
      const [zip, out] = args;
      const commit = option(args, '--commit');
      const builtAt = option(args, '--built-at');
      if (!zip || !out || !commit || !builtAt) throw new Error('Use: sign <zip> <manifest.json> --commit <sha> --built-at <iso> [--manual "<reason>"]');
      const privateKeyPem = await fs.readFile(privateKeyFile(), 'utf8').catch(() => {
        throw new Error(`No release key at ${privateKeyFile()}. Copy it from whoever made it, or set CAFEPOS_RELEASE_KEY.`);
      });
      await fs.writeFile(out, await buildManifest({ zip, commit, builtAt, manual: option(args, '--manual'), privateKeyPem }));
      console.log(`Signed ${out}`);
    } else {
      throw new Error('Use: node box/windows/release.mjs keygen | sign ...');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
