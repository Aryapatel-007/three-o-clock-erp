import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getNetworkSetup, getNetworkStatus } from '../../api/network.js';
import Button from '../../components/ui/Button.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { isWebsite, OFFLINE_APP_URL } from '../auth/OfflineAppCard.jsx';
import { rememberedSetup } from './linkMonitor.js';
import SignalBars from './SignalBars.jsx';
import { useLink } from './useNetwork.js';

/**
 * Connect a device. P62, docs/STAFF-SETUP.md.
 *
 * No sign-in: a new tablet, or one that joined the wrong WiFi, must be able to
 * read it. It says which WiFi to join and which address to open, with a QR
 * code for each, and the steps for each kind of device. Printed, it is the
 * card that sits by the till.
 *
 * The WiFi password appears only when an OWNER or MANAGER is signed in on this
 * device, so the card they print lets a phone join by scanning. The public
 * view names the WiFi and never its password.
 */

/** The WiFi QR format phones understand. Backslash-escapes the five special characters. */
export function wifiQrText(ssid, password) {
  const escape = (text) => String(text ?? '').replace(/([\\;,:"])/g, '\\$1');
  return password ? `WIFI:T:WPA;S:${escape(ssid)};P:${escape(password)};;` : `WIFI:T:nopass;S:${escape(ssid)};;`;
}

function Qr({ text, label }) {
  const [svg, setSvg] = useState(null);
  useEffect(() => {
    let alive = true;
    import('qrcode')
      .then(({ default: QRCode }) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }))
      .then((markup) => alive && setSvg(markup))
      .catch(() => alive && setSvg(null));
    return () => {
      alive = false;
    };
  }, [text]);
  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="size-44 rounded-lg border border-line bg-surface p-2 [&_svg]:size-full" role="img" aria-label={label} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
      <figcaption className="type-caption text-center text-muted">{label}</figcaption>
    </figure>
  );
}

/** Back to the app, at the top where people look for it. Not printed on the card. */
function BackHome() {
  return (
    <Link to="/" className="type-label inline-flex min-h-12 items-center self-start rounded-lg px-2 text-muted hover:bg-sunken hover:text-ink print:hidden">
      ← Back to Home
    </Link>
  );
}

/** The website's card: one address and its QR code, for any device with the internet. */
function WebsiteConnect({ address }) {
  return (
    <div className="v2 min-h-dvh bg-ground text-ink">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 print:p-0">
        <BackHome />
        <header>
          <h1 className="type-title">Connect a device to Three O’Clock</h1>
          <p className="type-caption text-muted">Any phone, tablet or computer with the internet opens the same system. Each person then signs in with their own login.</p>
        </header>

        <section className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center">
          <p className="type-label">Open this address, or scan the code with the camera</p>
          <p className="type-heading break-all font-mono">{address}</p>
          <Qr text={address} label="Scan to open Three O’Clock" />
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="type-label mb-2">Keep it one tap away</h2>
          <ul className="type-body flex list-disc flex-col gap-1 pl-5">
            <li><strong>Android (Chrome):</strong> menu ⋮, then <em>Add to Home screen</em>.</li>
            <li><strong>iPad or iPhone (Safari):</strong> the share button, then <em>Add to Home Screen</em>.</li>
            <li><strong>Windows or Mac:</strong> bookmark it, or in Chrome use ⋮, <em>Cast, save and share</em>, <em>Install page as app</em>.</li>
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="type-label mb-2">Working without the internet</h2>
          <p className="type-body">
            Install the offline app on the restaurant&apos;s Windows PC: billing, kitchen tickets and printing then keep working when the
            internet is down, and tablets connect to that PC over the WiFi.
          </p>
          <a href={OFFLINE_APP_URL} className="type-button mt-3 inline-flex min-h-12 items-center rounded-lg border border-ink bg-surface px-4 hover:bg-sunken print:hidden">
            Download for Windows
          </a>
        </section>

        <div className="flex flex-wrap gap-3 print:hidden">
          <Button onClick={() => window.print()} variant="secondary">
            Print this card
          </Button>
        </div>
      </main>
    </div>
  );
}

