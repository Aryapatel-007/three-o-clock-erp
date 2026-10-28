/**
 * P25 Part C: the page a print gets, the full-page invoice, and the review link.
 * docs/API-CONTRACT.md M3 section 16.1 and M7 "Setting groups added by P25".
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  BILL_TEXT_SIZES,
  billFontPx,
  billWidthMm,
  charactersFor,
  contentWidthMm,
  monospaceFontMm,
  pageCss,
  printerFor,
} from '../../client/src/features/printing/printers.js';
import { ALL_MODELS } from '../models/index.js';
import { Order } from '../models/Order.js';
import { paiseToRupees } from '../utils/money.js';
import { buildGoldenDay } from './helpers/goldenDay.js';
import { seedTeam } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

let golden;

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  golden = await buildGoldenDay({ name: 'Cafezza' });
});

after(async () => {
  await stopTestServer();
  await stopTestDatabase();
});

describe('the page a print gets', () => {
  it('gives a thermal bill a page exactly its printed width and measured height, never auto', () => {
    assert.equal(pageCss({ printer: 'THERMAL_80', contentHeightMm: 143.2 }), '@page { size: 78mm 145mm; margin: 0; }');
    assert.equal(pageCss({ printer: 'THERMAL_80', contentHeightMm: 143.2, printWidth: 'STANDARD' }), '@page { size: 72mm 145mm; margin: 0; }');
    assert.equal(pageCss({ printer: 'THERMAL_58', contentHeightMm: 143.2, paperLength: 'BILL' }), '@page { size: 48mm 145mm; margin: 0; }');
    assert.doesNotMatch(pageCss({ printer: 'THERMAL_58', contentHeightMm: 50 }), /auto/);
    assert.throws(() => pageCss({ printer: 'THERMAL_80' }), /measured height/);
    assert.throws(() => pageCss({ printer: 'THERMAL_80', contentHeightMm: 0 }), /measured height/);
  });

  it('narrows the bill and its page together when the device keeps the edges clear', () => {
    assert.equal(contentWidthMm('THERMAL_80', 'SMALL'), 74);
    assert.equal(contentWidthMm('THERMAL_80', 'MORE'), 70);
    assert.equal(contentWidthMm('THERMAL_80', 'SMALL', 'STANDARD'), 68);
    assert.equal(contentWidthMm('THERMAL_58', 'SMALL'), 44);
    assert.equal(contentWidthMm('THERMAL_80', 'UNKNOWN'), 78);
    assert.equal(pageCss({ printer: 'THERMAL_80', contentHeightMm: 100, edgeMargin: 'SMALL' }), '@page { size: 74mm 101mm; margin: 0; }');
    assert.equal(contentWidthMm('A4', 'MORE'), 186);
  });

  it('gives a bill 5 mm more on the right at 4 mm each side on the 80 mm roll, and nothing else', () => {
    // 2026-10-28, Three O'Clock: 72 mm, 4 mm each side left 5 mm blank on the right of the bill.
    assert.equal(billWidthMm('THERMAL_80', 'MORE', 'STANDARD'), 69);
    assert.equal(contentWidthMm('THERMAL_80', 'MORE', 'STANDARD'), 64);
    assert.equal(billWidthMm('THERMAL_80', 'MORE'), 75);
    assert.equal(billWidthMm('THERMAL_80', 'SMALL', 'STANDARD'), 68);
    assert.equal(billWidthMm('THERMAL_80', 'NONE', 'STANDARD'), 72);
    assert.equal(billWidthMm('THERMAL_58', 'MORE'), 40);
    assert.equal(billWidthMm('A4', 'MORE'), 186);
    assert.equal(
      pageCss({ printer: 'THERMAL_80', contentHeightMm: 100, edgeMargin: 'MORE', printWidth: 'STANDARD', widthMm: billWidthMm('THERMAL_80', 'MORE', 'STANDARD') }),
      '@page { size: 69mm 101mm; margin: 0; }',
    );
  });

  it("names no size on the printer's roll, so the bill starts at the top of the driver's paper", () => {
    for (const printer of ['THERMAL_80', 'THERMAL_58']) {
      assert.equal(pageCss({ printer, contentHeightMm: 120, paperLength: 'ROLL' }), '@page { margin: 0; }');
    }
  });

  it('lays a roll out to what the head prints, and fits its characters inside it', () => {
    assert.equal(contentWidthMm('THERMAL_58'), 48);
    assert.equal(contentWidthMm('THERMAL_58', 'NONE', 'STANDARD'), 48);
    assert.equal(contentWidthMm('THERMAL_80'), 78);
    assert.equal(contentWidthMm('THERMAL_80', 'NONE', 'STANDARD'), 72);
    assert.equal(contentWidthMm('THERMAL_80', 'NONE', 'UNKNOWN'), 78);
    for (const printer of ['THERMAL_58', 'THERMAL_80']) {
      for (const width of ['WIDE', 'STANDARD']) {
        const lineMm = monospaceFontMm(printer, 'NONE', width) * 0.6 * charactersFor(printer);
        assert.ok(lineMm <= contentWidthMm(printer, 'NONE', width) - 2 + 1e-9, `${printer} ${width}: ${lineMm} mm`);
      }
    }
  });

  it("sizes the thermal bill's text per roll, Normal by default and for anything unknown", () => {
    assert.equal(billFontPx('THERMAL_80'), 13.5);
    assert.equal(billFontPx('THERMAL_58'), 10);
    assert.equal(billFontPx('THERMAL_80', 'LARGE'), 15);
    assert.equal(billFontPx('THERMAL_58', 'SMALL'), 9);
    assert.equal(billFontPx('THERMAL_80', 'HUGE'), 13.5);
    for (const size of Object.keys(BILL_TEXT_SIZES)) assert.ok(billFontPx('THERMAL_58', size) < billFontPx('THERMAL_80', size));
  });

  it('gives A4 and A5 their own paper with 12 mm margins', () => {
    assert.equal(pageCss({ printer: 'A4' }), '@page { size: A4; margin: 12mm; }');
    assert.equal(pageCss({ printer: 'A5' }), '@page { size: A5; margin: 12mm; }');
  });

  it('refuses an unknown printer', () => {
    assert.throws(() => pageCss({ printer: 'LETTER' }), /Unknown printer/);
  });

  it('moves a device that saved a paper width to the same paper, as a printer', () => {
    assert.equal(printerFor({ paperMm: 80 }), 'THERMAL_80');
    assert.equal(printerFor({ paperMm: 58 }), 'THERMAL_58');
    assert.equal(printerFor({}), 'THERMAL_80');
    assert.equal(printerFor({ printer: 'A5', paperMm: 58 }), 'A5');
    assert.equal(charactersFor('THERMAL_58'), 32);
    assert.equal(charactersFor('A4'), 48);
  });
});

describe('the receipt and the full-page invoice', () => {
  it('print the same amounts for every golden day bill', async () => {
    const token = golden.tokens.OWNER;
    const ids = Object.entries(golden.ids.bills);
    assert.equal(ids.length, 16);

    for (const [name, billId] of ids) {
      const invoice = (await request('GET', `/api/v1/bills/${billId}/invoice`, { token })).body.data;
      const bill = (await request('GET', `/api/v1/bills/${billId}`, { token })).body.data;
      const { text } = (await request('GET', `/api/v1/bills/${billId}/receipt?width=48`, { token })).body.data;

      // The invoice carries the bill's own frozen figures, unchanged.
      assert.equal(invoice.billNumber, bill.billNumber, name);
      assert.equal(invoice.itemTotalInPaise, bill.subtotalInPaise, name);
      assert.equal(invoice.gstInPaise, bill.totalTaxInPaise, name);
      assert.equal(invoice.cgstInPaise + invoice.sgstInPaise, bill.totalTaxInPaise, name);
      assert.equal(invoice.roundOffInPaise, bill.roundOffInPaise, name);
      assert.equal(invoice.billTotalInPaise, bill.grandTotalInPaise, name);
      assert.equal(invoice.discount?.amountInPaise ?? 0, bill.discount?.amountInPaise ?? 0, name);
      assert.deepEqual(invoice.lines.map((line) => line.lineTotalInPaise), bill.lines.map((line) => line.lineTotalInPaise), name);
      assert.deepEqual(invoice.payments.map((payment) => payment.amountInPaise), bill.payments.map((payment) => payment.amountInPaise), name);

      // And the paper prints every one of those amounts.
      const onPaper = (paise) => assert.ok(text.includes(paiseToRupees(Math.abs(paise))), `${name}: ${paiseToRupees(paise)} is not on the receipt`);
      onPaper(invoice.itemTotalInPaise);
      onPaper(invoice.billTotalInPaise);
      invoice.lines.forEach((line) => onPaper(line.lineTotalInPaise));
      invoice.taxRows.forEach((row) => {
        onPaper(row.cgstInPaise);
        onPaper(row.sgstInPaise);
      });
      if (invoice.discount) onPaper(invoice.discount.amountInPaise);
      if (invoice.roundOffInPaise !== 0) onPaper(invoice.roundOffInPaise);
      invoice.payments.forEach((payment) => onPaper(payment.amountInPaise));
      assert.ok(text.includes(invoice.billNumber), name);
    }
  });

  it('names the cashier, and shows a guest by name and the last four digits of their mobile only', async () => {
    const plain = await request('GET', `/api/v1/bills/${golden.ids.bills.B01}/invoice`, { token: golden.tokens.OWNER });
    assert.equal(plain.status, 200);
    assert.equal(typeof plain.body.data.cashierName, 'string');
    assert.ok(plain.body.data.cashierName.length > 0);

    const orderId = golden.ids.orders.B01;
    await Order.updateOne({ restaurantId: golden.restaurant._id, _id: orderId }, { $set: { customerName: 'Asha', customerPhone: '9876543210' } });
    const named = await request('GET', `/api/v1/bills/${golden.ids.bills.B01}/invoice`, { token: golden.tokens.OWNER });
    assert.deepEqual(named.body.data.customer, { name: 'Asha', mobileLast4: '3210' });
    assert.doesNotMatch(JSON.stringify(named.body), /9876543210|987654/);
    await Order.updateOne({ restaurantId: golden.restaurant._id, _id: orderId }, { $set: { customerName: null, customerPhone: null } });
  });

  it('is readable by the same six roles as the receipt, and by no other restaurant', async () => {
    const billId = golden.ids.bills.B01;
    for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER']) {
      if (!golden.tokens[role]) continue;
      for (const path of ['invoice', 'receipt']) {
        const response = await request('GET', `/api/v1/bills/${billId}/${path}`, { token: golden.tokens[role] });
        assert.equal(response.status, 200, `${role} ${path}`);
      }
    }
    assert.equal((await request('GET', `/api/v1/bills/${billId}/invoice`)).status, 401);
    const other = await seedTeam();
    assert.equal((await request('GET', `/api/v1/bills/${billId}/invoice`, { token: other.tokens.OWNER })).status, 404);
  });

  it('prints the receipt settings, and Duplicate never on a first print', async () => {
    const owner = golden.tokens.OWNER;
    const billId = golden.ids.bills.B01;
    const before = (await request('GET', `/api/v1/bills/${billId}/receipt?width=48`, { token: owner })).body.data;
    assert.equal(before.reviewLinkUrl, null);
    assert.doesNotMatch(before.text, /DUPLICATE|Scan to review us/);
    assert.match(before.text, /TAX INVOICE/);

    const receipt = { headerLine2: 'Indian Street Food', footerText: 'Swaad bhi, Yaad bhi!', reviewLinkUrl: 'https://example.com/review' };
    const patch = await request('PATCH', '/api/v1/settings', { token: owner, body: { reason: 'Receipt lines', receipt } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    try {
      const after = (await request('GET', `/api/v1/bills/${billId}/receipt?width=48`, { token: owner })).body.data;
      assert.equal(after.reviewLinkUrl, 'https://example.com/review');
      assert.match(after.text, /Indian Street Food/);
      assert.match(after.text, /Swaad bhi, Yaad bhi!/);
      assert.match(after.text, /Scan to review us/);
      const invoice = (await request('GET', `/api/v1/bills/${billId}/invoice`, { token: owner })).body.data;
      assert.deepEqual(invoice.restaurant.headerLines, ['Indian Street Food']);
      assert.equal(invoice.footerText, 'Swaad bhi, Yaad bhi!');
      assert.equal(invoice.isDuplicate, false);
    } finally {
      await request('PATCH', '/api/v1/settings', {
        token: owner,
        body: { reason: 'Back', receipt: { headerLine2: null, footerText: null, reviewLinkUrl: null } },
      });
    }
  });
});

describe('the review link setting', () => {
  it('accepts an https address and clears with an empty string', async () => {
    const team = await seedTeam();
    const set = await request('PATCH', '/api/v1/settings', {
      token: team.tokens.OWNER,
      body: { reason: 'Review QR', receipt: { reviewLinkUrl: 'https://g.page/r/abc123/review' } },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.data.receipt.reviewLinkUrl, 'https://g.page/r/abc123/review');

    const cleared = await request('PATCH', '/api/v1/settings', {
      token: team.tokens.OWNER,
      body: { reason: 'No QR', receipt: { reviewLinkUrl: '' } },
    });
    assert.equal(cleared.body.data.receipt.reviewLinkUrl, null);
  });

  it('refuses http, anything not a web address, and anything over 300 characters', async () => {
    const team = await seedTeam();
    for (const bad of ['http://g.page/r/abc', 'not a link', 'https://', `https://example.com/${'a'.repeat(290)}`]) {
      const response = await request('PATCH', '/api/v1/settings', {
        token: team.tokens.OWNER,
        body: { reason: 'Review QR', receipt: { reviewLinkUrl: bad } },
      });
      assert.equal(response.status, 400, bad.slice(0, 40));
    }
  });
});
