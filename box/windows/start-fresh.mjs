/**
 * Start fresh before go-live, on the cafe PC (2026-10-28). Run by
 * start-fresh.ps1, from "Start fresh.bat" in C:\ThreeOClock.
 *
 *   node box\windows\start-fresh.mjs --uri "<MONGO_URI>" --keep "<restaurant>"
 *        [--remove "<duplicate restaurant>"] [--remove-id <its id>] [--move-owner]
 *        [--confirm-bills <n>] [--apply] [--backup-dir <dir>] [--allow-remote]
 *
 * Three things, in this order, each only if asked:
 *
 *   1. --remove      deletes a duplicate restaurant and everything it owns.
 *                    --remove-id also finds what it left behind once its
 *                    restaurant document is gone (on the website, after sync).
 *   2. --unpark-owner switches back on the kept restaurant's owner login that sync
 *                    parked (phone "...-website") and gives it back its phone, as
 *                    the cafe PC has it. On the website's copy, after the PC.
 *      --move-owner  gives the kept restaurant's owner login the duplicate
 *                    owner's name, phone, email, password and PIN, switched on.
 *                    After step 1, so the phone is free.
 *   3. always        deletes the kept restaurant's trading records: orders, KOTs,
 *                    bills, payments, the cash book, Day Closes, the activity log,
 *                    guests and the number counters, so bills start at 000001.
 *                    The menu, tables, stations, staff, settings, payment methods
 *                    and On Hold accounts stay.
 *
 * Without --apply it changes nothing and says what it would do. With --apply it
 * first writes every document it will touch as Extended JSON into the backup
 * folder, reads each file back, and stops if any check fails.
 *
 * It is not for a restaurant that has traded for real: CLAUDE.md, "never hard
 * delete a bill". --confirm-bills is the number of bills the person agreed to
 * lose, and a run that finds more refuses. The decision log records the
 * exception.
 *
 * Deletes go through the driver. On the PC the server keeps running: its change
 * stream records each delete and two-way sync carries it to the website. The
 * sync bookkeeping (changelog, syncdocs, cursors) is never touched, because a
 * delete finds its restaurant through the changelog.
 *
 * The last line printed is one line of JSON, for start-fresh.ps1.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BSON, MongoClient } from 'mongodb';

const { EJSON } = BSON;

/** Synced collections that are the restaurant's set-up: never touched. */
export const KEEP_COLLECTIONS = Object.freeze([
  'accounts', 'branches', 'categories', 'ingredients', 'integrationconnections', 'menuitems', 'menuphotos',
  'messagetemplates', 'paymentmethods', 'platformitemmappings', 'recipes', 'restaurants', 'stations',
  'tables', 'tallybridges', 'users',
]);

/** Synced collections that are trading records: emptied for the kept restaurant. */
export const WIPE_COLLECTIONS = Object.freeze([
  'accountentries', 'attendanceentries', 'auditlogs', 'bills', 'careportsends', 'cashmovements', 'conversations',
  'counters', 'customers', 'dayclosures', 'intakeapplications', 'integrationevents', 'integrationjobs', 'kots',
  'onlineorders', 'onlinepayments', 'orders', 'platformorders', 'platformpayouts', 'refunds', 'reservations',
  'stockmovements', 'syncconflicts', 'tallyexports', 'terminaltransactions',
]);

/** Within a wiped collection, what stays: set-up entries, not trading. */
const WIPE_ONLY = Object.freeze({
  // An account's opening balance is set-up; charges and collections are trading.
  accountentries: { type: { $ne: 'OPENING' } },
  // Stock received, counted or wasted by hand stays; only what orders moved goes.
  stockmovements: { type: { $in: ['DEDUCTION', 'CANCELLATION_RETURN'] } },
});

/** Each machine's own collections a duplicate also leaves behind. Never synced. */
const LOCAL_OF_DUPLICATE = Object.freeze(['refreshtokens']);

const OWNER_FIELDS = Object.freeze(['name', 'phone', 'email', 'passwordHash', 'passwordChangedAt', 'pinHash']);

export function parseArgs(argv) {
  const args = { apply: false, moveOwner: false, unparkOwner: false, allowRemote: false, remove: null, removeId: null, confirmBills: null, backupDir: null };
  const takes = { '--uri': 'uri', '--keep': 'keep', '--remove': 'remove', '--remove-id': 'removeId', '--confirm-bills': 'confirmBills', '--backup-dir': 'backupDir' };
  const flags = { '--apply': 'apply', '--move-owner': 'moveOwner', '--unpark-owner': 'unparkOwner', '--allow-remote': 'allowRemote' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags[arg]) args[flags[arg]] = true;
    else if (takes[arg]) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      args[takes[arg]] = value;
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.uri) throw new Error('Give --uri, the database address.');
  if (!args.keep) throw new Error('Give --keep, the exact name of the restaurant to keep.');
  if (args.moveOwner && !args.remove && !args.removeId) throw new Error('--move-owner takes the owner from --remove.');
  if (args.moveOwner && args.unparkOwner) throw new Error('Give --move-owner or --unpark-owner, not both.');
  if (args.removeId !== null && !/^[0-9a-f]{24}$/.test(args.removeId)) throw new Error('--remove-id is a 24-character id.');
  if (args.confirmBills !== null) {
    if (!/^\d+$/.test(args.confirmBills)) throw new Error('--confirm-bills is a whole number.');
    args.confirmBills = Number(args.confirmBills);
  }
  if (args.apply && args.confirmBills === null) throw new Error('--apply needs --confirm-bills: the number of bills you agree to remove.');
  if (args.apply && !args.backupDir) throw new Error('--apply needs --backup-dir.');
  return args;
}

