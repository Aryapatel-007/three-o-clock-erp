/**
 * P63. Whether this machine is one of two writers kept in step, and which.
 *
 *   ONE_WAY  (default) P62 exactly: one writer, the other a mirror.
 *   TWO_WAY  the cafe PC (BOX) and the cloud (CLOUD) both write; the box
 *            pulls the cloud's changes and pushes its own.
 *
 * Asked here, never read from config elsewhere, so a test can play either.
 */
import { currentRole, ROLES } from '../../config/deployment.js';
import { config } from '../../config/env.js';
import { SYNC_NODES } from '../../config/sync.js';

let override = null;

export const SYNC_MODES = Object.freeze({ ONE_WAY: 'ONE_WAY', TWO_WAY: 'TWO_WAY' });

export function syncMode() {
  return override ?? config.SYNC_MODE ?? SYNC_MODES.ONE_WAY;
}

/** True on a BOX or a CLOUD set to TWO_WAY. A mirror is never two-way. */
export function isTwoWay() {
  return syncMode() === SYNC_MODES.TWO_WAY && currentRole() !== ROLES.MIRROR;
}

/** BOX or CLOUD: which side of the pair this machine is. */
export function syncNode() {
  return currentRole() === ROLES.BOX ? SYNC_NODES.BOX : SYNC_NODES.CLOUD;
}

/** The cloud while two-way: the side that draws numbers from the W series. */
export function isTwoWayCloud() {
  return isTwoWay() && syncNode() === SYNC_NODES.CLOUD;
}

/** Tests only. */
export function setSyncModeForTest(mode) {
  if (!config.isTest) throw new Error('The sync mode can only be changed in tests.');
  if (mode !== null && !Object.values(SYNC_MODES).includes(mode)) throw new Error(`Unknown sync mode ${mode}.`);
  override = mode;
}
