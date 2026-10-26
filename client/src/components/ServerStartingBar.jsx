import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { SERVER_NOT_CONFIRMED_MESSAGE } from '../api/client.js';
import { clearUnconfirmed, getServerState, subscribeServerState } from '../api/serverWaking.js';
import { snapshot as linkSnapshot, subscribe as subscribeLink } from '../features/network/linkMonitor.js';

/** About how long a cold start takes, for the progress line. */
const EXPECTED_WAKE_MS = 70_000;

/**
 * The bar at the top of every screen while the free server wakes. P30,
 * API-CONTRACT P30 section 5.
 *
 * Two states, in the design system's `open` colours, calm rather than alarmed:
 * waiting, with a progress line that fills over the minute a cold start takes
 * (filled by a timer, never a looping animation); and a write the server may
 * not have received, which offers to reload the screen's data, because the
 * write itself is never sent twice.
 */
export default function ServerStartingBar() {
  const { waiting, since, unconfirmed } = useSyncExternalStore(subscribeServerState, getServerState);
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // P62. When this device cannot reach the server at all, the red banner under the top bar
  // says which WiFi and address to use; "starting the server" would point the wrong way.
  const link = useSyncExternalStore(subscribeLink, linkSnapshot);
  if (!waiting && !unconfirmed) return null;
  if (!unconfirmed && link.status === 'UNREACHABLE') return null;

  const progress = since ? Math.min(95, Math.max(5, ((now - since) / EXPECTED_WAKE_MS) * 100)) : 5;

  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 top-0 z-50 border-b border-open bg-open-tint text-ink print:hidden">
      {waiting > 0 ? (
        <>
          <p className="type-body px-4 py-3">Starting the server. This takes about a minute the first time in the morning.</p>
          <div className="h-1 w-full bg-surface" aria-hidden="true">
            <div className="h-1 bg-open transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <p className="type-body min-w-0 flex-1">{SERVER_NOT_CONFIRMED_MESSAGE}</p>
          <button
            type="button"
            onClick={() => {
              queryClient.invalidateQueries();
              clearUnconfirmed();
            }}
            className="type-button min-h-12 rounded-lg border border-ink bg-surface px-4 hover:bg-sunken"
          >
            Reload this screen
          </button>
          <button type="button" onClick={clearUnconfirmed} className="type-label min-h-12 rounded-lg px-3 text-muted hover:bg-sunken">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
