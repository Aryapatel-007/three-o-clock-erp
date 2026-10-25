/**
 * P65: the CA's month, sent by itself. docs/API-CONTRACT.md "P65", REPORT-SPEC
 * R20, DB-SCHEMA section 61.
 *
 * September 2026 around the golden day, every date closed with the count the
 * owner sees as expected. The pack must agree with R2, R5, R8 and R10 to the
 * paisa, refuse a month with a day open or a check failing, never send a month
 * twice, and never write the CA's contact details into the audit trail.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';

import ExcelJS from 'exceljs';

import { setRoleForTest } from '../config/deployment.js';
import { AuditLog } from '../models/AuditLog.js';
import { Bill } from '../models/Bill.js';
import { CaReportSend } from '../models/CaReportSend.js';
import { ALL_MODELS } from '../models/index.js';
import { Order } from '../models/Order.js';
import { ReplicaCursor } from '../models/ReplicaCursor.js';
import { tickCaSends } from '../services/caPackService.js';
import { setEmailForTests } from '../services/emailService.js';
import { setSyncModeForTest } from '../services/sync/mode.js';
import { resetWriterStateForTest } from '../services/replication/writerState.js';
import { resetClockForTests, setClockForTests } from '../utils/time.js';
import { buildGoldenDay, GOLDEN_DATE, ist } from './helpers/goldenDay.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

const MONTH = '2026-09';
const CA = { enabled: true, name: 'Mehta & Co', email: 'ca@mehta.example', whatsapp: '9876500011' };

let golden;
let serverUrl;
const baseUrl = () => serverUrl;
let fake;
let failNext = false;
const sent = [];

const owner = () => golden.tokens.OWNER;
const get = (path, token = owner()) => request('GET', path, { token });
const pack = (query = `month=${MONTH}`, token = owner()) => get(`/api/v1/reports/v2/ca-pack?${query}`, token);
const section = (envelope, key) => envelope.sections.find((entry) => entry.key === key);

function nextDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** Closes every date of the month in order, counting what the owner sees as expected. */
async function closeMonth(world) {
  for (let day = 1; day <= 30; day += 1) {
    const date = `${MONTH}-${String(day).padStart(2, '0')}`;
    setClockForTests(ist('09:00', nextDate(date)));
    try {
      const read = await get(`/api/v1/day-close/${date}`, world.tokens.OWNER);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const expected = read.body.data.figures?.cash?.expectedCashInPaise ?? read.body.data.expectedCashInPaise ?? 0;
      const close = await request('POST', '/api/v1/day-close', {
        token: world.tokens.OWNER,
        body: { businessDate: date, countedCashInPaise: expected, note: 'Counted for the CA pack test' },
      });
      assert.equal(close.status, 201, `${date}: ${JSON.stringify(close.body)}`);
    } finally {
      resetClockForTests();
    }
  }
}

async function connectTally(world) {
  const ledgers = {
    salesByRate: { 0: 'Sales @ 0%', 500: 'Sales @ 5%' },
    platformSales: 'Sales, aggregator, section 9(5)',
    cgst: 'Output CGST',
    sgst: 'Output SGST',
    roundOff: 'Round Off',
    paymentMethods: { CASH: 'Cash', CARD: 'Card', UPI: 'UPI', ZOMATO_GOLD: 'Zomato Gold', DINEOUT: 'Dineout', EAZYDINER: 'EazyDiner', ZOMATO: 'Zomato', SWIGGY: 'Swiggy' },
    onHold: { mode: 'PER_ACCOUNT', byAccount: { [world.ids.accounts['E-210 Office']]: 'E-210 Office', [world.ids.accounts['W-330 Office']]: 'W-330 Office' } },
    paidOut: 'Petty Expenses',
    paidIn: 'Petty Cash Received',
  };
  const saved = await request('PUT', '/api/v1/integrations/TALLY', {
    token: world.tokens.OWNER,
    body: { environment: 'PRODUCTION', config: { version: 'TALLY_PRIME', companyName: 'CA Cafe & Co', granularity: 'DAILY_SUMMARY', ledgers } },
  });
  assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.body));
  const tested = await request('POST', '/api/v1/integrations/TALLY/test', { token: world.tokens.OWNER });
  assert.equal(tested.status, 200, JSON.stringify(tested.body));
}

