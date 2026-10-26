/**
 * P63. Names shared by the sync code and its models. Imports nothing, so a
 * model and the writer guard can both read it without a cycle.
 */
export const SYNC_NODES = Object.freeze({ BOX: 'BOX', CLOUD: 'CLOUD' });

export const SYNC_CONFLICT_KINDS = Object.freeze({
  // A field changed both ways: the newer value was kept.
  EDITED_BOTH: 'EDITED_BOTH',
  // A table, a live bill, a name or a number taken on both sides.
  SAME_SLOT: 'SAME_SLOT',
  // Deleted on one side after it was changed on the other: the change was kept.
  DELETED_HERE: 'DELETED_HERE',
});
