/**
 * Copies one restaurant's menu, floor and setup from another database into this
 * one. P62, for bringing a cafe's real setup onto a box for a trial.
 *
 * Straight from the live database (needs its address on the box):
 *   SOURCE_MONGO_URI="mongodb+srv://..." npm run copy:menu -- --source "Z Chaat" --target-phone 9000000001 [--apply]
 *
 * Or in two steps, so the box never holds the live database's password:
 *   on a developer's computer:
 *   SOURCE_MONGO_URI="mongodb+srv://..." npm run copy:menu -- --source "Z Chaat" --export zchaat-setup.json [--with-staff]
 *   on the box:
 *   npm run copy:menu -- --from-file zchaat-setup.json --target-phone 9000000001 [--apply]
 *
 * READS ONLY from the source: it runs `find` and nothing else there. The source
 * address comes from the environment, never the command line, so it does not
 * land in the shell history.
 *
 * Copies: stations, categories (with their station), dishes, dish photos, and
 * tables with their sections and floor plan positions; the restaurant's settings,
 * logo, address and phone; the payment methods; and, with --with-staff, the staff
 * other than the owner, with their passwords and PINs. Never: orders, bills,
 * guests, money, sessions.
 *
 * Left out of the settings on purpose, because a trial must not pass for the real
 * restaurant: the invoice series and the GSTIN (a trial bill must never look like
 * a tax invoice of the live series), the day-end email addresses (the owner must
 * not get trial figures), the online page (the box serves no public page) and the
 * payment gateway. A payment method linked to a card machine comes unlinked.
 *
 * Writes into the restaurant whose owner signs in with --target-phone, in the
 * database MONGO_URI names, keeping the source's document ids and moving each
 * document onto the target's restaurant and branch. It refuses when the target
 * already has a menu or tables, so it can never mix two menus. Without --apply
 * it only says what it would copy.
 *
 * Written through the driver, as a restore is: the documents are already
 * valid, made by the same code on the source. On a box the change stream sees
 * them, so they reach the cloud copy like any other change, once a mirror is set.
 */
import { pathToFileURL } from 'node:url';

import fs from 'node:fs/promises';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { databaseHost } from './listRestaurants.js';

const COPIED = Object.freeze(['stations', 'categories', 'menuitems', 'menuphotos', 'tables']);
const MUST_BE_EMPTY = Object.freeze(['categories', 'menuitems', 'tables']);

