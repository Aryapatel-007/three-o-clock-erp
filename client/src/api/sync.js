/**
 * P63. Two-way sync, for the owner and the manager. API-CONTRACT "P63" section 4.
 */
import { api, requestWithMeta } from './client.js';

/** GET /sync/status. */
export function getSyncStatus() {
  return api.get('/sync/status');
}

/** GET /sync/conflicts: `{ data, meta }`, newest first. */
export function listSyncConflicts({ seen = false, page = 1, limit = 50 } = {}) {
  return requestWithMeta(`/sync/conflicts?seen=${seen ? 'true' : 'false'}&page=${page}&limit=${limit}`);
}

/** POST /sync/conflicts/:id/seen. */
export function markSyncConflictSeen(conflictId) {
  return api.post(`/sync/conflicts/${conflictId}/seen`, {});
}

/** POST /sync/conflicts/:id/keep. `version`: LOCAL, INCOMING or RESULT. 2026-10-22. */
export function keepSyncConflictVersion(conflictId, version) {
  return api.post(`/sync/conflicts/${conflictId}/keep`, { version });
}

/** POST /sync/now: `{ did, failed, status, changes }`. 2026-10-22. */
export function syncNow() {
  return api.post('/sync/now', {});
}

/** GET /sync/changes: what the other side's changes did here, newest first. 2026-10-22. */
export function listSyncChanges() {
  return api.get('/sync/changes');
}

/** POST /sync/changes/:id/undo. 2026-10-22. */
export function undoSyncChange(changeId) {
  return api.post(`/sync/changes/${changeId}/undo`, {});
}
