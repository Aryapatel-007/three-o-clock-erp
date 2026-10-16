import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import * as authApi from '../api/authApi.js';
import { setAccessToken, setSessionHandlers } from '../api/client.js';

/**
 * The session.
 *
 * Holds the signed-in user and the access token, and nothing else. It does not
 * decide what the user may do. React can hide a button, but the server is what
 * stops the action.
 *
 * The access token is kept in React state, in memory, and never in
 * localStorage: a 15 minute credential should die with the tab. The refresh
 * token is an httpOnly cookie set by the server (M0-D). The client never sees
 * it, never stores it, and cannot read it; the browser sends it to the auth
 * endpoints on its own. So there is nothing to persist here and no way to tell
 * from JavaScript whether a session exists without asking the server.
 */

const AuthContext = createContext(null);

/**
 * Which optional modules this restaurant uses, from GET /auth/me (P02).
 *
 * Both on until the server says otherwise. Hiding a link here is tidiness only:
 * a switched-off feature is refused by requireFeature on the server whatever
 * this says.
 */
const ALL_FEATURES_ON = Object.freeze({ inventory: true, attendance: true });

/**
 * What the screens read from GET /auth/me: the feature switches, plus P08's
 * cashier platform-discount switch, off until the server says otherwise. Kept
 * in the same bag because both answer "what should this screen show".
 */
const DEFAULT_FLOOR = Object.freeze({ sectionOrder: [], longOpenMinutes: 90, requireGuestCount: false });

/** P23. Off until /auth/me says otherwise, so no device chimes by mistake. */
const DEFAULT_ONLINE = Object.freeze({
  enabled: false,
  takeawayEnabled: false,
  reservationsEnabled: false,
  alertRoles: [],
  publicSlug: null,
  pausedUntil: null,
  // P25 Part H. The delivery platforms connected and on.
  platformChannels: [],
  // P51. WhatsApp is on: chats waiting for a person ring the same alert.
  chats: false,
});

/** P20A. Ocean and no second language until /auth/me says otherwise. */
const DEFAULT_APPEARANCE = Object.freeze({
  accentPreset: 'OCEAN',
  accent: null,
  accentNight: null,
  wordmark: null,
  secondLanguage: 'NONE',
  todayTiles: null,
});

