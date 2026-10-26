/**
 * Network routes. P62, API-CONTRACT P62 section 4.
 *
 * `ping` and `setup` answer without a sign-in: a tablet that has lost its
 * session, or has never had one, must still learn whether it can reach the
 * box and where to go. Neither touches the database or says a password.
 */
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import {
  getNetworks,
  getPing,
  getSelf,
  getSetup,
  getStatus,
  postConnect,
  postReport,
  putStaffWifi,
} from '../controllers/networkController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { networkReadSchema, networkReportSchema, staffWifiSchema, wifiConnectSchema } from '../validators/networkValidators.js';

const router = Router();

router.get('/network/ping', getPing);
router.get('/network/setup', getSetup);

router.post('/network/report', authenticate, tenant, validate(networkReportSchema), postReport);
router.get('/network/self', authenticate, tenant, validate(networkReadSchema), getSelf);
router.get('/network/status', authenticate, tenant, requireRole(ROLES.OWNER, ROLES.MANAGER), validate(networkReadSchema), getStatus);
router.get('/network/wifi/networks', authenticate, tenant, requireRole(ROLES.OWNER), validate(networkReadSchema), getNetworks);
router.post('/network/wifi/connect', authenticate, tenant, requireRole(ROLES.OWNER), validate(wifiConnectSchema), postConnect);
router.put('/network/staff-wifi', authenticate, tenant, requireRole(ROLES.OWNER, ROLES.MANAGER), validate(staffWifiSchema), putStaffWifi);

export default router;
