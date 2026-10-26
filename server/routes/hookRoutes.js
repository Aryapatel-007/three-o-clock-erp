/**
 * Partners' webhooks. P25 Part G, API-CONTRACT M21 section 4.
 *
 *   POST /api/v1/hooks/:provider/:webhookKey
 *
 * Mounted in server.js BEFORE the JSON body parser, so the exact bytes are
 * here for the signature. No sign-in and no tenant: the key in the address is
 * the credential, and the connection is found by its hash.
 */
import express, { Router } from 'express';

import { webhookLimiter } from '../middleware/rateLimit.js';
import { receiveWebhook, verifySubscription } from '../services/integrations/webhookService.js';
import { partnerIntake } from '../services/intake/cloudIntake.js';
import { mirrorIsReadOnly } from '../services/replication/writerState.js';
import { sendSuccess } from '../utils/response.js';
import { NotFoundError, UnauthenticatedError } from '../utils/errors.js';

export const HOOKS_PATH = '/hooks';
export const WEBHOOK_BODY_LIMIT = '256kb';

const router = Router();

/**
 * P37. Meta's subscription handshake: a GET with `hub.challenge`, answered with
 * the challenge as plain text when `hub.verify_token` is the connection's own.
 */
router.get('/:provider/:webhookKey', webhookLimiter, async (req, res) => {
  const outcome = await verifySubscription(req.params.provider, req.params.webhookKey, req.query);
  if (outcome.status === 404) throw new NotFoundError();
  if (outcome.status !== 200) return res.status(403).type('text/plain').send('Forbidden');
  return res.status(200).type('text/plain').send(outcome.text);
});

router.post(
  '/:provider/:webhookKey',
  express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  webhookLimiter,
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // P62. On the read-only cloud mirror: verified the same way, kept in intake for the cafe box.
    const outcome = mirrorIsReadOnly()
      ? await partnerIntake(req.params.provider, req.params.webhookKey, rawBody, req.headers)
      : await receiveWebhook(req.params.provider, req.params.webhookKey, rawBody, req.headers);
    if (outcome.status === 404) throw new NotFoundError();
    if (outcome.status === 401) throw new UnauthenticatedError('The signature did not match.');
    if (outcome.status === 400) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_FAILED', message: 'That webhook could not be read.' } });
    }
    return sendSuccess(res, outcome.body);
  },
);

export default router;
