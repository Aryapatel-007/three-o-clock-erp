/**
 * A screen whose code is gone, as on a tablet left open across a deploy:
 * Vercel answers the old file's address with the app's page. The app reloads
 * once by itself; if the file still cannot load it says so, with Reload,
 * instead of a blank page. 2026-10-18.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';

test('a screen whose code cannot load reloads once, then shows Reload instead of a blank page', async ({ browser }) => {
  const golden = await resetGolden();
  await at('15:05', '2026-09-26');
  const desk = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });
  const page = desk.page;
  await page.goto('/floor');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  // The settlement group's file, answered with the app's page, as after a deploy.
  let asked = 0;
  await page.route(/\/assets\/settlement-[^/]+\.js$/, async (route) => {
    asked += 1;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' });
  });
  let reloads = 0;
  page.on('load', () => (reloads += 1));

  await page.getByRole('link', { name: 'Bills' }).first().click();
  // One reload by itself, then the message, never a blank page.
  await expect(page.getByText('This screen could not load.')).toBeVisible();
  expect(reloads).toBe(1);
  expect(asked).toBeGreaterThanOrEqual(2);

  // Once the file is back, Reload opens the screen.
  await page.unroute(/\/assets\/settlement-[^/]+\.js$/);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.getByText('This screen could not load.')).toHaveCount(0);
  await expect(page.getByText('Bill total').first()).toBeVisible();
});