/** Only this machine's database, unless a person says otherwise. */
export function assertLocal(uri, allowRemote) {
  const url = new URL(uri);
  const local = url.protocol === 'mongodb:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!local && !allowRemote) throw new Error(`Refusing: ${url.hostname} is not this PC. Add --allow-remote only for the website's copy.`);
}

async function findOne(db, name, { required }) {
  const found = await db.collection('restaurants').find({ name }).toArray();
  if (found.length > 1) throw new Error(`Two restaurants are called "${name}". Nothing was changed.`);
  if (!found.length && required) throw new Error(`No restaurant is called "${name}". Nothing was changed.`);
  return found[0] ?? null;
}

/** Every document the run would touch, by collection, and the owner change. */
export async function plan(db, { keep: keepName, remove: removeName, removeId, moveOwner, unparkOwner }) {
  const keep = await findOne(db, keepName, { required: true });
  let duplicate = removeName ? await findOne(db, removeName, { required: false }) : null;
  if (removeId) {
    const id = BSON.ObjectId.createFromHexString(removeId);
    if (duplicate && String(duplicate._id) !== removeId) throw new Error(`"${removeName}" is not ${removeId}. Nothing was changed.`);
    const byId = await db.collection('restaurants').findOne({ _id: id });
    if (byId && removeName && byId.name !== removeName) throw new Error(`${removeId} is "${byId.name}", not "${removeName}". Nothing was changed.`);
    // Its restaurant document may be gone already, sync having removed it: what it left still goes.
    duplicate = duplicate ?? byId ?? { _id: id, name: removeName ?? removeId, gone: true };
  }
  if (duplicate && String(duplicate._id) === String(keep._id)) throw new Error('The restaurant to keep and the one to remove are the same.');
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const docsOf = async (coll, filter) => (existing.has(coll) ? db.collection(coll).find(filter).toArray() : []);

  const removeDocs = {};
  if (duplicate) {
    for (const coll of [...KEEP_COLLECTIONS, ...WIPE_COLLECTIONS, ...LOCAL_OF_DUPLICATE]) {
      const docs = await docsOf(coll, coll === 'restaurants' ? { _id: duplicate._id } : { restaurantId: duplicate._id });
      if (docs.length) removeDocs[coll] = docs;
    }
  }

  const wipeDocs = {};
  for (const coll of WIPE_COLLECTIONS) {
    const docs = await docsOf(coll, { restaurantId: keep._id, ...(WIPE_ONLY[coll] ?? {}) });
    if (docs.length) wipeDocs[coll] = docs;
  }

  const owners = await db.collection('users').find({ restaurantId: keep._id, role: 'OWNER' }).toArray();
  let owner = null;
  if (moveOwner) owner = ownerMove(owners, (removeDocs.users ?? []).filter((user) => user.role === 'OWNER'));
  if (unparkOwner) owner = await ownerUnpark(db, owners, removeDocs.users ?? []);
  const activeOwnerAfter = owner ? true : owners.some((user) => user.isActive);
  if (duplicate && !activeOwnerAfter) {
    throw new Error(`${keepName} has no owner login switched on. Add --move-owner, or nobody can sign in as its owner. Nothing was changed.`);
  }
  return { keep, duplicate, removeDocs, wipeDocs, owner, owners };
}

function ownerMove(owners, fromOwners) {
  // Done on an earlier run, or on the other side and synced here: what the duplicate left is not an owner to copy.
  if (owners.some((user) => user.isActive)) return null;
  if (fromOwners.length === 0) {
    throw new Error('The duplicate has no owner to move, and the restaurant to keep has none switched on. Nothing was changed.');
  }
  if (fromOwners.length > 1) throw new Error('The duplicate has two owner logins: say which one by hand. Nothing was changed.');
  const inactive = owners.filter((user) => !user.isActive);
  const target = owners.length === 1 ? owners[0] : inactive.length === 1 ? inactive[0] : null;
  if (!target) throw new Error('The restaurant to keep has several owner logins: fix them by hand. Nothing was changed.');
  const from = fromOwners[0];
  const set = Object.fromEntries(OWNER_FIELDS.map((field) => [field, from[field] ?? null]));
  return { targetId: target._id, from, set };
}

const PARKED_PHONE = /-website(-\d+)?$/;

async function ownerUnpark(db, owners, removedUsers) {
  if (owners.some((user) => user.isActive)) return null; // Done on an earlier run.
  const parked = owners.filter((user) => PARKED_PHONE.test(String(user.phone)));
  if (parked.length !== 1) throw new Error('The restaurant to keep has no one owner login parked by sync. Nothing was changed.');
  const target = parked[0];
  const phone = String(target.phone).replace(PARKED_PHONE, '');
  const email = target.email ? String(target.email).replace(/\.website\d*$/, '') : target.email ?? null;
  const removing = new Set(removedUsers.map((user) => String(user._id)));
  const holder = await db.collection('users').findOne({ phone, _id: { $ne: target._id } });
  if (holder && !removing.has(String(holder._id))) throw new Error(`Another login (${holder.name}) holds phone ending ${phone.slice(-4)}. Nothing was changed.`);
  return { targetId: target._id, set: { name: target.name, phone, email } };
}

const countOf = (byColl) => Object.fromEntries(Object.entries(byColl).map(([coll, docs]) => [coll, docs.length]));

async function backUp(dir, groups) {
  await mkdir(dir, { recursive: true });
  for (const [group, byColl] of Object.entries(groups)) {
    for (const [coll, docs] of Object.entries(byColl)) {
      const file = path.join(dir, `${group}-${coll}.json`);
      await writeFile(file, EJSON.stringify(docs, { relaxed: false }));
      const back = EJSON.parse(await readFile(file, 'utf8'), { relaxed: false });
      if (back.length !== docs.length) throw new Error(`The backup of ${coll} did not read back. Nothing was changed.`);
    }
  }
}

async function deleteAll(db, byColl) {
  const deleted = {};
  // The restaurant document last, so a run stopped halfway can find the rest again.
  const order = Object.keys(byColl).sort((a, b) => (a === 'restaurants') - (b === 'restaurants'));
  for (const coll of order) {
    const result = await db.collection(coll).deleteMany({ _id: { $in: byColl[coll].map((doc) => doc._id) } });
    deleted[coll] = result.deletedCount;
  }
  return deleted;
}

export async function startFresh(db, args, { now = new Date(), log = () => {} } = {}) {
  const found = await plan(db, args);
  const bills = found.wipeDocs.bills?.length ?? 0;
  const summary = {
    keep: found.keep.name,
    duplicate: found.duplicate ? found.duplicate.name : null,
    remove: countOf(found.removeDocs),
    wipe: countOf(found.wipeDocs),
    bills,
    owner: found.owner ? { name: found.owner.set.name, phoneEnds: String(found.owner.set.phone).slice(-4) } : null,
    applied: false,
  };
  log(`Keeping ${found.keep.name}: menu, tables, stations, staff, settings and payment methods stay.`);
  if (found.duplicate) summary.duplicateId = String(found.duplicate._id);
  log(found.duplicate ? `Removing the duplicate ${found.duplicate.name} (${summary.duplicateId}): ${Object.keys(summary.remove).length ? JSON.stringify(summary.remove) : 'nothing left of it'}` : 'No duplicate to remove.');
  if (found.owner) log(`The owner login becomes ${summary.owner.name} (phone ending ${summary.owner.phoneEnds}), switched on.`);
  log(`Clearing: ${Object.keys(summary.wipe).length ? JSON.stringify(summary.wipe) : 'nothing left to clear'}.`);
  if (!args.apply) return summary;

  if (bills > args.confirmBills) {
    throw new Error(`There are ${bills} bills, more than the ${args.confirmBills} you agreed to remove. Nothing was changed.`);
  }
  await backUp(args.backupDir, { remove: found.removeDocs, wipe: found.wipeDocs, owners: found.owners.length ? { users: found.owners } : {} });
  log(`Backed up to ${args.backupDir}.`);

  summary.removed = await deleteAll(db, found.removeDocs);
  if (found.owner) {
    await db.collection('users').updateOne(
      { _id: found.owner.targetId },
      { $set: { ...found.owner.set, isActive: true, pinFailedAttempts: 0, pinLockedUntil: null, updatedAt: now } },
    );
    // The old owner's sessions end; this machine's only, as sessions never sync.
    await db.collection('refreshtokens').deleteMany({ userId: found.owner.targetId });
  }
  summary.cleared = await deleteAll(db, found.wipeDocs);
  summary.applied = true;
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertLocal(args.uri, args.allowRemote);
  const client = await MongoClient.connect(args.uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const summary = await startFresh(client.db(), args, { log: (line) => console.log(line) });
    console.log(JSON.stringify({ ok: true, ...summary }));
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, message: error.message }));
    process.exit(1);
  });
}
