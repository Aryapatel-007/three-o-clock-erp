/**
 * Authentication.
 *
 * The shapes returned here are fixed by docs/API-CONTRACT.md sections 1.1 to
 * 1.6. Nothing in this file touches the stored credential. services/
 * authService.js owns it, so a grep of this folder for the field name comes
 * back empty and stays that way.
 */
import { currentRole } from '../config/deployment.js';
import { ROLES } from '../config/roles.js';
import { syncMode } from '../services/sync/mode.js';
import { conflictsUnseen } from '../services/sync/statusService.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { Branch } from '../models/Branch.js';
import { REVOKE_REASONS } from '../models/RefreshToken.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import {
  setPassword,
  verifyCredentials,
  verifyPasswordFor,
} from '../services/authService.js';
import {
  accessTokenLifetimeSeconds,
  issueAccessToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeOne,
  rotateRefreshToken,
} from '../services/tokenService.js';
import { presentLogos } from '../services/brandLogoService.js';
import { getSettings, presentAppearance } from '../services/settingsService.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../utils/authCookie.js';
import {
  BusinessRuleError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from '../utils/errors.js';
import { resetPasswordFromSignIn } from '../services/passwordResetService.js';
import { sendSuccess } from '../utils/response.js';
import { nowUtc } from '../utils/time.js';
import { activeOrderChannels, activeTerminals, whatsappOn } from '../services/integrations/channelStatus.js';
import { writeRefusal } from '../models/plugins/writerGuard.js';

function presentUser(user, { includeLastLoginAt = false, includeStation = false } = {}) {
  const shape = {
    id: String(user._id),
    name: user.name,
    phone: user.phone,
    email: user.email ?? null,
    role: user.role,
    restaurantId: String(user.restaurantId),
    branchId: String(user.branchId),
  };
  if (includeLastLoginAt) shape.lastLoginAt = user.lastLoginAt ?? null;
  // P05. The station a KITCHEN user's screen opens on. GET /auth/me only.
  if (includeStation) shape.stationId = user.stationId ? String(user.stationId) : null;
  return shape;
}

function presentRestaurant(restaurant, { includeGstin = false } = {}) {
  const shape = { id: String(restaurant._id), name: restaurant.name };
  if (includeGstin) shape.gstin = restaurant.gstin ?? null;
  return shape;
}

function presentBranch(branch) {
  return { id: String(branch._id), name: branch.name };
}

function requestContext(req) {
  return { userAgent: req.get('user-agent'), ipAddress: req.ip };
}

/**
 * POST /auth/login
 *
 * The body carries exactly one of `phone` or `email`, plus the password. Every
 * failure produces one identical response. The order below matters: the dummy
 * comparison on the not-found path is what keeps the response time the same
 * whether or not the identifier is registered.
 */
export async function login(req, res) {
  const { phone, email, password } = req.body;

  const { user, failure } = await verifyCredentials({ phone, email }, password);

  if (failure) {
    req.log?.warn(
      { reason: failure, by: email ? 'email' : 'phone', userId: user ? String(user._id) : null },
      'Login failed.',
    );
    throw new InvalidCredentialsError();
  }

  // Legitimate unguarded query pattern 1: lookup by _id from a trusted record.
  const restaurant = await Restaurant.findById(user.restaurantId);

  if (!restaurant || restaurant.isActive === false) {
    req.log?.warn(
      { reason: 'RESTAURANT_INACTIVE', userId: String(user._id), restaurantId: String(user.restaurantId) },
      'Login failed.',
    );
    throw new InvalidCredentialsError();
  }

  const branch = await Branch.findOne({ _id: user.branchId, restaurantId: user.restaurantId });
  if (!branch) {
    req.log?.error(
      { reason: 'BRANCH_MISSING', userId: String(user._id), restaurantId: String(user.restaurantId) },
      'Login failed: user points at a branch that does not exist.',
    );
    throw new InvalidCredentialsError();
  }

  const accessToken = issueAccessToken(user);
  const refreshToken = await issueRefreshToken(user, requestContext(req));

  // P62. Signing in works wherever writing does not: the read-only cloud copy,
  // a box that stood down, a box whose clock is wrong. There the last sign-in
  // time is simply not written; the user record belongs to the writer.
  if (!writeRefusal('User')) {
    user.lastLoginAt = nowUtc();
    await user.save();
  }

  // The refresh token leaves the server once, in an httpOnly cookie the browser
  // stores and JavaScript cannot read. It is never in the response body.
  setRefreshCookie(res, refreshToken);

  return sendSuccess(res, {
    accessToken,
    expiresInSeconds: accessTokenLifetimeSeconds(accessToken),
    user: presentUser(user),
    restaurant: presentRestaurant(restaurant),
    branch: presentBranch(branch),
  });
}

/**
 * POST /auth/refresh
 *
 * The credential is the `refreshToken` cookie. Rotation and reuse detection
 * both live in the token service, which throws InvalidRefreshTokenError for a
 * missing, unknown, expired or revoked token. On any of those the cookie is
 * cleared as well, so the browser stops re-sending a dead credential.
 *
 * The `X-Requested-With` header is enforced by requireCsrfHeader on the route.
 */
export async function refresh(req, res) {
  try {
    const rawToken = readRefreshCookie(req);
    if (!rawToken) throw new InvalidRefreshTokenError();

    const { stored, refreshToken } = await rotateRefreshToken(rawToken, requestContext(req));

    const user = await User.findOne({ _id: stored.userId, restaurantId: stored.restaurantId });

    if (!user || user.isActive === false) {
      await revokeAllForUser(
        { restaurantId: stored.restaurantId, userId: stored.userId },
        REVOKE_REASONS.USER_DEACTIVATED,
      );
      throw new InvalidRefreshTokenError();
    }

    const accessToken = issueAccessToken(user);

    setRefreshCookie(res, refreshToken);

    return sendSuccess(res, {
      accessToken,
      expiresInSeconds: accessTokenLifetimeSeconds(accessToken),
    });
  } catch (error) {
    if (error instanceof InvalidRefreshTokenError) clearRefreshCookie(res);
    throw error;
  }
}

/**
 * POST /auth/logout
 *
 * Revokes the session named by the `refreshToken` cookie, then clears the
 * cookie. Always 200, even for a missing cookie or a token that was unknown or
 * already revoked. Logout must never fail in a way that strands someone on a
 * POS screen mid-service.
 */
export async function logout(req, res) {
  const rawToken = readRefreshCookie(req);
  if (rawToken) await revokeOne(rawToken, REVOKE_REASONS.LOGOUT);
  clearRefreshCookie(res);
  return sendSuccess(res, { loggedOut: true });
}

/** POST /auth/logout-all */
export async function logoutAll(req, res) {
  const sessionsRevoked = await revokeAllForUser(
    { restaurantId: req.restaurantId, userId: req.user.id },
    REVOKE_REASONS.LOGOUT_ALL,
  );

  // This device's cookie points at one of the sessions just revoked.
  clearRefreshCookie(res);

  return sendSuccess(res, { sessionsRevoked });
}

/**
 * GET /auth/me
 *
 * Reads live, so a role changed five minutes ago shows here rather than
 * whatever the token was minted with. The authenticate middleware already
 * loaded the user and the restaurant on this request, so this reuses them
 * instead of reading the same two documents twice.
 */
export async function me(req, res) {
  const branch = await Branch.findOne({
    _id: req.branchId,
    restaurantId: req.restaurantId,
  });

  // P02. Every role gets the feature switches, because every screen needs to
  // know what to hide and GET /settings is owner and manager only.
  // P08. The cashier platform-discount switch too, so the till knows whether
  // to show a cashier the discount panel. The server still decides.
  // P19. The floor settings too: the section order, when a table runs long, and
  // whether the guest picker may offer "Skip". The server still decides.
  // P20A. The look too, with the night accent worked out on the server.
  // P23. Online orders too: whether this device's role hears the alert, and
  // the page address for the copy-link button. The server still decides.
  // P25. Whether a captain may bill and take payment, so the order screen knows. The server still decides.
  // P25 Part F. The active notes and coins, for the cash counter on the till.
  // P29. Revisions, print before payment, ready means served and the cash book's categories and usual float.
  const { features, discounts, billing, approvals, floor, appearance, online, cash, kitchen, payments } = await getSettings(req.restaurantId, { req });
  const now = nowUtc();

  return sendSuccess(res, {
    user: presentUser(req.currentUser, { includeLastLoginAt: true, includeStation: true }),
    restaurant: presentRestaurant(req.currentRestaurant, { includeGstin: true }),
    branch: branch ? presentBranch(branch) : null,
    features,
    discounts: {
      cashierMayApplyPlatformDiscounts: discounts.cashierMayApplyPlatformDiscounts,
    },
    billing: {
      captainsMayBill: billing.captainsMayBill,
      captainsMayTakePayment: billing.captainsMayTakePayment,
      reviseUnpaidBills: billing.reviseUnpaidBills,
      printBeforePayment: billing.printBeforePayment,
    },
    // P28. What needs a manager's PIN, so the till and the captain know when to ask. The server still decides.
    approvals: {
      lineCancel: approvals.lineCancel,
      paidIn: approvals.paidIn,
      managerTasks: approvals.managerTasks,
      revisePrintedBill: approvals.revisePrintedBill,
    },
    kitchen: { readyMeansServed: kitchen.readyMeansServed, splitTicketsByStation: kitchen.splitTicketsByStation !== false },
    // P47. The modes Other offers one tap each; a cashier cannot read GET /settings.
    payments: { otherModes: payments?.otherModes ?? [] },
    // P25 Part I. The card machines this device may send a payment to.
    terminals: await activeTerminals(req),
    cash: {
      denominations: cash.denominations
        .filter((entry) => entry.isActive)
        .map(({ valueInPaise, kind }) => ({ valueInPaise, kind })),
      expenseCategories: cash.expenseCategories
        .filter((entry) => entry.isActive)
        .map(({ code, label }) => ({ code, label })),
      usualFloatInPaise: cash.usualFloatInPaise,
    },
    floor,
    online: {
      enabled: features.online,
      takeawayEnabled: online.takeawayEnabled,
      reservationsEnabled: online.reservationsEnabled,
      alertRoles: [...online.alertRoles],
      publicSlug: branch?.online?.publicSlug ?? null,
      pausedUntil: branch?.online?.pausedUntil && branch.online.pausedUntil > now ? branch.online.pausedUntil : null,
      // P30. The opening hours, so every screen keeps its heartbeat to working hours.
      opensAtMinutes: online.opensAtMinutes,
      closesAtMinutes: online.closesAtMinutes,
      // P25 Part H. The delivery platforms connected and on: their orders arrive in the same inbox.
      platformChannels: await activeOrderChannels(req),
      // P51. WhatsApp is on: chats waiting for a person ring the same alert, for the till.
      chats: await whatsappOn(req),
    },
    // P33. Whether the live channel is on, and where to open it: a page on
    // Vercel reaches the API through a rewrite that does not carry a WebSocket.
    live: { enabled: config.LIVE_CHANNEL === 'on', origin: config.LIVE_ORIGIN },
    // P63. Owners and managers see how many sync conflicts wait to be read.
    sync: {
      mode: syncMode(),
      // Which server answered: CLOUD (the website), BOX (the cafe PC) or MIRROR. The cafe
      // server's connection bar and banner show only off the website.
      server: currentRole(),
      conflictsUnseen: [ROLES.OWNER, ROLES.MANAGER].includes(req.user.role) ? await conflictsUnseen(req.restaurantId) : null,
    },
    // P22. Each logo slot's hash and size, never its bytes: a device fetches a
    // logo only when the hash differs from the one it saved.
    appearance: { ...presentAppearance(appearance, req.currentRestaurant?.name), logos: presentLogos(req.currentRestaurant) },
  });
}

/**
 * PATCH /auth/password
 *
 * The "new password is the same as the old one" check lives here rather than
 * in the Zod schema. docs/API-CONTRACT.md section 1.6 wants 422
 * BUSINESS_RULE_VIOLATED for it, and every failure raised inside a schema
 * comes back as 400 VALIDATION_FAILED through the validate middleware. It is a
 * business rule, not a malformed request.
 */
export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  if (newPassword === currentPassword) {
    throw new BusinessRuleError('The new password must be different from the current one.');
  }

  const { matches, user } = await verifyPasswordFor(
    { userId: req.user.id, restaurantId: req.restaurantId },
    currentPassword,
  );

  if (!matches) {
    req.log?.warn({ reason: 'WRONG_CURRENT_PASSWORD', userId: req.user.id }, 'Password change failed.');
    throw new InvalidCredentialsError();
  }

  // The service stamps passwordChangedAt in the same save, which is what makes
  // the old 15 minute access token stop working.
  await setPassword(user, newPassword);

  /**
   * Every session ends, including the one that made this request. A password
   * change that leaves old sessions alive is not a password change: the whole
   * reason someone changes a password is that they think someone else has it.
   */
  const sessionsRevoked = await revokeAllForUser(
    { restaurantId: req.restaurantId, userId: req.user.id },
    REVOKE_REASONS.PASSWORD_CHANGED,
  );

  clearRefreshCookie(res);

  logger.info({ userId: req.user.id, restaurantId: req.restaurantId, sessionsRevoked }, 'Password changed.');

  return sendSuccess(res, { passwordChanged: true });
}

/**
 * POST /auth/password-reset. P34, API-CONTRACT 1.7.
 *
 * Public. A person who cannot sign in sets a new password while an owner or
 * manager beside them approves it with their own phone and PIN. Issues no
 * token: the screen signs in afterwards through the ordinary login.
 */
export async function passwordReset(req, res) {
  return sendSuccess(res, await resetPasswordFromSignIn(req, req.body));
}
