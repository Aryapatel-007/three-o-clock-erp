/**
 * Settings tests.
 *
 * Four of these are the reason M7 is a safe change rather than a risky one, and
 * they are marked in the describe names: the no-migration read, the untouched
 * business-day field, the strict-key rejection, and the audit trail.
 *
 * The rest is the ordinary work: permissions, tenancy, and the two settings
 * that are actually wired to something.
 */
import assert from 'node:assert/strict';

import { DEFAULT_DENOMINATIONS, DEFAULT_EXPENSE_CATEGORIES } from '../models/Restaurant.js';
import { after, before, beforeEach, describe, it } from 'node:test';

import { AuditLog } from '../models/AuditLog.js';
import { Ingredient } from '../models/Ingredient.js';
import { Restaurant } from '../models/Restaurant.js';
import { businessDateFor } from '../utils/time.js';
import { clearTestDatabase, startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { createMenuItem, seedTeam } from './helpers/m2Fixtures.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

before(async () => {
  await startTestDatabase();
  await startTestServer();
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

const getSettings = (token) => request('GET', '/api/v1/settings', { token });

const patchSettings = (token, body) => request('PATCH', '/api/v1/settings', { token, body });

/** Every group and every field, as the contract's own example lists them. */
const DEFAULTS = {
  business: { businessDayStartsAtMinutes: 300 },
  tax: { pricingMode: 'EXCLUSIVE', defaultTaxRateBps: 500, roundOffEnabled: true },
  receipt: {
    headerLine1: null,
    headerLine2: null,
    footerText: null,
    showGstin: true,
    showFssai: true,
    showServerName: false,
    reviewLinkUrl: null,
  },
  inventory: { lowStockAlertsEnabled: true },
  // P02.
  features: { inventory: true, attendance: true, online: false },
  invoice: { mode: 'FINANCIAL_YEAR', prefix: null, startingNumber: null },
  // P06.
  delivery: { platformCollectsGst: true },
  discounts: { cashierMayApplyPlatformDiscounts: false },
  // P29 added reviseUnpaidBills, printBeforePayment, revisePrintedBill, the kitchen group and the cash book fields.
  billing: { captainsMayBill: true, captainsMayTakePayment: false, reviseUnpaidBills: true, printBeforePayment: true, payFirstTakeaway: true },
  // P28.
  approvals: { lineCancel: true, paidIn: true, managerTasks: true, revisePrintedBill: true },
  kitchen: { readyMeansServed: true, oneTicketPerOrder: true },
  // P51.
  assistant: { enabled: false, bookingsEnabled: true, greeting: null, handoffHours: null, dailyAiLimit: 500 },
  dayClose: { showCashDifferenceToManager: false },
  cash: {
    denominations: DEFAULT_DENOMINATIONS.map((entry) => ({ ...entry })),
    expenseCategories: DEFAULT_EXPENSE_CATEGORIES.map((entry) => ({ ...entry })),
    usualFloatInPaise: 200000,
    showDrawerTotalToStaff: false,
  },
  // P47 added otherModes.
  payments: { requireTerminalForLinkedMethods: true, otherModes: ['Swiggy Dineout', 'Zomato Dineout', 'EazyDiner', 'Cheque', 'Bank transfer', 'Coupon'] },
  // P25 Part J.
  // P44 added dayEndEmails.
  reports: { onHoldTallyCode: null, dayEndEmails: [] },
  // P19.
  floor: { sectionOrder: [], longOpenMinutes: 90, requireGuestCount: false },
  // P20A.
  appearance: {
    accentPreset: 'OCEAN',
    accentHex: null,
    wordmark: null,
    secondLanguage: 'NONE',
    todayTiles: [
      'billTotalInPaise',
      'netSalesInPaise',
      'billCount',
      'covers',
      'averagePerCoverInPaise',
      'openTables',
      'openItemTotalInPaise',
      'unpaidCount',
      'unpaidInPaise',
      'lastWeekBillTotalInPaise',
    ],
    // P22.
    neutralTone: 'COOL',
    brandHex: null,
    onBrandHex: null,
  },
  // P23.
  online: {
    takeawayEnabled: false,
    reservationsEnabled: false,
    opensAtMinutes: 600,
    closesAtMinutes: 1380,
    takeawayMinLeadMinutes: 20,
    takeawayAnswerWithinMinutes: 10,
    reservationMaxPartySize: 10,
    reservationDaysAhead: 14,
    reservationSlotMinutes: 30,
    reservationHoldMinutes: 90,
    pageNote: 'Pay at the counter when you collect.',
    alertRoles: ['OWNER', 'MANAGER', 'CASHIER'],
    // P24.
    takeawayPrepay: false,
    depositPerPersonInPaise: 0,
    depositRefundCutoffMinutes: 120,
    paymentWindowMinutes: 20,
  },
};

// ---------------------------------------------------------------------------

describe('reading settings', () => {
  it('returns every group with its default filled in', async () => {
    const { tokens } = await seedTeam();

    const response = await getSettings(tokens.OWNER);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, DEFAULTS);
  });

  /**
   * The no-migration test.
   *
   * A restaurant written before M7 has no settings.tax in its document at all.
   * Mongoose fills every missing path from the schema defaults when it hydrates,
   * so the endpoint answers in full without a migration and without a seeding
   * step. If this ever fails, somebody has added a field without a default and
   * every existing restaurant is about to read back a null.
   */
  it('fills in every default for a restaurant written before M7 existed', async () => {
    const { tokens, restaurant } = await seedTeam();

    // Strip the document back to what M5 would have written: one key, no groups.
    await Restaurant.collection.updateOne(
      { _id: restaurant._id },
      { $set: { settings: { businessDayStartsAtMinutes: 420 } } },
    );

    const response = await getSettings(tokens.OWNER);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, {
      ...DEFAULTS,
      // The stored value survives; only the missing groups are defaulted.
      business: { businessDayStartsAtMinutes: 420 },
    });

    // And the stored document is still the small one. Reading did not write.
    const raw = await Restaurant.collection.findOne({ _id: restaurant._id });
    assert.deepEqual(raw.settings, { businessDayStartsAtMinutes: 420 });
  });

  it('takes no parameters', async () => {
    const { tokens } = await seedTeam();

    const response = await request('GET', '/api/v1/settings?tax=true', { token: tokens.OWNER });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  });
});

describe('businessDayStartsAtMinutes stays where three modules read it', () => {
  /**
   * The untouched-field test.
   *
   * The API groups this field under `business`. The document does not, and must
   * not: M3 derives every bill's businessDate from the top-level path, M5
   * derives every attendance entry's, and M6 reads it for every report. If this
   * fails, somebody has nested it for tidiness and broken three shipped modules.
   */
  it('is stored at the top level of settings, not inside a business group', async () => {
    const { tokens, restaurant } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Kitchen closes at 2am',
      business: { businessDayStartsAtMinutes: 240 },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.business.businessDayStartsAtMinutes, 240);

    const raw = await Restaurant.collection.findOne({ _id: restaurant._id });
    assert.equal(raw.settings.businessDayStartsAtMinutes, 240);
    assert.equal(raw.settings.business, undefined);
  });

  /** The boundary M3 and M5 both derive from still produces the same answer. */
  it('still drives the business date the same way it did before M7', async () => {
    const { tokens } = await seedTeam();

    await patchSettings(tokens.OWNER, {
      reason: 'Late service',
      business: { businessDayStartsAtMinutes: 300 },
    });

    // 04:30 IST on the 2nd is 23:00 UTC on the 1st, and falls under the 1st,
    // because the business day starts at 05:00 IST. Unchanged by M7.
    assert.equal(businessDateFor(new Date('2026-03-01T23:00:00.000Z'), 300), '2026-03-01');
    // 05:30 IST on the 2nd is the 2nd.
    assert.equal(businessDateFor(new Date('2026-03-02T00:00:00.000Z'), 300), '2026-03-02');
  });

  it('is reachable through the M5 clock-in path after being changed here', async () => {
    const { tokens } = await seedTeam();

    await patchSettings(tokens.OWNER, {
      reason: 'Opening earlier',
      business: { businessDayStartsAtMinutes: 0 },
    });

    const clockIn = await request('POST', '/api/v1/attendance/clock-in', { token: tokens.WAITER });
    assert.equal(clockIn.status, 201);
    // Midnight boundary: the business date is the calendar date in IST.
    assert.equal(clockIn.body.data.businessDate, businessDateFor(new Date(), 0));
  });
});

