/**
 * P63. Two documents claiming one place: the same table, the same order's live
 * bill, the same name. Prompt section 4.
 *
 * The cafe PC's document keeps its place on both sides, so both end the same:
 *
 *   on the box    the incoming document is the website's: it is changed so it
 *                 no longer claims the place, then written. That write is a
 *                 change here and goes back, so the website gets the same.
 *   on the cloud  the incoming document is the PC's: the website's own
 *                 document is changed so it gives the place up, then the PC's
 *                 is written. The website's change goes to the PC.
 *
 * A clash with no rule here is not applied, and recorded for a person.
 */
import { SYNC_CONFLICT_KINDS, SYNC_NODES } from '../../models/SyncConflict.js';
import { nowUtc } from '../../utils/time.js';
import { recordConflict } from './conflicts.js';
import { syncNode } from './mode.js';
import { isNumberClash, renumber, renumberDetail, updateCopies } from './numberClashes.js';

const VOID_NOTE = 'Voided by sync: this was also done on the cafe PC while the two were apart.';

// 2026-10-28. A second clash on the same name or phone finds the first parked copy
// already holding the plain placeholder, so later tries number it: (website 2), -website-2.
const suffix = (attempt) => (attempt > 1 ? `-${attempt}` : '');
const renamed = (doc, attempt = 1) => {
  const name = `${String(doc.name ?? '').replace(/ \(website( \d+)?\)$/, '')} (website${attempt > 1 ? ` ${attempt}` : ''})`;
  return { ...doc, name, nameLower: name.toLowerCase() };
};
const voided = (doc) => ({
  ...doc,
  isVoided: true,
  voidedAt: doc.voidedAt ?? nowUtc(),
  voidReason: VOID_NOTE,
  updatedAt: nowUtc(),
});

/**
 * Per collection: the extra conditions of the partial unique index (to find the
 * other document), what giving up the place means, and the words for a person.
 */
export const CLASH_RULES = Object.freeze({
  orders: {
    partial: { occupiesTable: true },
    giveUp: (doc) => ({ ...doc, occupiesTable: false, updatedAt: nowUtc() }),
    detail: 'The same table was opened on the cafe PC and on the website. The PC\'s order keeps the table; the website\'s order is still open, without a table on the floor. Move it to a free table or join the two.',
  },
  bills: {
    partial: { isVoided: false },
    giveUp: (doc) => ({ ...voided(doc), voidReasonCode: 'OTHER' }),
    detail: 'The same order was billed on the cafe PC and on the website. The PC\'s bill stands; the website\'s was voided. Check what the guest paid, and refund any second payment.',
  },
  cashmovements: {
    partial: { type: 'OPENING_FLOAT', isVoided: false },
    giveUp: voided,
    detail: 'An opening float was entered on both. The PC\'s stands; the website\'s was voided.',
  },
  attendanceentries: {
    partial: { clockOutAt: null },
    giveUp: voided,
    detail: 'The same person was clocked in on both. The PC\'s shift stands; the website\'s was voided.',
  },
  menuitems: { partial: {}, giveUp: renamed, detail: 'A dish with this name was added on both. The website\'s was renamed "(website)".' },
  categories: { partial: {}, giveUp: renamed, detail: 'A menu section with this name was added on both. The website\'s was renamed "(website)".' },
  tables: { partial: {}, giveUp: renamed, detail: 'A table with this name was added on both. The website\'s was renamed "(website)".' },
  stations: { partial: {}, giveUp: renamed, detail: 'A station with this name was added on both. The website\'s was renamed "(website)".' },
  accounts: { partial: {}, giveUp: renamed, detail: 'An On Hold account with this name was added on both. The website\'s was renamed "(website)".' },
  ingredients: { partial: {}, giveUp: renamed, detail: 'An ingredient with this name was added on both. The website\'s was renamed "(website)".' },
  customers: {
    partial: {},
    giveUp: (doc, attempt = 1) => ({ ...doc, phone: `${doc.phone}-website${suffix(attempt)}`, updatedAt: nowUtc() }),
    detail: 'The same guest was added on both. The PC\'s record keeps the mobile number; the website\'s is kept with "-website" after it.',
  },
  users: {
    partial: {},
    giveUp: (doc, attempt = 1) => ({
      ...doc,
      isActive: false,
      phone: `${doc.phone}-website${suffix(attempt)}`,
      email: doc.email ? `${doc.email}.website${attempt > 1 ? attempt : ''}` : doc.email ?? null,
      updatedAt: nowUtc(),
    }),
    detail: 'The same phone or email was given to two staff logins. The PC\'s login stands; the website\'s was switched off.',
  },
});

