import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { fetchLogoDataUrl, LOGO_SLOT_NAMES } from '../api/brand.js';
import { brandName, EMPTY_BRAND, resolveBrand } from '../features/brand/brand.js';
import { setBrowserTab } from '../features/brand/browserTab.js';
import { useDeviceSettings } from '../features/printing/useDeviceSettings.js';
import { useAuth } from './AuthContext.jsx';

/**
 * The look on this device. P20A and P22, DESIGN-SYSTEM sections 4, 11 and 13.
 *
 * Sets these on the root element, which every token in index.css reads:
 * `data-theme` (day or night), `data-neutral` (cool or warm), `--accent` and
 * `--accent-night`, `--brand` and `--on-brand`, `data-density` and
 * `data-text-size`. It also names the browser tab after the restaurant and
 * gives it the restaurant's logo.
 *
 * Automatic is Day on every screen, the kitchen included (the owner's call,
 * 2 October 2026). A device that wants Night chooses it on This device.
 *
 * Before sign-in it is Day, in the look of the last restaurant signed in on
 * this device (P22): its accent, tone, brand colours and logo, kept with this
 * device's settings. A device that has never seen a restaurant is Ocean, cool.
 */
const ThemeContext = createContext({ theme: 'day', neutral: 'cool', secondLanguage: 'NONE', brand: EMPTY_BRAND, name: '' });

export function themeFor(setting) {
  return setting === 'NIGHT' ? 'night' : 'day';
}

/** The signed-in restaurant's brand, without images, as a string that changes when anything saved would. */
const brandKey = (brand) =>
  JSON.stringify({ ...brand, logos: LOGO_SLOT_NAMES.map((slot) => brand.logos?.[slot]?.hash ?? null) });

/**
 * Keeps this device's saved brand in step with the signed-in restaurant: the
 * colours and wordmark every time they change, and a logo image only when its
 * hash differs from the one saved.
 */
function useBrandSync({ user, appearance, restaurantName, saved, updateDevice }) {
  const inFlight = useRef(null);
  // A brand whose logo could not be fetched is not tried again until the next
  // sign-in, so a failing request cannot repeat on every render.
  const gaveUp = useRef(new Set());

  useEffect(() => {
    if (!user || !appearance) return undefined;
    let cancelled = false;

    const live = resolveBrand({ appearance, restaurantName, saved: null });
    const wanted = { ...live, logos: appearance.logos ?? EMPTY_BRAND.logos };
    const key = brandKey(wanted);
    const savedKey = saved ? brandKey(saved) : null;
    if (key === savedKey || inFlight.current === key || gaveUp.current.has(key)) return undefined;
    inFlight.current = key;

    (async () => {
      const logos = {};
      let complete = true;
      for (const slot of LOGO_SLOT_NAMES) {
        const meta = appearance.logos?.[slot] ?? null;
        const kept = saved?.logos?.[slot] ?? null;
        if (!meta) logos[slot] = null;
        else if (kept?.hash === meta.hash && kept.dataUrl) logos[slot] = kept;
        else {
          try {
            logos[slot] = { ...meta, dataUrl: await fetchLogoDataUrl(slot) };
          } catch {
            // Not fatal: the text wordmark shows until the next sign-in fetches it.
            logos[slot] = null;
            complete = false;
          }
        }
      }
      if (!complete) gaveUp.current.add(key);
      if (!cancelled) updateDevice({ brand: { ...live, logos } });
      inFlight.current = null;
    })();

    return () => {
      cancelled = true;
      inFlight.current = null;
    };
  }, [user, appearance, restaurantName, saved, updateDevice]);
}

/**
 * 2026-10-22. The cafe PC's print window, by the titles box/windows/print-agent.ps1
 * looks for: running (hidden), or sent to sign in first (left on screen). Null elsewhere.
 */
function printerWindowTitle() {
  const { pathname } = window.location;
  if (pathname.startsWith('/print-station')) return "Three O'Clock printer";
  if (pathname === '/login' && window.history.state?.usr?.from?.pathname === '/print-station') return "Three O'Clock printer - sign in";
  return null;
}

export function ThemeProvider({ children }) {
  const { user, features } = useAuth();
  const [device, updateDevice] = useDeviceSettings();

  const appearance = user ? features.appearance : null;
  const restaurantName = user ? features.restaurantName : null;
  const theme = user ? themeFor(device.theme) : 'day';
  const secondLanguage = device.secondLanguage ?? appearance?.secondLanguage ?? 'NONE';

  useBrandSync({ user, appearance, restaurantName, saved: device.brand, updateDevice });

  const brand = useMemo(
    () => resolveBrand({ appearance, restaurantName, saved: device.brand }),
    [appearance, restaurantName, device.brand],
  );
  const name = brandName(brand, restaurantName);

  // P22. The restaurant's neutral set, cool unless it chose warm.
  const neutral = brand.neutralTone === 'WARM' ? 'warm' : 'cool';

  useEffect(() => {
    document.documentElement.dataset.neutral = neutral;
  }, [neutral]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.density = device.density === 'COMPACT' ? 'compact' : 'comfortable';
    root.dataset.textSize = String(device.textSize ?? 100);
  }, [theme, device.density, device.textSize]);

  useEffect(() => {
    const root = document.documentElement;
    if (brand.accent && brand.accentNight) {
      root.style.setProperty('--accent', brand.accent);
      root.style.setProperty('--accent-night', brand.accentNight);
    } else {
      // Ocean, from index.css.
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-night');
    }
  }, [brand.accent, brand.accentNight]);

  useEffect(() => {
    const root = document.documentElement;
    if (brand.brandHex && brand.onBrandHex) {
      root.style.setProperty('--brand', brand.brandHex);
      root.style.setProperty('--on-brand', brand.onBrandHex);
    } else {
      root.style.removeProperty('--brand');
      root.style.removeProperty('--on-brand');
    }
  }, [brand.brandHex, brand.onBrandHex]);

  useEffect(() => {
    // 2026-10-22. The cafe PC's hidden print window keeps the title box/windows/print-agent.ps1 finds it by.
    setBrowserTab({ title: printerWindowTitle() ?? name, brand });
  }, [name, brand]);

  // The sign-in screen the print window was sent to: titled so the agent leaves it on screen.
  const { pathname } = useLocation();
  useEffect(() => {
    const title = printerWindowTitle();
    if (title) document.title = title;
  }, [pathname]);

  const value = useMemo(() => ({ theme, neutral, secondLanguage, brand, name }), [theme, neutral, secondLanguage, brand, name]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