export function parseArgs(argv) {
  const args = { source: null, targetPhone: null, apply: false, exportFile: null, fromFile: null, withStaff: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i] ?? null;
    else if (argv[i] === '--target-phone') args.targetPhone = argv[++i] ?? null;
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--export') args.exportFile = argv[++i] ?? null;
    else if (argv[i] === '--from-file') args.fromFile = argv[++i] ?? null;
    else if (argv[i] === '--with-staff') args.withStaff = true;
    else throw new Error(`Unknown argument ${argv[i]}.`);
  }
  if (args.exportFile && args.fromFile) throw new Error('Use --export on the computer that reads the live database, and --from-file on the box: not both.');
  if (!args.fromFile && !args.source) throw new Error('Give the source restaurant\'s name with --source "Z Chaat".');
  if (!args.exportFile && !args.targetPhone) throw new Error("Give this database's owner phone with --target-phone.");
  return args;
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The source restaurant and its first branch, by exact name, case ignored. */
async function findSource(db, name) {
  const matches = await db.collection('restaurants').find({ name: { $regex: `^${escape(name.trim())}$`, $options: 'i' } }).toArray();
  if (matches.length === 0) throw new Error(`No restaurant called "${name}" in the source.`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} restaurants called "${name}" in the source: ${matches.map((r) => String(r._id)).join(', ')}. Rename one, or ask for --source-id.`);
  }
  const restaurant = matches[0];
  const branch = await db.collection('branches').findOne({ restaurantId: restaurant._id }, { sort: { createdAt: 1 } });
  if (!branch) throw new Error(`"${restaurant.name}" has no branch in the source.`);
  return { restaurant, branch };
}

/** Settings a trial copy keeps from the source; see the header for what is left out and why. */
export function trialSettings(settings = {}) {
  const { invoice, reports, features, ...rest } = settings;
  void invoice;
  return {
    ...rest,
    ...(reports ? { reports: { ...reports, dayEndEmails: [] } } : {}),
    ...(features ? { features: { ...features, online: false } } : {}),
  };
}

/** Everything the copy needs, read from the source. Plain data, so it can go through a file. */
export async function readBundle({ sourceDb, source, withStaff = false }) {
  const from = await findSource(sourceDb, source);
  const scope = { restaurantId: from.restaurant._id, branchId: from.branch._id };
  const docs = {};
  for (const coll of COPIED) docs[coll] = await sourceDb.collection(coll).find(scope).toArray();
  const paymentMethods = await sourceDb.collection('paymentmethods').find({ restaurantId: from.restaurant._id }).toArray();
  const staff = withStaff
    ? await sourceDb.collection('users').find({ restaurantId: from.restaurant._id, role: { $ne: 'OWNER' }, isSystem: { $ne: true } }).toArray()
    : [];
  return {
    kind: 'cafe-pos-setup',
    version: 1,
    exportedAt: new Date(),
    source: { name: from.restaurant.name, restaurantId: from.restaurant._id, branchName: from.branch.name ?? null },
    docs,
    setup: {
      settings: trialSettings(from.restaurant.settings),
      brandLogos: from.restaurant.brandLogos ?? null,
      address: from.restaurant.address ?? null,
      contactPhone: from.restaurant.contactPhone ?? null,
    },
    paymentMethods,
    staff,
  };
}

export async function writeBundle({ targetDb, bundle, targetPhone, apply, log = console.log }) {
  if (bundle?.kind !== 'cafe-pos-setup') throw new Error('That file is not a Cafe POS setup export.');
  const owner = await targetDb.collection('users').findOne({ phone: targetPhone, role: 'OWNER' });
  if (!owner) throw new Error(`No owner with phone ${targetPhone} in this database.`);
  const to = { restaurantId: owner.restaurantId, branchId: owner.branchId, ownerId: owner._id };
  const target = await targetDb.collection('restaurants').findOne({ _id: to.restaurantId });
  const { docs, setup, paymentMethods } = bundle;
  const staff = bundle.staff ?? [];

  log(`From: ${bundle.source.name} (${bundle.source.restaurantId}), branch ${bundle.source.branchName ?? 'first'}`);
  log(`To:   ${target.name} (${to.restaurantId})`);

  for (const coll of MUST_BE_EMPTY) {
    const already = await targetDb.collection(coll).countDocuments({ restaurantId: to.restaurantId });
    if (already > 0) throw new Error(`"${target.name}" already has ${already} ${coll}. This copies into an empty restaurant only. Nothing was changed.`);
  }

  // A person can sign in at one restaurant per database, by phone or email.
  const staffToAdd = [];
  const staffSkipped = [];
  for (const person of staff) {
    const clash = await targetDb.collection('users').findOne({
      $or: [{ phone: person.phone }, ...(person.email ? [{ email: person.email }] : [])],
    });
    if (clash) staffSkipped.push(person);
    else staffToAdd.push(person);
  }

  const activeItems = docs.menuitems.filter((item) => item.isActive !== false).length;
  log(`  stations   ${docs.stations.length}`);
  log(`  categories ${docs.categories.length}`);
  log(`  dishes     ${docs.menuitems.length} (${activeItems} on the menu)`);
  log(`  photos     ${docs.menuphotos.length}`);
  log(`  tables     ${docs.tables.length}, sections: ${[...new Set(docs.tables.map((table) => table.section ?? 'none'))].join(', ')}`);
  log(`  settings   ${Object.keys(setup.settings).length} groups, logo ${setup.brandLogos ? 'yes' : 'none'} (not the invoice series, GSTIN, day-end emails or online page)`);
  log(`  payment    ${paymentMethods.map((method) => method.code).join(', ') || 'none'}`);
  log(`  staff      ${staff.length ? `${staffToAdd.length}${staffSkipped.length ? `, ${staffSkipped.length} skipped (their phone or email is already used here)` : ''}` : 'none (add --with-staff when exporting)'}`);

  if (!apply) {
    log('Dry run. Nothing was changed. Add --apply to copy.');
    return { copied: null, counts: Object.fromEntries(COPIED.map((coll) => [coll, docs[coll].length])) };
  }

  const move = (doc) => ({ ...doc, restaurantId: to.restaurantId, branchId: to.branchId });
  const existingStations = await targetDb.collection('stations').find({ restaurantId: to.restaurantId }).toArray();
  const stationIdFor = new Map();
  const newStations = [];
  for (const station of docs.stations) {
    // A station with the same name made at setup is reused, so there are never two "Kitchen"s.
    const same = existingStations.find((mine) => mine.name?.toLowerCase() === station.name?.toLowerCase());
    if (same) stationIdFor.set(String(station._id), same._id);
    else newStations.push(move(station));
  }
  const mapStation = (id) => (id ? (stationIdFor.get(String(id)) ?? id) : id);

  const copied = {};
  const insert = async (coll, list) => {
    if (list.length) await targetDb.collection(coll).insertMany(list, { ordered: true });
    copied[coll] = list.length;
  };
  await insert('stations', newStations);
  await insert('categories', docs.categories.map((category) => ({ ...move(category), stationId: mapStation(category.stationId) })));
  await insert('menuitems', docs.menuitems.map((item) => ({ ...move(item), ...(item.stationId !== undefined ? { stationId: mapStation(item.stationId) } : {}) })));
  await insert('menuphotos', docs.menuphotos.map((photo) => ({ ...move(photo), setBy: to.ownerId })));
  await insert('tables', docs.tables.map(move));

  // Settings group by group, so the target keeps its own invoice series and anything the source lacks.
  const settingsSet = Object.fromEntries(Object.entries(setup.settings).map(([key, value]) => [`settings.${key}`, value]));
  const restaurantSet = { ...settingsSet };
  if (setup.brandLogos) restaurantSet.brandLogos = setup.brandLogos;
  if (setup.address) restaurantSet.address = setup.address;
  if (setup.contactPhone) restaurantSet.contactPhone = setup.contactPhone;
  if (Object.keys(restaurantSet).length) {
    await targetDb.collection('restaurants').updateOne({ _id: to.restaurantId }, { $set: restaurantSet });
  }

  let methodsAdded = 0;
  let methodsUpdated = 0;
  for (const method of paymentMethods) {
    const { _id, restaurantId, branchId, createdAt, __v, ...fields } = method;
    void restaurantId; void branchId; void createdAt; void __v;
    const unlinked = { ...fields, terminalProvider: null, terminalPaymentMode: null };
    const mine = await targetDb.collection('paymentmethods').findOne({ restaurantId: to.restaurantId, code: method.code });
    if (mine) {
      await targetDb.collection('paymentmethods').updateOne({ _id: mine._id }, { $set: unlinked });
      methodsUpdated += 1;
    } else {
      await targetDb.collection('paymentmethods').insertOne({ _id, ...unlinked, restaurantId: to.restaurantId, ...(method.branchId !== undefined ? { branchId: to.branchId } : {}), createdAt });
      methodsAdded += 1;
    }
  }

  await insert('users', staffToAdd.map((person) => ({ ...move(person), lastLoginAt: null })));

  log(`Copied: ${Object.entries(copied).map(([coll, count]) => `${count} ${coll}`).join(', ')}; settings and logo; payment methods ${methodsUpdated} updated, ${methodsAdded} added.`);
  if (staffSkipped.length) log(`Not copied, their phone or email is already used here: ${staffSkipped.map((person) => person.name).join(', ')}.`);
  return { copied, methodsAdded, methodsUpdated, staffSkipped: staffSkipped.length };
}

/** From one database straight into another. */
export async function copyMenu({ sourceDb, targetDb, source, targetPhone, apply, withStaff = false, log = console.log }) {
  const bundle = await readBundle({ sourceDb, source, withStaff });
  return writeBundle({ targetDb, bundle, targetPhone, apply, log });
}

const { EJSON } = mongoose.mongo.BSON;
/** Extended JSON keeps ids, dates and the logo's bytes exactly. */
export const bundleToText = (bundle) => EJSON.stringify(bundle, null, 1, { relaxed: false });
export const bundleFromText = (text) => EJSON.parse(text, { relaxed: false });

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  let sourceConnection = null;
  let targetConnected = false;
  try {
    const args = parseArgs(process.argv.slice(2));
    let bundle;
    if (args.fromFile) {
      bundle = bundleFromText(await fs.readFile(args.fromFile, 'utf8'));
      console.log(`Reading ${args.fromFile}, exported ${bundle.exportedAt?.toISOString?.() ?? 'at an unknown time'}`);
    } else {
      const sourceUri = process.env.SOURCE_MONGO_URI;
      if (!sourceUri) throw new Error('Set SOURCE_MONGO_URI to the live database address first (it is never taken from the command line).');
      sourceConnection = await mongoose.createConnection(sourceUri, { serverSelectionTimeoutMS: 15_000 }).asPromise();
      console.log(`Reading from ${databaseHost(sourceUri)} / ${sourceConnection.db.databaseName} (read only)`);
      bundle = await readBundle({ sourceDb: sourceConnection.db, source: args.source, withStaff: args.withStaff });
    }
    if (args.exportFile) {
      await fs.writeFile(args.exportFile, bundleToText(bundle), { mode: 0o600 });
      console.log(`Wrote ${args.exportFile}: ${bundle.docs.menuitems.length} dishes, ${bundle.docs.tables.length} tables, ${bundle.staff.length} staff.`);
      if (bundle.staff.length) console.log('It holds the staff\'s password and PIN hashes: move it by pen drive, and delete it once copied.');
    } else {
      await connectDatabase();
      targetConnected = true;
      console.log(`Writing into ${databaseHost()} / ${mongoose.connection.db.databaseName}`);
      await writeBundle({ targetDb: mongoose.connection.db, bundle, targetPhone: args.targetPhone, apply: args.apply });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await sourceConnection?.close().catch(() => {});
    if (targetConnected) await disconnectDatabase().catch(() => {});
  }
}
