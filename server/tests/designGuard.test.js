/**
 * Design guard. P20A, DESIGN-SYSTEM section 13.
 *
 * Reads client source from disk and fails the build when a shared component
 * or a service screen:
 *   1. contains a raw hex colour (every colour is a token in index.css),
 *   2. uses a version 1 token class (`paper`, `steel`, `chana`, `mirch`,
 *      `patta`), or
 *   3. formats money anywhere but `Money`: no `toLocaleString` on a number,
 *      no `/ 100` beside a `₹`, and no call to version 1's `formatPaise`.
 *
 * P20A guarded the shared components and the service screens; P20B widened
 * all three to the whole of `client/src/`, and added a fourth: nothing imports
 * a component that version 1 had and version 2 deleted.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = path.resolve(SERVER_DIR, '..', 'client', 'src');

/** The whole client. `index.css` is not JavaScript, so it is the one place colours are written. */
const GUARDED = ['.'];

/** Version 1 files deleted in P20A and P20B. An import of any of them is a bug. */
const DELETED = ['StatusBadge', 'AvailabilityStamp', 'PanelShell', 'PaymentPanel', 'billing/Bilingual', 'attendance/Bilingual', 'billing/labels', 'attendance/labels'];

/**
 * The colour arithmetic that checks an owner's accent: the mirror of
 * `server/utils/colour.js`, which has to name the state and preset colours to
 * measure against them. It styles nothing.
 */
const COLOUR_ARITHMETIC = 'utils/colour.js';

/** The one component allowed to format money, and its plain-text words (P64). */
const MONEY_COMPONENT = 'components/ui/Money.jsx';
const MONEY_TEXT = 'components/ui/moneyText.js';

/** P22. The one component that draws a logo, the one file that fetches it, and the two users of `brand`. */
const BRAND_LOGO = 'components/ui/BrandLogo.jsx';
// P24. Dish photos are the one other image, drawn by one component.
const DISH_PHOTO = 'components/ui/DishPhoto.jsx';
// P25. The printed tax invoice is a separate HTML document, not a screen, and
// draws the logo BrandLogo already holds, from its data URL.
const PRINTED_INVOICE = 'features/printing/invoiceHtml.js';
// P64. The full-page themes draw the logo and the signature image the same way.
const PRINTED_THEMES = 'features/printing/themes/';
const BRAND_API = 'api/brand.js';
const BRAND_USERS = [BRAND_LOGO, 'features/auth/LoginPage.jsx'];
const LOOPING = /(?<![\w-])(?:[a-z-]+:)*animate-(?:spin|pulse|ping|bounce)(?![\w-])/;
const BRAND_CLASS = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|shadow)-(?:on-)?brand(?![\w-])|--color-(?:on-)?brand\b/;

/** Every file in the client folder, built output and dependencies left out. */
function sourceFilesOfAnyKind(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.vite'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFilesOfAnyKind(full));
    else if (/\.(js|jsx|css|html|json|md)$/.test(entry.name)) found.push(full);
  }
  return found;
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const relative = (file) => path.relative(CLIENT_SRC, file).split(path.sep).join('/');

