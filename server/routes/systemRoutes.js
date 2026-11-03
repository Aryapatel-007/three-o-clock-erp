/**
 * System routes. P30.
 *
 * The record of server starts is about the server, which every restaurant
 * shares, and it says when the server slept. It is the owner's to read.
 */
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import { getInstalledPrinters, getServerBackups, getServerStarts } from '../controllers/systemController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { installedPrintersSchema, serverBackupsSchema, serverStartsSchema } from '../validators/systemValidators.js';

const router = Router();

router.get('/system/starts', authenticate, tenant, requireRole(ROLES.OWNER), validate(serverStartsSchema), getServerStarts);
// P54. The backups, the owner's to read, like the starts.
router.get('/system/backups', authenticate, tenant, requireRole(ROLES.OWNER), validate(serverBackupsSchema), getServerBackups);
// 2026-11-03. The restaurant PC's printers, for the Printers screen. The box only.
router.get(
  '/system/printers',
  authenticate,
  tenant,
  requireRole(ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER),
  validate(installedPrintersSchema),
  getInstalledPrinters,
);

export default router;
