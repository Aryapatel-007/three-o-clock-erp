import { expect } from '@playwright/test';

/** A dish card on the order screen. */
const card = (page, item) => page.locator('li').filter({ has: page.getByRole('heading', { name: item, exact: true, level: 3 }) });

/**
 * Adds dishes one tap at a time, in order. `[name, quantity]` raises the
 * quantity on the card. The order screen merges a second tap on a dish that
 * has an unsent line into that line, so a dish listed again on the timeline as
 * its own line is sent first and then added again, which makes it a new line.
 */
export async function addItems(page, items) {
  const unsent = new Set();
  for (const entry of items) {
    const [item, quantity] = Array.isArray(entry) ? entry : [entry, 1];
    if (unsent.has(item)) {
      await sendToKitchen(page);
      unsent.clear();
    }
    await page.getByRole('button', { name: `Add ${item}`, exact: true }).click();
    // + opens the options panel, with its note to the chef; adding takes one more tap.
    await addFromPanel(page);
    const stepper = card(page, item).getByRole('button', { name: 'One more' });
    await expect(stepper).toBeVisible();
    for (let more = 1; more < quantity; more += 1) {
      await stepper.click();
      await expect(card(page, item).locator('[aria-live="polite"]')).toHaveText(String(more + 1));
    }
    unsent.add(item);
  }
}

/** Confirms the options panel that + opens, with no note. */
export async function addFromPanel(page, note = null) {
  const sheet = page.getByRole('dialog');
  if (note) await sheet.getByLabel('Note to chef').fill(note);
  await sheet.getByRole('button', { name: /^Add to order/ }).click();
  await expect(sheet).toHaveCount(0);
}

export async function sendToKitchen(page) {
  await page.getByRole('button', { name: /^Send \d+ to (the )?kitchen/ }).filter({ visible: true }).first().click();
  const sent = page.getByText('Sent to the kitchen.');
  // P56. A table's first Send asks for the guest's details; these tests skip them.
  const guest = page.getByRole('dialog', { name: 'Guest details' });
  await expect(sent.or(guest).first()).toBeVisible();
  if (await guest.isVisible()) await skipGuestDetails(page);
  await expect(sent).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click().catch(() => {});
}

/** P56. Skips the Guest details sheet a table's first Send opens. */
export async function skipGuestDetails(page) {
  const guest = page.getByRole('dialog', { name: 'Guest details' });
  await guest.getByRole('button', { name: 'Skip, send without details' }).click();
  await expect(guest).toHaveCount(0);
}

/** The lines and the order's own actions: a sheet on a table's order, the panel beside a counter order. */
export async function details(page) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const sheet = page.getByRole('dialog', { name: /^Table/ });
  if (await sheet.isVisible().catch(() => false)) return sheet;
  const aside = page.getByRole('complementary', { name: 'This order' });
  if (await aside.isVisible().catch(() => false)) return aside;
  const summary = page.getByRole('button', { name: /Item total, before GST/ });
  if (await summary.isVisible().catch(() => false)) {
    await summary.click();
    return page.getByRole('dialog');
  }
  const review = page.getByRole('button', { name: 'Review order' });
  if (await review.isVisible().catch(() => false)) {
    await review.click();
    return page.getByRole('dialog');
  }
  return page.getByRole('region', { name: 'This order' });
}

/** Marks every ready line served, one at a time, as a captain does. */
export async function serveAll(page) {
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const area = await details(page);
  const serve = area.getByRole('button', { name: 'Mark served' });
  for (let left = await serve.count(); left > 0; left = await serve.count()) {
    await serve.first().click();
    await expect(serve).toHaveCount(left - 1);
  }
}

/**
 * Cancels one line, with its fixed reason, and says whether the kitchen made it.
 * `approval` (P28), `{ name, pin }`: the manager picks their name and types their
 * PIN on this same screen, for a dish the kitchen already has.
 */
