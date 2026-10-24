/**
 * The CA's month. P65, docs/API-CONTRACT.md "P65" section 4. OWNER only.
 */
import { CA_SEND_TRIGGERS } from '../models/CaReportSend.js';
import { listSends, monthTallyXml, presentSend, sendMonth } from '../services/caPackService.js';
import { sendSuccess } from '../utils/response.js';

/** GET /reports/ca/sends */
export async function getCaSends(req, res) {
  return sendSuccess(res, await listSends(req));
}

/** POST /reports/ca/send: Send now, even a month already sent. */
export async function postCaSend(req, res) {
  const row = await sendMonth(req, req.body.month, { trigger: CA_SEND_TRIGGERS.MANUAL, sentBy: req.user.id });
  req.log?.info({ actorId: req.user.id, period: req.body.month, status: row.status }, 'CA pack sent by the owner.');
  return sendSuccess(res, presentSend(row));
}

/** GET /reports/ca/tally-xml?month= : the month's Tally file, recorded nowhere. */
export async function getCaTallyXml(req, res) {
  const xml = await monthTallyXml(req, req.query.month);
  const name = `${req.currentRestaurant.name}-Tally-${req.query.month}.xml`.replace(/[^A-Za-z0-9.-]+/g, '-');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  return res.status(200).send(xml);
}
