/**
 * P65 through the screens: the owner sets the CA's details, sends September by
 * hand, sees it in the history, and downloads the workbook. The e2e server's
 * fake Resend receives the email with both attachments, the workbook and the
 * Tally file. On a phone the screen has no sideways scroll.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';

const APP = 'http://127.0.0.1:5055/api/v1';
const CONTROL = 'http://127.0.0.1:5056';

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
const emails = async () => (await (await fetch(`${CONTROL}/emails`)).json()).emails;

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

test.describe.configure({ mode: 'serial' });

test('the owner sets the CA, sends September by hand, sees it sent, and downloads the workbook', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', '2026-09-26');
  const [owner, manager, captain, cashier] = await Promise.all(['Owner', 'Manager', 'Budha Singh', 'Counter'].map((name) => tokenOf(golden, name)));

  // One bill in the month, paid in cash: Table 3's pizza.
  const { items, tables, accounts } = golden.ids;
  const order = await api('POST', '/orders', captain, { orderType: 'DINE_IN', tableId: tables['Table 3'], guestCount: 2, lines: [{ menuItemId: items['Half & Half Pizza'], quantity: 1 }] });
  const fired = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
  for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);
  const served = await api('GET', `/orders/${order.id}`, captain);
  const bill = await api('POST', '/bills', cashier, { orderId: order.id, version: served.version });
  await api('POST', `/bills/${bill.id}/printed`, cashier);
  await api('POST', `/bills/${bill.id}/payments`, cashier, { method: 'CASH', amountInPaise: bill.grandTotalInPaise });

  // Tally, so the month's file goes with the workbook.
  await api('PUT', '/integrations/TALLY', owner, {
    environment: 'PRODUCTION',
    config: {
      version: 'TALLY_PRIME',
      companyName: 'Golden Day Cafe',
      granularity: 'DAILY_SUMMARY',
      ledgers: {
        salesByRate: { 0: 'Sales @ 0%', 500: 'Sales @ 5%' },
        platformSales: 'Sales, aggregator',
        cgst: 'Output CGST',
        sgst: 'Output SGST',
        roundOff: 'Round Off',
        paymentMethods: { CASH: 'Cash', CARD: 'Card', UPI: 'UPI', ZOMATO_GOLD: 'Zomato Gold', DINEOUT: 'Dineout', EAZYDINER: 'EazyDiner', ZOMATO: 'Zomato', SWIGGY: 'Swiggy' },
        onHold: { mode: 'PER_ACCOUNT', byAccount: Object.fromEntries(Object.entries(accounts).map(([name, id]) => [id, name])) },
        paidOut: 'Petty Expenses',
        paidIn: 'Petty Cash Received',
      },
    },
  });
  await api('POST', '/integrations/TALLY/test', owner);

  // Every day of September closed, each counted as the owner sees it expected.
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-09-${String(day).padStart(2, '0')}`;
    await at('09:00', nextDate(date));
    const read = await api('GET', `/day-close/${date}`, owner);
    const expected = read.figures?.cash?.expectedCashInPaise ?? read.expectedCashInPaise ?? 0;
    await api('POST', '/day-close', owner, { businessDate: date, countedCashInPaise: expected, note: 'Counted' });
  }

  await at('11:00', '2026-10-02');
  const person = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'computer' });
  const page = person.page;
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Open CA reports' }).click();
  await expect(page.getByRole('heading', { name: 'CA reports' })).toBeVisible();
  await expect(page.getByText('Nothing sent yet.')).toBeVisible();

  await page.getByLabel('CA name').fill('Mehta & Co');
  await page.getByLabel("CA's email").fill('ca@mehta.example');
  await page.getByLabel("CA's WhatsApp number").fill('9876500011');
  await page.getByLabel('Send the pack on the 1st of every month').check();
  await page.getByLabel('Why are you changing this?').fill('Our CA for the GST returns');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText("The CA's details are saved.")).toBeVisible();

  const before = (await emails()).length;
  await page.getByLabel('Month', { exact: true }).fill('2026-09');
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('The pack for September 2026 is sent.')).toBeVisible();
  await expect(page.getByText('September 2026', { exact: true })).toBeVisible();
  await expect(page.getByText(/Sent .* to ca@mehta\.example, 2 files\./)).toBeVisible();

  const sent = await emails();
  expect(sent.length).toBe(before + 1);
  const mail = sent.at(-1);
  expect(mail.to).toEqual(['ca@mehta.example']);
  expect(mail.text.split('\n')[0]).toContain('September 2026');
  expect(mail.attachments.map((file) => file.filename.split('.').pop())).toEqual(['xlsx', 'xml']);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download workbook' }).click()]);
  expect(download.suggestedFilename()).toMatch(/R20-2026-09-01-2026-09-30\.xlsx$/);

  // On a phone the screen fits, with no sideways scroll.
  const phone = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'phone' });
  await phone.page.goto('/settings/ca-reports');
  await expect(phone.page.getByRole('heading', { name: 'CA reports' })).toBeVisible();
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