export async function cancelLine(page, item, reason, wasPrepared = null, approval = null) {
  const area = await details(page);
  const line = area.locator('li').filter({ hasText: item }).filter({ hasNot: page.getByText('Cancelled', { exact: true }) });
  // P42. A sent dish is removed through Change.
  const change = line.getByRole('button', { name: 'Change', exact: true });
  if (await change.count()) {
    await change.first().click();
    const sheet = page.getByRole('dialog', { name: `Change ${item}` });
    if (wasPrepared) {
      const made = sheet.getByLabel('Already made by the kitchen');
      if (await made.count()) await made.check();
      await sheet.getByRole('button', { name: reason, exact: true }).click();
    }
    if (approval) {
      await expect(sheet.getByText('A manager approves')).toBeVisible();
      await sheet.getByRole('button', { name: approval.name, exact: true }).click();
      await sheet.getByLabel('Their PIN').fill(approval.pin);
    }
    await sheet.getByRole('button', { name: 'Remove dish' }).click();
    await expect(page.getByText(`${item} removed. The kitchen can see it.`)).toBeVisible();
    return;
  }
  await line.getByRole('button', { name: /^Cancel/ }).first().click();
  const sheet = page.getByRole('dialog', { name: `Cancel ${item}` });
  await sheet.getByRole('button', { name: reason, exact: true }).click();
  if (wasPrepared !== null) await sheet.getByText(wasPrepared ? 'Yes, it was made' : 'No, it was not started').click();
  if (approval) {
    await expect(sheet.getByText('A manager approves')).toBeVisible();
    await sheet.getByRole('button', { name: approval.name, exact: true }).click();
    await sheet.getByLabel('Their PIN').fill(approval.pin);
  }
  await sheet.getByRole('button', { name: /^Cancel it/ }).click();
  await expect(page.getByText('Line cancelled.')).toBeVisible();
}

/** Removes an unsent dish from its card: the minus at one removes it (P49). */
export async function removeUnsent(page, item) {
  // P49. A dish not sent yet goes at once: no reason asked, nothing kept.
  await card(page, item).getByRole('button', { name: `Remove ${item}` }).click();
  await expect(page.getByText(`${item} removed.`)).toBeVisible();
  await expect(card(page, item).getByRole('button', { name: `Remove ${item}` })).toHaveCount(0);
}

/** No Charge, from the order's sheet. Manager. */
export async function giveNoCharge(page, reason) {
  const area = await details(page);
  await area.getByRole('button', { name: 'No Charge', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'No Charge' });
  await sheet.getByRole('button', { name: reason, exact: true }).click();
  await sheet.getByRole('button', { name: 'Give No Charge' }).click();
  await expect(page.getByText('No Charge given. The table is free.')).toBeVisible();
}

/**
 * Bills an order waiting for the cashier, and lands on its bill.
 *
 * A captain still has Bill this order. The till now takes payment on the
 * order's own page and never visits the bill in service, so for the tests of
 * the bill page itself the bill is made through the API, unprinted, and opened
 * the way Bills opens a past one.
 */
export async function billOrder(page) {
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const captainButton = page.getByRole('button', { name: 'Bill this order' });
  if ((await captainButton.count()) > 0) {
    await captainButton.click();
    await expect(page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
    return page.url();
  }
  const orderId = new URL(page.url()).pathname.split('/').at(-1);
  // From inside the page, as the app itself calls: the browser sends its own session cookie.
  const billId = await page.evaluate(async (id) => {
    const call = async (method, path, body) => {
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(call.token ? { Authorization: `Bearer ${call.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
      return json.data;
    };
    call.token = (await call('POST', '/auth/refresh')).accessToken;
    const order = await call('GET', `/orders/${id}`);
    return order.billId ?? (await call('POST', '/bills', { orderId: id, version: order.version })).id;
  }, orderId);
  await page.goto(`/bills/${billId}`);
  await expect(page).toHaveURL(/\/bills\/[a-f0-9]{24}$/);
  return page.url();
}
