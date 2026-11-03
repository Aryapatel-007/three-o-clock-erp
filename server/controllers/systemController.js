/**
 * The server's own records. P30, API-CONTRACT P30 section 3.
 */
import { isBox } from '../config/deployment.js';
import { backupStatus } from '../services/backup/statusService.js';
import { listInstalledPrinters } from '../services/printerListService.js';
import { readServerStarts } from '../services/serverStartService.js';
import { NotFoundError } from '../utils/errors.js';
import { sendSuccess } from '../utils/response.js';

/** GET /system/starts. OWNER only. */
export async function getServerStarts(req, res) {
  return sendSuccess(res, await readServerStarts(req, { days: req.query.days }));
}

/**
 * GET /system/printers. OWNER, MANAGER, CASHIER. 2026-11-03. The printers Windows has on
 * the restaurant PC, for the Printers screen; only the box has printers to list.
 */
export async function getInstalledPrinters(req, res) {
  if (!isBox()) throw new NotFoundError();
  const printers = await listInstalledPrinters();
  return sendSuccess(res, { checked: printers !== null, printers: printers ?? [] });
}

/** GET /system/backups. OWNER only. P54. */
export async function getServerBackups(req, res) {
  return sendSuccess(res, await backupStatus());
}
