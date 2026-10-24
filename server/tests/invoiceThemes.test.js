/**
 * P64: invoice themes, HSN and SAC codes, and what prints on a bill.
 * docs/API-CONTRACT.md "P64", DB-SCHEMA section 60.
 *
 * The page fixtures in tests/fixtures/invoiceThemes were saved from the
 * full-page invoice and the thermal bill as they were before P64, for every
 * golden day bill. CLASSIC and the roll, at their default switches, must still
 * print them byte for byte.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { moneyText } from '../../client/src/components/ui/moneyText.js';
import { invoiceHtml, thermalBillHtml } from '../../client/src/features/printing/invoiceHtml.js';
import { escapeHtml } from '../../client/src/features/printing/printText.js';
import { THEMES } from '../../client/src/features/printing/themes/index.js';
import { dateOf } from '../../client/src/features/printing/themes/shared.js';
import { AuditLog } from '../models/AuditLog.js';
import { ALL_MODELS } from '../models/index.js';
import { Order } from '../models/Order.js';
import { INVOICE_SHOW_DEFAULTS, Restaurant } from '../models/Restaurant.js';
import { paiseToIndianWords } from '../utils/money.js';
import { buildGoldenDay } from './helpers/goldenDay.js';
import { addLines, openOrder, readyToBillOrder, seedFloor } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/invoiceThemes');
const PRINT_OPTIONS = { qrSvg: '<svg data-qr="1"></svg>', logoDataUrl: 'data:image/png;base64,AAAA' };
const ALL_OFF = Object.fromEntries(Object.keys(INVOICE_SHOW_DEFAULTS).map((key) => [key, false]));
const ALL_ON = Object.fromEntries(Object.keys(INVOICE_SHOW_DEFAULTS).map((key) => [key, true]));
const FIGURE = /-?₹[\d,]+\.\d{2}/g;

let golden;
const invoices = {};

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  golden = await buildGoldenDay({ name: 'Cafezza' });
  // The same guest the fixtures were saved with.
  await Order.updateOne({ restaurantId: golden.restaurant._id, _id: golden.ids.orders.B01 }, { $set: { customerName: 'Asha', customerPhone: '9876543210' } });
  for (const [name, billId] of Object.entries(golden.ids.bills)) {
    invoices[name] = (await request('GET', `/api/v1/bills/${billId}/invoice`, { token: golden.tokens.OWNER })).body.data;
  }
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

const fixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');
const figures = (html) => [...new Set(html.match(FIGURE) ?? [])].sort();

describe('the printed bill before and after P64', () => {
  it('prints the CLASSIC page byte for byte as before, for every golden day bill', () => {
    assert.equal(Object.keys(invoices).length, 16);
    for (const [name, data] of Object.entries(invoices)) {
      assert.equal(data.layout.theme, 'CLASSIC', name);
      assert.equal(invoiceHtml(data, PRINT_OPTIONS), fixture(`${name}.page.html`), `${name}: the page changed`);
    }
  });

  it('prints the thermal roll byte for byte as before, on both rolls, at the default switches', () => {
    for (const [name, data] of Object.entries(invoices)) {
      for (const printer of ['THERMAL_80', 'THERMAL_58']) {
        assert.equal(thermalBillHtml(data, { printer, ...PRINT_OPTIONS }), fixture(`${name}.${printer}.html`), `${name} on ${printer}`);
      }
    }
  });
});

describe('the four themes', () => {
  it('print exactly the same money figures as each other, for B07 and every other bill', () => {
    for (const show of [INVOICE_SHOW_DEFAULTS, ALL_ON]) {
      for (const [name, data] of Object.entries(invoices)) {
        const expected = figures(THEMES[0].render(data, { ...PRINT_OPTIONS, show }));
        assert.ok(expected.length > 0, name);
        for (const theme of THEMES) {
          assert.deepEqual(figures(theme.render(data, { ...PRINT_OPTIONS, show })), expected, `${theme.id} on ${name}`);
        }
      }
    }
    // B07, named in the prompt: its bill total is on every theme.
    const b07 = invoices.B07;
    for (const theme of THEMES) assert.ok(theme.render(b07, { show: ALL_OFF }).includes(moneyText(b07.billTotalInPaise)), theme.id);
  });

  it('still print the mandatory core of a tax invoice with every switch off', () => {
    for (const theme of THEMES) {
      for (const [name, data] of Object.entries(invoices)) {
        const html = theme.render(data, { show: ALL_OFF });
        const where = `${theme.id} on ${name}`;
        const has = (text, what) => assert.ok(html.includes(text), `${where}: ${what} "${text}" is missing`);
        has(escapeHtml(data.restaurant.name), 'the name');
        // The golden restaurant has no address set; a restaurant that has one prints it.
        if (data.restaurant.address) has(escapeHtml(data.restaurant.address), 'the address');
        has(data.restaurant.gstin, 'the GSTIN');
        has('TAX INVOICE', 'the title');
        has(escapeHtml(data.billNumber), 'the invoice number');
        has(escapeHtml(dateOf(data.issuedAtIst)), 'the date');
        for (const row of data.itemRows) has(moneyText(row.lineTotalInPaise), 'a line value');
        for (const slab of data.taxRows) {
          has(`${slab.taxRateBps / 100}%`, 'a rate');
          has(moneyText(slab.netSalesInPaise), 'a taxable value');
          has(moneyText(slab.cgstInPaise), 'CGST');
          has(moneyText(slab.sgstInPaise), 'SGST');
        }
        has(moneyText(data.billTotalInPaise), 'the bill total');
      }
    }
  });

  it('show what the switches add: HSN, words, the copy, the account balance, the signatory', () => {
    const b09 = invoices.B09;
    assert.equal(b09.billTotalInWords, paiseToIndianWords(b09.billTotalInPaise));
    assert.ok(Number.isInteger(b09.onHoldOutstandingInPaise), 'an On Hold bill carries the account balance');
    assert.equal(invoices.B01.onHoldOutstandingInPaise, null);
    for (const theme of THEMES) {
      const on = theme.render(b09, { show: ALL_ON, copy: 'SUPPLIER' });
      assert.ok(on.includes('HSN/SAC'), theme.id);
      assert.ok(on.includes(escapeHtml(b09.billTotalInWords)), theme.id);
      assert.ok(on.includes('DUPLICATE FOR SUPPLIER'), theme.id);
      assert.ok(on.includes('Account balance') && on.includes(moneyText(b09.onHoldOutstandingInPaise)), theme.id);
      assert.ok(on.includes('Authorised signatory'), theme.id);
      assert.ok(theme.render(b09, { show: { copyMarking: true } }).includes('ORIGINAL FOR RECIPIENT'), theme.id);
      const off = theme.render(b09, { show: ALL_OFF });
      for (const word of ['HSN/SAC', 'ORIGINAL FOR RECIPIENT', 'Account balance', 'Authorised signatory', 'Rupees ']) {
        assert.ok(!off.includes(word), `${theme.id} shows "${word}" with its switch off`);
      }
    }
  });

  it('let the roll show the guest, covers, notes and words only when asked', () => {
    const data = invoices.B01;
    const quiet = thermalBillHtml(data, { printer: 'THERMAL_80', show: { customerName: false, customerMobileMasked: false, paymentBreakdown: false } });
    assert.doesNotMatch(quiet, /Asha|XXXXXX3210|Paid:/);
    const loud = thermalBillHtml(data, { printer: 'THERMAL_80', show: { covers: true, amountInWords: true } });
    assert.ok(loud.includes(escapeHtml(data.billTotalInWords)));
    if (data.guestCount) assert.ok(loud.includes(`Covers: ${data.guestCount}`));
  });
});

describe('HSN and SAC codes, frozen like a price', () => {
  it('freezes the item code, or the default SAC, onto the line, the bill and the invoice', async () => {
    const floor = await seedFloor();
    const { tokens } = floor;
    const coded = (await request('POST', '/api/v1/menu-items', {
      token: tokens.OWNER,
      body: { categoryId: floor.item.categoryId, name: 'Masala Chai', priceInPaise: 3000, taxRateBps: 500, hsnCode: '2106' },
    })).body.data;
    assert.equal(coded.hsnCode, '2106');
    assert.equal(floor.item.hsnCode, null);

    const order = await readyToBillOrder(floor, [
      { menuItemId: floor.item.id, quantity: 1 },
      { menuItemId: coded.id, quantity: 2 },
    ]);
    assert.deepEqual(order.lines.map((line) => line.hsnCode), ['996331', '2106']);

    const bill = (await request('POST', '/api/v1/bills', { token: tokens.OWNER, body: { orderId: order.id, version: order.version } })).body.data;
    assert.deepEqual(bill.lines.map((line) => line.hsnCode), ['996331', '2106']);

    // Changing the item or the default afterwards moves nothing already issued.
    assert.equal((await request('PATCH', `/api/v1/menu-items/${coded.id}`, { token: tokens.OWNER, body: { hsnCode: '0902' } })).status, 200);
    const sac = await request('PATCH', '/api/v1/settings', { token: tokens.OWNER, body: { reason: 'CA asked', invoice: { defaultSacCode: '996332' } } });
    assert.equal(sac.status, 200, JSON.stringify(sac.body));
    assert.equal(sac.body.data.invoice.defaultSacCode, '996332');
    assert.equal(sac.body.data.invoice.mode, 'FINANCIAL_YEAR', 'the series is untouched');

    const invoice = (await request('GET', `/api/v1/bills/${bill.id}/invoice`, { token: tokens.OWNER })).body.data;
    assert.deepEqual(invoice.lines.map((line) => line.hsnCode), ['996331', '2106']);
    assert.deepEqual(invoice.itemRows.map((row) => row.hsnCode), ['996331', '2106']);

    // A line added now freezes the new codes.
    const next = (await openOrder(tokens.WAITER, { tableId: (await request('POST', '/api/v1/tables', { token: tokens.OWNER, body: { name: 'T9' } })).body.data.id, lines: [{ menuItemId: floor.item.id, quantity: 1 }] })).body.data;
    const added = (await addLines(tokens.WAITER, next.id, { version: next.version, lines: [{ menuItemId: coded.id, quantity: 1 }] })).body.data;
    assert.deepEqual(added.lines.map((line) => line.hsnCode), ['996332', '0902']);
  });

  it('refuses a code that is not 4 to 8 digits, and clears with an empty string', async () => {
    const floor = await seedFloor();
    for (const hsnCode of ['12', '123456789', 'ABCD', 12]) {
      const response = await request('PATCH', `/api/v1/menu-items/${floor.item.id}`, { token: floor.tokens.OWNER, body: { hsnCode } });
      assert.equal(response.status, 400, String(hsnCode));
    }
    await request('PATCH', `/api/v1/menu-items/${floor.item.id}`, { token: floor.tokens.OWNER, body: { hsnCode: '1905' } });
    const cleared = await request('PATCH', `/api/v1/menu-items/${floor.item.id}`, { token: floor.tokens.OWNER, body: { hsnCode: '' } });
    assert.equal(cleared.body.data.hsnCode, null);
  });
});

describe('the invoice layout setting', () => {
  it('reads back complete on a restaurant written before P64', async () => {
    const floor = await seedFloor();
    await Restaurant.collection.updateOne(
      { _id: floor.restaurant._id },
      { $unset: { 'settings.invoiceLayout': '', 'settings.invoice.defaultSacCode': '', 'settings.receipt.termsText': '', panNumber: '', msmeNumber: '' } },
    );
    const settings = (await request('GET', '/api/v1/settings', { token: floor.tokens.OWNER })).body.data;
    assert.equal(settings.invoiceLayout.theme, 'CLASSIC');
    assert.equal(settings.invoiceLayout.useBrandAccent, false);
    assert.deepEqual(settings.invoiceLayout.show, INVOICE_SHOW_DEFAULTS);
    assert.equal(settings.invoiceLayout.thermalShow.cashier, true);
    assert.equal(settings.invoice.defaultSacCode, '996331');
    assert.equal(settings.receipt.termsText, null);
  });

  it('saves a theme and switches, one audit line each, and refuses an unknown theme or switch', async () => {
    const floor = await seedFloor();
    const token = floor.tokens.OWNER;
    const saved = await request('PATCH', '/api/v1/settings', {
      token,
      body: { reason: 'For the CA', invoiceLayout: { theme: 'GST_DETAILED', show: { hsn: true, declaration: true } }, receipt: { termsText: '  Goods once sold.  ' } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.invoiceLayout.theme, 'GST_DETAILED');
    assert.equal(saved.body.data.invoiceLayout.show.hsn, true);
    assert.equal(saved.body.data.invoiceLayout.show.time, true, 'a switch not sent is untouched');
    assert.equal(saved.body.data.receipt.termsText, 'Goods once sold.');

    const audit = await AuditLog.find({ restaurantId: floor.restaurant._id, action: 'SETTINGS_CHANGED' }).lean();
    const fields = audit.map((line) => line.details?.field);
    for (const field of ['invoiceLayout.theme', 'invoiceLayout.show.hsn', 'invoiceLayout.show.declaration', 'receipt.termsText']) {
      assert.ok(fields.includes(field), field);
    }

    for (const invoiceLayout of [{ theme: 'DIWALI' }, { show: { freeItemQuantity: true } }, { show: { hsn: 'yes' } }]) {
      const refused = await request('PATCH', '/api/v1/settings', { token, body: { reason: 'x', invoiceLayout } });
      assert.equal(refused.status, 400, JSON.stringify(invoiceLayout));
    }
    assert.equal((await request('PATCH', '/api/v1/settings', { token: floor.tokens.MANAGER, body: { reason: 'x', invoiceLayout: { theme: 'MODERN' } } })).status, 403);
  });

  it('draws the accent only when it passes the accent rules, and puts it in the invoice data', async () => {
    const floor = await seedFloor();
    const token = floor.tokens.OWNER;
    const on = await request('PATCH', '/api/v1/settings', { token, body: { reason: 'Brand', invoiceLayout: { useBrandAccent: true, theme: 'MODERN' } } });
    assert.equal(on.status, 200, JSON.stringify(on.body));

    const order = await readyToBillOrder(floor);
    const bill = (await request('POST', '/api/v1/bills', { token, body: { orderId: order.id, version: order.version } })).body.data;
    const invoice = (await request('GET', `/api/v1/bills/${bill.id}/invoice`, { token })).body.data;
    assert.equal(invoice.layout.theme, 'MODERN');
    assert.match(invoice.layout.accent, /^#[0-9A-F]{6}$/);

    // A custom colour that fails the rules (stored before a rule tightened) is refused for print.
    await request('PATCH', '/api/v1/settings', { token, body: { reason: 'off', invoiceLayout: { useBrandAccent: false } } });
    await Restaurant.collection.updateOne({ _id: floor.restaurant._id }, { $set: { 'settings.appearance.accentPreset': 'CUSTOM', 'settings.appearance.accentHex': '#EEEEEE' } });
    const refused = await request('PATCH', '/api/v1/settings', { token, body: { reason: 'Brand', invoiceLayout: { useBrandAccent: true } } });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
  });

  it('takes the PAN and the Udyam number on the restaurant, and prints them under their switches', async () => {
    const floor = await seedFloor();
    const token = floor.tokens.OWNER;
    const saved = await request('PATCH', '/api/v1/restaurant', { token, body: { panNumber: 'aaapz1234c', msmeNumber: 'udyam-gj-01-0012345' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.panNumber, 'AAAPZ1234C');
    assert.equal(saved.body.data.msmeNumber, 'UDYAM-GJ-01-0012345');
    for (const body of [{ panNumber: 'AAAP1234C' }, { msmeNumber: 'UDYAM-1' }]) {
      assert.equal((await request('PATCH', '/api/v1/restaurant', { token, body })).status, 400, JSON.stringify(body));
    }
    const order = await readyToBillOrder(floor);
    const bill = (await request('POST', '/api/v1/bills', { token, body: { orderId: order.id, version: order.version } })).body.data;
    const invoice = (await request('GET', `/api/v1/bills/${bill.id}/invoice`, { token })).body.data;
    assert.equal(invoice.restaurant.panNumber, 'AAAPZ1234C');
    assert.ok(invoiceHtml(invoice).includes('PAN AAAPZ1234C'));
    assert.ok(!invoiceHtml(invoice, { show: { pan: false } }).includes('AAAPZ1234C'));
    assert.equal(invoice.signature, null);
    assert.equal((await request('PATCH', '/api/v1/restaurant', { token, body: { panNumber: null } })).body.data.panNumber, null);
  });
});