/** A record can clash on its number and on its table: each round settles one. */
const MAX_CLASH_ROUNDS = 4;
/** How many placeholders a parked copy tries before it is left to a person. */
const MAX_PARK_TRIES = 5;

const isDuplicate = (error) => error?.code === 11000;
const isIdDuplicate = (error) => isDuplicate(error) && Object.keys(error.keyPattern ?? {}).join() === '_id';

/** Something here changed between reading it and writing: read again and decide again. */
export const RETRY = Symbol('retry');

/**
 * Writes `doc` (the incoming document, or the merge) by `_id`, only if what is
 * here is still `expected` (null: nothing was here). On a clash, applies the
 * rule. Gives back the document that ended up here, null when nothing was
 * written, or RETRY when this side changed it a moment ago.
 */
export async function writeWithClashRules(db, { restaurantId, coll, doc, incomingDoc, expected = null, attempt = 0 }) {
  const collection = db.collection(coll);
  const filter = expected
    ? { _id: doc._id, ...(expected.updatedAt !== undefined ? { updatedAt: expected.updatedAt } : {}) }
    : { _id: doc._id };
  try {
    const result = await collection.replaceOne(filter, doc, { upsert: !expected });
    if (expected && result.matchedCount === 0) return RETRY;
    return doc;
  } catch (error) {
    if (!expected && isIdDuplicate(error)) return RETRY;
    if (!isDuplicate(error)) throw error;
    if (coll === 'counters') return foldCounter(db, doc, error);
    if (isNumberClash(coll, error) && attempt < MAX_CLASH_ROUNDS) {
      return writeAfterNumberClash(db, { restaurantId, coll, doc, incomingDoc, expected, attempt, error });
    }
    const rule = CLASH_RULES[coll];
    const keyValue = error.keyValue ?? {};
    const other = Object.keys(keyValue).length
      ? await collection.findOne({ ...keyValue, ...(rule?.partial ?? {}), _id: { $ne: doc._id } })
      : null;
    if (!rule || !other) {
      await recordConflict(db, {
        restaurantId,
        coll,
        documentId: doc._id,
        kind: SYNC_CONFLICT_KINDS.SAME_SLOT,
        detail: `Not copied here: it breaks a rule only one record may hold (${Object.keys(error.keyPattern ?? {}).join(', ')}). A person decides which stays.`,
        keptFrom: syncNode(),
        localDoc: other,
        incomingDoc,
      });
      return null;
    }

    if (syncNode() === SYNC_NODES.BOX) {
      // The incoming document is the website's: it gives the place up.
      const parked = await park(collection, rule, doc, { upsert: true });
      if (!parked) return leftForAPerson(db, { restaurantId, coll, doc, other, incomingDoc });
      await recordConflict(db, {
        restaurantId, coll, documentId: doc._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT, detail: rule.detail,
        keptFrom: SYNC_NODES.BOX, localDoc: other, incomingDoc, resultDoc: parked,
      });
      return parked;
    }

    // On the cloud the incoming document is the PC's: the website's own gives the place up first.
    const parked = await park(collection, rule, other, { upsert: false });
    if (!parked) return leftForAPerson(db, { restaurantId, coll, doc, other, incomingDoc });
    try {
      await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    } catch (again) {
      if (!isDuplicate(again)) throw again;
      if (isNumberClash(coll, again) && attempt < MAX_CLASH_ROUNDS) {
        return writeAfterNumberClash(db, { restaurantId, coll, doc, incomingDoc, expected: null, attempt, error: again });
      }
      // A second rule broken as well: leave it to a person.
      await recordConflict(db, {
        restaurantId, coll, documentId: doc._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT,
        detail: `Not copied here: it breaks a second rule only one record may hold (${Object.keys(again.keyPattern ?? {}).join(', ')}).`,
        keptFrom: SYNC_NODES.CLOUD, localDoc: parked, incomingDoc,
      });
      return null;
    }
    await recordConflict(db, {
      restaurantId, coll, documentId: other._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT, detail: rule.detail,
      keptFrom: SYNC_NODES.BOX, localDoc: other, incomingDoc, resultDoc: parked,
    });
    return doc;
  }
}

/**
 * Writes the copy that gives the place up. Its placeholder (a phone with
 * "-website", a name with "(website)") can itself be taken, by the copy parked
 * in an earlier clash: then the next numbered one is tried. Gives back the
 * written copy, or null when every try was taken.
 */
async function park(collection, rule, doc, { upsert }) {
  for (let attempt = 1; attempt <= MAX_PARK_TRIES; attempt += 1) {
    const parked = rule.giveUp(doc, attempt);
    try {
      await collection.replaceOne({ _id: parked._id }, parked, { upsert });
      return parked;
    } catch (error) {
      if (!isDuplicate(error) || isIdDuplicate(error)) throw error;
    }
  }
  return null;
}

