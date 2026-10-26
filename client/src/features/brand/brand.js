/**
 * The restaurant's brand as this device remembers it. P22, DESIGN-SYSTEM
 * sections 4d and 11b.
 *
 * After a sign-in the logos (as small `data:` URLs), their hashes, the
 * wordmark, the accent pair, the neutral tone and the brand pair are kept with
 * this device's other settings, beside the printing settings. The sign-in
 * screen and the browser tab use them before anyone signs in, so the screen a
 * cashier opens in the morning already looks like their restaurant. Signing
 * out keeps them. None of it is secret: it is what the restaurant shows anyone
 * who walks in.
 */

import { ACCENT_PRESETS, DEFAULT_BRAND_COLOURS, nightVariant } from '../../utils/colour.js';
import logoOnDark from '../../assets/brand/threeoclock-logo-dark-ground.png';
import logoOnLight from '../../assets/brand/threeoclock-logo-light-ground.png';

/** The product's own name, for a device that has never seen a restaurant. */
export const PRODUCT_NAME = "Three O'Clock";

export const EMPTY_BRAND = Object.freeze({
  wordmark: null,
  accent: null,
  accentNight: null,
  neutralTone: 'COOL',
  brandHex: null,
  onBrandHex: null,
  logos: { LIGHT_GROUND: null, DARK_GROUND: null },
});

/**
 * 2026-10-26, at Rishi's word: this repository is Three O'Clock's own, so a
 * device that has never signed in shows Three O'Clock's logo, name and colours
 * (setup/threeoclock.json) rather than a blank product look. The logos are
 * files built into the screens, so they need no sign-in to fetch.
 */
export const DEFAULT_BRAND = Object.freeze({
  wordmark: PRODUCT_NAME,
  accent: ACCENT_PRESETS.ESPRESSO,
  accentNight: nightVariant(ACCENT_PRESETS.ESPRESSO),
  neutralTone: 'WARM',
  ...DEFAULT_BRAND_COLOURS,
  logos: {
    LIGHT_GROUND: { hash: null, dataUrl: logoOnLight },
    DARK_GROUND: { hash: null, dataUrl: logoOnDark },
  },
});

/**
 * The brand to draw: the signed-in restaurant's live appearance with this
 * device's saved logo images, or, before sign-in, what this device saved last,
 * or Three O'Clock's own on a device that has saved nothing.
 */
export function resolveBrand({ appearance, restaurantName, saved }) {
  const stored = saved ? { ...EMPTY_BRAND, ...saved } : DEFAULT_BRAND;
  if (!appearance) return stored;

  const logos = {};
  for (const slot of ['LIGHT_GROUND', 'DARK_GROUND']) {
    const live = appearance.logos?.[slot] ?? null;
    const kept = stored.logos?.[slot] ?? null;
    // A saved image is used only while it is the one the server still has.
    logos[slot] = live && kept?.hash === live.hash ? kept : null;
  }
  return {
    wordmark: appearance.wordmark || restaurantName || null,
    accent: appearance.accent,
    accentNight: appearance.accentNight,
    neutralTone: appearance.neutralTone ?? 'COOL',
    brandHex: appearance.brandHex ?? null,
    onBrandHex: appearance.onBrandHex ?? null,
    logos,
  };
}

/** The name to show when there is no logo: the wordmark, then the restaurant, then the product. */
export function brandName(brand, restaurantName) {
  return brand?.wordmark || restaurantName || PRODUCT_NAME;
}