export default function ConnectPage() {
  const { user } = useAuth();
  const link = useLink({ signedIn: Boolean(user) });
  const [setup, setSetup] = useState(() => rememberedSetup());
  const [password, setPassword] = useState(null);
  const manager = user?.role === 'OWNER' || user?.role === 'MANAGER';

  useEffect(() => {
    getNetworkSetup().then(setSetup).catch(() => {});
    if (manager) getNetworkStatus().then((status) => setPassword(status.staffWifi?.password ?? null)).catch(() => {});
  }, [manager]);

  // 2026-11-03. On the website there is no restaurant WiFi to join: any device with the
  // internet opens the website itself. The server's own address there is the cloud
  // host's internal one, which no tablet can reach, so it is never shown.
  const website = isWebsite();
  const address = website ? window.location.origin : (setup?.boxUrl ?? window.location.origin);
  const wifiName = setup?.wifiName ?? null;
  const reachable = link.status !== 'UNREACHABLE';

  if (website) return <WebsiteConnect address={address} />;

  return (
    <div className="v2 min-h-dvh bg-ground text-ink">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 print:p-0">
        <BackHome />
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="type-title">Connect a device to Three O’Clock</h1>
            <p className="type-caption text-muted">Tills, captain tablets, kitchen screens and phones all use the restaurant&apos;s own server, over the restaurant WiFi.</p>
          </div>
          <span className="flex items-center gap-2 print:hidden">
            <span className={`flex items-center gap-1.5 type-label ${reachable ? 'text-ok' : 'text-alert'}`}>
              <SignalBars bars={reachable ? link.quality.bars : 0} />
              {reachable ? `This device: ${link.quality.word}` : 'This device cannot reach the server'}
            </span>
          </span>
        </header>

        <section className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-surface p-4 min-[600px]:grid-cols-2">
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="type-label">Step 1. Join this WiFi</p>
            <p className="type-heading">{wifiName ?? 'The cafe staff WiFi'}</p>
            {wifiName && <Qr text={wifiQrText(wifiName, password)} label={password ? 'Scan with the camera to join' : 'Scan to see the WiFi name'} />}
            {manager && wifiName && !password && <p className="type-caption text-muted">Add the WiFi password in Network and devices to make this code join by itself.</p>}
          </div>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="type-label">Step 2. Open this address</p>
            <p className="type-heading break-all font-mono">{address}</p>
            {setup?.localNameUrl && <p className="type-caption text-muted">or {setup.localNameUrl}</p>}
            <Qr text={address} label="Scan to open the system" />
          </div>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="type-label mb-2">Step 3. Keep it one tap away</h2>
          <ul className="type-body flex list-disc flex-col gap-1 pl-5">
            <li><strong>Android (Chrome):</strong> menu ⋮, then <em>Add to Home screen</em>.</li>
            <li><strong>iPad or iPhone (Safari):</strong> the share button, then <em>Add to Home Screen</em>.</li>
            <li><strong>Windows or Mac:</strong> bookmark it, or in Chrome use ⋮, <em>Cast, save and share</em>, <em>Install page as app</em>.</li>
          </ul>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="type-label mb-2">If it does not open</h2>
          <ol className="type-body flex list-decimal flex-col gap-1 pl-5">
            <li>Check the WiFi name on the device is exactly <strong>{wifiName ?? 'the staff WiFi'}</strong>. A guest WiFi or mobile data cannot reach the server.</li>
            <li>Turn off mobile data on phones while on shift, so the phone does not leave the WiFi when the signal dips.</li>
            <li>Type the address exactly, starting with <span className="font-mono">{address.split('//')[0]}//</span>. Do not search for it.</li>
            <li>If no device opens it, the server or the router is off. The manager checks both have power (they are on the UPS).</li>
          </ol>
        </section>

        <div className="flex flex-wrap gap-3 print:hidden">
          <Button onClick={() => window.print()} variant="secondary">
            Print this card
          </Button>
          <Link to="/" className="type-button inline-flex min-h-12 items-center rounded-lg px-4 hover:bg-sunken">
            Open the system
          </Link>
        </div>
      </main>
    </div>
  );
}