describe('rejecting unknown keys', () => {
  /**
   * The strict-keys test.
   *
   * A settings endpoint that silently drops a typo'd field name is how somebody
   * spends an hour wondering why their change did nothing. Both the plausible
   * typo and the unknown group have to name the offending key.
   */
  it('rejects a plausible typo inside a known group, naming the key', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Raising the default rate',
      tax: { defaultTaxRate: 500 },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    assert.match(JSON.stringify(response.body.error.fields), /defaultTaxRate/);
  });

  it('rejects an unknown group, naming it', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Trying something',
      printing: { enabled: true },
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body.error.fields), /printing/);
  });

  it('refuses a body carrying no setting at all', async () => {
    const { tokens } = await seedTeam();

    assert.equal((await patchSettings(tokens.OWNER, { reason: 'Nothing to say' })).status, 400);
    assert.equal((await patchSettings(tokens.OWNER, {})).status, 400);
    // An empty group is not a change either.
    assert.equal((await patchSettings(tokens.OWNER, { reason: 'Empty', tax: {} })).status, 400);
  });
});

describe('the reason, which is never defaulted', () => {
  it('refuses a patch with no reason, and one with an empty reason', async () => {
    const { tokens } = await seedTeam();

    const missing = await patchSettings(tokens.OWNER, { tax: { defaultTaxRateBps: 1800 } });
    assert.equal(missing.status, 400);
    assert.match(JSON.stringify(missing.body.error.fields), /reason/);

    const empty = await patchSettings(tokens.OWNER, {
      reason: '   ',
      tax: { defaultTaxRateBps: 1800 },
    });
    assert.equal(empty.status, 400);
  });
});

