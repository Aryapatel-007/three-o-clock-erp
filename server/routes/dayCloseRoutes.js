/**
 * Cash drawer and Day Close routes. P10.
 *
 * The till records the float and cash paid in; taking cash out is manager
 * work, checked in cashService because one endpoint takes all three types.
 * Closing a day and reading a close are for the owner and manager; only the
 * owner reopens a closed day.
 */
import { isTwoWayCloud } from '../services/sync/mode.js';
import { CloseOnCafePcError } from '../utils/errors.js';
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import {
  getCash,
  getCashBook,
  getDay,
  getDayMessage,
  postDayEmail,
  getDayPrint,
  getDays,
  postCash,
  postCloseDay,
  postReopenDay,
  postVoidCash,
} from '../controllers/dayCloseController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import {
  cashBookSchema,
  closeDaySchema,
  listCashSchema,
  listDaysSchema,
  printDaySchema,
  readDaySchema,
  recordCashSchema,
  reopenDaySchema,
  voidCashSchema,
} from '../validators/dayCloseValidators.js';

/** P63. While the PC and the website both write, only the PC closes or reopens a day. */
function onlyOnCafePc(_req, _res, next) {
  return next(isTwoWayCloud() ? new CloseOnCafePcError() : undefined);
}

const router = Router();

const base = [authenticate, tenant];
const owner = [...base, requireRole(ROLES.OWNER)];
const managers = [...base, requireRole(ROLES.OWNER, ROLES.MANAGER)];
const till = [...base, requireRole(ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER)];

router.get('/cash-movements', ...till, validate(listCashSchema), getCash);
// P29 Part F. The cash book: the till reads it; the server leaves out what a role may not see.
router.get('/cash-book', ...till, validate(cashBookSchema), getCashBook);
router.post('/cash-movements', ...till, validate(recordCashSchema), postCash);
// A cashier voids with a manager's PIN; cashService decides.
router.post('/cash-movements/:movementId/void', ...till, validate(voidCashSchema), postVoidCash);

router.get('/day-close', ...managers, validate(listDaysSchema), getDays);
// P61. The cashier closes the day too, always blind.
router.post('/day-close', ...till, onlyOnCafePc, validate(closeDaySchema), postCloseDay);
router.get('/day-close/:businessDate', ...till, validate(readDaySchema), getDay);
// P44. The day-end message, and emailing it to the addresses in Settings.
router.get('/day-close/:businessDate/message', ...till, validate(readDaySchema), getDayMessage);
router.post('/day-close/:businessDate/email', ...till, validate(readDaySchema), postDayEmail);
router.get('/day-close/:businessDate/print', ...till, validate(printDaySchema), getDayPrint);
router.post('/day-close/:businessDate/reopen', ...owner, onlyOnCafePc, validate(reopenDaySchema), postReopenDay);

export default router;
