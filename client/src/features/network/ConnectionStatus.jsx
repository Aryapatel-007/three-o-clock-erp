import { useState } from 'react';
import { Link } from 'react-router-dom';

import StateChip from '../../components/ui/StateChip.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { rememberedSetup } from './linkMonitor.js';
import { DEVICE_WORDS, serverLine } from './networkCopy.js';
import SignalBars from './SignalBars.jsx';
import { useLink, useNetworkSelf } from './useNetwork.js';

const MANAGERS = new Set(['OWNER', 'MANAGER']);

/**
 * The top bar's two kinds of offline, shown differently. P62 section 7.
 *
 *   This device to the cafe server: four bars and a word, on every device,
 *   always. Connected is quiet (just the bars); Reconnecting is a caution;
 *   Cannot reach server is an alert, with the banner below the bar.
 *
 *   The cafe server to the cloud: "12 waiting to upload" is calm, never an
 *   alert, because service is fine. "Not synced for 3 hours" and a failed
 *   reconciliation are alerts for OWNER and MANAGER only.
 */
/**
 * P63. The website is not the cafe server: its screens keep the look they had before P62.
 * Before /auth/me has answered, a device that has used a cafe server before is taken to be on one.
 */
function onWebsite(features) {
  const server = features?.sync?.server;
  if (server) return server === 'CLOUD';
  return !rememberedSetup();
}

export default function ConnectionStatus() {
  const { features } = useAuth();
  if (onWebsite(features)) return null;
  return <CafeConnectionStatus />;
}

function CafeConnectionStatus() {
  const { user } = useAuth();
  const link = useLink({ signedIn: Boolean(user) });
  const self = useNetworkSelf(Boolean(user) && link.status !== 'UNREACHABLE');
  const [open, setOpen] = useState(false);
  const manager = MANAGERS.has(user?.role);
  const line = serverLine(self.data, { manager });
  const ms = link.quality.medianMs;

  const deviceWord = link.status === 'CONNECTED' ? link.quality.word : DEVICE_WORDS[link.status];
  const deviceLabel = `Connection to the cafe server: ${deviceWord}${ms !== null && link.status === 'CONNECTED' ? `, ${ms} milliseconds` : ''}`;

  return (
    <span className="relative flex items-center gap-2">
      {line && !line.quiet && (
        <StateChip state={line.state} word={line.word} size="sm" onClick={() => setOpen((value) => !value)} ariaLabel={`${line.word}. Tap for more.`} className="hidden min-[600px]:inline-flex" />
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={deviceLabel}
        title={deviceLabel}
        className={[
          'flex min-h-10 items-center gap-1.5 rounded-full px-2 type-caption',
          link.status === 'UNREACHABLE' ? 'bg-alert-tint text-alert' : link.status === 'RECONNECTING' ? 'bg-open-tint text-open' : 'text-muted hover:bg-sunken',
        ].join(' ')}
      >
        <SignalBars bars={link.status === 'UNREACHABLE' ? 0 : link.quality.bars} />
        <span className={link.status === 'CONNECTED' ? 'hidden min-[600px]:inline' : ''}>{deviceWord}</span>
        {link.status === 'CONNECTED' && ms !== null && <span className="hidden font-mono min-[900px]:inline">{ms} ms</span>}
      </button>
      {open && <Details link={link} line={line} onClose={() => setOpen(false)} />}
    </span>
  );
}

function Details({ link, line, onClose }) {
  const q = link.quality;
  return (
    <div role="dialog" aria-label="Connection" className="absolute right-0 top-11 z-40 w-72 rounded-xl border border-line bg-surface p-4 shadow-lg">
      <p className="type-label mb-2">This device</p>
      <p className="type-body flex items-center gap-2">
        <SignalBars bars={link.status === 'UNREACHABLE' ? 0 : q.bars} />
        {link.status === 'CONNECTED' ? q.word : DEVICE_WORDS[link.status]}
      </p>
      {q.medianMs !== null && (
        <p className="type-caption mt-1 text-muted">
          {q.medianMs} ms to the server{q.jitterMs !== null ? `, wobble ${q.jitterMs} ms` : ''}, {q.lossPercent}% of pings lost
        </p>
      )}
      {line && (
        <>
          <p className="type-label mb-1 mt-3">Cafe server</p>
          <p className="type-body">{line.word}</p>
          <p className="type-caption mt-1 text-muted">{line.detail}</p>
        </>
      )}
      <div className="mt-3 flex items-center justify-between">
        <Link to="/connect" className="type-label text-accent underline-offset-2 hover:underline" onClick={onClose}>
          How to connect a device
        </Link>
        <button type="button" onClick={onClose} className="type-label min-h-10 px-2 text-muted hover:text-ink">
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * The alert under the top bar while this device cannot reach the server. It
 * says what to do from what the device remembered while it could still ask:
 * the WiFi to join and the address to open.
 */
export function LostConnectionBanner() {
  const { features } = useAuth();
  if (onWebsite(features)) return null;
  return <CafeLostConnectionBanner />;
}

function CafeLostConnectionBanner() {
  const { user } = useAuth();
  const link = useLink({ signedIn: Boolean(user) });
  if (link.status !== 'UNREACHABLE') return null;
  const setup = rememberedSetup();
  const address = setup?.boxUrl ?? window.location.origin;
  return (
    <div role="alert" className="flex flex-col gap-1 border-b border-alert bg-alert-tint px-4 py-3 text-alert print:hidden">
      <p className="type-label">Cannot reach the cafe server. Nothing you tap now is saved.</p>
      <ol className="type-caption list-decimal pl-5 text-ink">
        <li>
          Check this device is on the WiFi {setup?.wifiName ? <strong>&ldquo;{setup.wifiName}&rdquo;</strong> : 'the cafe gave you'}, not mobile data or another network.
        </li>
        <li>
          Then open <strong className="font-mono">{address}</strong>
          {setup?.localNameUrl ? (
            <>
              {' '}or <strong className="font-mono">{setup.localNameUrl}</strong>
            </>
          ) : null}
          .
        </li>
        <li>Still nothing on every device? The server or the router is off: tell the manager.</li>
      </ol>
      <Link to="/connect" className="type-label underline">
        Full steps for this device
      </Link>
    </div>
  );
}
