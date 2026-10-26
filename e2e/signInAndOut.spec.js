/**
 * The sign-in screen and Sign out, 2026-10-19 (GLOSSARY section 42): a refused
 * sign-in puts the cursor back in the password, a tap on Sign out does not
 * sign anyone out, holding it does and the sign-in screen says goodbye, and
 * from the keyboard it asks first.
 */
import { expect, test } from '@playwright/test';

import { resetGolden } from './helpers/clock.js';
import { DEVICES, signIn } from './helpers/people.js';

test.describe.configure({ mode: 'serial' });

test('a refused sign-in keeps the phone and selects the password to type again', async ({ browser }) => {
  const golden = await resetGolden();
  const context = await browser.newContext(DEVICES.phone);
  const page = await context.newPage();
  await page.goto('/login');

  await page.getByLabel('Phone or email').fill(golden.phones.Counter.slice(0, 4));
  await expect(page.getByText('Mobile number, 4 of 10 digits')).toBeVisible();
  await page.getByLabel('Phone or email').fill(golden.phones.Counter);
  await expect(page.getByText('Mobile number, 10 digits')).toBeVisible();

  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText(/incorrect/i)).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Phone or email')).toHaveValue(golden.phones.Counter);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await context.close();
});

test('a tap on Sign out does nothing, holding it signs out, and the sign-in screen says goodbye', async ({ browser }) => {
  const golden = await resetGolden();
  const counter = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  const page = counter.page;

  await page.getByRole('button', { name: /account/ }).click();
  await page.getByRole('button', { name: /^Sign out/ }).click();
  await expect(page.getByText('Press and hold to sign out.')).toBeVisible();
  await expect(page).not.toHaveURL(/\/login/);

  const box = await page.getByRole('button', { name: /^Sign out/ }).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText('Counter, you are signed out. See you next shift.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('you are signed out')).toHaveCount(0);
});

test('from the keyboard, Sign out asks first, and Stay keeps the person signed in', async ({ browser }) => {
  const golden = await resetGolden();
  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  const page = captain.page;

  await page.getByRole('button', { name: /account/ }).click();
  await page.getByRole('button', { name: /^Sign out/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sign out now?')).toBeVisible();
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(page).not.toHaveURL(/\/login/);

  await page.getByRole('button', { name: /^Sign out/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
});
