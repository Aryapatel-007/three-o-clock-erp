/**
 * P64 through the screens: the owner picks the GST detailed theme on Invoice
 * layout, sees the preview of a real bill change before saving, saves with a
 * reason, and the next full-page print uses it. On a phone the screen has no
 * sideways scroll.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';

const DAY = '2026-09-26';
const APP = 'http://127.0.0.1:5055/api/v1';

async function api(method, path, token, body) {
  const response = await fetch(`${APP}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(parsed)}`);
  return parsed.data;
}
const tokenOf = async (golden, name) => (await api('POST', '/auth/login', null, { phone: golden.phones[name], password: golden.password })).accessToken;

test.describe.configure({ mode: 'serial' });

test('the owner switches the invoice theme, sees the preview change, saves, and the next print uses it', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', DAY);
  const [manager, captain, cashier] = await Promise.all(['Manager', 'Budha Singh', 'Counter'].map((name) => tokenOf(golden, name)));

  // One real bill to preview and print: Table 3's pizza.
  const { items, tables } = golden.ids;
  const order = await api('POST', '/orders', captain, {
    orderType: 'DINE_IN',
    tableId: tables['Table 3'],
    guestCount: 2,
    lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 1 }],
  });
  const fired = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);
  const served = await api('GET', `/orders/${order.id}`, captain);
  const bill = await api('POST', '/bills', cashier, { orderId: order.id, version: served.version });
  expect(bill.lines[0].hsnCode).toBe('996331');

  await at('15:30', DAY);
  const owner = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'computer' });
  const page = owner.page;
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Open Invoice layout' }).click();
  await expect(page.getByRole('heading', { name: 'Invoice layout' })).toBeVisible();

  const preview = page.frameLocator('iframe[title="Tax invoice preview"]');
  await expect(preview.getByText('TAX INVOICE')).toBeVisible();
  await expect(preview.getByText(bill.billNumber)).toBeVisible();
  await expect(preview.getByText('Tax summary')).toHaveCount(0);

  // Picking GST detailed changes the preview before anything is saved.
  await page.getByRole('radio', { name: /GST detailed/ }).click();
  await expect(preview.getByText('Tax summary')).toBeVisible();
  await expect(preview.getByText('HSN/SAC')).toBeVisible();
  await expect(preview.getByText('996331')).toBeVisible();
  await expect(preview.getByText('ORIGINAL FOR RECIPIENT')).toBeVisible();
  await expect(preview.getByText(/^Rupees .* Only$/)).toBeVisible();

  // The thermal tab previews the roll, which keeps its own layout.
  await page.getByRole('tab', { name: 'Thermal settings' }).click();
  await expect(page.frameLocator('iframe[title="Thermal bill preview"]').getByText('Grand Total')).toBeVisible();
  await page.getByRole('tab', { name: 'Invoice settings' }).click();

  const save = page.getByRole('button', { name: 'Save invoice layout' });
  await expect(save).toBeDisabled();
  await page.getByLabel('Why are you changing this?').fill('Our CA asked for HSN codes');
  await save.click();
  await expect(page.getByText('Invoice layout saved. The next print uses it.')).toBeVisible();

  // The next full-page print, from the receipt preview on A4, is in the new theme.
  await page.evaluate(() => {
    const stored = JSON.parse(window.localStorage.getItem('caffeza.device') ?? '{}');
    window.localStorage.setItem('caffeza.device', JSON.stringify({ ...stored, printer: 'A4' }));
  });
  await page.goto(`/bills/${bill.id}/receipt`);
  await expect(page.frameLocator('iframe[title="Tax invoice as printed"]').getByText('Tax summary')).toBeVisible();
  await page.getByRole('button', { name: 'Duplicate for supplier' }).click();
  await page.getByRole('button', { name: /Print/ }).first().click();
  await expect.poll(() => owner.prints.length).toBe(1);
  const printed = owner.prints[0];
  expect(printed.paperMm).toBe('A4');
  expect(printed.text).toContain('Tax summary');
  expect(printed.text).toContain('DUPLICATE FOR SUPPLIER');
  expect(printed.text).toContain('996331');
  expect(printed.text).toContain(bill.billNumber);

  // On a phone the screen fits, with no sideways scroll.
  const phone = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'phone' });
  await phone.page.goto('/settings/invoice-layout');
  await expect(phone.page.getByRole('heading', { name: 'Invoice layout' })).toBeVisible();
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