describe('the audit trail', () => {
  /**
   * The audit test.
   *
   * One line per field that actually changed, and nothing at all for a field
   * sent with the value it already has. A log that records non-changes is a log
   * nobody reads, and the real change hides in it.
   */
  it('writes one line per changed field, with the dotted path and both values', async () => {
    const { tokens, restaurant } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'CA confirmed the slab',
      tax: { defaultTaxRateBps: 1800 },
      receipt: { footerText: 'GST included. Thank you.' },
    });
    assert.equal(response.status, 200);

    const entries = await AuditLog.find({ restaurantId: restaurant._id }).sort({ entityLabel: 1 });

    assert.equal(entries.length, 2);
    for (const entry of entries) {
      assert.equal(entry.action, 'SETTINGS_CHANGED');
      assert.equal(entry.entityType, 'SETTINGS');
      assert.equal(String(entry.entityId), String(restaurant._id));
      assert.equal(entry.reason, 'CA confirmed the slab');
      assert.equal(entry.amountInPaise, null);
      assert.equal(entry.actorRole, 'OWNER');
    }

    const byPath = Object.fromEntries(entries.map((entry) => [entry.entityLabel, entry.details]));

    assert.deepEqual(byPath['tax.defaultTaxRateBps'], {
      field: 'tax.defaultTaxRateBps',
      previousValue: '500',
      newValue: '1800',
    });
    assert.deepEqual(byPath['receipt.footerText'], {
      field: 'receipt.footerText',
      previousValue: 'null',
      newValue: 'GST included. Thank you.',
    });
  });

  it('writes nothing for a field sent with the value it already has', async () => {
    const { tokens, restaurant } = await seedTeam();

    // 500 is the default, so this changes nothing.
    const response = await patchSettings(tokens.OWNER, {
      reason: 'Confirming the rate',
      tax: { defaultTaxRateBps: 500 },
    });

    assert.equal(response.status, 200);
    assert.equal(await AuditLog.countDocuments({ restaurantId: restaurant._id }), 0);
  });

  it('audits only the field that moved when a patch mixes changed and unchanged', async () => {
    const { tokens, restaurant } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'One real change',
      tax: { defaultTaxRateBps: 500, roundOffEnabled: false },
    });

    assert.equal(response.status, 200);
    const entries = await AuditLog.find({ restaurantId: restaurant._id });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entityLabel, 'tax.roundOffEnabled');
  });
});

