/**
 * P63. Recording a sync conflict for the owner and manager to read.
 *
 * Written through the driver into `syncconflicts`, which ships both ways (it
 * is MIRROR), so the cafe PC and the website both list it. The title names the
 * thing as staff know it: the order, the bill, the table, the dish.
 */
import mongoose from 'mongoose';

import { logger } from '../../config/logger.js';
import { SYNC_NODES } from '../../models/SyncConflict.js';
import { nowUtc } from '../../utils/time.js';
import { syncNode } from './mode.js';

const NAMED = {
  orders: (doc) => `Order ${doc.orderNumber ?? ''}${doc.tableName ? `, ${doc.tableName}` : ''}`.trim(),
  bills: (doc) => `Bill ${doc.billNumber ?? ''}`.trim(),
  kots: (doc) => `KOT ${doc.kotNumber ?? ''}`.trim(),
  tables: (doc) => `Table ${doc.name ?? ''}`.trim(),
  menuitems: (doc) => `Dish ${doc.name ?? ''}`.trim(),
  categories: (doc) => `Menu section ${doc.name ?? ''}`.trim(),
  stations: (doc) => `Station ${doc.name ?? ''}`.trim(),
  customers: () => 'Guest',
  users: (doc) => `Staff ${doc.name ?? ''}`.trim(),
  cashmovements: () => 'Cash book entry',
  dayclosures: (doc) => `Day Close ${doc.businessDate ?? ''}`.trim(),
  restaurants: () => 'Restaurant settings',
  reservations: (doc) => `Booking ${doc.reference ?? ''}`.trim(),
  attendanceentries: () => 'Attendance entry',
};

export function describe(coll, doc) {
  const name = NAMED[coll];
  return name && doc ? name(doc) : `${coll} record`;
}

/** Where a person fixes it, when there is one screen for it. */
export function linkFor(coll, documentId) {
  if (coll === 'orders') return `/orders/${documentId}`;
  if (coll === 'bills') return `/bills/${documentId}`;
  return null;
}

async function branchFor(db, restaurantId, docs) {
  for (const doc of docs) if (doc?.branchId) return doc.branchId;
  const branch = await db.collection('branches').findOne({ restaurantId }, { sort: { createdAt: 1 }, projection: { _id: 1 } });
  return branch?._id ?? null;
}

export async function recordConflict(db, { restaurantId, coll, documentId, kind, detail = null, fields = [], keptFrom, localDoc = null, incomingDoc = null, resultDoc = null }) {
  try {
    const now = nowUtc();
    // One open record per document and kind: a clash met again on every later change of the
    // same document brings the record up to date instead of filling the list.
    const open = await db.collection('syncconflicts').findOne({ restaurantId, coll, documentId, kind, seenAt: null }, { projection: { _id: 1 } });
    if (open) {
      await db.collection('syncconflicts').updateOne(
        { _id: open._id },
        { $set: { localDoc, incomingDoc, resultDoc, detectedAt: now, updatedAt: now }, $addToSet: { fields: { $each: fields.slice(0, 40) } } },
      );
      return;
    }
    const titleDoc = resultDoc ?? localDoc ?? incomingDoc;
    const branchId = await branchFor(db, restaurantId, [resultDoc, localDoc, incomingDoc]);
    await db.collection('syncconflicts').insertOne({
      _id: new mongoose.Types.ObjectId(),
      restaurantId,
      branchId,
      coll,
      documentId,
      kind,
      title: describe(coll, titleDoc).slice(0, 200),
      detail: detail ? String(detail).slice(0, 1000) : null,
      fields: fields.slice(0, 40),
      keptFrom: keptFrom ?? syncNode(),
      detectedOn: syncNode(),
      detectedAt: now,
      localDoc,
      incomingDoc,
      resultDoc,
      seenAt: null,
      seenBy: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // A conflict that cannot be recorded is logged; it never stops the sync.
    logger.error({ err: error, coll }, 'A sync conflict could not be recorded.');
  }
}

export const otherNode = () => (syncNode() === SYNC_NODES.BOX ? SYNC_NODES.CLOUD : SYNC_NODES.BOX);
