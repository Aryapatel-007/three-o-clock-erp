/**
 * The words for the network and the cloud copy. P62 section 7.
 *
 * Staff must never confuse "the cloud is unreachable", which is harmless to
 * service, with "this tablet cannot reach the cafe server", which stops it.
 * So the two never share a word, and only the second is ever an alert for
 * the people taking orders. A person never sees a code.
 */
import { formatTimeIst } from '../../utils/formatDate.js';

export const DEVICE_WORDS = Object.freeze({
  CONNECTED: 'Connected',
  RECONNECTING: 'Reconnecting',
  UNREACHABLE: 'Cannot reach server',
});

/** "3 hours", "40 minutes": how long, in words. */
export function durationWords(seconds) {
  if (!Number.isFinite(seconds)) return 'a while';
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * The server and cloud line for the top bar: { state, word, detail } or null
 * for nothing to say. `state` is a StateChip state.
 */
export function serverLine(self, { manager }) {
  if (!self) return null;
  if (self.clock?.refusing) {
    return { state: 'alert', word: 'Saving paused: server clock is wrong', detail: "The cafe server's clock is behind its last sale. Nothing can be saved until it is fixed. Manager: runbook section 4." };
  }
  if (self.writer?.fenced) {
    return { state: 'alert', word: 'This server has handed over', detail: 'The cloud copy is now the main server. Sign in at the cloud address the manager gives you.' };
  }
  if (self.role === 'MIRROR' && self.writer?.readOnly) {
    const asOf = self.sync?.figuresAsOf ? `figures as of ${formatTimeIst(self.sync.figuresAsOf)}` : 'no figures yet';
    return { state: self.sync?.stale ? 'open' : 'free', word: `Cloud copy, ${asOf}`, detail: self.sync?.stale ? 'These figures are older than 15 minutes: the cafe server has not sent anything since.' : 'Read-only. Orders and bills are made on the cafe server.' };
  }
  if (self.role !== 'BOX' || !self.sync) return null;
  const sync = self.sync;
  if (manager && sync.reconcile?.status === 'MISMATCH') {
    return { state: 'alert', word: 'Cloud copy differs', detail: `The daily check found the cloud copy is not the same as this server (${sync.reconcile.mismatches.map((entry) => entry.coll).join(', ')}). Service is fine. Runbook section 7.` };
  }
  if (sync.state === 'NOT_SYNCED' && manager) {
    return { state: 'alert', word: `Not synced for ${durationWords(sync.secondsBehind)}`, detail: 'The cloud backup is behind. Service is fine; the internet line needs checking.' };
  }
  if (sync.state === 'WAITING') {
    return { state: 'open', word: `${sync.entriesWaiting} waiting to upload`, detail: 'Saved on the cafe server. They go to the cloud when the internet is back. Service is fine.' };
  }
  if (sync.state === 'SYNCED') return { state: 'ok', word: 'Synced', detail: 'Everything is in the cloud copy.', quiet: true };
  return null;
}
