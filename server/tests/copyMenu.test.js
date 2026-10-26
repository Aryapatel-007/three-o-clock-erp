/**
 * P62. Copying a cafe's menu and floor from the live database onto a box.
 * The source is read only; the target must be empty; ids and the floor plan survive.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { ALL_MODELS } from '../models/index.js';
import { bundleFromText, bundleToText, copyMenu, readBundle, trialSettings, writeBundle } from '../scripts/copyMenuFromLive.js';
import { createMenuItem, createTable, seedTeam } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

let sourceDb;
let targetDb;
const quiet = () => {};

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  sourceDb = mongoose.connection.db;
  targetDb = mongoose.connection.client.db('copy-menu-target');
});

after(async () => {
  await targetDb.dropDatabase();
  await stopTestServer();
  await stopTestDatabase();
});

async function emptyTarget(phone = '9111111111') {
  const restaurantId = new mongoose.Types.ObjectId();
  const branchId = new mongoose.Types.ObjectId();
  await targetDb.collection('restaurants').insertOne({
    _id: restaurantId,
    name: 'Box Cafe',
    settings: { invoice: { mode: 'FINANCIAL_YEAR', prefix: null, startingNumber: null }, businessDayStartsAtMinutes: 300 },
  });
  await targetDb.collection('users').insertOne({ restaurantId, branchId, phone, role: 'OWNER', name: 'Box Owner' });
  await targetDb.collection('paymentmethods').insertOne({ restaurantId, code: 'CASH', name: 'Cash', kind: 'IN_HAND', isActive: true });
  return { restaurantId, branchId };
}

/** seedTeam gives every restaurant one name; the copy finds its source by name. */
let named = 0;
async function nameSource(team) {
  named += 1;
  const name = `Source Cafe ${named}`;
  await sourceDb.collection('restaurants').updateOne({ _id: new mongoose.Types.ObjectId(team.restaurant.id) }, { $set: { name } });
  return name;
}