before(async () => {
  await startTestDatabase();
  serverUrl = await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  golden = await buildGoldenDay({ name: 'CA Cafe' });
  // A guest on one order, so the pack can be checked for carrying nothing of theirs.
  await Order.updateOne({ restaurantId: golden.restaurant._id, _id: golden.ids.orders.B01 }, { $set: { customerName: 'Asha Patel', customerPhone: '9123456780' } });
  await closeMonth(golden);
  await connectTally(golden);

  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (failNext) {
        failNext = false;
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'The from address is not verified' }));
        return;
      }
      sent.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `email_${sent.length}` }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  setEmailForTests({ base: `http://127.0.0.1:${fake.address().port}`, apiKey: 're_test_key', from: 'Test <onboarding@resend.dev>' });
});

afterEach(() => {
  resetClockForTests();
  setRoleForTest(null);
  setSyncModeForTest(null);
  resetWriterStateForTest();
});

after(async () => {
  setEmailForTests(null);
  await new Promise((resolve) => fake.close(resolve));
  await stopTestServer();
  await stopTestDatabase();
});

describe('R20 CA Pack', () => {
  it('reconciles with R2, R5, R8 and R10 to the paisa, and passes its checks', async () => {
    const response = await pack();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const envelope = response.body.data;
    assert.deepEqual(envelope.sections.map((entry) => entry.key), ['cover', 'outward', 'hsn', 'documents', 'money', 'onHold', 'cash', 'checks']);
    assert.equal(envelope.openDays.length, 0);
    assert.ok(envelope.checks.every((check) => check.passed || check.severity !== 'ERROR'), JSON.stringify(envelope.checks));
    assert.ok(envelope.checks.some((check) => check.id === 'C5.8' && check.passed));

    const gst = (await get(`/api/v1/reports/v2/gst?from=${MONTH}-01&to=${MONTH}-30`)).body.data;
    const r8 = section(gst, 'byRate');
    const r8Platform = section(gst, 'platform');
    const outward = section(envelope, 'outward');
    assert.equal(outward.totals.netSalesInPaise, r8.totals.netSalesInPaise + r8Platform.totals.netSalesInPaise);
    assert.equal(outward.totals.cgstInPaise, r8.totals.cgstInPaise);
    assert.equal(outward.totals.sgstInPaise, r8.totals.sgstInPaise);
    assert.ok(outward.rows.some((row) => /section 9\(5\)/.test(row.taxRate)), 'the platform line names section 9(5)');

    // The golden day is the month's only trading day, so its R2 is the month.
    const r2 = (await get(`/api/v1/reports/v2/day-close?date=${GOLDEN_DATE}`)).body.data;
    const r2Net = section(r2, 'sales').rows.find((row) => row.line === 'Net sales');
    assert.equal(outward.totals.netSalesInPaise, r2Net.amountInPaise, 'net sales as R2 says');

    const hsn = section(envelope, 'hsn');
    assert.equal(hsn.totals.netSalesInPaise, outward.totals.netSalesInPaise);
    assert.equal(hsn.totals.cgstInPaise, outward.totals.cgstInPaise);
    assert.equal(hsn.totals.sgstInPaise, outward.totals.sgstInPaise);
    assert.ok(hsn.rows.every((row) => row.code === '996331'), 'every golden line froze the default SAC');

    const register = (await get(`/api/v1/reports/v2/invoice-register?from=${MONTH}-01&to=${MONTH}-30&limit=200`)).body.data;
    assert.deepEqual(section(envelope, 'documents').rows.map((row) => [row.billNumber, row.status]), register.rows.map((row) => [row.billNumber, row.status]));

    const r5 = section((await get(`/api/v1/reports/v2/payments?from=${MONTH}-01&to=${MONTH}-30`)).body.data, 'days');
    const money = section(envelope, 'money');
    for (const column of r5.columns.filter((entry) => entry.type === 'money')) {
      assert.equal(money.rows.find((row) => row.line === column.label)?.amountInPaise, r5.totals[column.key], column.label);
    }

    const onHold = section(envelope, 'onHold');
    for (const row of onHold.rows) {
      assert.equal(row.openingInPaise + row.chargedInPaise - row.collectedInPaise + row.adjustedInPaise, row.closingInPaise, row.name);
    }
    assert.ok(section(envelope, 'cover').rows.some((row) => /No purchases/.test(row.detail)));
  });

  it('carries no guest field anywhere', async () => {
    const text = JSON.stringify((await pack()).body.data);
    for (const leak of ['Asha', '9123456780', '6780', 'customer', 'mobile']) assert.ok(!text.includes(leak), leak);
  });

  it('writes one sheet per section in the workbook', async () => {
    const response = await fetch(`${baseUrl()}/api/v1/reports/v2/ca-pack?month=${MONTH}&format=xlsx`, { headers: { Authorization: `Bearer ${owner()}` } });
    assert.equal(response.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const names = book.worksheets.map((sheet) => sheet.name);
    for (const name of ['Cover', 'Outward supplies', 'HSN and SAC summary', 'Document series', 'Money received', 'On Hold movement', 'Cash and expenses', 'Checks run', 'Checks']) {
      assert.ok(names.includes(name), name);
    }
  });

  it('refuses a month with a day open and names the dates', async () => {
    const response = await pack('month=2026-08');
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'DAY_NOT_CLOSED');
    assert.ok(response.body.error.businessDates.includes('2026-08-01'));
    assert.match(response.body.error.message, /whole months of closed days/);
  });

  it('refuses while an ERROR check fails, as R9 does', async () => {
    const bill = await Bill.findOne({ restaurantId: golden.restaurant._id, isVoided: false, roundOffInPaise: { $ne: 0 } }).lean();
    await Bill.collection.updateOne({ _id: bill._id }, { $inc: { roundOffInPaise: 1 } });
    try {
      const response = await pack();
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'CHECK_FAILED');
    } finally {
      await Bill.collection.updateOne({ _id: bill._id }, { $inc: { roundOffInPaise: -1 } });
    }
  });

  it('fails C5.8 when a line has no share, and refuses the pack', async () => {
    const bill = await Bill.findOne({ restaurantId: golden.restaurant._id, isVoided: false, 'lines.0.taxableInPaise': { $gt: 0 } }).lean();
    const was = bill.lines[0].taxableInPaise;
    await Bill.collection.updateOne({ _id: bill._id }, { $set: { 'lines.0.taxableInPaise': null } });
    try {
      const response = await pack();
      assert.equal(response.status, 422);
      assert.equal(response.body.error.code, 'CHECK_FAILED');
      assert.deepEqual(response.body.error.checks.map((check) => check.id), ['C5.8']);
    } finally {
      await Bill.collection.updateOne({ _id: bill._id }, { $set: { 'lines.0.taxableInPaise': was } });
    }
  });

  it('refuses on a mirror that has not received the month, and builds once the cursor passes', async () => {
    const restaurantId = golden.restaurant._id;
    await ReplicaCursor.create({ restaurantId, appliedSeq: 10, lastCapturedAt: new Date('2026-09-20T00:00:00Z') });
    setRoleForTest('MIRROR');
    const behind = await pack();
    assert.equal(behind.status, 422, JSON.stringify(behind.body));
    assert.match(behind.body.error.message, /not received the whole month/);
    setRoleForTest(null);
    await ReplicaCursor.updateOne({ restaurantId }, { $set: { lastCapturedAt: new Date('2026-10-02T00:00:00Z') } });
    setRoleForTest('MIRROR');
    assert.equal((await pack()).status, 200);
    setRoleForTest(null);
    await ReplicaCursor.deleteMany({ restaurantId });
  });

  it('refuses on the two-way website until the cafe PC has sent the month, and builds once it has', async () => {
    const restaurantId = golden.restaurant._id;
    await ReplicaCursor.create({ restaurantId, appliedSeq: 10, lastCapturedAt: new Date('2026-09-20T00:00:00Z') });
    setRoleForTest('CLOUD');
    setSyncModeForTest('TWO_WAY');
    const behind = await pack();
    assert.equal(behind.status, 422, JSON.stringify(behind.body));
    assert.match(behind.body.error.message, /not received the whole month/);
    // A gap in what arrived is as good as behind.
    await ReplicaCursor.updateOne({ restaurantId }, { $set: { lastCapturedAt: new Date('2026-10-02T00:00:00Z'), gap: { expectedSeq: 11, gotSeq: 13, at: new Date() } } });
    assert.equal((await pack()).status, 422);
    await ReplicaCursor.updateOne({ restaurantId }, { $set: { gap: { expectedSeq: null, gotSeq: null, at: null } } });
    assert.equal((await pack()).status, 200);
    setSyncModeForTest(null);
    setRoleForTest(null);
    await ReplicaCursor.deleteMany({ restaurantId });
  });

  it('is the owner’s alone', async () => {
    assert.equal((await pack(`month=${MONTH}`, golden.tokens.MANAGER)).status, 403);
    assert.equal((await get('/api/v1/reports/ca/sends', golden.tokens.MANAGER)).status, 403);
    assert.equal((await request('POST', '/api/v1/reports/ca/send', { token: golden.tokens.MANAGER, body: { month: MONTH } })).status, 403);
    assert.equal((await get(`/api/v1/reports/ca/tally-xml?month=${MONTH}`, golden.tokens.MANAGER)).status, 403);
  });
});

