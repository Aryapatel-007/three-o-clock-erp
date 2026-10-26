/**
 * P27 and P56, through the screens: a captain on a phone seats Table 2 with
 * only the guests, adds a dish and a note for all dishes, and gives the
 * guest's name, mobile and yes to offers on the first Send. The kitchen sees
 * the note on the ticket; the owner finds the guest on the Customers screen.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { gotoFloor, tile } from './pages/floor.js';
import { addItems } from './pages/order.js';

const DAY = '2026-09-26';

test.describe.configure({ mode: 'serial' });

test("the guest's details on the first Send, and a note for all dishes on the ticket", async ({ browser }) => {
  const golden = await resetGolden();
  await at('19:00', DAY);

  const captain = await signIn(browser, { name: 'Khuman Singh', phone: golden.phones['Khuman Singh'], password: golden.password, device: 'phone' });
  await gotoFloor(captain.page);
  // P59. A free table opens at once; nothing is asked until the first Send.
  await tile(captain.page, 'Table 2', 'free').click();
  await expect(captain.page).toHaveURL(/\/orders\/[a-f0-9]{24}$/);

  await addItems(captain.page, ['Caffe Latte']);
  await captain.page.getByRole('button', { name: 'Note for all dishes' }).click();
  const note = captain.page.getByRole('dialog', { name: 'Note for all dishes' });
  await note.getByRole('button', { name: 'Less spicy' }).click();
  await note.getByRole('button', { name: 'Jain' }).click();
  await note.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(captain.page.getByText('Less spicy, Jain').first()).toBeVisible();

  await captain.page.getByRole('button', { name: /^Send \d+ to (the )?kitchen/ }).filter({ visible: true }).first().click();
  const sheet = captain.page.getByRole('dialog', { name: 'Guest details' });
  // P59. The golden restaurant requires covers: no Skip, and Save waits for the count.
  await expect(sheet.getByRole('button', { name: 'Skip, send without details' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Choose the number of guests' })).toBeDisabled();
  await sheet.getByRole('button', { name: '3', exact: true }).click();
  await sheet.getByLabel('Guest name').fill('Meera Joshi');
  await sheet.getByLabel('Mobile number').fill('98250 12345');
  await sheet.getByText('The guest agrees to offers and news by SMS or WhatsApp').click();
  await captain.page.screenshot({ path: 'e2e/screenshots/seat-guest-details.png', fullPage: true });
  await sheet.getByRole('button', { name: 'Save and send' }).click();
  await expect(captain.page.getByText('Sent to the kitchen.')).toBeVisible();
  await expect(captain.page.getByText('Meera Joshi').first()).toBeVisible();
  await expect(captain.page.getByText('3 guests').first()).toBeVisible();
  expect(await captain.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const kitchen = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });
  await kitchen.page.goto('/kitchen');
  await kitchen.page.getByRole('tab', { name: 'All stations' }).click();
  const ticket = kitchen.page.locator('article').filter({ hasText: 'Table 2' });
  await expect(ticket.getByText('For all items:')).toBeVisible();
  await expect(ticket).toContainText('Less spicy, Jain');

  const owner = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'computer' });
  await owner.page.goto('/customers');
  await owner.page.getByLabel('Search').fill('meera');
  const card = owner.page.getByRole('button', { name: /Meera Joshi/ });
  await expect(card).toContainText('9825012345');
  await expect(card).toContainText('1 visit');
  await expect(card).toContainText('Agreed to offers');
  await card.click();
  await expect(owner.page.getByRole('dialog', { name: 'Meera Joshi' }).getByText(/Table 2/)).toBeVisible();
  await owner.page.screenshot({ path: 'e2e/screenshots/customers.png', fullPage: true });
});
