/**
 * P62. Which machine this process is, and what that lets it write.
 *
 * `config.DEPLOYMENT_ROLE` decides it at boot. Everything else asks here,
 * so a test can play the box or the mirror without a second process; the
 * override refuses to run outside NODE_ENV=test, the same rule as the clock.
 *
 *   CLOUD   P12 to P61 unchanged: one hosted writer.
 *   BOX     the cafe box, the only writer, shipping its changes up.
 *   MIRROR  the cloud copy: read-only except intake, until promoted.
 */
import { config } from './env.js';

export const ROLES = Object.freeze({ CLOUD: 'CLOUD', BOX: 'BOX', MIRROR: 'MIRROR' });

let override = null;

export function currentRole() {
  return override ?? config.DEPLOYMENT_ROLE;
}

export const isBox = () => currentRole() === ROLES.BOX;
export const isMirror = () => currentRole() === ROLES.MIRROR;

/** Tests only: play another role until reset with null. */
export function setRoleForTest(role) {
  if (!config.isTest) throw new Error('The deployment role can only be changed in tests.');
  if (role !== null && !Object.values(ROLES).includes(role)) throw new Error(`Unknown role ${role}.`);
  override = role;
}
