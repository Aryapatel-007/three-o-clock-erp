import { expect } from '@playwright/test';

/**
 * A table's tile on the floor, by its name ("Table 5"). Names are matched whole,
 * so Table 1 is not Table 12. A bare name ("5") is spoken "Table 5" too.
 */
export const tile = (page, table, state = '[a-z ]+') => {
  const spoken = /^table\b/i.test(table) ? table : `Table ${table}`;
  return page.getByRole('button', { name: new RegExp(`^${spoken}, ${state}, `) });
};

export async function gotoFloor(page) {
  await page.goto('/floor');
  await expect(page.getByRole('heading', { name: 'Floor', level: 1 })).toBeVisible();
}

/**
 * P59. The guests a test means to seat, given on the Guest details sheet at the
 * table's first Send (see `answerGuestDetails` in order.js), one per page.
 */
const pendingGuests = new WeakMap();
export function takePendingGuests(page) {
  const guests = pendingGuests.get(page);
  pendingGuests.delete(page);
  return guests;
}

/** Opens a free table's order; P59: a tap opens it, and the guests are given at the first Send. */
export async function openTable(page, table, guests) {
  await gotoFloor(page);
  await tile(page, table, 'free').click();
  await expect(page).toHaveURL(/\/orders\/[a-f0-9]{24}$/);
  if (guests != null) pendingGuests.set(page, guests);
}

/** Opens the order on a taken table. */
export async function openTableOrder(page, table) {
  await gotoFloor(page);
  await tile(page, table).click();
  await expect(page).toHaveURL(/\/orders\/[a-f0-9]{24}$/);
}

/** The tile of a taken table says its state and its guests. */
export async function expectTable(page, table, state, guests) {
  const button = tile(page, table, state.toLowerCase());
  await expect(button).toBeVisible();
  await expect(button).toContainText(`${guests} ${guests === 1 ? 'guest' : 'guests'}`);
}

/** The billing strip lists a table waiting to pay. */
export async function expectWaitingToPay(page, table) {
  const strip = page.getByRole('region', { name: 'Billing' });
  await expect(strip.getByRole('link').filter({ hasText: new RegExp(`^${table}(?!\\d)`) })).toBeVisible();
}
