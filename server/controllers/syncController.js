/**
 * P63. Two-way sync, for the owner and the manager: status, the conflicts, and
 * marking one seen. docs/API-CONTRACT.md "P63". 2026-10-22: Sync now, what came
 * in with Undo, and the version a conflict keeps.
 */
import { syncNow } from '../services/replication/runtime.js';
import { keepConflictVersion, listIncoming, undoIncoming } from '../services/sync/recentChanges.js';
import { listConflicts, markConflictSeen, readConflict, syncStatus } from '../services/sync/statusService.js';
import { sendList, sendSuccess } from '../utils/response.js';

export async function getSyncStatus(req, res) {
  return sendSuccess(res, await syncStatus(req.restaurantId));
}

export async function getSyncConflicts(req, res) {
  const { seen, page, limit } = req.query;
  const { rows, total } = await listConflicts(req.restaurantId, { seen: seen === 'true', page, limit });
  return sendList(res, rows, { page, limit, total });
}

export async function postConflictSeen(req, res) {
  return sendSuccess(res, await markConflictSeen(req.restaurantId, req.params.conflictId, req.user.id));
}

/** POST /sync/conflicts/:conflictId/keep. The chosen version is written here, then the conflict is seen. */
export async function postConflictKeep(req, res) {
  const conflict = await readConflict(req.restaurantId, req.params.conflictId);
  await keepConflictVersion(req.restaurantId, conflict, req.body.version);
  return sendSuccess(res, await markConflictSeen(req.restaurantId, req.params.conflictId, req.user.id));
}

/** POST /sync/now. */
export async function postSyncNow(req, res) {
  const result = await syncNow();
  return sendSuccess(res, { ...result, status: await syncStatus(req.restaurantId), changes: await listIncoming(req.restaurantId) });
}

/** GET /sync/changes. Newest first. */
export async function getSyncChanges(req, res) {
  return sendSuccess(res, await listIncoming(req.restaurantId));
}

/** POST /sync/changes/:changeId/undo. */
export async function postSyncChangeUndo(req, res) {
  return sendSuccess(res, await undoIncoming(req.restaurantId, req.params.changeId, req.user.id));
}
