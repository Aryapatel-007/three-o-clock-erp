/**
 * 2026-10-22, through the screens: voiding a bill closes the table unless the
 * bill is being corrected, an order whose bill was voided can be cancelled, and
 * Save is never held back. Arya, at Z Chaat: a voided test bill left its table
 * taken, with no way on the screen to close it.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { gotoFloor, openTable, tile } from './pages/floor.js';
import { addItems, details } from './pages/order.js';

const DAY = '2026-09-26';

/** Bills a table without a KOT on the counter computer, and lands on its bill. */
async function billTable(page, table) {
  await openTable(page, table);
  await addItems(page, ['Caffe Latte']);
  const order = await details(page);
  await order.getByRole('button', { name: 'Bill without KOT' }).click();
  const guest = page.getByRole('dialog', { name: 'Guest details' });
  await guest.getByRole('button', { name: '2', exact: true }).click();
  await guest.getByRole('button', { name: 'Save and bill' }).click();
  await page.getByRole('region', { name: 'Bill' }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
}

/** Opens Void bill and picks a reason; returns the sheet. */
async function startVoid(page, reason, note = null) {
  await page.getByRole('button', { name: /Void bill/ }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: reason, exact: true }).click();
  if (note) await sheet.getByRole('textbox').first().fill(note);
  return sheet;
}

test('voiding a bill closes the table by default', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);
  const { page } = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });

  await billTable(page, 'Table 3');
  const sheet = await startVoid(page, 'Other', 'test');
  await expect(sheet.getByRole('radio', { name: /Close the table/ })).toBeChecked();
  await sheet.getByRole('button', { name: /Void bill/ }).last().click();

  await expect(page).toHaveURL(/\/floor$/);
  await gotoFloor(page);
  await expect(tile(page, 'Table 3', 'free')).toBeVisible();
});

test('a bill voided to correct it waits for a new bill, and its order can be cancelled', async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);
  const { page } = await signIn(browser, { name: 'Manager', phone: golden.phones.Manager, password: golden.password, device: 'computer' });

  await billTable(page, 'Table 4');
  const sheet = await startVoid(page, 'Discount needs changing');
  await expect(sheet.getByRole('radio', { name: /Bill this table again/ })).toBeChecked();
  await sheet.getByRole('button', { name: /Void bill/ }).last().click();
  await expect(page.getByText('Bill voided.')).toBeVisible();

  // The order waits for a new bill: Save is there, and so is Cancel the whole order.
  await gotoFloor(page);
  await tile(page, 'Table 4').click();
  const order = await details(page);
  await expect(page.getByRole('region', { name: 'Bill' }).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await order.getByRole('button', { name: 'Cancel the whole order' }).click();
  const cancel = page.getByRole('dialog', { name: /^Cancel order #/ });
  await cancel.getByRole('button', { name: 'Other', exact: true }).click();
  await cancel.getByRole('textbox').first().fill('test');
  await cancel.getByText(/^No, /).first().click();
  await cancel.getByRole('button', { name: /^Cancel it/ }).click();

  await gotoFloor(page);
  await expect(tile(page, 'Table 4', 'free')).toBeVisible();
});
