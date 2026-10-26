/**
 * The CA's month. P65, docs/API-CONTRACT.md "P65" section 4. OWNER only: the
 * pack carries the cash and every account. Middleware order is CONVENTIONS
 * section 8.
 */
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import { getCaSends, getCaTallyXml, postCaSend } from '../controllers/caReportController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import { caTallyXmlSchema, listCaSendsSchema, sendCaPackSchema } from '../validators/caReportValidators.js';

const router = Router();
const owner = [authenticate, tenant, requireRole(ROLES.OWNER)];

router.get('/reports/ca/sends', ...owner, validate(listCaSendsSchema), getCaSends);
router.post('/reports/ca/send', ...owner, validate(sendCaPackSchema), postCaSend);
router.get('/reports/ca/tally-xml', ...owner, validate(caTallyXmlSchema), getCaTallyXml);

export default router;
