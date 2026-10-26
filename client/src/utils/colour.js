/**
 * Colour arithmetic for the restaurant's accent. P20A.
 * docs/DESIGN-SYSTEM.md sections 4c and 13.
 *
 * MIRROR of server/utils/colour.js, used only to preview and explain on the
 * settings screen before saving. The server validates and computes; this file
 * never decides anything. A server test runs both on the same 50 colours.
 * NO IMPORTS, so the mirror can stay identical.
 */

/**
 * The two neutral sets, DESIGN-SYSTEM section 4a. COOL is every restaurant's
 * default. WARM was added by P22, translated from Cafezza's printed menu: cream
 * cards on linen become white surfaces on a warm linen ground, with espresso
 * ink. Day `surface` stays pure white in both, so the state tints read exactly
 * as they do on cool. index.css carries the same values; a test compares them.
 */
export const NEUTRALS = Object.freeze({
  COOL: Object.freeze({
    day: Object.freeze({ ground: '#F2F4F3', surface: '#FFFFFF', sunken: '#E7ECEA', ink: '#1B2623', muted: '#53615C', line: '#C9D2CE' }),
    night: Object.freeze({ ground: '#0F1715', surface: '#17211E', sunken: '#0B1210', ink: '#E4ECE8', muted: '#98A9A2', line: '#2B3733' }),
  }),
  WARM: Object.freeze({
    day: Object.freeze({ ground: '#EFE9E1', surface: '#FFFFFF', sunken: '#E9E2D8', ink: '#2E201B', muted: '#625147', line: '#D5CABD' }),
    night: Object.freeze({ ground: '#1A1310', surface: '#241B17', sunken: '#140E0C', ink: '#F3E8DC', muted: '#B9A699', line: '#3A2E28' }),
  }),
});
export const NEUTRAL_TONES = Object.freeze(['COOL', 'WARM']);

/** Cool day `ground` and cool night `ground`. Kept by name for the callers that predate P22. */
export const DAY_GROUND = NEUTRALS.COOL.day.ground;
export const NIGHT_GROUND = NEUTRALS.COOL.night.ground;

/** Every ground an accent must read on, in both tones, so switching tone never breaks a saved accent. */
export const DAY_GROUNDS = Object.freeze([NEUTRALS.COOL.day.ground, NEUTRALS.WARM.day.ground]);
export const NIGHT_GROUNDS = Object.freeze([NEUTRALS.COOL.night.ground, NEUTRALS.WARM.night.ground]);

/**
 * The five fixed state colours, DESIGN-SYSTEM section 4b: a tint and a text and
 * edge colour, in day and night. No tone and no setting changes them.
 */
export const STATES = Object.freeze({
  open: Object.freeze({ day: { tint: '#FBEAC4', edge: '#7A4F00' }, night: { tint: '#3A2B0C', edge: '#F2C25B' } }),
  served: Object.freeze({ day: { tint: '#D2ECE5', edge: '#16614F' }, night: { tint: '#11322B', edge: '#6FD0BC' } }),
  bill: Object.freeze({ day: { tint: '#F5D8E5', edge: '#922457' }, night: { tint: '#3A1526', edge: '#F28FBB' } }),
  alert: Object.freeze({ day: { tint: '#F8DCD5', edge: '#A8321C' }, night: { tint: '#3D1610', edge: '#FF8B73' } }),
  ok: Object.freeze({ day: { tint: '#D6EADC', edge: '#256640' }, night: { tint: '#112F1E', edge: '#7BD69C' } }),
});

/** The five fixed state colours' text and edge values, day. An accent must not look like one. */
export const STATE_COLOURS = Object.freeze({
  open: STATES.open.day.edge,
  served: STATES.served.day.edge,
  bill: STATES.bill.day.edge,
  alert: STATES.alert.day.edge,
  ok: STATES.ok.day.edge,
});

/** The six accent presets, day values. Night values come from nightVariant. */
export const ACCENT_PRESETS = Object.freeze({
  OCEAN: '#1C5C86',
  INDIGO: '#3446A8',
  PLUM: '#6A3878',
  OLIVE: '#4F6328',
  ESPRESSO: '#55473F',
  GRAPHITE: '#343B41',
});

/** The example shown in the custom colour field. It passes every rule. */
export const EXAMPLE_ACCENT = '#2D5DA8';

/**
 * Three O'Clock's brand pair, as `setup/threeoclock.json` sets it: the sign-in
 * screen's colours on a device that has never signed in (features/brand/brand.js).
 */
export const DEFAULT_BRAND_COLOURS = Object.freeze({ brandHex: '#1A1A1A', onBrandHex: '#E2C08D' });

