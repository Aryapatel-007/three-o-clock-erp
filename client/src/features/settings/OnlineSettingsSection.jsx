/**
 * Online orders and bookings, in Settings. P23 (M14), owner only.
 *
 * The switches, hours and limits save with the rest of Settings, with a
 * reason. The page address saves on its own, because it is unique across
 * every restaurant and can be refused for that alone.
 */
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { setPageAddress } from '../../api/online.js';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { copyText } from '../../utils/copyText.js';
import { parseRupeesToPaise } from '../../utils/formatMoney.js';
import { Checkbox, Section } from './settingsParts.jsx';
import PaymentGatewayPanel from './PaymentGatewayPanel.jsx';
import { clockToMinutes, minutesToClock } from './timeOfDay.js';

const ALERT_ROLES = [
  { role: 'OWNER', label: 'Owner' },
  { role: 'MANAGER', label: 'Manager' },
  { role: 'CASHIER', label: 'Cashier' },
  { role: 'WAITER', label: 'Captain' },
];

function NumberField({ label, hint, value, min, max, onChange }) {
  return (
    <Input
      label={label}
      hint={hint}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step="1"
      value={value ?? ''}
      onChange={(event) => {
        const typed = Number.parseInt(event.target.value, 10);
        if (Number.isInteger(typed)) onChange(typed);
      }}
    />
  );
}

/** Rupees typed as text, kept as typed, sent as whole paise once it parses. */
function RupeeField({ label, hint, paise, onChange }) {
  const [text, setText] = useState(String(paise / 100));
  return (
    <Input
      label={label}
      hint={hint}
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = parseRupeesToPaise(event.target.value || '0');
        if (parsed !== null) onChange(parsed);
      }}
    />
  );
}

function PageAddress() {
  const { features, refreshFeatures } = useAuth();
  const current = features.online?.publicSlug ?? '';
  const [slug, setSlug] = useState(current);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: () => setPageAddress(slug.trim() === '' ? null : slug.trim().toLowerCase()),
    onSuccess: () => refreshFeatures().catch(() => {}),
  });
  const link = current ? `${window.location.origin}/r/${current}` : null;

  const copy = async () => {
    try {
      await copyText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="grid gap-3 rounded-lg border border-line p-3">
      <Input
        label="Page address"
        hint="Lowercase letters, numbers and dashes. Guests open /r/ and this."
        value={slug}
        maxLength={40}
        onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        error={save.isError ? save.error.message : undefined}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" disabled={slug === current} isLoading={save.isPending} onClick={() => save.mutate()}>
          Save address
        </Button>
        {link && (
          <>
            <a href={link} target="_blank" rel="noreferrer" className="type-body break-all text-accent underline-offset-4 hover:underline">
              {link}
            </a>
            <Button type="button" variant="quiet" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </>
        )}
      </div>
      <p className="type-caption text-muted">
        Put this link on your Instagram, your Google listing and your table cards. Orders that come through it pay no commission.
      </p>
      {features.sync?.server && features.sync.server !== 'CLOUD' && (
        <p className="type-caption text-alert">
          This link is the cafe PC&apos;s, and opens only inside the cafe. Give guests the website&apos;s link, ending in /r/{current || 'your-address'}.
        </p>
      )}
    </div>
  );
}

export default function OnlineSettingsSection({ form, set }) {
  const online = form.online;
  const setOnline = (field) => set('online', field);
  const roles = online.alertRoles ?? [];
  const toggleRole = (role) => (checked) =>
    setOnline('alertRoles')(checked ? [...roles, role] : roles.filter((entry) => entry !== role));

  return (
    <Section
      title="Online orders and bookings"
      description="Your own page for takeaway and table bookings. Every request waits for someone at the till to accept it."
    >
      <Checkbox
        label="Online orders and bookings"
        hint="When off, the page shows nothing and the staff screens are hidden. Past requests are kept."
        checked={form.features.online}
        onChange={set('features', 'online')}
      />
      {form.features.online && (
        <>
          <PageAddress />
          <Checkbox label="Take takeaway orders" checked={online.takeawayEnabled} onChange={setOnline('takeawayEnabled')} />
          <Checkbox label="Take table bookings" checked={online.reservationsEnabled} onChange={setOnline('reservationsEnabled')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Opens at"
              type="time"
              value={minutesToClock(online.opensAtMinutes)}
              onChange={(event) => {
                const minutes = clockToMinutes(event.target.value);
                if (minutes !== null) setOnline('opensAtMinutes')(minutes);
              }}
              hint="India time"
            />
            <Input
              label="Closes at"
              type="time"
              value={minutesToClock(online.closesAtMinutes)}
              onChange={(event) => {
                const minutes = clockToMinutes(event.target.value);
                if (minutes !== null) setOnline('closesAtMinutes')(minutes);
              }}
              hint="Earlier than opening means after midnight"
            />
            <NumberField label="Earliest pickup, minutes from now" min={0} max={240} value={online.takeawayMinLeadMinutes} onChange={setOnline('takeawayMinLeadMinutes')} />
            <NumberField label="Answer within, minutes" hint="Unanswered after this, a request expires" min={3} max={60} value={online.takeawayAnswerWithinMinutes} onChange={setOnline('takeawayAnswerWithinMinutes')} />
            <NumberField label="Largest party" min={1} max={50} value={online.reservationMaxPartySize} onChange={setOnline('reservationMaxPartySize')} />
            <NumberField label="Bookings up to, days ahead" min={1} max={60} value={online.reservationDaysAhead} onChange={setOnline('reservationDaysAhead')} />
            <Select
              label="Booking times every"
              value={String(online.reservationSlotMinutes)}
              onChange={(event) => setOnline('reservationSlotMinutes')(Number(event.target.value))}
              options={[15, 30, 60].map((value) => ({ value: String(value), label: `${value} minutes` }))}
            />
            <NumberField label="A booking holds its table for, minutes" min={30} max={240} value={online.reservationHoldMinutes} onChange={setOnline('reservationHoldMinutes')} />
          </div>
          <Input
            label="Note on the page"
            maxLength={200}
            value={online.pageNote ?? ''}
            onChange={(event) => setOnline('pageNote')(event.target.value)}
          />
          <PaymentGatewayPanel />
          <Checkbox
            label="Takeaway is paid online, in full, before the cafe sees it"
            hint="Only while Razorpay is connected. Declined or unanswered orders are refunded automatically."
            checked={online.takeawayPrepay}
            onChange={setOnline('takeawayPrepay')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <RupeeField
              label="Booking deposit per person, ₹"
              hint="0 means no deposit. Taken off the bill on the day."
              paise={online.depositPerPersonInPaise ?? 0}
              onChange={setOnline('depositPerPersonInPaise')}
            />
            <NumberField
              label="Refund a cancelled booking up to, minutes before"
              hint="Cancelled later, or a no-show, keeps the deposit"
              min={0}
              max={2880}
              value={online.depositRefundCutoffMinutes}
              onChange={setOnline('depositRefundCutoffMinutes')}
            />
          </div>
          <fieldset className="grid gap-2">
            <legend className="type-label mb-1">Who hears the alert</legend>
            {ALERT_ROLES.map(({ role, label }) => (
              <Checkbox key={role} label={label} checked={roles.includes(role)} onChange={toggleRole(role)} />
            ))}
          </fieldset>
        </>
      )}
    </Section>
  );
}
