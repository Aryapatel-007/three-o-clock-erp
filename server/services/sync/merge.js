/**
 * P63. The three-way merge of one document changed on both sides.
 *
 * `base` is the version both sides last agreed on, `local` this side's,
 * `incoming` the other side's. Value by value:
 *
 *   - both sides the same                 that value
 *   - only one side changed it from base  that side's value
 *   - both changed it, differently        the newer document's value (by
 *                                         updatedAt; a tie goes to the box), and
 *                                         the field is named as a conflict
 *
 * Plain objects are merged key by key. An array whose items are sub-documents
 * with an `_id` (order lines, payments, a ticket's lines) is merged item by item,
 * so a dish added on each side is kept on both. Any other value (a date, an id,
 * an array of plain values) is one value.
 *
 * The result is the same on both sides for the same three inputs: the box's
 * order of items first, then the cloud's new ones; `updatedAt` and `version` are
 * the larger of the two. So the side that merges and the side that receives the
 * merge end with one document.
 */
import { canonicalText } from './hash.js';

/** Bookkeeping that changes on every write: never a conflict to show a person. */
export const IGNORED_CONFLICT_FIELDS = Object.freeze(['updatedAt', 'createdAt', 'lastLoginAt', 'version', '__v']);

const same = (a, b) => canonicalText({ v: a ?? null }) === canonicalText({ v: b ?? null });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && value.constructor === Object;
}

function isIdArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isPlainObject(item) && item._id !== undefined);
}

const idOf = (item) => canonicalText({ v: item._id });

function time(doc) {
  const at = doc?.updatedAt;
  return at instanceof Date ? at.getTime() : (at ? new Date(at).getTime() : 0);
}

/**
 * Merges three versions. `localIsBox` says which side this is, for the tie and
 * the order of items. Gives back { doc, conflictFields }.
 */
export function threeWayMerge({ base, local, incoming, localIsBox }) {
  const localTime = time(local);
  const incomingTime = time(incoming);
  let newer;
  if (localTime === incomingTime) newer = localIsBox ? 'local' : 'incoming';
  else newer = localTime > incomingTime ? 'local' : 'incoming';
  const conflictFields = new Set();

  function mergeValue(baseValue, localValue, incomingValue, path) {
    if (same(localValue, incomingValue)) return localValue;
    if (same(baseValue, localValue)) return incomingValue;
    if (same(baseValue, incomingValue)) return localValue;
    // Both changed it, differently.
    if (isPlainObject(localValue) && isPlainObject(incomingValue)) {
      return mergeObject(isPlainObject(baseValue) ? baseValue : {}, localValue, incomingValue, path);
    }
    if ((isIdArray(localValue) || isIdArray(incomingValue)) && Array.isArray(localValue) && Array.isArray(incomingValue)) {
      return mergeIdArray(Array.isArray(baseValue) ? baseValue : [], localValue, incomingValue, path);
    }
    const top = path.split('.')[0];
    if (!IGNORED_CONFLICT_FIELDS.includes(top)) conflictFields.add(path);
    return newer === 'local' ? localValue : incomingValue;
  }

  function mergeObject(baseObject, localObject, incomingObject, path) {
    const result = {};
    const keys = new Set([...Object.keys(localObject), ...Object.keys(incomingObject)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const value = mergeValue(baseObject[key], localObject[key], incomingObject[key], childPath);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  function mergeIdArray(baseArray, localArray, incomingArray, path) {
    const byId = (list) => new Map(list.filter(isPlainObject).map((item) => [idOf(item), item]));
    const baseItems = byId(baseArray);
    const localItems = byId(localArray);
    const incomingItems = byId(incomingArray);
    const boxArray = localIsBox ? localArray : incomingArray;
    const cloudArray = localIsBox ? incomingArray : localArray;
    const order = [];
    const seen = new Set();
    for (const item of [...boxArray, ...cloudArray]) {
      const key = isPlainObject(item) ? idOf(item) : null;
      if (key && !seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    const result = [];
    for (const key of order) {
      const baseItem = baseItems.get(key);
      const localItem = localItems.get(key);
      const incomingItem = incomingItems.get(key);
      if (localItem && incomingItem) {
        result.push(mergeValue(baseItem, localItem, incomingItem, `${path}[${key}]`));
      } else if (localItem) {
        // Removed on the other side: gone, unless this side changed it since.
        if (baseItem && same(baseItem, localItem)) continue;
        if (baseItem) conflictFields.add(`${path}[removed]`);
        result.push(localItem);
      } else if (incomingItem) {
        if (baseItem && same(baseItem, incomingItem)) continue;
        if (baseItem) conflictFields.add(`${path}[removed]`);
        result.push(incomingItem);
      }
    }
    return result;
  }

  const doc = mergeObject(isPlainObject(base) ? base : {}, local, incoming, '');
  if (localTime || incomingTime) doc.updatedAt = localTime >= incomingTime ? local.updatedAt : incoming.updatedAt;
  if (typeof local.version === 'number' || typeof incoming.version === 'number') {
    doc.version = Math.max(local.version ?? 0, incoming.version ?? 0);
  }
  return { doc, conflictFields: [...conflictFields] };
}
