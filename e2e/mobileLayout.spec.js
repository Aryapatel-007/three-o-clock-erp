/**
 * Every screen on a phone, with the golden day's bills on it. 2026-10-27.
 *
 * Signs in on a 360 px phone (the narrowest Android in use) and a 390 px one,
 * opens every route the app has, and fails on any screen that scrolls sideways
 * or puts something past the right edge outside a box that scrolls on purpose
 * (a report table, the category chips). Screenshots go to
 * e2e/screenshots/mobile/ for a person to look at.
 *
 *   npm run e2e -- mobileLayout
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { at, track } from './helpers/clock.js';

const DAY = '2026-09-26';
const APP = 'http://127.0.0.1:5055/api/v1';
const CONTROL = 'http://127.0.0.1:5056';
const WIDTHS = [360, 390];

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

/**
 * What does not fit on this screen:
 * - the page itself scrolls sideways;
 * - a box scrolls sideways without being made to (only `overflow-x-auto`,
 *   `overflow-auto` or `overflow-x-scroll` in its classes say it should: a table,
 *   the category chips);
 * - a box cuts its content off on the right, with no ellipsis to say so.
 */
function measure() {
  const width = document.documentElement.clientWidth;
  const pageScrolls = document.documentElement.scrollWidth > width + 1 || document.body.scrollWidth > width + 1;
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    className: String(element.className?.baseVal ?? element.className ?? '').slice(0, 140),
    text: (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    width: Math.round(element.clientWidth),
    scrollWidth: element.scrollWidth,
  });
  const sideways = [];
  const cut = [];
  for (const element of document.body.querySelectorAll('*')) {
    if (element.scrollWidth <= element.clientWidth + 1 || element.clientWidth === 0) continue;
    const style = getComputedStyle(element);
    const classes = String(element.className?.baseVal ?? element.className ?? '');
    if (['auto', 'scroll'].includes(style.overflowX)) {
      if (/(^|\s)(overflow-x-auto|overflow-auto|overflow-x-scroll)(\s|$)/.test(classes)) continue;
      sideways.push(describe(element));
    } else if (['hidden', 'clip'].includes(style.overflowX)) {
      if (style.textOverflow === 'ellipsis' || /truncate|line-clamp|sr-only/.test(classes)) continue;
      if (element.closest('[aria-hidden="true"]')) continue;
      cut.push(describe(element));
    }
  }
  return { pageScrolls, scrollWidth: document.documentElement.scrollWidth, sideways: sideways.slice(0, 5), cut: cut.slice(0, 5) };
}

/** The height of the tallest scrolling area, so a screenshot can show all of it. */
function contentHeight() {
  let tallest = document.documentElement.scrollHeight;
  for (const element of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
      tallest = Math.max(tallest, element.scrollHeight + (window.innerHeight - element.clientHeight));
    }
  }
  return Math.min(tallest, 6000);
}

test.describe.configure({ mode: 'serial' });

test('every screen fits a phone', async ({ browser }) => {
  test.setTimeout(30 * 60 * 1000);
  const golden = await (await fetch(`${CONTROL}/reset-played`, { method: 'POST' })).json();
  await at('20:30', DAY);

  const owner = await api('POST', '/auth/login', null, { phone: golden.phones.Owner, password: golden.password });
  await api('PATCH', '/settings', owner.accessToken, {
    reason: 'Phone layout check',
    features: { online: true, inventory: true, attendance: true },
    online: { takeawayEnabled: true, reservationsEnabled: true },
  });
  await api('PATCH', '/online/site', owner.accessToken, { publicSlug: 'golden' });
  const tables = await api('GET', '/tables', owner.accessToken);
  const free = tables.find((table) => !table.occupancy || table.occupancy.state === 'FREE');
  const itemIds = Object.values(golden.ids.items);
  const open = await api('POST', '/orders', owner.accessToken, {
    orderType: 'DINE_IN',
    tableId: free.id,
    guestCount: 2,
    lines: itemIds.slice(0, 4).map((menuItemId) => ({ menuItemId, quantity: 2 })),
  });
  const staff = await api('GET', '/users', owner.accessToken);
  const someone = staff.find((user) => user.role === 'WAITER');
  const bill = golden.ids.bills.B03;
  const order = golden.ids.orders.B03;

  const day = `from=${DAY}&to=${DAY}`;
  const reports = ['today', 'day-close', 'sales-by-day', 'hours', 'payments', 'platform-money', 'cash-till', 'accounts', 'gst',
    'tally-export', 'ca-pack', 'invoice-register', 'menu', 'captains', 'tables', 'discounts', 'cancellations', 'no-charge'];
  const signedIn = [
    '/dashboard', '/owner', '/floor', `/orders/${open.id}`, `/orders/${order}`, '/orders/takeaway', '/orders/delivery', '/kitchen',
    '/bills', `/bills/${bill}`, `/bills/${bill}/receipt`, '/cash-book', '/day-end', `/day-close?date=${DAY}`, '/accounts', '/payouts',
    '/customers', '/menu', '/menu/availability', '/tables', '/tables/arrange', '/stations', '/staff', '/staff/new',
    `/staff/${someone.id}/edit`, '/settings', '/settings/appearance', '/settings/invoice-layout', '/settings/ca-reports',
    '/settings/integrations', '/settings/integrations/TALLY', '/settings/tally', '/reports', ...reports.map((name) => `/reports/${name}?${day}`),
    `/reports/activity?${day}`, `/reports/bills?${day}`, `/reports/bills/${bill}`, '/reports/labour', '/reports/stock',
    '/inventory', '/inventory/recipes', '/attendance', '/attendance/register', '/attendance/me',
    '/online', '/online/bookings', '/online/chats', '/device', '/network', '/connect', '/sync',
  ];
  const signedOut = ['/login', '/r/golden', '/r/golden/order', '/r/golden/book', '/connect'];

  mkdirSync('e2e/screenshots/mobile', { recursive: true });
  const failures = [];
  for (const width of WIDTHS) {
    const run = async (page, path, label) => {
      await page.goto(path);
      // The live channel and the polls keep the network busy, so never "idle": a short wait instead.
      await page.waitForTimeout(1200);
      const result = await page.evaluate(measure);
      const name = `${width}-${label}${path}`.replace(/[^a-z0-9-]+/gi, '_').slice(0, 120);
      if (width === WIDTHS[0]) {
        await page.setViewportSize({ width, height: await page.evaluate(contentHeight) });
        await page.screenshot({ path: `e2e/screenshots/mobile/${name}.png` });
        await page.setViewportSize({ width, height: 780 });
      }
      if (result.pageScrolls || result.sideways.length || result.cut.length) failures.push({ width, path, label, ...result });
    };

    const context = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await track(page);
    for (const path of signedOut) await run(page, path, 'guest');
    await page.goto('/login');
    await page.getByLabel('Phone or email').fill(golden.phones.Owner);
    await page.getByLabel('Password').fill(golden.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/);
    for (const path of signedIn) await run(page, path, 'owner');
    await context.close();
  }

  writeFileSync('e2e/screenshots/mobile/failures.json', JSON.stringify(failures, null, 2));
  console.log(JSON.stringify(failures, null, 2));
  expect(failures, 'screens that do not fit a phone').toEqual([]);
});