/** The examples shown in the brand colour fields, P22. A readable pair. */
export const EXAMPLE_BRAND = '#4A2E2A';
export const EXAMPLE_ON_BRAND = '#F2D7BC';

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_GROUND_CONTRAST = 3;
export const MIN_HUE_DISTANCE = 30;
export const LOW_SATURATION = 0.25;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** "#1C5C86" as { r, g, b }, 0 to 255, or null when it is not six-digit hex. */
export function parseHex(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const toHexPart = (value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0').toUpperCase();

export function toHex({ r, g, b }) {
  return `#${toHexPart(r)}${toHexPart(g)}${toHexPart(b)}`;
}

/** WCAG relative luminance, 0 to 1. */
export function relativeLuminance(hex) {
  const { r, g, b } = parseHex(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** { h, s, l }: hue in degrees 0 to 360, saturation and lightness 0 to 1. */
export function toHsl(hex) {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

/** HSL back to a hex colour, each channel rounded to the nearest whole number. */
export function fromHsl({ h, s, l }) {
  if (s === 0) return toHex({ r: l * 255, g: l * 255, b: l * 255 });
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hn = h / 360;
  return toHex({ r: hue(hn + 1 / 3) * 255, g: hue(hn) * 255, b: hue(hn - 1 / 3) * 255 });
}

/** The shorter way round the colour wheel between two hues, 0 to 180. */
export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The lowest contrast a colour has against any of the grounds given. */
export function lowestContrast(hex, grounds) {
  return Math.min(...grounds.map((ground) => contrastRatio(hex, ground)));
}

/**
 * The night variant of an accent: its HSL lightness raised by 0.01 at a time,
 * from its own, until it reaches 4.5 to 1 against both night grounds, cool and
 * warm. A colour that already reads on both is returned as it is. Warm night
 * ground is the lighter of the two by a little, and P22 measured every preset's
 * night value still passing on it, so no preset's night value moved.
 */
export function nightVariant(hex) {
  const { h, s, l } = toHsl(hex);
  let lightness = l;
  let candidate = toHex(parseHex(hex));
  while (lowestContrast(candidate, NIGHT_GROUNDS) < MIN_TEXT_CONTRAST && lightness < 1) {
    lightness = Math.min(1, Math.round((lightness + 0.01) * 100) / 100);
    candidate = fromHsl({ h, s, l: lightness });
  }
  return candidate;
}

/** The preset whose hue is nearest, for a refused colour's suggestion. */
export function nearestPreset(hex) {
  const { h } = toHsl(hex);
  let best = null;
  for (const [name, value] of Object.entries(ACCENT_PRESETS)) {
    const distance = hueDistance(h, toHsl(value).h);
    if (!best || distance < best.distance) best = { name, value, distance };
  }
  return best.name;
}

const PRESET_WORDS = { OCEAN: 'Ocean', INDIGO: 'Indigo', PLUM: 'Plum', OLIVE: 'Olive', ESPRESSO: 'Espresso', GRAPHITE: 'Graphite' };
const STATE_WORDS = { open: 'Open', served: 'Served', bill: 'Bill printed', alert: 'Late', ok: 'Paid' };

/**
 * Checks an owner's accent against the four rules in DESIGN-SYSTEM 4c.
 * Returns { ok: true } or { ok: false, rule, message, nearestPreset }.
 */
export function checkAccent(hex) {
  if (!parseHex(hex)) {
    return { ok: false, rule: 'FORMAT', message: 'Enter a six-digit colour, like #2D5DA8.', nearestPreset: 'OCEAN' };
  }
  const suggestion = nearestPreset(hex);
  const tryInstead = `Try ${PRESET_WORDS[suggestion]} instead.`;
  if (contrastRatio('#FFFFFF', hex) < MIN_TEXT_CONTRAST) {
    return { ok: false, rule: 'TEXT_CONTRAST', message: `White text on this colour is too faint to read. ${tryInstead}`, nearestPreset: suggestion };
  }
  if (lowestContrast(hex, DAY_GROUNDS) < MIN_GROUND_CONTRAST) {
    return { ok: false, rule: 'GROUND_CONTRAST', message: `This colour is too light to stand out on the page. ${tryInstead}`, nearestPreset: suggestion };
  }
  const { h, s } = toHsl(hex);
  if (s >= LOW_SATURATION) {
    for (const [state, value] of Object.entries(STATE_COLOURS)) {
      if (hueDistance(h, toHsl(value).h) < MIN_HUE_DISTANCE) {
        return {
          ok: false,
          rule: 'STATE_HUE',
          message: `This colour is too close to the ${STATE_WORDS[state]} state, so a button could look like a table's state. ${tryInstead}`,
          nearestPreset: suggestion,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * The brand pair, P22, DESIGN-SYSTEM section 4d: the logo's background and the
 * text that sits on it. Not an accent, so not held to the accent rules; only
 * readable. Returns { ok: true, ratio } or { ok: false, ratio, message }.
 */
export const MIN_BRAND_CONTRAST = 4.5;

export function checkBrandPair(brandHex, onBrandHex) {
  if (!parseHex(brandHex) || !parseHex(onBrandHex)) {
    return { ok: false, ratio: null, message: 'Enter two six-digit colours, like #4A2E2A.' };
  }
  const ratio = contrastRatio(brandHex, onBrandHex);
  if (ratio < MIN_BRAND_CONTRAST) {
    return {
      ok: false,
      ratio,
      message: `Text on the brand colour measures ${ratio.toFixed(1)} to 1. It needs at least 4.5 to 1 to be read.`,
    };
  }
  return { ok: true, ratio };
}

export default { checkAccent, checkBrandPair, contrastRatio, nearestPreset, nightVariant, parseHex, toHsl };
