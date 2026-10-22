import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { keepSyncConflictVersion, listSyncChanges, listSyncConflicts, markSyncConflictSeen, syncNow, undoSyncChange } from '../../api/sync.js';
import { errorMessage } from '../billing/errorCopy.js';
import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import { formatDateIst, formatTimeIst } from '../../utils/formatDate.js';
import { durationWords } from '../network/networkCopy.js';
import { useSyncStatus } from './useSyncStatus.js';

const SIDE = { BOX: 'the cafe PC', CLOUD: 'the website' };
const KIND = {
  EDITED_BOTH: 'Changed on both',
  SAME_SLOT: 'Taken on both',
  DELETED_HERE: 'Removed on one, changed on the other',
};

/**
 * Sync. P63, for OWNER and MANAGER.
 *
 * How far the cafe PC and the website are in step, and the sync conflicts:
 * things both changed, or both took, before they could tell each other. Each
 * says what was kept; the fix itself is made on the ordinary screens, which
 * each conflict links to, and Mark as seen says a person has dealt with it.
 */
export default function SyncPage() {
  const [showSeen, setShowSeen] = useState(false);
  const status = useSyncStatus();
  const conflicts = useQuery({ queryKey: ['sync', 'conflicts', showSeen], queryFn: () => listSyncConflicts({ seen: showSeen }) });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="type-title">Sync</h1>
          <p className="type-body text-muted">The cafe PC and the website, kept in step.</p>
        </div>
        <SyncNowButton isBox={status?.data?.node === 'BOX'} />
      </header>
      <StatusCard status={status} />
      <IncomingChanges />
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="type-label">{showSeen ? 'Conflicts already seen' : 'Sync conflicts to check'}</h2>
          <Button size="sm" variant="quiet" onClick={() => setShowSeen((value) => !value)}>
            {showSeen ? 'Show the ones to check' : 'Show the ones seen'}
          </Button>
        </div>
        {conflicts.isError && <ErrorMessage error={conflicts.error} />}
        {conflicts.isLoading && <p className="type-body text-muted">Reading…</p>}
        {conflicts.data && conflicts.data.data.length === 0 && (
          <p className="type-body text-muted">{showSeen ? 'None yet.' : 'Nothing to check. Everything the PC and the website did fitted together.'}</p>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {(conflicts.data?.data ?? []).map((conflict) => <ConflictRow key={conflict.id} conflict={conflict} />)}
        </ul>
      </section>
    </div>
  );
}

/**
 * 2026-10-22. Sync now. On the cafe PC a whole round at once: the website's
 * changes in, then this PC's out. On the website its own changes are made
 * ready; the PC takes them on its next round, within a minute while it is on.
 */
function SyncNowButton({ isBox }) {
  const queryClient = useQueryClient();
  const [said, setSaid] = useState(null);
  const now = useMutation({
    mutationFn: syncNow,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sync'] });
      const words = {
        PULLED_AND_PUSHED: 'Synced: the website’s changes are in, and this PC’s have gone.',
        PUSHED: 'This PC’s changes have gone to the website.',
        READY_FOR_THE_PC: 'Ready: the cafe PC takes the website’s changes on its next sync, within a minute while it is on.',
        NOTHING: 'Nothing to sync on this server.',
      };
      setSaid({ tone: result.failed ? 'alert' : 'ok', text: result.failed ? 'The sync could not finish. See Last problem below; it tries again by itself.' : words[result.did] ?? 'Synced.' });
    },
    onError: (error) => setSaid({ tone: 'alert', text: errorMessage(error) }),
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button isLoading={now.isPending} onClick={() => now.mutate()}>
        {now.isPending ? (isBox ? 'Syncing…' : 'Getting ready…') : 'Sync now'}
      </Button>
      {said && <p className={`type-caption max-w-xs text-right ${said.tone === 'alert' ? 'text-alert' : 'text-muted'}`}>{said.text}</p>}
    </div>
  );
}

const OUTCOME = { APPLIED: 'Taken as it came', MERGED: 'Merged with a change here', DELETED: 'Removed' };

/** 2026-10-22. What the other side's changes did here, newest first, each with Undo. */
function IncomingChanges() {
  const changes = useQuery({ queryKey: ['sync', 'changes'], queryFn: listSyncChanges, refetchInterval: 30_000 });
  const rows = changes.data ?? [];
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="type-label mb-1">What came in</h2>
      <p className="type-caption mb-3 text-muted">
        Changes the other side sent here, newest first. Each is kept unless you undo it; an undo goes back to the other side at the next sync.
      </p>
      {changes.isError && <ErrorMessage error={changes.error} />}
      {changes.isLoading && <p className="type-body text-muted">Reading…</p>}
      {changes.data && rows.length === 0 && <p className="type-body text-muted">Nothing has come in yet.</p>}
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((change) => <IncomingRow key={change.id} change={change} />)}
      </ul>
    </section>
  );
}

