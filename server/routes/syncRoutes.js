/**
 * P63. Two-way sync, read and acknowledged by the owner and the manager.
 *
 *   GET  /sync/status
 *   GET  /sync/conflicts?seen=false
 *   POST /sync/conflicts/:conflictId/seen
 *   POST /sync/conflicts/:conflictId/keep    2026-10-22, the version to keep
 *   POST /sync/now                           2026-10-22, Sync now
 *   GET  /sync/changes                       2026-10-22, what the other side's changes did here
 *   POST /sync/changes/:changeId/undo        2026-10-22
 */
import { Router } from 'express';

import { ROLES } from '../config/roles.js';
import {
  getSyncChanges,
  getSyncConflicts,
  getSyncStatus,
  postConflictKeep,
  postConflictSeen,
  postSyncChangeUndo,
  postSyncNow,
} from '../controllers/syncController.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/permission.js';
import { tenant } from '../middleware/tenant.js';
import { validate } from '../middleware/validate.js';
import {
  conflictKeepSchema,
  conflictSeenSchema,
  syncChangesSchema,
  syncChangeUndoSchema,
  syncConflictsSchema,
  syncNowSchema,
  syncStatusSchema,
} from '../validators/syncValidators.js';

const router = Router();
const managers = [authenticate, tenant, requireRole(ROLES.OWNER, ROLES.MANAGER)];

router.get('/sync/status', ...managers, validate(syncStatusSchema), getSyncStatus);
router.get('/sync/conflicts', ...managers, validate(syncConflictsSchema), getSyncConflicts);
router.post('/sync/conflicts/:conflictId/seen', ...managers, validate(conflictSeenSchema), postConflictSeen);
router.post('/sync/conflicts/:conflictId/keep', ...managers, validate(conflictKeepSchema), postConflictKeep);
router.post('/sync/now', ...managers, validate(syncNowSchema), postSyncNow);
router.get('/sync/changes', ...managers, validate(syncChangesSchema), getSyncChanges);
router.post('/sync/changes/:changeId/undo', ...managers, validate(syncChangeUndoSchema), postSyncChangeUndo);

export default router;
