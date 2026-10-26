import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { connectWifi, getWifiNetworks, saveStaffWifi } from '../../api/network.js';
import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Input from '../../components/ui/Input.jsx';
import Sheet from '../../components/ui/Sheet.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatTimeIst } from '../../utils/formatDate.js';
import { deviceIdentity, setDeviceName } from './linkMonitor.js';
import { durationWords, serverLine } from './networkCopy.js';
import SignalBars from './SignalBars.jsx';
import { useNetworkStatus } from './useNetwork.js';

/**
 * Network and devices. P62 network additions, for OWNER and MANAGER.
 *
 * Which WiFi the whole system runs on and how strong the server's signal is,
 * the addresses staff open, every device connected right now with its
 * strength, the cloud copy, and (for the owner, when the box allows it)
 * moving the server to another WiFi.
 */
export default function NetworkPage() {
  const { user } = useAuth();
  const status = useNetworkStatus();
  const data = status.data;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="type-title">Network and devices</h1>
        <Link to="/connect" className="type-label text-accent underline-offset-2 hover:underline">
          Staff setup card
        </Link>
      </header>
      {status.isError && <ErrorMessage error={status.error} />}
      {!data && !status.isError && <p className="type-body text-muted">Reading the network…</p>}
      {data && (
        <>
          <ServerWifi data={data} isOwner={user?.role === 'OWNER'} />
          <Addresses data={data} />
          <Devices devices={data.devices} />
          <CloudCopy data={data} />
          <ThisDevice />
        </>
      )}
    </div>
  );
}

function Card({ title, aside = null, children }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-label">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ServerWifi({ data, isOwner }) {
  const [changing, setChanging] = useState(false);
  const box = data.box;
  if (data.role !== 'BOX') {
    return (
      <Card title="The cafe server">
        <p className="type-body">This is the {data.role === 'MIRROR' ? 'cloud copy' : 'cloud server'}, not a server in the cafe. It has no WiFi of its own to show.</p>
      </Card>
    );
  }
  let heading;
  if (box?.wired && !box.wifiConnected) heading = 'On a cable (wired)';
  else if (box?.wifiConnected) heading = box.ssid ?? 'WiFi (name hidden)';
  else if (box?.readable) heading = 'Not on WiFi';
  else heading = 'Not readable on this server';
  return (
    <Card
      title="The WiFi the system runs on"
      aside={isOwner && box?.canChange ? <Button size="sm" variant="secondary" onClick={() => setChanging(true)}>Change WiFi</Button> : null}
    >
      <div className="flex flex-wrap items-center gap-3">
        {box?.wifiConnected && <SignalBars bars={box.signal.bars ?? 0} size={28} />}
        <div>
          <p className="type-heading">{heading}</p>
          <p className="type-caption text-muted">
            {box?.wifiConnected && box.signalPercent !== null ? `Server signal ${box.signal.word}, ${box.signalPercent}%` : null}
            {box?.wired ? `${box?.wifiConnected ? ' · ' : ''}Cable connected` : null}
            {!box?.readable ? 'The server could not read its own network. docs/STAFF-SETUP.md section 5.' : null}
          </p>
        </div>
      </div>
      {isOwner && !box?.canChange && (
        <p className="type-caption mt-3 text-muted">Changing WiFi from here is switched off on this server. It is set once at install (docs/STAFF-SETUP.md section 5).</p>
      )}
      {changing && <ChangeWifiSheet current={box?.ssid} onClose={() => setChanging(false)} />}
    </Card>
  );
}