/** Comments say what the colours were; only code is checked. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const files = GUARDED.flatMap((folder) => sourceFiles(path.join(CLIENT_SRC, folder))).map((file) => ({
  name: relative(file),
  code: withoutComments(readFileSync(file, 'utf8')),
}));

function offenders(pattern) {
  const found = [];
  for (const { name, code } of files) {
    code.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${name}:${index + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

const RAW_HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/;
const V1_TOKEN = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|outline|fill|stroke|from|to|via|decoration|divide|accent|shadow|placeholder)-(?:paper|steel|chana|mirch|patta)(?![\w])|--color-(?:paper|steel|chana|mirch|patta)/;

describe('design guard: the whole client', () => {
  it('guards a real set of files', () => {
    assert.ok(files.length > 120, `only ${files.length} files found under ${GUARDED.join(', ')}`);
  });

  it('contain no raw hex colour', () => {
    assert.deepEqual(offenders(RAW_HEX).filter((line) => !line.startsWith(`${COLOUR_ARITHMETIC}:`)), []);
  });

  it('use no version 1 token class', () => {
    assert.deepEqual(offenders(V1_TOKEN), []);
  });

  it('format money only through Money', () => {
    const found = [];
    for (const { name, code } of files) {
      if (name === MONEY_COMPONENT || name === MONEY_TEXT) continue;
      code.split('\n').forEach((line, index) => {
        const where = `${name}:${index + 1}  ${line.trim().slice(0, 100)}`;
        if (/\.toLocaleString\(/.test(line)) found.push(where);
        if (/\/\s*100\b/.test(line) && /₹/.test(line)) found.push(where);
        if (/\bformatPaise\b/.test(line)) found.push(where);
      });
    }
    assert.deepEqual(found, []);
  });

  it('import no deleted version 1 component', () => {
    const found = [];
    for (const { name, code } of files) {
      for (const match of code.matchAll(/from\s+'([^']+)'/g)) {
        if (DELETED.some((gone) => match[1].replace(/\.jsx?$/, '').endsWith(`/${gone}`))) found.push(`${name}  ${match[1]}`);
      }
    }
    assert.deepEqual(found, []);
  });

  // P22. The logo is drawn by one component, and the brand colour has two jobs.
  it('draw a logo only through BrandLogo, and a dish only through DishPhoto', () => {
    const found = [];
    for (const { name, code } of files) {
      code.split('\n').forEach((line, index) => {
        const where = `${name}:${index + 1}  ${line.trim().slice(0, 100)}`;
        if (/<img\b/.test(line) && ![BRAND_LOGO, DISH_PHOTO, PRINTED_INVOICE].includes(name) && !name.startsWith(PRINTED_THEMES)) found.push(where);
        // Only the brand API file asks the server for the logo's bytes.
        if (/\/restaurant\/logo/.test(line) && name !== BRAND_API) found.push(where);
      });
    }
    assert.deepEqual(found, []);
  });

  it('use the brand colour only in BrandLogo and the sign-in screen', () => {
    const found = offenders(BRAND_CLASS).filter((line) => !BRAND_USERS.some((allowed) => line.startsWith(`${allowed}:`)));
    assert.deepEqual(found, []);
  });

  it('never reference the menu reference image', () => {
    const everything = sourceFilesOfAnyKind(path.resolve(CLIENT_SRC, '..'));
    const found = everything.filter((file) => /cafezza-menu-reference/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(found.map((file) => path.relative(SERVER_DIR, file)), []);
  });

  // P22, DESIGN-SYSTEM 13c. Loading shows the screen's shape, still; nothing loops.
  it('use no looping animation', () => {
    assert.deepEqual(offenders(LOOPING), []);
  });

  it('catch a planted logo, brand class and menu reference', () => {
    assert.ok(LOOPING.test('className="animate-spin rounded-full"'));
    assert.ok(!LOOPING.test("animation: 'sheet-in-right 180ms'"));
    assert.ok(BRAND_CLASS.test('className="bg-brand text-on-brand"'));
    assert.ok(BRAND_CLASS.test("'hover:border-brand'"));
    assert.ok(!BRAND_CLASS.test('className="bg-surface text-brandish"'));
    assert.ok(/<img\b/.test('<img src={logo} alt="" />'));
  });

  it('catch a planted raw colour, version 1 token and private money format', () => {
    // The patterns above are only worth anything if they match what they exist to stop.
    assert.ok(RAW_HEX.test('className="bg-[#c99a2e]"'));
    assert.ok(RAW_HEX.test("color: '#fff'"));
    assert.ok(!RAW_HEX.test('#{order.orderNumber}'));
    assert.ok(V1_TOKEN.test("'hover:bg-chana text-ink'"));
    assert.ok(V1_TOKEN.test('className="text-steel"'));
    assert.ok(V1_TOKEN.test('accent-[var(--color-chana)]'));
    assert.ok(!V1_TOKEN.test('className="text-muted bg-accent"'));
  });
});
