/**
 * P29 Part F, through the screens: the owner confirms the float brought forward,
 * a cashier adds a top-up and an expense, the owner takes cash out to the bank
 * and closes the day keeping ₹2,000.00, and the next day opens with ₹2,000.00
 * brought forward.
 */
import { expect, test } from '@playwright/test';

import { at, resetGolden } from './helpers/clock.js';
import { signIn } from './helpers/people.js';
import { typeOnKeypad } from './pages/keypad.js';
import { countNotes } from './pages/manager.js';
import { recordCash } from './pages/counter.js';

const DAY_BEFORE = '2026-09-25';
const DAY = '2026-09-26';
const NEXT_DAY = '2026-09-27';
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

test('a day through the cash book', async ({ browser }) => {
  const golden = await resetGolden();

  // 25 September closed the night before, ₹2,000.00 kept in the drawer.
  await at('10:00', DAY_BEFORE);
  const managerToken = await tokenOf(golden, 'Manager');
  await api('POST', '/cash-movements', managerToken, { type: 'OPENING_FLOAT', amountInPaise: 200000 });
  await at('23:00', DAY_BEFORE);
  await api('POST', '/day-close', managerToken, { businessDate: DAY_BEFORE, countedCashInPaise: 200000, keptForTomorrowInPaise: 200000 });

  // 11:00 AM the owner confirms the float brought forward.
  await at('11:00', DAY);
  const owner = await signIn(browser, { name: 'Owner', phone: golden.phones.Owner, password: golden.password, device: 'computer' });
  await owner.page.goto('/cash-book');
  await expect(owner.page.getByText('Brought forward', { exact: true }).first()).toBeVisible();
  await expect(owner.page.getByText(/^From .+: $/).or(owner.page.getByText(/2,000\.00/)).first()).toBeVisible();
  await owner.page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(owner.page.getByText('Opening float confirmed.')).toBeVisible();

  // The cashier adds a top-up of ₹3,000.00 and an expense of ₹200.00, each with the manager's PIN.
  await at('12:00', DAY);
  const cashier = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'computer' });
  const approval = { name: 'Manager', pin: '2468' };
  await recordCash(cashier.page, 'Top-up', '3000', null, { source: 'From the owner', approval });
  await recordCash(cashier.page, 'Expense', '200', 'Milk for the chai', { category: 'Milk and dairy', approval });
  // A cashier is not shown the cash in the drawer.
  await expect(cashier.page.getByText('Counted at Day Close. The owner sees the total.').first()).toBeVisible();

  // 5:00 PM the owner takes ₹1,000.00 to the bank.
  await at('17:00', DAY);
  await owner.page.goto('/cash-book');
  await owner.page.getByRole('button', { name: 'Take cash out' }).click();
  const takeOut = owner.page.getByRole('dialog', { name: 'Take cash out' });
  await typeOnKeypad(takeOut, '1000');
  await takeOut.getByRole('button', { name: 'Bank deposit', exact: true }).click();
  await takeOut.getByRole('button', { name: /^Take out ₹/ }).click();
  await expect(owner.page.getByText('Cash taken out recorded.')).toBeVisible();
  // 2,000 + 3,000 − 200 − 1,000.
  await expect(owner.page.getByText(/3,800\.00/).first()).toBeVisible();

  // 11:00 PM the owner counts ₹3,800.00, keeps ₹2,000.00, and the rest goes to the bank.
  await at('23:00', DAY);
  await owner.page.goto('/cash-book');
  await owner.page.getByRole('button', { name: 'Close the day' }).click();
  const close = owner.page.getByRole('dialog', { name: /^Close / });
  await countNotes(close.getByRole('region', { name: 'Cash counted in the drawer' }), [[500, 7], [200, 1], [100, 1]]);
  await expect(close.getByText(/Taken out at close: ₹1,800\.00/)).toBeVisible();
  await close.getByRole('button', { name: 'Close the day' }).click();
  await expect(owner.page.getByText(/is closed\.$/)).toBeVisible();

  // The next morning the float is proposed: ₹2,000.00 from 26 September.
  await at('10:00', NEXT_DAY);
  await owner.page.goto('/cash-book');
  await expect(owner.page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(owner.page.getByText(/2,000\.00/).first()).toBeVisible();
  const book = await api('GET', '/cash-book', await tokenOf(golden, 'Owner'));
  expect(book.broughtForward).toMatchObject({ fromDate: DAY, keptInPaise: 200000 });
  await owner.page.screenshot({ path: 'e2e/screenshots/cash-book.png', fullPage: true });
});

test("a cashier voids a top-up typed twice, with the manager's PIN", async ({ browser }) => {
  const golden = await resetGolden();
  await at('12:00', DAY);
  const cashier = await signIn(browser, { name: 'Counter', phone: golden.phones.Counter, password: golden.password, device: 'phone' });
  const approval = { name: 'Manager', pin: '2468' };
  await recordCash(cashier.page, 'Top-up', '500', null, { source: 'From the owner', approval });

  const today = cashier.page.getByRole('region', { name: 'Today' });
  await today.getByRole('button', { name: 'Void', exact: true }).click();
  const sheet = cashier.page.getByRole('dialog', { name: 'Void this entry' });
  await sheet.getByLabel('Why is this being voided?').fill('Typed twice');
  await expect(sheet.getByRole('button', { name: 'Void it' })).toBeDisabled();
  await sheet.getByRole('button', { name: approval.name, exact: true }).click();
  await sheet.getByLabel('Their PIN').fill(approval.pin);
  await sheet.getByRole('button', { name: 'Void it' }).click();
  await expect(cashier.page.getByText('Entry voided.')).toBeVisible();
  await expect(today.getByText(/voided: Typed twice/)).toBeVisible();
  await cashier.context.close();
});