describe('copying the menu and floor from the live database', () => {
  it('copies stations, categories, dishes and tables with their places, and reads only from the source', async () => {
    const team = await seedTeam();
    const owner = team.tokens.OWNER;
    const dish = (await createMenuItem(owner, { name: 'Pani Puri', priceInPaise: 6000 })).body.data;
    const table = (await createTable(owner, { name: 'A1', section: 'Garden' })).body.data;
    await request('PATCH', '/api/v1/tables/layout', { token: owner, body: { section: 'Garden', tables: [{ id: table.id, x: 2, y: 1 }] } });
    const before = await sourceDb.collection('menuitems').countDocuments();

    const target = await emptyTarget();
    const name = team.restaurant.name;
    const dry = await copyMenu({ sourceDb, targetDb, source: name, targetPhone: '9111111111', apply: false, log: quiet });
    assert.equal(dry.copied, null);
    assert.equal(await targetDb.collection('menuitems').countDocuments(), 0);

    await copyMenu({ sourceDb, targetDb, source: name, targetPhone: '9111111111', apply: true, log: quiet });
    const copiedDish = await targetDb.collection('menuitems').findOne({ _id: new mongoose.Types.ObjectId(dish.id) });
    assert.equal(copiedDish.name, 'Pani Puri');
    assert.equal(copiedDish.priceInPaise, 6000);
    assert.equal(String(copiedDish.restaurantId), String(target.restaurantId));
    assert.equal(String(copiedDish.branchId), String(target.branchId));
    const category = await targetDb.collection('categories').findOne({ _id: copiedDish.categoryId });
    assert.ok(category, 'the dish keeps its category');
    const copiedTable = await targetDb.collection('tables').findOne({ _id: new mongoose.Types.ObjectId(table.id) });
    assert.equal(copiedTable.section, 'Garden');
    const sourceTable = await sourceDb.collection('tables').findOne({ _id: new mongoose.Types.ObjectId(table.id) });
    assert.deepEqual(copiedTable.layout, sourceTable.layout);
    assert.equal(await sourceDb.collection('menuitems').countDocuments(), before, 'the source is unchanged');

    await assert.rejects(copyMenu({ sourceDb, targetDb, source: name, targetPhone: '9111111111', apply: true, log: quiet }), /already has/);
  });

  it('refuses an unknown restaurant or owner, changing nothing', async () => {
    await assert.rejects(copyMenu({ sourceDb, targetDb, source: 'No Such Cafe', targetPhone: '9111111111', apply: true, log: quiet }), /No restaurant called/);
  });

  it('brings the look, settings and payment methods, but never the invoice series, GSTIN or day-end emails', async () => {
    const team = await seedTeam();
    const name = await nameSource(team);
    const sourceRestaurant = await sourceDb.collection('restaurants').findOne({ name });
    await sourceDb.collection('restaurants').updateOne({ _id: sourceRestaurant._id }, {
      $set: {
        gstin: '24ACFFM2074F1ZH',
        contactPhone: '9876543210',
        brandLogos: { lightGround: { data: new mongoose.mongo.Binary(Buffer.from('logo-bytes')), contentType: 'image/png' } },
        'settings.invoice': { mode: 'PREFIX', prefix: 'ZC/', startingNumber: 500 },
        'settings.receipt.footerText': 'Thanks & visit again !!!!',
        'settings.reports': { onHoldTallyCode: 'P03', dayEndEmails: ['owner@example.com'] },
        'settings.features.online': true,
        'settings.appearance.wordmark': 'Z Chaat',
      },
    });
    await sourceDb.collection('paymentmethods').updateOne(
      { restaurantId: sourceRestaurant._id, code: 'CASH' },
      { $set: { name: 'Cash in hand', terminalProvider: 'PINE_LABS', terminalPaymentMode: 1 }, $setOnInsert: { kind: 'IN_HAND', isActive: true } },
      { upsert: true },
    );

    const target = await emptyTarget('9222222222');
    await copyMenu({ sourceDb, targetDb, source: name, targetPhone: '9222222222', apply: true, log: quiet });
    const copied = await targetDb.collection('restaurants').findOne({ _id: target.restaurantId });
    assert.equal(copied.name, 'Box Cafe', 'the target keeps its own name');
    assert.equal(copied.settings.receipt.footerText, 'Thanks & visit again !!!!');
    assert.equal(copied.settings.appearance.wordmark, 'Z Chaat');
    assert.equal(copied.contactPhone, '9876543210');
    assert.equal(Buffer.from(copied.brandLogos.lightGround.data.buffer).toString(), 'logo-bytes');
    assert.equal(copied.settings.invoice.mode, 'FINANCIAL_YEAR', 'never the live invoice series');
    assert.equal(copied.gstin, undefined, 'never the GSTIN');
    assert.deepEqual(copied.settings.reports.dayEndEmails, []);
    assert.equal(copied.settings.reports.onHoldTallyCode, 'P03');
    assert.equal(copied.settings.features.online, false);
    assert.equal(copied.settings.businessDayStartsAtMinutes, sourceRestaurant.settings.businessDayStartsAtMinutes);
    const cash = await targetDb.collection('paymentmethods').find({ restaurantId: target.restaurantId, code: 'CASH' }).toArray();
    assert.equal(cash.length, 1, 'the target\'s own Cash is updated, not doubled');
    assert.equal(cash[0].name, 'Cash in hand');
    assert.equal(cash[0].terminalProvider, null, 'no card machine on the box');
    const methods = await targetDb.collection('paymentmethods').countDocuments({ restaurantId: target.restaurantId });
    assert.equal(methods, await sourceDb.collection('paymentmethods').countDocuments({ restaurantId: sourceRestaurant._id }));
    assert.equal(await targetDb.collection('users').countDocuments({ restaurantId: target.restaurantId }), 1, 'no staff without --with-staff');
  });

  it('brings the staff only when asked, with their sign-in, never the owner or a phone already used', async () => {
    const team = await seedTeam();
    const name = await nameSource(team);
    const sourceRestaurant = await sourceDb.collection('restaurants').findOne({ name });
    const sourceStaff = await sourceDb.collection('users').find({ restaurantId: sourceRestaurant._id, role: { $ne: 'OWNER' } }).toArray();
    const sourceOwner = await sourceDb.collection('users').findOne({ restaurantId: sourceRestaurant._id, role: 'OWNER' });
    const taken = sourceStaff[0];

    const target = await emptyTarget('9333333333');
    await targetDb.collection('users').insertOne({ restaurantId: new mongoose.Types.ObjectId(), phone: taken.phone, role: 'OWNER', name: 'Someone else' });
    const result = await copyMenu({ sourceDb, targetDb, source: name, targetPhone: '9333333333', apply: true, withStaff: true, log: quiet });
    assert.equal(result.staffSkipped, 1);
    const copiedStaff = await targetDb.collection('users').find({ restaurantId: target.restaurantId, role: { $ne: 'OWNER' } }).toArray();
    assert.equal(copiedStaff.length, sourceStaff.length - 1);
    const one = copiedStaff.find((person) => String(person._id) === String(sourceStaff[1]._id));
    assert.equal(one.passwordHash, sourceStaff[1].passwordHash, 'they sign in with the password they know');
    assert.equal(String(one.branchId), String(target.branchId));
    assert.equal(await targetDb.collection('users').countDocuments({ phone: sourceOwner.phone }), 0, 'never the source owner');
  });

  it('goes through a file exactly: ids, dates and the logo bytes', async () => {
    const team = await seedTeam();
    const name = await nameSource(team);
    const sourceRestaurant = await sourceDb.collection('restaurants').findOne({ name });
    await sourceDb.collection('restaurants').updateOne({ _id: sourceRestaurant._id }, {
      $set: { brandLogos: { darkGround: { data: new mongoose.mongo.Binary(Buffer.from([0, 1, 2, 255])), contentType: 'image/png' } } },
    });
    await createMenuItem(team.tokens.OWNER, { name: 'Sev Puri', priceInPaise: 7000 });
    const bundle = await readBundle({ sourceDb, source: name });
    const back = bundleFromText(bundleToText(bundle));
    assert.ok(back.docs.menuitems[0]._id instanceof mongoose.Types.ObjectId);
    assert.ok(back.exportedAt instanceof Date);
    assert.deepEqual([...back.setup.brandLogos.darkGround.data.buffer], [0, 1, 2, 255]);

    const target = await emptyTarget('9444444444');
    await writeBundle({ targetDb, bundle: back, targetPhone: '9444444444', apply: true, log: quiet });
    const dish = await targetDb.collection('menuitems').findOne({ restaurantId: target.restaurantId, name: 'Sev Puri' });
    assert.equal(dish.priceInPaise, 7000);
    await assert.rejects(writeBundle({ targetDb, bundle: { kind: 'something' }, targetPhone: '9444444444', apply: true, log: quiet }), /not a Cafe POS setup/);
  });

  it('keeps the settings a trial must not inherit out of the copy', () => {
    const kept = trialSettings({ invoice: { mode: 'PREFIX' }, reports: { dayEndEmails: ['a@b.c'] }, features: { online: true, inventory: true }, tax: { x: 1 } });
    assert.deepEqual(kept, { reports: { dayEndEmails: [] }, features: { online: false, inventory: true }, tax: { x: 1 } });
  });
});

