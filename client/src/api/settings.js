/**
 * Settings API calls. Shapes from docs/API-CONTRACT.md section M7.
 *
 * Two calls, because there are two endpoints. Reading is OWNER and MANAGER;
 * writing is OWNER only, and the server is what enforces that.
 *
 * The patch sends only what changed, plus the reason. Sending the whole object
 * back would be harmless but would fill the audit log with lines saying a field
 * was set to the value it already had, which makes the real change harder to
 * find later. `changedSettings` below is what keeps that honest.
 */
import { api } from './client.js';

export function getSettings() {
  return api.get('/settings');
}

/**
 * `patch` is the changed groups only. `reason` is required by the server and
 * is not defaulted to anything, here or there.
 */
export function updateSettings({ reason, ...patch }) {
  return api.patch('/settings', { reason, ...patch });
}

/**
 * The difference between what was loaded and what is on screen, in the shape
 * the endpoint takes.
 *
 * Returns an empty object when nothing moved, which the form reads as "there is
 * nothing to save" rather than sending a patch the server would reject.
 */
export function changedSettings(original, current) {
  const patch = {};

  for (const group of Object.keys(current)) {
    const next = group === 'invoice' ? normaliseInvoice(current.invoice) : current[group];
    for (const [field, value] of Object.entries(next)) {
      if (sameValue(value, original?.[group]?.[field])) continue;
      patch[group] ??= {};
      patch[group][field] = value;
    }
  }

  /**
   * The invoice series is validated as a whole group (P02): if any of its
   * fields changes, all three are sent, so the stored series is never
   * half-changed.
   */
  if (patch.invoice) patch.invoice = normaliseInvoice(current.invoice);

  return patch;
}

/**
 * Equal by value: a list (Today tiles, section order) or a group of switches
 * (P64's `invoiceLayout.show`) is a new object after every clone.
 */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/**
 * Financial-year numbering takes no prefix and no starting number. The form
 * keeps whatever was typed while the owner flips between the two choices, and
 * this is where it is dropped before sending.
 */
function normaliseInvoice(invoice) {
  if (invoice.mode === 'FINANCIAL_YEAR') {
    return { mode: 'FINANCIAL_YEAR', prefix: null, startingNumber: null };
  }
  return {
    mode: 'PREFIX',
    prefix: invoice.prefix === '' ? null : invoice.prefix,
    startingNumber: invoice.startingNumber,
  };
}

/* P24. The cafe's own Razorpay account. Secrets are sent once and never read back. */
export const getPaymentGateway = () => api.get('/settings/payments/gateway');
export const connectPaymentGateway = (body) => api.put('/settings/payments/gateway', body);
export const disconnectPaymentGateway = (reason) => api.delete('/settings/payments/gateway', { body: { reason } });

/* M0 2.2. The restaurant's own details; P64 adds the PAN and the Udyam number. OWNER only to change. */
export const getRestaurant = () => api.get('/restaurant');
export const updateRestaurant = (body) => api.patch('/restaurant', body);
