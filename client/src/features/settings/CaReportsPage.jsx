import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import Button from '../../components/ui/Button.jsx';
import ErrorState from '../../components/ui/ErrorState.jsx';
import { BackIcon } from '../../components/ui/icons/index.jsx';
import Input from '../../components/ui/Input.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { downloadCaTallyXml, downloadCaWorkbook, getCaSends, sendCaPack } from '../../api/caReports.js';
import { changedSettings, getSettings, updateSettings } from '../../api/settings.js';
import { businessDateToday } from '../../utils/formatDate.js';
import { CaSendHistory, monthWords } from './CaSendHistory.jsx';
import { Checkbox } from './settingsParts.jsx';
import { errorMessage } from './errorCopy.js';

/**
 * CA reports. P65, API-CONTRACT P65, GLOSSARY section 49. Owner only: the
 * server's settings and report rules refuse anyone else, and the screen is
 * gated the same way.
 *
 * The CA's details, what goes and when, the last twelve months sent, Send now
 * for any month, and the month's workbook and Tally file to download. A month
 * that was not sent says why in words.
 */

/** The month before today's business date, "2026-10". */
function lastMonth() {
  const [year, month] = businessDateToday().split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

async function save(fetcher) {
  const { blob, fileName } = await fetcher();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

const EMPTY = { enabled: false, name: '', email: '', whatsapp: '' };
const asForm = (ca) => ({ enabled: Boolean(ca?.enabled), name: ca?.name ?? '', email: ca?.email ?? '', whatsapp: ca?.whatsapp ?? '' });
const asSetting = (form) => ({
  enabled: form.enabled,
  name: form.name.trim() || null,
  email: form.email.trim().toLowerCase() || null,
  whatsapp: form.whatsapp.trim() || null,
});

export default function CaReportsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const sends = useQuery({ queryKey: ['ca-sends'], queryFn: getCaSends });
  const [form, setForm] = useState(EMPTY);
  const [reason, setReason] = useState('');
  const [month, setMonth] = useState(lastMonth);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (settings.data) setForm(asForm(settings.data.reports.ca));
  }, [settings.data]);

  const saveDetails = useMutation({
    mutationFn: (patch) => updateSettings({ reason: reason.trim(), ...patch }),
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      queryClient.invalidateQueries({ queryKey: ['ca-sends'] });
      setReason('');
      setToast({ tone: 'success', message: "The CA's details are saved." });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  if (settings.isError) {
    return (
      <main className="min-h-full bg-ground p-6">
        <ErrorState error={errorMessage(settings.error)} onRetry={() => settings.refetch()} />
      </main>
    );
  }
  if (!settings.data) {
    return (
      <main className="min-h-full bg-ground p-6">
        <Spinner label="Loading CA reports" />
      </main>
    );
  }

  const patch = changedSettings({ reports: { ca: settings.data.reports.ca } }, { reports: { ca: asSetting(form) } });
  const changed = Object.keys(patch).length > 0;
  const emailMissing = form.enabled && !form.email.trim();
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const run = async (label, action, success) => {
    setBusy(label);
    try {
      await action();
      if (success) setToast({ tone: 'success', message: success });
    } catch (error) {
      setToast({ tone: 'error', message: errorMessage(error) });
    } finally {
      setBusy(null);
      queryClient.invalidateQueries({ queryKey: ['ca-sends'] });
    }
  };

  return (
    <main className="min-h-full bg-ground px-4 py-4 text-ink sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex items-center gap-3">
          <Link to="/settings" aria-label="Settings" className="flex size-12 items-center justify-center rounded-lg border border-line bg-surface hover:bg-sunken">
            <BackIcon />
          </Link>
          <div>
            <h1 className="type-title">CA reports</h1>
            <p className="type-caption text-muted">The month&apos;s figures for your chartered accountant, sent by email on the 1st.</p>
          </div>
        </header>

        <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
          <h2 className="type-heading">What goes, and when</h2>
          <p className="type-body">
            On the 1st of every month, once every day of the last month is closed, your CA is emailed one workbook: sales by tax rate, the HSN and
            SAC summary, every invoice number, money received, On Hold accounts, cash and expenses, and the checks. With Tally connected, the
            month&apos;s Tally file goes with it.
          </p>
          <p className="type-caption text-muted">
            A month with a day still open is not sent, and is tried again later: half a month would be worse than none. The pack has no
            purchases, no B2B sales, no credit notes and no guest&apos;s details, and its cover says so.
          </p>
        </section>

        <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
          <h2 className="type-heading">Your CA</h2>
          <Input label="CA name" value={form.name} maxLength={80} onChange={set('name')} />
          <Input label="CA's email" type="email" value={form.email} onChange={set('email')} error={emailMissing ? 'Add the email: the pack goes by email.' : undefined} />
          <Input label="CA's WhatsApp number" inputMode="tel" value={form.whatsapp} maxLength={14} onChange={set('whatsapp')} hint="Kept for later. Nothing is sent on WhatsApp yet." />
          <Checkbox label="Send the pack on the 1st of every month" checked={form.enabled} onChange={(value) => setForm((current) => ({ ...current, enabled: value }))} />
          <Input label="Why are you changing this?" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="Recorded with the change, without the CA's details" />
          <div className="flex justify-end">
            <Button disabled={!changed || !reason.trim() || emailMissing || saveDetails.isPending} isLoading={saveDetails.isPending} onClick={() => saveDetails.mutate(patch)}>
              Save
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
          <h2 className="type-heading">A month</h2>
          <label className="flex flex-col gap-1">
            <span className="type-label">Month</span>
            <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className="type-body min-h-12 w-fit rounded-lg border border-line bg-surface px-3" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!month || !settings.data.reports.ca.email || busy !== null}
              isLoading={busy === 'send'}
              onClick={() => run('send', () => sendCaPack(month), `The pack for ${monthWords(month)} is sent.`)}
            >
              Send now
            </Button>
            <Button variant="secondary" disabled={!month || busy !== null} isLoading={busy === 'workbook'} onClick={() => run('workbook', () => save(() => downloadCaWorkbook(month)))}>
              Download workbook
            </Button>
            <Button variant="secondary" disabled={!month || busy !== null} isLoading={busy === 'xml'} onClick={() => run('xml', () => save(() => downloadCaTallyXml(month)))}>
              Download Tally file
            </Button>
          </div>
          {!settings.data.reports.ca.email && <p className="type-caption text-muted">Save the CA&apos;s email to send.</p>}
        </section>

        <CaSendHistory sends={sends} />
      </div>

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}