function IncomingRow({ change }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const undo = useMutation({
    mutationFn: () => undoSyncChange(change.id),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries();
    },
  });
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="type-heading">{change.title}</span>
        <span className="type-caption text-muted">
          From {SIDE[change.from] ?? change.from} · {formatDateIst(change.at)} {formatTimeIst(change.at)}
        </span>
      </div>
      <p className="type-caption text-muted">{change.wasNew ? 'New here' : OUTCOME[change.outcome] ?? change.outcome}</p>
      <div className="flex flex-wrap items-center gap-2">
        {change.link && (
          <Link to={change.link} className="type-label inline-flex min-h-12 items-center rounded-full border border-line px-4 hover:bg-sunken">
            Open it
          </Link>
        )}
        {change.undoneAt ? (
          <span className="type-caption text-muted">Undone at {formatTimeIst(change.undoneAt)}</span>
        ) : change.canUndo ? (
          confirming ? (
            <>
              <span className="type-body">Put back how it was here before this change?</span>
              <Button size="sm" variant="secondary" isLoading={undo.isPending} onClick={() => undo.mutate()}>
                Yes, undo it
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => setConfirming(true)}>
              Undo
            </Button>
          )
        ) : (
          <span className="type-caption text-muted">Kept. {change.undoBlocked}</span>
        )}
      </div>
      {undo.isError && <ErrorMessage error={undo.error} />}
    </li>
  );
}

function StatusCard({ status }) {
  const data = status?.data;
  if (!status) {
    return (
      <section className="rounded-xl border border-line bg-surface p-4">
        <p className="type-body">Two-way sync is off on this server. The cafe PC and the website are not both taking bills.</p>
      </section>
    );
  }
  if (status.isError) return <ErrorMessage error={status.error} />;
  if (!data) return <p className="type-body text-muted">Reading…</p>;

  const isBox = data.node === 'BOX';
  let state = 'ok';
  let word = 'In step';
  let line;
  if (isBox) {
    const waiting = data.pushed?.waiting ?? 0;
    if (data.lastError && waiting > 0) {
      state = 'alert';
      word = 'Cannot reach the website';
    } else if (waiting > 0) {
      state = 'open';
      word = 'Catching up';
    }
    line = waiting > 0
      ? `${waiting} change${waiting === 1 ? '' : 's'} from this PC waiting to reach the website${data.pushed.secondsBehind ? `, the oldest ${durationWords(data.pushed.secondsBehind)} old` : ''}. They go as soon as the internet is back; billing here carries on.`
      : `Everything from this PC has reached the website. Last heard from the website ${data.pulled?.at ? `at ${formatTimeIst(data.pulled.at)}` : 'not yet'}.`;
  } else {
    const ago = data.boxSecondsAgo;
    if (ago === null || ago > 120) {
      state = 'open';
      word = 'The cafe PC is away';
    }
    line = ago === null
      ? 'The cafe PC has not connected yet. Bills made here use the website series (W).'
      : `The cafe PC last checked in ${durationWords(ago)} ago. While it is away, both keep billing; they catch up when it is back.`;
  }
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StateChip state={state} word={word} />
        <span className="type-caption text-muted">This is {isBox ? 'the cafe PC' : 'the website'}</span>
      </div>
      <p className="type-body mt-2">{line}</p>
      {data.lastError && <p className="type-caption mt-1 text-muted">Last problem: {data.lastError}</p>}
    </section>
  );
}

function ConflictRow({ conflict }) {
  const queryClient = useQueryClient();
  const keep = useMutation({
    mutationFn: (version) => (version === 'RESULT' ? markSyncConflictSeen(conflict.id) : keepSyncConflictVersion(conflict.id, version)),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="type-heading">{conflict.title}</span>
        <span className="type-caption text-muted">
          {formatDateIst(conflict.detectedAt)} {formatTimeIst(conflict.detectedAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StateChip state="open" word={KIND[conflict.kind] ?? conflict.kind} size="sm" />
        <span className="type-caption text-muted">Kept from {SIDE[conflict.keptFrom] ?? conflict.keptFrom}</span>
        {conflict.fields.length > 0 && <span className="type-caption text-muted">· {conflict.fields.join(', ')}</span>}
      </div>
      {conflict.detail && <p className="type-body">{conflict.detail}</p>}
      <div className="flex flex-wrap gap-2">
        {conflict.link && (
          <Link to={conflict.link} className="type-label inline-flex min-h-12 items-center rounded-full border border-line px-4 hover:bg-sunken">
            Open it
          </Link>
        )}
        {!conflict.seenAt ? (
          <>
            {/* 2026-10-22. Which version to keep: as merged, or either side's whole version. */}
            <Button size="sm" variant="secondary" isLoading={keep.isPending && keep.variables === 'RESULT'} onClick={() => keep.mutate('RESULT')}>
              Keep as it is
            </Button>
            {(conflict.versions ?? []).map((version) => (
              <Button key={version.key} size="sm" variant="quiet" isLoading={keep.isPending && keep.variables === version.key} onClick={() => keep.mutate(version.key)}>
                Use {SIDE[version.from] ?? version.from}&rsquo;s version
              </Button>
            ))}
          </>
        ) : (
          <span className="type-caption text-muted">Seen{conflict.seenByName ? ` by ${conflict.seenByName}` : ''}</span>
        )}
      </div>
      {keep.isError && <ErrorMessage error={keep.error} />}
    </li>
  );
}
