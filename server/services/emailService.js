/**
 * Email, through Resend. P44: the day-end message; P65: the CA's monthly pack.
 *
 * One HTTPS call with the API key, no SDK, the way razorpayClient.js reaches
 * Razorpay. The key comes from RESEND_API_KEY and is never logged. Without it,
 * nothing is sent and the caller is told so in plain words.
 */
import { config } from '../config/env.js';
import { BusinessRuleError, EmailSendFailedError } from '../utils/errors.js';

let forTests = null;

/** Tests point the sender at a fake Resend with a key of their own. */
export function setEmailForTests(value) {
  if (!config.isTest) throw new Error('setEmailForTests is for tests only.');
  forTests = value;
}

const settings = () => ({
  apiKey: forTests ? forTests.apiKey : config.RESEND_API_KEY,
  base: forTests?.base ?? config.RESEND_API_BASE,
  from: forTests?.from ?? config.DAY_END_EMAIL_FROM,
});

export function isEmailSetUp() {
  return Boolean(settings().apiKey);
}

/**
 * Sends one plain-text email. Returns Resend's id. Throws a 422 without a key,
 * a 502 when Resend says no. P65: `attachments`, optional, in Resend's own
 * shape, `[{ filename, content }]` with `content` as base64.
 */
export async function sendEmail({ to, subject, text, attachments }) {
  const { apiKey, base, from } = settings();
  if (!apiKey) throw new BusinessRuleError('Email is not set up on the server.');

  let response;
  try {
    response = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, ...(attachments?.length ? { attachments } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EmailSendFailedError('Could not reach the email service. Please try again in a moment.');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new EmailSendFailedError(`The email service refused it: ${body?.message ?? `status ${response.status}`}.`);
  }
  return body.id ?? null;
}

export default { isEmailSetUp, sendEmail, setEmailForTests };