const fromMe = (me) => ({
  ...ALL_FEATURES_ON,
  ...me.features,
  cashierMayApplyPlatformDiscounts: Boolean(me.discounts?.cashierMayApplyPlatformDiscounts),
  // P25 Part D. Whether a captain may make a bill, and take its payment. The server still decides.
  billing: {
    captainsMayBill: me.billing?.captainsMayBill ?? true,
    captainsMayTakePayment: Boolean(me.billing?.captainsMayTakePayment),
    // P29. Revise an unpaid bill rather than void it, and print it before taking payment.
    reviseUnpaidBills: me.billing?.reviseUnpaidBills ?? true,
    printBeforePayment: me.billing?.printBeforePayment ?? true,
    // Counter Sale: a sent takeaway is billed and paid before the kitchen is done.
    payFirstTakeaway: me.billing?.payFirstTakeaway ?? true,
  },
  // P33. The live channel: on or off, and the address to open it on (null: this page's own).
  live: { enabled: Boolean(me.live?.enabled), origin: me.live?.origin ?? null },
  // P28. What needs an owner's or manager's PIN. The server still decides.
  approvals: {
    lineCancel: me.approvals?.lineCancel ?? true,
    paidIn: me.approvals?.paidIn ?? true,
    managerTasks: me.approvals?.managerTasks ?? true,
    revisePrintedBill: me.approvals?.revisePrintedBill ?? true,
  },
  // P29 Part C. The kitchen's ready also serves the dish.
  kitchen: { readyMeansServed: me.kitchen?.readyMeansServed ?? true },
  // P47. The modes Other offers one tap each.
  payments: { otherModes: me.payments?.otherModes ?? null },
  // P25 Part F. The active notes and coins, for the cash counter.
  // P29 Part F. The cash book's expense categories and the usual float.
  cash: {
    denominations: me.cash?.denominations ?? [],
    expenseCategories: me.cash?.expenseCategories ?? [],
    usualFloatInPaise: me.cash?.usualFloatInPaise ?? 200000,
  },
  // P25 Part I. The card machines this device may send a payment to.
  terminals: me.terminals ?? [],
  // P19. Section order, the long-open threshold and whether the guest picker may offer Skip.
  floor: { ...DEFAULT_FLOOR, ...(me.floor ?? {}) },
  // P20A. The accent, both colours already worked out by the server.
  appearance: { ...DEFAULT_APPEARANCE, ...(me.appearance ?? {}) },
  // The top bar's wordmark falls back to the restaurant's name.
  restaurantName: me.restaurant?.name ?? null,
  // P23. Online orders: whether this role hears the alert, and the page address.
  online: { ...DEFAULT_ONLINE, ...(me.online ?? {}) },
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [features, setFeatures] = useState(ALL_FEATURES_ON);

  // True until we know whether there is a session to restore. Starting at
  // false would flash the login screen at someone who is already signed in.
  const [isRestoring, setIsRestoring] = useState(true);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    setFeatures(ALL_FEATURES_ON);
  }, []);

  /**
   * Reads the feature switches again. Called after an owner saves Settings, so
   * the links follow the change without a reload.
   */
  const refreshFeatures = useCallback(async () => {
    const me = await authApi.getCurrentUser();
    setFeatures(fromMe(me));
    return me.features;
  }, []);

  const login = useCallback(async (credentials) => {
    // credentials is { phone, password } or { email, password }.
    const data = await authApi.login(credentials);
    // The refresh token came back as a cookie, not in `data`.
    setAccessToken(data.accessToken);

    // The login response does not carry the feature switches, so read them
    // before the user is set: a screen should never draw a link and then
    // take it away again a moment later.
    try {
      const me = await authApi.getCurrentUser();
      setFeatures(fromMe(me));
    } catch {
      setFeatures(ALL_FEATURES_ON);
    }

    setUser(data.user);
    setToken(data.accessToken);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      // Tell the server so the refresh token is revoked and its cookie cleared.
      // Clearing local state alone would end the session in this tab and nowhere
      // else, and leave the cookie live.
      await authApi.logout();
    } catch {
      // Logout must never fail visibly. The local session goes either way.
    } finally {
      clearSession();
    }
  }, [clearSession]);

  /**
   * Exchanges the refresh-token cookie for a new access token.
   *
   * Returns the new access token, or null when the session is genuinely over.
   * The API client calls this once on TOKEN_EXPIRED and gives up if it returns
   * null, so there is exactly one retry path in the app rather than two.
   */
  const refresh = useCallback(async () => {
    const data = await authApi.refreshSession();
    if (!data) return null;

    // Rotation happens server-side and the new refresh token is set as a fresh
    // cookie. The client only takes the new access token.
    setToken(data.accessToken);
    return data.accessToken;
  }, []);

  // Keep the API client in step with the token it should be sending.
  useEffect(() => {
    setAccessToken(token);
  }, [token]);

  useEffect(() => {
    setSessionHandlers({ refresh, sessionLost: clearSession });
  }, [refresh, clearSession]);

  // Restore the session on a page reload, so a hard refresh mid-shift does not
  // drop someone at the login screen. There is no stored token to check first:
  // just ask the server to refresh, and treat a failure as "no session".
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      try {
        const data = await authApi.refreshSession();
        if (cancelled) return;

        if (!data) {
          clearSession();
          return;
        }

        setAccessToken(data.accessToken);
        setToken(data.accessToken);

        const me = await authApi.getCurrentUser();
        if (!cancelled) {
          setFeatures(fromMe(me));
          setUser(me.user);
        }
      } catch {
        if (!cancelled) clearSession();
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
  }, [clearSession]);

  const value = useMemo(
    () => ({
      user,
      token,
      isAuthenticated: user !== null,
      isRestoring,
      features,
      refreshFeatures,
      login,
      logout,
      refresh,
    }),
    [user, token, isRestoring, features, refreshFeatures, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth must be used inside an AuthProvider.');
  }
  return context;
}