describe('writing settings', () => {
  it('returns the full object, with the change applied and everything else untouched', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Onboarding',
      receipt: { headerLine1: 'Shreeji Dining Hall', showServerName: true },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, {
      ...DEFAULTS,
      receipt: { ...DEFAULTS.receipt, headerLine1: 'Shreeji Dining Hall', showServerName: true },
    });
  });

  it('caps a receipt header at the width of a thermal roll', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Long name',
      receipt: { headerLine1: 'x'.repeat(41) },
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(response.body.error.fields), /headerLine1/);
  });

  it('clears a receipt line with null, and treats an emptied box the same way', async () => {
    const { tokens } = await seedTeam();

    await patchSettings(tokens.OWNER, { reason: 'Set', receipt: { footerText: 'Visit again' } });

    const cleared = await patchSettings(tokens.OWNER, {
      reason: 'Clear it',
      receipt: { footerText: null },
    });
    assert.equal(cleared.body.data.receipt.footerText, null);

    await patchSettings(tokens.OWNER, { reason: 'Set again', receipt: { footerText: 'Visit' } });

    // An owner clearing the box sends "", which means the same as null here.
    const emptied = await patchSettings(tokens.OWNER, {
      reason: 'Clear with an empty box',
      receipt: { footerText: '' },
    });
    assert.equal(emptied.body.data.receipt.footerText, null);
  });

  it('refuses a pricing mode that is not one of the two', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Trying',
      tax: { pricingMode: 'INCLUSIVE_OF_SERVICE' },
    });

    assert.equal(response.status, 400);
  });

  it('stores pricingMode and roundOffEnabled even though nothing reads them yet', async () => {
    const { tokens } = await seedTeam();

    const response = await patchSettings(tokens.OWNER, {
      reason: 'Recording what the CA said',
      tax: { pricingMode: 'INCLUSIVE', roundOffEnabled: false },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.tax.pricingMode, 'INCLUSIVE');
    assert.equal(response.body.data.tax.roundOffEnabled, false);

    // Read back through a fresh request, so this is the stored value.
    const reread = await getSettings(tokens.OWNER);
    assert.equal(reread.body.data.tax.pricingMode, 'INCLUSIVE');
  });
});