function ChangeWifiSheet({ current, onClose }) {
  const queryClient = useQueryClient();
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const networks = useQuery({ queryKey: ['network', 'wifi-list'], queryFn: getWifiNetworks, staleTime: 0 });
  const change = useMutation({
    mutationFn: () => connectWifi({ ssid, password }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['network'] });
      onClose();
    },
  });

  return (
    <Sheet
      title="Change the server's WiFi"
      subtitle={current ? `Now on ${current}` : null}
      onClose={onClose}
      footer={
        <Button fullWidth disabled={!ssid || !understood} isLoading={change.isPending} onClick={() => change.mutate()}>
          Move the server to {ssid || 'this WiFi'}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-open bg-open-tint p-3 text-open">
          <p className="type-label">Every tablet, till and kitchen screen must move too.</p>
          <p className="type-caption mt-1 text-ink">
            The server is where every device sends its orders. Once it moves, a device left on the old WiFi cannot reach it. Do this outside service, then join every
            device to the new WiFi and print a new setup card. If the new WiFi refuses the password, the server stays on the one it has.
          </p>
        </div>
        {networks.isError && <ErrorMessage error={networks.error} />}
        <div>
          <p className="type-label mb-2">WiFi the server can see</p>
          {networks.isLoading && <p className="type-caption text-muted">Looking for WiFi…</p>}
          <ul className="flex flex-col gap-1">
            {(networks.data?.networks ?? []).map((network) => (
              <li key={network.ssid}>
                <button
                  type="button"
                  onClick={() => setSsid(network.ssid)}
                  className={`flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left ${ssid === network.ssid ? 'bg-sunken font-semibold' : 'hover:bg-sunken'}`}
                >
                  <span className="type-body">
                    {network.ssid}
                    {network.inUse ? ' (now)' : ''}
                    {!network.secured ? ' · open' : ''}
                  </span>
                  <span className="flex items-center gap-2 type-caption text-muted">
                    <SignalBars bars={network.signalPercent >= 75 ? 4 : network.signalPercent >= 55 ? 3 : network.signalPercent >= 35 ? 2 : 1} />
                    {network.signalPercent}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <Input label="WiFi name" value={ssid} onChange={(event) => setSsid(event.target.value)} maxLength={32} autoComplete="off" />
        <Input label="WiFi password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={63} autoComplete="new-password" />
        <label className="type-body flex items-start gap-2">
          <input type="checkbox" className="mt-1 size-5" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
          I will move every device to this WiFi straight after.
        </label>
        {change.isError && <ErrorMessage error={change.error} />}
      </div>
    </Sheet>
  );
}

function Addresses({ data }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [ssid, setSsid] = useState(data.staffWifi?.ssid ?? '');
  const [password, setPassword] = useState(data.staffWifi?.password ?? '');
  const save = useMutation({
    mutationFn: () => saveStaffWifi({ ssid, password }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['network'] });
      setEditing(false);
    },
  });
  return (
    <Card title="What staff open" aside={<Button size="sm" variant="quiet" onClick={() => setEditing((value) => !value)}>{editing ? 'Cancel' : 'Edit staff WiFi'}</Button>}>
      <dl className="grid grid-cols-1 gap-3 min-[600px]:grid-cols-3">
        <div>
          <dt className="type-caption text-muted">Staff WiFi</dt>
          <dd className="type-body font-semibold">{data.staffWifi?.ssid ?? data.box?.ssid ?? 'Not set yet'}</dd>
        </div>
        <div>
          <dt className="type-caption text-muted">Address to open{data.addressFixed ? '' : ', from the WiFi the server is on now'}</dt>
          <dd className="type-body font-mono">{data.boxUrl ?? window.location.origin}</dd>
          {data.otherUrls?.length > 0 && <dd className="type-caption font-mono text-muted">also {data.otherUrls.join(', ')}</dd>}
        </div>
        <div>
          <dt className="type-caption text-muted">Or by name</dt>
          <dd className="type-body font-mono">{data.localNameUrl ?? '—'}</dd>
        </div>
      </dl>
      {editing && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="type-caption text-muted">What the setup card prints, so a new tablet can join by scanning. Kept on the server only, never in the cloud.</p>
          <Input label="Staff WiFi name" value={ssid} onChange={(event) => setSsid(event.target.value)} maxLength={32} />
          <Input label="Staff WiFi password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={63} />
          {save.isError && <ErrorMessage error={save.error} />}
          <Button onClick={() => save.mutate()} isLoading={save.isPending} disabled={!ssid}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function Devices({ devices }) {
  const connected = devices.filter((device) => device.connected).length;
  return (
    <Card title="Devices connected" aside={<span className="type-caption text-muted">{connected} connected now, weakest first</span>}>
      {devices.length === 0 && <p className="type-body text-muted">No device has reported yet. A device reports every 15 seconds once someone signs in on it.</p>}
      <ul className="flex flex-col divide-y divide-line">
        {devices.map((device) => (
          <li key={device.deviceId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="flex min-w-0 items-center gap-3">
              <SignalBars bars={device.connected ? device.bars : 0} size={22} />
              <span className="min-w-0">
                <span className="type-body block truncate font-semibold">{device.name}</span>
                <span className="type-caption block truncate text-muted">
                  {[device.userName, device.role, device.address].filter(Boolean).join(' · ')}
                </span>
              </span>
            </span>
            <span className="text-right">
              <span className={`type-label block ${device.connected ? (device.bars >= 3 ? 'text-ok' : device.bars === 2 ? 'text-open' : 'text-alert') : 'text-muted'}`}>{device.word}</span>
              <span className="type-caption block font-mono text-muted">
                {device.connected
                  ? `${device.medianMs ?? '—'} ms · ${device.lossPercent}% lost`
                  : `last seen ${durationWords(device.secondsSinceSeen)} ago`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="type-caption mt-3 text-muted">
        Strength is each device&apos;s own round trip to the server, measured every 5 seconds: what decides whether a tap reaches the till. A browser cannot read the WiFi signal itself.
      </p>
    </Card>
  );
}

function CloudCopy({ data }) {
  const line = serverLine(data, { manager: true });
  const sync = data.sync;
  if (data.role !== 'BOX') return null;
  return (
    <Card title="Cloud copy and backup" aside={line ? <StateChip state={line.state} word={line.word} size="sm" /> : null}>
      {sync?.state === 'LOCAL_ONLY' && <p className="type-body">Nothing is sent to the cloud from this server: MIRROR_URL is not set. Everything is kept here, and in the local snapshots.</p>}
      {sync && sync.state !== 'LOCAL_ONLY' && (
        <dl className="grid grid-cols-2 gap-3 min-[600px]:grid-cols-4">
          <div>
            <dt className="type-caption text-muted">Waiting to upload</dt>
            <dd className="type-body font-mono">{sync.entriesWaiting}</dd>
          </div>
          <div>
            <dt className="type-caption text-muted">Cloud has everything up to</dt>
            <dd className="type-body">{sync.syncedThrough ? formatTimeIst(sync.syncedThrough) : '—'}</dd>
          </div>
          <div>
            <dt className="type-caption text-muted">Last check of the copy</dt>
            <dd className="type-body">{sync.reconcile?.checkedAt ? `${sync.reconcile.status === 'MATCH' ? 'Same' : sync.reconcile.status === 'MISMATCH' ? 'Differs' : 'Waiting'} at ${formatTimeIst(sync.reconcile.checkedAt)}` : 'Not yet'}</dd>
          </div>
          <div>
            <dt className="type-caption text-muted">Last problem</dt>
            <dd className="type-caption">{sync.lastError ?? 'None'}</dd>
          </div>
        </dl>
      )}
      {line?.detail && <p className="type-caption mt-3 text-muted">{line.detail}</p>}
    </Card>
  );
}

function ThisDevice() {
  const [name, setName] = useState(deviceIdentity().name);
  const [saved, setSaved] = useState(false);
  return (
    <Card title="This device's name">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Input label="Shown in the device list" value={name} maxLength={40} placeholder="Counter till, Captain tab 2…" onChange={(event) => { setName(event.target.value); setSaved(false); }} />
        </div>
        <Button variant="secondary" onClick={() => { setDeviceName(name); setSaved(true); }}>
          {saved ? 'Saved' : 'Save name'}
        </Button>
      </div>
    </Card>
  );
}