async function leftForAPerson(db, { restaurantId, coll, doc, other, incomingDoc }) {
  await recordConflict(db, {
    restaurantId, coll, documentId: doc._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT,
    detail: 'Not copied here: two records claim one place, and the one to give it up could not be moved aside. A person decides which stays.',
    keptFrom: syncNode(), localDoc: other, incomingDoc,
  });
  return null;
}

/**
 * One series (2026-10-25). Two records with one number: the PC's keeps it, the
 * website's takes the next free one in its series, and its copies follow.
 *
 *   on the cloud  the incoming record is the PC's: the website's own record with
 *                 that number is renumbered first, then the PC's is written. Only
 *                 the website knows every number it handed out, so only it
 *                 renumbers: the next free number is then free on both sides,
 *                 and the series stays gap-free.
 *   on the box    the incoming record is the website's: it is not written yet.
 *                 The PC's record with that number reaches the website in this
 *                 round's push, the website renumbers its own, and that version
 *                 comes back in the next round. Nothing for a person.
 *
 * Each step writes with the same rules, so a record that also clashes on its
 * table is settled in the next round.
 */
async function writeAfterNumberClash(db, { restaurantId, coll, doc, incomingDoc, expected, attempt, error }) {
  const collection = db.collection(coll);
  const notCopied = async (localDoc) => {
    await recordConflict(db, {
      restaurantId, coll, documentId: doc._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT,
      detail: `Not copied here: its number (${Object.keys(error.keyPattern ?? {}).join(', ')}) is already used here, and it could not be given a new one. A person decides.`,
      keptFrom: syncNode(), localDoc, incomingDoc,
    });
    return null;
  };

  // The website renumbers its own once the PC's record reaches it; that version comes back.
  if (syncNode() === SYNC_NODES.BOX) return null;

  const keyValue = error.keyValue ?? {};
  const other = Object.keys(keyValue).length
    ? await collection.findOne({ ...keyValue, _id: { $ne: doc._id } })
    : null;
  if (!other) return notCopied(null);
  const renumbered = await renumber(db, coll, other);
  if (!renumbered) return notCopied(other);
  const moved = await writeWithClashRules(db, { restaurantId, coll, doc: renumbered, incomingDoc: other, expected: other, attempt: attempt + 1 });
  if (moved === RETRY) return RETRY;
  if (!moved) return notCopied(other);
  await updateCopies(db, coll, moved);
  await recordConflict(db, {
    restaurantId, coll, documentId: other._id, kind: SYNC_CONFLICT_KINDS.SAME_SLOT,
    detail: renumberDetail(coll, other, moved), keptFrom: SYNC_NODES.BOX, localDoc: other, incomingDoc, resultDoc: moved,
  });
  return writeWithClashRules(db, { restaurantId, coll, doc, incomingDoc, expected, attempt: attempt + 1 });
}

/**
 * One series (2026-10-25). The PC and the website each made the same counter
 * (the first bill of a year, say) while apart, so one series has two counter
 * documents. They become one, the PC's, with the higher value:
 *
 *   on the box    the website's is folded into the PC's: the higher value, and
 *                 nothing written when the PC's is already as high.
 *   on the cloud  the website's own is swapped for the PC's, in one
 *                 transaction, so a bill made at that moment counts on the
 *                 PC's document and never starts a third one at 1.
 *
 * Nothing is shown to a person.
 */
async function foldCounter(db, doc, error) {
  const counters = db.collection('counters');
  const keyValue = error.keyValue ?? {};
  const own = Object.keys(keyValue).length
    ? await counters.findOne({ ...keyValue, _id: { $ne: doc._id } })
    : null;
  if (!own) return null;
  const value = Math.max(Number(own.value) || 0, Number(doc.value) || 0);

  if (syncNode() === SYNC_NODES.BOX) {
    await counters.updateOne({ _id: own._id, value: { $lt: value } }, { $set: { value, updatedAt: nowUtc() } });
    return { ...own, value };
  }

  const adopted = { ...doc, value, updatedAt: nowUtc() };
  const session = db.client.startSession();
  try {
    await session.withTransaction(async () => {
      const mine = await counters.findOne({ _id: own._id }, { session });
      adopted.value = Math.max(value, Number(mine?.value) || 0);
      await counters.deleteOne({ _id: own._id }, { session });
      await counters.replaceOne({ _id: doc._id }, adopted, { upsert: true, session });
    });
  } finally {
    await session.endSession();
  }
  return adopted;
}
