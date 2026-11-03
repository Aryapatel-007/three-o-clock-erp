import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { getSyncStatus, syncNow } from '../../api/sync.js';
import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import { formatDateIst, formatTimeIst } from '../../utils/formatDate.js';
import { errorMessage } from '../billing/errorCopy.js';
import { durationWords } from '../network/networkCopy.js';

/**
 * Push and pull. 2026-11-03, for OWNER and MANAGER.
 *
 * The restaurant PC is the main system and the only one that writes. It pushes its
 * records to the online copy by itself, on a timer, and Push now sends them at once.
 * The online copy is for the owner to see the records from anywhere, and a backup;
 * nothing on it can change the PC. Pull brings down what only the online copy
 * receives: online orders and bookings from the restaurant's page.
 */
export default function PushPullPage() {
  const status = useQuery({ queryKey: ['sync', 'status'], queryFn: getSyncStatus, refetchInterval: 15_000, staleTime: 5_000 });
  const oneWay = status.data?.oneWay;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <header>
        <h1 className="type-title">Push and pull</h1>
        <p className="type-body text-muted">The restaurant PC is the main system. It pushes its records to the online copy, which the owner can see from anywhere.</p>
      </header>
      {status.isError && <ErrorMessage error={status.error} />}
      {status.isLoading && <p className="type-body text-muted">Reading…</p>}
      {oneWay?.side === 'PC' && !oneWay.connected && <NotConnected />}
      {oneWay?.side === 'PC' && oneWay.connected && <OnThePc state={oneWay} />}
      {oneWay?.side === 'ONLINE_COPY' && <OnTheOnlineCopy state={oneWay} />}
      {oneWay?.side === 'WEBSITE_ALONE' && (
        <section className="rounded-[10px] border border-line bg-surface p-4">
          <p className="type-body">This website runs on its own: no restaurant PC pushes to it.</p>
        </section>
      )}
    </div>
  );
}

const when = (at) => (at ? `${formatDateIst(at)}, ${formatTimeIst(at)}` : 'not yet');

function paceWords(state) {
  const every = state.pushEverySeconds >= 120 ? `${Math.round(state.pushEverySeconds / 60)} minutes` : `${state.pushEverySeconds} seconds`;
  if (!state.syncHours || state.syncHours === 'always') return `Every ${every}, whenever there is something new.`;
  const [from, to] = state.syncHours.split('-');
  return `Every ${every} from ${from} to ${to} (India time), whenever there is something new; outside those hours, every 15 minutes.`;
}

function OnThePc({ state }) {
  const upToDate = state.pushed.waiting === 0;
  return (
    <>
      <section aria-label="Push" className="flex flex-col gap-3 rounded-[10px] border-2 border-ink bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="type-heading">Push: this PC to the online copy</h2>
            <p className="type-caption text-muted">{paceWords(state)}</p>
          </div>
          <StateChip
            state={upToDate ? 'ok' : 'open'}
            word={upToDate ? 'Up to date' : `${state.pushed.waiting} ${state.pushed.waiting === 1 ? 'change' : 'changes'} waiting`}
            size="sm"
          />
        </div>
        <dl className="grid gap-2 sm:grid-cols-2">
          <Fact label="Last pushed" value={when(state.pushed.at)} />
          <Fact label="Online copy holds records up to" value={when(state.pushed.through)} />
          {!upToDate && <Fact label="Oldest change waiting" value={`${durationWords(state.pushed.secondsBehind)} old`} />}
          <Fact label="Online copy" value={state.onlineUrl.replace(/^https?:\/\//, '')} />
        </dl>
        <NowButton direction="PUSH" primary label="Push now" busyLabel="Pushing…" />
      </section>

      <section aria-label="Pull" className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
        <div>
          <h2 className="type-heading">Pull: the online copy to this PC</h2>
          <p className="type-caption text-muted">
            Online orders and bookings from your restaurant&apos;s page come down every few seconds. The online copy can never change this PC&apos;s own records.
          </p>
        </div>
        <Fact label="Last pulled" value={when(state.pulledAt)} />
        <NowButton direction="PULL" label="Pull now" busyLabel="Pulling…" />
      </section>

      {state.lastError && (
        <p className="type-caption rounded-lg border border-line border-l-[3px] border-l-alert bg-surface px-3 py-2">
          Last problem, {when(state.lastErrorAt)}: {state.lastError}. It tries again by itself; billing on this PC is never affected.
        </p>
      )}
    </>
  );
}

function OnTheOnlineCopy({ state }) {
  const quiet = state.pcSecondsAgo == null || state.pcSecondsAgo > 30 * 60;
  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="type-heading">This is the online copy</h2>
          <p className="type-caption text-muted">
            Every record here comes from the restaurant PC. It can be read, not changed: bills, orders and settings are changed on the PC.
          </p>
        </div>
        <StateChip state={quiet ? 'open' : 'ok'} word={quiet ? 'PC not heard from lately' : 'PC connected'} size="sm" />
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <Fact label="Last records received" value={when(state.receivedAt)} />
        <Fact label="PC last called" value={state.pcSecondsAgo == null ? 'not yet' : `${durationWords(state.pcSecondsAgo)} ago`} />
      </dl>
    </section>
  );
}

function NotConnected() {
  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line border-l-[3px] border-l-open bg-surface p-4">
      <h2 className="type-heading">Not connected to the online copy</h2>
      <p className="type-body text-muted">
        Everything is kept on this PC and in its hourly snapshots. To push to the online copy, double-click &quot;Connect to the website&quot; in the Three O’Clock folder on
        this PC.
      </p>
    </section>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="type-caption text-muted">{label}</dt>
      <dd className="type-body">{value}</dd>
    </div>
  );
}

function NowButton({ direction, label, busyLabel, primary = false }) {
  const queryClient = useQueryClient();
  const [said, setSaid] = useState(null);
  const now = useMutation({
    mutationFn: () => syncNow({ direction }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['sync'] });
      if (result.failed) {
        setSaid({ tone: 'alert', text: 'The online copy did not answer. It tries again by itself.' });
        return;
      }
      setSaid({
        tone: 'ok',
        text: direction === 'PUSH' ? 'Pushed: the online copy has this PC’s records.' : result.pulled ? `Pulled ${result.pulled} online ${result.pulled === 1 ? 'request' : 'requests'}.` : 'Pulled: nothing was waiting online.',
      });
    },
    onError: (error) => setSaid({ tone: 'alert', text: errorMessage(error) }),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant={primary ? 'primary' : 'secondary'} isLoading={now.isPending} onClick={() => now.mutate()}>
        {now.isPending ? busyLabel : label}
      </Button>
      {said && <p className={`type-caption ${said.tone === 'alert' ? 'text-alert' : 'text-muted'}`}>{said.text}</p>}
    </div>
  );
}