describe("the CA's details", () => {
  it('cannot be switched on without an email', async () => {
    const refused = await request('PATCH', '/api/v1/settings', { token: owner(), body: { reason: 'CA', reports: { ca: { enabled: true } } } });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
  });

  it('are saved without their values in the audit trail', async () => {
    const saved = await request('PATCH', '/api/v1/settings', { token: owner(), body: { reason: 'Our CA', reports: { ca: CA } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.data.reports.ca, CA);
    const lines = await AuditLog.find({ restaurantId: golden.restaurant._id, action: 'SETTINGS_CHANGED', 'details.field': /^reports\.ca\./ }).lean();
    assert.equal(lines.length, 4);
    const text = JSON.stringify(lines);
    for (const value of [CA.whatsapp, CA.email, 'Mehta']) assert.ok(!text.includes(value), `${value} is in the audit trail`);
    assert.ok(lines.filter((line) => line.details.field !== 'reports.ca.enabled').every((line) => line.details.valueRecorded === false));
    const me = await get('/api/v1/auth/me');
    assert.ok(!JSON.stringify(me.body).includes(CA.whatsapp));
  });
});

describe('the monthly send', () => {
  it('sends last month once on the 1st, with the workbook and the Tally file, however often it ticks', async () => {
    await CaReportSend.deleteMany({ restaurantId: golden.restaurant._id });
    const before = sent.length;
    setClockForTests(ist('10:00', '2026-10-01'));
    await tickCaSends();
    await tickCaSends();
    assert.equal(sent.length, before + 1, 'one email for the month');
    const mail = sent.at(-1);
    assert.deepEqual(mail.to, [CA.email]);
    assert.match(mail.text.split('\n')[0], /September 2026/);
    assert.deepEqual(mail.attachments.map((file) => file.filename.split('.').pop()), ['xlsx', 'xml']);
    assert.match(Buffer.from(mail.attachments[1].content, 'base64').toString('utf8'), /<ENVELOPE>/);

    const rows = await CaReportSend.find({ restaurantId: golden.restaurant._id }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'SENT');
    assert.equal(rows[0].period, MONTH);
    const audit = await AuditLog.find({ restaurantId: golden.restaurant._id, action: 'CA_PACK_SENT' }).lean();
    assert.equal(audit.length, 1);
    assert.ok(!JSON.stringify(audit).includes(CA.email), 'the audit line never carries the address');
  });

  it('records a refusal by the email service as FAILED, and tries once on the next tick', async () => {
    await CaReportSend.deleteMany({ restaurantId: golden.restaurant._id });
    const before = sent.length;
    setClockForTests(ist('11:00', '2026-10-01'));
    failNext = true;
    await tickCaSends();
    let row = await CaReportSend.findOne({ restaurantId: golden.restaurant._id }).lean();
    assert.equal(row.status, 'FAILED');
    assert.match(row.lastError, /not verified/);
    assert.equal(sent.length, before);
    await tickCaSends();
    row = await CaReportSend.findOne({ restaurantId: golden.restaurant._id }).lean();
    assert.equal(row.status, 'SENT');
    assert.equal(row.attempts, 2);
    assert.equal(sent.length, before + 1);
  });

  it('refuses a month with a day open, and says so in the history', async () => {
    setClockForTests(ist('10:00', '2026-09-01'));
    await tickCaSends();
    resetClockForTests();
    const history = (await get('/api/v1/reports/ca/sends')).body.data;
    const august = history.sends.find((entry) => entry.period === '2026-08');
    assert.equal(august.status, 'REFUSED');
    assert.ok(august.openDates.includes('2026-08-31'));
    assert.equal(history.ca.enabled, true);
    assert.ok(!JSON.stringify(history).includes(CA.whatsapp));
  });

  it("lets the owner send a month now, even one already sent, and download the Tally file", async () => {
    const before = sent.length;
    const now = await request('POST', '/api/v1/reports/ca/send', { token: owner(), body: { month: MONTH } });
    assert.equal(now.status, 200, JSON.stringify(now.body));
    assert.equal(now.body.data.status, 'SENT');
    assert.equal(now.body.data.trigger, 'MANUAL');
    assert.equal(sent.length, before + 1);

    const open = await request('POST', '/api/v1/reports/ca/send', { token: owner(), body: { month: '2026-07' } });
    assert.equal(open.status, 422);
    assert.equal((await CaReportSend.findOne({ restaurantId: golden.restaurant._id, period: '2026-07' }).lean()).status, 'REFUSED');

    const xml = await get(`/api/v1/reports/ca/tally-xml?month=${MONTH}`);
    assert.equal(xml.status, 200);
    assert.match(xml.body.raw, /<ENVELOPE>/);
    assert.equal((await request('POST', '/api/v1/reports/ca/send', { token: owner(), body: { month: '2026-13' } })).status, 400);
  });
});
