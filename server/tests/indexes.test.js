/**
 * Index build and the production index check.
 *
 * `autoIndex` is off in production, so on a fresh production database nothing
 * would build the unique indexes that stop a duplicate bill number, a second
 * open order on a table, a reused KOT number or a double stock deduction.
 * `npm run db:indexes` builds them on every deploy and the boot check refuses
 * to start without them. These tests prove both halves read the database
 * honestly, and that the build never drops anything.
 *
 * Every test that removes an index puts it back, so the next one starts clean.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import mongoose from 'mongoose';

import { Bill } from '../models/Bill.js';
import { ALL_MODELS } from '../models/index.js';
import { Kot } from '../models/Kot.js';
import { Table } from '../models/Table.js';
import { User } from '../models/User.js';
import { buildIndexes, findMissingIndexes } from '../services/indexService.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';

const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');

before(async () => {
  await startTestDatabase();
  await Promise.all(ALL_MODELS.map((model) => model.init()));
});

after(async () => {
  await stopTestDatabase();
});

const rowFor = (report, modelName) => report.find((row) => row.model === modelName);

describe('the model registry', () => {
  it('lists every model file in server/models, and nothing else', () => {
    const fromFolder = readdirSync(MODELS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js')
      .map((entry) => entry.name.replace(/\.js$/, ''))
      .sort();

    const registered = ALL_MODELS.map((model) => model.modelName);

    assert.deepEqual([...registered].sort(), fromFolder);
    assert.deepEqual(registered, [...registered].sort(), 'ALL_MODELS is alphabetical');
    assert.equal(Object.isFrozen(ALL_MODELS), true);
  });
});

describe('findMissingIndexes', () => {
  it('finds nothing missing and nothing extra once every model has built its indexes', async () => {
    const { missing, extra } = await findMissingIndexes();
    assert.deepEqual(missing, []);
    assert.deepEqual(extra, []);
  });

  it('reports a dropped unique index on bills, and buildIndexes puts it back', async () => {
    await Bill.collection.dropIndex('restaurantId_1_billNumber_1');

    const before = await findMissingIndexes();
    assert.equal(before.missing.length, 1);
    assert.deepEqual(before.missing[0], {
      model: 'Bill',
      collection: 'bills',
      key: { restaurantId: 1, billNumber: 1 },
      options: { unique: true },
    });

    const report = await buildIndexes();
    assert.deepEqual(rowFor(report, 'Bill').created, ['restaurantId_1_billNumber_1']);
    assert.equal(rowFor(report, 'Bill').error, null);

    const afterBuild = await findMissingIndexes();
    assert.deepEqual(afterBuild.missing, []);
  });

  it('reads indexes listed as MongoDB 9 lists them, with the simple collation, as present', async () => {
    const listIndexes = User.listIndexes;
    User.listIndexes = async function asMongo9() {
      return (await listIndexes.call(this)).map((index) => ({ ...index, collation: { locale: 'simple' } }));
    };
    try {
      const { missing, extra } = await findMissingIndexes([User]);
      assert.deepEqual(missing, []);
      assert.deepEqual(extra, []);
    } finally {
      User.listIndexes = listIndexes;
    }
  });

  it('still counts an index with a real collation as different', async () => {
    const listIndexes = User.listIndexes;
    User.listIndexes = async function withFrench() {
      return (await listIndexes.call(this)).map((index) => ({ ...index, collation: { locale: 'fr' } }));
    };
    try {
      const { missing } = await findMissingIndexes([User]);
      assert.equal(missing.length, User.schema.indexes().length);
    } finally {
      User.listIndexes = listIndexes;
    }
  });

  it('treats a collection that does not exist as missing every index, without throwing', async () => {
    await Kot.collection.drop();

    const declared = Kot.schema.indexes().map(([key]) => key);
    const { missing } = await findMissingIndexes();

    assert.equal(missing.length, declared.length);
    assert.ok(missing.every((index) => index.model === 'Kot' && index.collection === 'kots'));
    assert.deepEqual(
      missing.map((index) => index.key),
      declared,
    );

    const report = await buildIndexes();
    assert.equal(rowFor(report, 'Kot').created.length, declared.length);
    assert.equal(rowFor(report, 'Kot').alreadyPresent, 0);
    assert.deepEqual((await findMissingIndexes()).missing, []);
  });
});

describe('buildIndexes', () => {
  it('reports duplicate data on a unique index and carries on with every other model', async () => {
    await User.collection.dropIndex('phone_1');

    // Straight into the collection: no schema, no tenant guard, which is
    // exactly how bad data gets into a real database before an index exists.
    const restaurantId = new mongoose.Types.ObjectId();
    const branchId = new mongoose.Types.ObjectId();
    const duplicate = { restaurantId, branchId, name: 'Duplicate', phone: '9000000001' };
    const { insertedIds } = await User.collection.insertMany([{ ...duplicate }, { ...duplicate }]);

    try {
      const report = await buildIndexes();

      assert.equal(report.length, ALL_MODELS.length);
      const userRow = rowFor(report, 'User');
      assert.match(userRow.error, /Duplicate key on \{ phone: 1 \}/);
      assert.match(userRow.error, /by hand/);
      assert.deepEqual(userRow.created, []);

      for (const row of report.filter((r) => r.model !== 'User')) {
        assert.equal(row.error, null, `${row.model} should not fail because User did`);
      }
    } finally {
      await User.collection.deleteMany({ _id: { $in: Object.values(insertedIds) } });
      const rebuilt = await buildIndexes();
      assert.deepEqual(rowFor(rebuilt, 'User').created, ['phone_1']);
    }

    assert.deepEqual((await findMissingIndexes()).missing, []);
  });

  it('leaves an index nobody declared exactly where it is, and reports it as extra', async () => {
    await Table.collection.createIndex({ restaurantId: 1, foo: 1 });

    try {
      const report = await buildIndexes();
      assert.deepEqual(rowFor(report, 'Table').extra, ['restaurantId_1_foo_1']);
      assert.equal(rowFor(report, 'Table').error, null);

      const names = (await Table.collection.listIndexes().toArray()).map((index) => index.name);
      assert.ok(names.includes('restaurantId_1_foo_1'), 'the build must never drop an index');

      const { extra } = await findMissingIndexes();
      assert.deepEqual(extra, [{ model: 'Table', collection: 'tables', name: 'restaurantId_1_foo_1' }]);
    } finally {
      // The test removes its own index. The build never would.
      await Table.collection.dropIndex('restaurantId_1_foo_1');
    }
  });
});
