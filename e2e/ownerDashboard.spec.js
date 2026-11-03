/**
 * P55. The owner signs in to the dashboard, outside the ERP: today's figures,
 * read from R1, R2 and R4, and a way into the ERP and back. A manager is not
 * sent there.
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

test('the owner signs in to the dashboard, and opens the ERP from it', async ({ browser }) => {
  const golden = await resetGolden();
  await at('20:05', DAY);
  const [manager, captain, cashier] = await Promise.all(['Manager', 'Budha Singh', 'Counter'].map((name) => tokenOf(golden, name)));
  const { items, tables } = golden.ids;

  const billFor = async (table, item) => {
    const order = await api('POST', '/orders', captain, { orderType: 'DINE_IN', tableId: tables[table], guestCount: 2, lines: [{ menuItemId: items[item], quantity: 1 }] });
    const fired = await api('POST', `/orders/${order.id}/fire`, captain, { version: order.version });
    for (const kot of fired.kots) await api('PATCH', `/kots/${kot.id}/ready`, manager);
    const served = await api('GET', `/orders/${order.id}`, captain);
    return api('POST', '/bills', cashier, { orderId: order.id, version: served.version });
  };
  // Table 3 paid in cash; Table 5 billed and not yet paid.
  const paid = await billFor('Table 3', 'Half & Half Pizza');
  await api('POST', `/bills/${paid.id}/payments`, cashier, { method: 'CASH', amountInPaise: paid.grandTotalInPaise });
  const unpaid = await billFor('Table 5', 'Caffe Latte');

  await at('21:42', DAY);
  const owner = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'phone' });
  const page = owner.page;
  // Signing in lands the owner on the dashboard, its own page outside the ERP.
  await expect(page).toHaveURL(/\/owner$/);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByText('Day open · figures to 9:42')).toBeVisible();

  const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const billTotal = paid.grandTotalInPaise + unpaid.grandTotalInPaise;
  await expect(page.getByText(rupees(billTotal)).first()).toBeVisible();
  const cards = page.getByRole('region', { name: 'Bills, covers and unpaid' });
  await expect(cards).toContainText('Bills2');
  await expect(cards).toContainText(`Unpaid${rupees(unpaid.grandTotalInPaise)}(1 bill)`);

  const salesCard = page.locator('section', { has: page.getByRole('heading', { name: 'Where the sales came from' }) });
  await expect(salesCard).toContainText('Dine-in');
  await expect(salesCard).toContainText('100% of total · 2 bills');
  const moneyCard = page.locator('section', { has: page.getByRole('heading', { name: 'Where the money went' }) });
  await expect(moneyCard).toContainText(`Cash${rupees(paid.grandTotalInPaise)}`);
  await expect(moneyCard).toContainText(`Unpaid${rupees(unpaid.grandTotalInPaise)}`);
  await expect(moneyCard).toContainText(`Total${rupees(billTotal)}`);
  await expect(page.getByText('Busiest 8pm')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Watch list' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Checks' })).toContainText('balance checks passed');
  await expect(page.getByRole('link', { name: 'Day Close', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'e2e/screenshots/owner-dashboard.png', fullPage: true });

  // Open the ERP leads to Home; the menu leads back to the dashboard.
  await page.getByRole('link', { name: 'Open the ERP' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('button', { name: 'Open the menu' }).click();
  await page.getByRole('navigation', { name: 'All places' }).getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/\/owner$/);

  // A manager signs in to the ERP's home, and the dashboard is not theirs.
  const person = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'phone' });
  await expect(person.page).toHaveURL(/\/dashboard$/);
  await person.page.goto('/owner');
  await expect(person.page.getByRole('heading', { name: 'Where the sales came from' })).toHaveCount(0);
});