describe('settings permissions', () => {
  it('lets a manager read and refuses to let one write', async () => {
    const { tokens } = await seedTeam();

    assert.equal((await getSettings(tokens.MANAGER)).status, 200);

    const write = await patchSettings(tokens.MANAGER, {
      reason: 'Trying',
      tax: { defaultTaxRateBps: 1800 },
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error.code, 'FORBIDDEN');
  });

  it('refuses a cashier on both', async () => {
    const { tokens } = await seedTeam();

    assert.equal((await getSettings(tokens.CASHIER)).status, 403);
    assert.equal(
      (await patchSettings(tokens.CASHIER, { reason: 'Trying', tax: { defaultTaxRateBps: 1800 } }))
        .status,
      403,
    );
  });

  it('refuses every other role a read', async () => {
    const { tokens } = await seedTeam();

    for (const role of ['WAITER', 'KITCHEN', 'STOREKEEPER']) {
      assert.equal((await getSettings(tokens[role])).status, 403, `${role} should not read settings`);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    assert.equal((await request('GET', '/api/v1/settings')).status, 401);
  });
});

describe('one restaurant never reads or writes another restaurant settings', () => {
  it('keeps two restaurants on their own values', async () => {
    const a = await seedTeam({ name: 'A' });
    const b = await seedTeam({ name: 'B' });

    await patchSettings(a.tokens.OWNER, {
      reason: 'A raises its rate',
      tax: { defaultTaxRateBps: 1800 },
    });
    await patchSettings(b.tokens.OWNER, {
      reason: 'B lowers its rate',
      tax: { defaultTaxRateBps: 0 },
    });

    assert.equal((await getSettings(a.tokens.OWNER)).body.data.tax.defaultTaxRateBps, 1800);
    assert.equal((await getSettings(b.tokens.OWNER)).body.data.tax.defaultTaxRateBps, 0);

    // And B's audit lines are B's alone.
    const bEntries = await AuditLog.find({ restaurantId: b.restaurant._id });
    assert.equal(bEntries.length, 1);
    assert.equal(bEntries[0].details.newValue, '0');
  });
});

describe('the default tax rate, which is wired', () => {
  it('fills in an omitted rate from the setting, and never overrides one that was sent', async () => {
    const { tokens } = await seedTeam();

    await patchSettings(tokens.OWNER, {
      reason: 'This restaurant is on 18%',
      tax: { defaultTaxRateBps: 1800 },
    });

    const filled = await createMenuItem(tokens.OWNER, { name: 'Dal Fry', taxRateBps: undefined });
    assert.equal(filled.status, 201);
    assert.equal(filled.body.data.taxRateBps, 1800);

    const explicit = await createMenuItem(tokens.OWNER, { name: 'Rice', taxRateBps: 500 });
    assert.equal(explicit.body.data.taxRateBps, 500);

    // An explicit zero is a rate, not an absence. A zero-rated dish is legitimate.
    const zero = await createMenuItem(tokens.OWNER, { name: 'Water', taxRateBps: 0 });
    assert.equal(zero.body.data.taxRateBps, 0);
  });

  it('does not move a rate already stored on an item when the setting changes later', async () => {
    const { tokens } = await seedTeam();

    const item = (await createMenuItem(tokens.OWNER, { name: 'Paneer', taxRateBps: undefined }))
      .body.data;
    assert.equal(item.taxRateBps, 500);

    await patchSettings(tokens.OWNER, {
      reason: 'Rate went up',
      tax: { defaultTaxRateBps: 1800 },
    });

    const reread = await request('GET', `/api/v1/menu-items/${item.id}`, { token: tokens.OWNER });
    assert.equal(reread.body.data.taxRateBps, 500);
  });
});

describe('the low stock toggle, which is wired', () => {
  /** An ingredient sitting below its own threshold, so it shows up in both reads. */
  async function seedLowIngredient(tokens) {
    const created = await request('POST', '/api/v1/ingredients', {
      token: tokens.OWNER,
      body: {
        name: 'Paneer',
        baseUnit: 'G',
        lowStockThresholdInBase: 5000,
        openingQtyInBase: 1000,
      },
    });
    assert.equal(created.status, 201);
    return created.body.data;
  }

  it('empties the low-stock read and the dashboard panel, leaving the quantities alone', async () => {
    const { tokens, restaurant } = await seedTeam();
    const ingredient = await seedLowIngredient(tokens);

    const lowStockUrl = '/api/v1/ingredients?lowStockOnly=true';

    // On by default: the ingredient is listed in both places.
    assert.equal((await request('GET', lowStockUrl, { token: tokens.OWNER })).body.data.length, 1);
    const dashboardOn = await request('GET', '/api/v1/reports/dashboard', { token: tokens.OWNER });
    assert.equal(dashboardOn.body.data.lowStock.length, 1);

    await patchSettings(tokens.OWNER, {
      reason: 'Too noisy during service',
      inventory: { lowStockAlertsEnabled: false },
    });

    assert.deepEqual((await request('GET', lowStockUrl, { token: tokens.OWNER })).body.data, []);
    const dashboardOff = await request('GET', '/api/v1/reports/dashboard', { token: tokens.OWNER });
    assert.deepEqual(dashboardOff.body.data.lowStock, []);

    // The data is untouched. Only the surfacing was switched off.
    const stored = await Ingredient.findOne({
      restaurantId: restaurant._id,
      _id: ingredient.id,
    });
    assert.equal(stored.currentQtyInBase, 1000);

    // And the plain list still shows it, with its real quantity.
    const all = await request('GET', '/api/v1/ingredients', { token: tokens.OWNER });
    assert.equal(all.body.data.length, 1);
    assert.equal(all.body.data[0].currentQtyInBase, 1000);
  });
});

describe('PATCH /restaurant does not wipe the settings it does not mention', () => {
  /**
   * PATCH /restaurant accepts `settings.businessDayStartsAtMinutes` and writes
   * it with $set. Before M7 that replaced a one-key object with a one-key
   * object and lost nothing. With four groups on it, replacing the whole
   * subdocument would silently reset an owner's tax rate and receipt text,
   * so the controller writes dotted paths instead.
   */
  it('keeps the tax and receipt settings when the business day is changed there', async () => {
    const { tokens, restaurant } = await seedTeam();

    await patchSettings(tokens.OWNER, {
      reason: 'Onboarding',
      tax: { defaultTaxRateBps: 1800 },
      receipt: { footerText: 'Thank you, visit again.' },
    });

    const moved = await request('PATCH', '/api/v1/restaurant', {
      token: tokens.OWNER,
      body: { settings: { businessDayStartsAtMinutes: 420 } },
    });
    assert.equal(moved.status, 200);

    const after = await getSettings(tokens.OWNER);
    assert.equal(after.body.data.business.businessDayStartsAtMinutes, 420);
    assert.equal(after.body.data.tax.defaultTaxRateBps, 1800);
    assert.equal(after.body.data.receipt.footerText, 'Thank you, visit again.');

    const raw = await Restaurant.collection.findOne({ _id: restaurant._id });
    assert.equal(raw.settings.tax.defaultTaxRateBps, 1800);
  });
});
