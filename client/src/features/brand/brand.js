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

/** The product's own name, for a device that has never seen a restaurant. */
export const PRODUCT_NAME = 'Dakaar';

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
 * The brand to draw: the signed-in restaurant's live appearance with this
 * device's saved logo images, or, before sign-in, what this device saved last.
 */
export function resolveBrand({ appearance, restaurantName, saved }) {
  const stored = { ...EMPTY_BRAND, ...(saved ?? {}) };
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
