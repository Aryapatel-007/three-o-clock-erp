/**
 * Makes the server in a release package hard to read: called by make-package.sh on the
 * staged copy, never on the repository. Every entry point the restaurant PC runs is
 * bundled with its own code into one minified file at the same path (esbuild), then
 * obfuscated (javascript-obfuscator), and the readable source folders are removed.
 * Packages from node_modules stay outside the bundles: they are installed by npm ci.
 *
 *   node box/windows/protect-server.mjs <stage folder>
 *
 * A module that asks where it is (`import.meta.url`: the settings file finding .env,
 * the server finding client/dist, each script checking it is the one being run) is
 * told where it would have been, relative to its bundle, so every path resolves as
 * before from whatever folder Three O’Clock is installed in, and an imported script never
 * mistakes itself for the program being run.
 */
import { mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

/**
 * What the restaurant PC runs, from the package's root: the server, the scripts the
 * installer and its tasks call, and the installer's sample loader. Each is its own
 * program; one process never loads two bundles, as each carries its own copy of the
 * database models (load-starter.mjs is one bundle with the three scripts it uses).
 */
export const ENTRIES = [
  'server/server.js',
  'server/scripts/provisionRestaurant.js',
  'server/scripts/buildIndexes.js',
  'server/scripts/localSnapshot.js',
  'server/scripts/setupRestaurant.js',
  'server/scripts/importMenu.js',
  'box/windows/load-starter.mjs',
];

/** Light enough not to slow a till; strong enough that the code no longer reads as code. */
const OBFUSCATION = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  transformObjectKeys: false,
  numbersToExpressions: false,
  simplify: true,
  target: 'node',
};

const toPosix = (p) => p.split(path.sep).join('/');

/** Rewrites `import.meta.url` in a module of ours to the URL it had before bundling. */
function selfLocationPlugin(stageDir, entryFile) {
  const entryDir = path.dirname(entryFile);
  return {
    name: 'self-location',
    setup(b) {
      b.onLoad({ filter: /\.m?js$/ }, async (args) => {
        if (!args.path.startsWith(stageDir) || args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        let rel = toPosix(path.relative(entryDir, args.path));
        if (!rel.startsWith('.')) rel = `./${rel}`;
        const source = await readFile(args.path, 'utf8');
        return { contents: source.replaceAll('import.meta.url', `new URL(${JSON.stringify(rel)}, import.meta.url).href`), loader: 'js' };
      });
    },
  };
}

async function jsFilesUnder(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...(await jsFilesUnder(full)));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

export async function protectServer(stage) {
  const stageDir = path.resolve(stage) + path.sep;
  const serverDir = path.join(stageDir, 'server') + path.sep;
  const bundles = new Map();
  for (const entry of ENTRIES) {
    const entryFile = path.join(stageDir, entry);
    const result = await build({
      entryPoints: [entryFile],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      minify: true,
      legalComments: 'none',
      write: false,
      logLevel: 'error',
      plugins: [selfLocationPlugin(stageDir, entryFile)],
    });
    const code = JavaScriptObfuscator.obfuscate(result.outputFiles[0].text, OBFUSCATION).getObfuscatedCode();
    bundles.set(entry, code);
  }

  // Every readable source file goes; the bundles take the entry points' places.
  for (const file of await jsFilesUnder(serverDir)) await rm(file);
  for (const folder of await readdir(serverDir)) {
    const full = path.join(serverDir, folder);
    if ((await stat(full)).isDirectory() && (await jsFilesUnder(full)).length === 0 && folder !== 'node_modules') {
      await rm(full, { recursive: true, force: true });
    }
  }
  await rm(path.join(serverDir, '.env.test.example'), { force: true });
  for (const [entry, code] of bundles) {
    const target = path.join(stageDir, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, code);
  }
  return [...bundles].map(([entry, code]) => ({ entry, bytes: Buffer.byteLength(code) }));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isDirectRun) {
  const stage = process.argv[2];
  if (!stage) {
    console.error('Use: node box/windows/protect-server.mjs <stage folder>');
    process.exit(1);
  }
  const made = await protectServer(stage);
  for (const { entry, bytes } of made) console.log(`  ${entry}  ${(bytes / 1024).toFixed(0)} KB, bundled and obfuscated`);
}
