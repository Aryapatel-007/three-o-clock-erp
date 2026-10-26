import { Link } from 'react-router-dom';

import { serverLine } from './networkCopy.js';
import SignalBars from './SignalBars.jsx';
import { useNetworkStatus } from './useNetwork.js';

/**
 * The owner's dashboard card for the network. P62.
 *
 * Which WiFi the whole system runs on and the server's signal, how many
 * devices are connected and the weakest of them, and the cloud copy, in the
 * dashboard's own look. "Network and devices" opens the full page, where the
 * owner changes the WiFi and sees every device.
 */
export default function OwnerNetworkCard() {
  const status = useNetworkStatus();
  const data = status.data;
  if (!data) return null;
  const box = data.box;
  const connected = data.devices.filter((device) => device.connected);
  const weakest = connected[0] ?? null;
  const line = serverLine(data, { manager: true });
  let wifi = 'Cloud server';
  if (data.role === 'BOX') wifi = box?.wifiConnected ? (box.ssid ?? 'WiFi') : box?.wired ? 'Wired (cable)' : 'Not on WiFi';

  return (
    <section className="rounded-xl border border-dash-line bg-dash-card p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Network</h2>
        <Link to="/network" className="text-xs font-medium underline-offset-2 hover:underline">
          Network and devices
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-dash-muted">System runs on</p>
          <p className="flex items-center gap-2 truncate font-semibold">
            {box?.wifiConnected && <SignalBars bars={box.signal.bars ?? 0} />}
            <span className="truncate">{wifi}</span>
          </p>
          {box?.wifiConnected && box.signalPercent !== null && <p className="text-[11px] text-dash-muted">Server signal {box.signal.word.toLowerCase()}</p>}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-dash-muted">Devices connected</p>
          <p className="font-mono font-semibold">{connected.length}</p>
          {weakest && (
            <p className={`flex items-center gap-1 truncate text-[11px] ${weakest.bars <= 1 ? 'text-dash-alert' : 'text-dash-muted'}`}>
              <SignalBars bars={weakest.bars} size={14} />
              Weakest: {weakest.name}, {weakest.word.toLowerCase()}
            </p>
          )}
        </div>
      </div>
      {line && !line.quiet && (
        <p className={`mt-3 text-xs ${line.state === 'alert' ? 'text-dash-alert' : 'text-dash-muted'}`}>
          {line.word}. {line.detail}
        </p>
      )}
      {line?.quiet && <p className="mt-3 text-xs text-dash-ok">Cloud copy up to date.</p>}
    </section>
  );
}
