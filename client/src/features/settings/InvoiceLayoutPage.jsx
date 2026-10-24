import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import Button from '../../components/ui/Button.jsx';
import ErrorState from '../../components/ui/ErrorState.jsx';
import { BackIcon } from '../../components/ui/icons/index.jsx';
import Input from '../../components/ui/Input.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { getInvoice, listBills } from '../../api/bills.js';
import { changedSettings, getRestaurant, getSettings, updateRestaurant, updateSettings } from '../../api/settings.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { businessDateBefore, businessDateToday } from '../../utils/formatDate.js';
import { THEME_SUGGESTIONS } from '../printing/themes/index.js';
import { InvoiceTab } from './InvoiceLayoutParts.jsx';
import { Preview, PrintTab } from './InvoiceLayoutPreview.jsx';
import { Checkbox } from './settingsParts.jsx';
import { errorMessage } from './errorCopy.js';

/**
 * Invoice layout. P64, API-CONTRACT P64 6, GLOSSARY section 48. Owner only:
 * the server's settings rule refuses anyone else, and this screen is gated the
 * same way.
 *
 * Three tabs, following the three things being set up: the full-page invoice
 * (its theme and what it shows), the paper a printer previews it on and the
 * copy, and the thermal roll. Each previews the most recent real bill, drawn
 * by the same functions the printer gets, with the choices on screen and
 * nothing saved. Saving goes through PATCH /settings with a reason; the PAN and
 * the Udyam number are the restaurant's own details, through PATCH /restaurant.
 * The paper and the edge margin of a printer stay on This device.
 */

const TABS = [
  { id: 'invoice', label: 'Invoice settings' },
  { id: 'print', label: 'Print settings' },
  { id: 'thermal', label: 'Thermal settings' },
];


const THERMAL_LABELS = [
  ['time', 'Time issued'],
  ['orderType', 'Order type'],
  ['table', 'Table'],
  ['cashier', 'Cashier'],
  ['covers', 'Covers'],
  ['customerName', 'Guest name'],
  ['customerMobileMasked', 'Guest mobile, last four digits only'],
  ['itemNote', 'Note on each dish'],
  ['paymentBreakdown', 'Paid with'],
  ['onHoldOutstanding', 'Account balance on an On Hold bill'],
  ['amountInWords', 'Amount in words'],
  ['reviewQr', 'Review link QR code'],
];

const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;
const UDYAM = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
const SAC = /^\d{4,8}$/;

export default function InvoiceLayoutPage() {
  const queryClient = useQueryClient();
  const { features } = useAuth();
  const { brand } = useTheme();
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const restaurantQuery = useQuery({ queryKey: ['restaurant'], queryFn: getRestaurant });
  const today = businessDateToday();
  const latest = useQuery({
    queryKey: ['bills', 'latest-for-preview', today],
    queryFn: () => listBills({ from: businessDateBefore(today, 60), to: today, limit: 1 }),
  });
  const billId = latest.data?.data?.[0]?.id ?? null;
  const invoice = useQuery({ queryKey: ['invoice', billId], queryFn: () => getInvoice(billId), enabled: Boolean(billId) });

  const [tab, setTab] = useState('invoice');
  const [form, setForm] = useState(null);
  const [details, setDetails] = useState(null);
  const [reason, setReason] = useState('');
  const [paper, setPaper] = useState('A4');
  const [copy, setCopy] = useState('RECIPIENT');
  const [toast, setToast] = useState(null);

  const original = settingsQuery.data ?? null;
  useEffect(() => {
    if (!original) return;
    setForm({
      invoiceLayout: structuredClone(original.invoiceLayout),
      receipt: { termsText: original.receipt.termsText ?? '' },
      invoice: { defaultSacCode: original.invoice.defaultSacCode },
    });
  }, [original]);
  useEffect(() => {
    if (!restaurantQuery.data) return;
    setDetails({ panNumber: restaurantQuery.data.panNumber ?? '', msmeNumber: restaurantQuery.data.msmeNumber ?? '' });
  }, [restaurantQuery.data]);

  const save = useMutation({
    mutationFn: async ({ patch, restaurantPatch }) => {
      let saved = original;
      if (Object.keys(patch).length > 0) saved = await updateSettings({ reason: reason.trim(), ...patch });
      if (Object.keys(restaurantPatch).length > 0) {
        const restaurant = await updateRestaurant(restaurantPatch);
        queryClient.setQueryData(['restaurant'], restaurant);
      }
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      setReason('');
      setToast({ tone: 'success', message: 'Invoice layout saved. The next print uses it.' });
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  if (settingsQuery.isError || restaurantQuery.isError) {
    return (
      <main className="min-h-full bg-ground p-6">
        <ErrorState error={errorMessage(settingsQuery.error ?? restaurantQuery.error)} onRetry={() => { settingsQuery.refetch(); restaurantQuery.refetch(); }} />
      </main>
    );
  }
  if (!form || !details) {
    return (
      <main className="min-h-full bg-ground p-6">
        <Spinner label="Loading the invoice layout" />
      </main>
    );
  }

  const layout = form.invoiceLayout;
  const setLayout = (change) => setForm((current) => ({ ...current, invoiceLayout: { ...current.invoiceLayout, ...change } }));
  const setSwitch = (group, key, value) => setLayout({ [group]: { ...layout[group], [key]: value } });
  const chooseTheme = (id) => setLayout({ theme: id, show: { ...layout.show, ...THEME_SUGGESTIONS[id] } });

  const current = {
    invoiceLayout: layout,
    receipt: { termsText: form.receipt.termsText.trim() === '' ? null : form.receipt.termsText.trim() },
    invoice: { defaultSacCode: form.invoice.defaultSacCode.trim() },
  };
  const before = {
    invoiceLayout: original.invoiceLayout,
    receipt: { termsText: original.receipt.termsText ?? null },
    invoice: { defaultSacCode: original.invoice.defaultSacCode },
  };
  const patch = {};
  for (const group of ['invoiceLayout', 'receipt']) Object.assign(patch, changedSettings({ [group]: before[group] }, { [group]: current[group] }));
  if (current.invoice.defaultSacCode !== before.invoice.defaultSacCode) patch.invoice = { defaultSacCode: current.invoice.defaultSacCode };

  const pan = details.panNumber.trim().toUpperCase();
  const udyam = details.msmeNumber.trim().toUpperCase();
  const restaurantPatch = {};
  if ((pan || null) !== (restaurantQuery.data.panNumber ?? null)) restaurantPatch.panNumber = pan || null;
  if ((udyam || null) !== (restaurantQuery.data.msmeNumber ?? null)) restaurantPatch.msmeNumber = udyam || null;

  const problems = {
    sac: SAC.test(current.invoice.defaultSacCode) ? null : 'A SAC code is 4 to 8 digits.',
    pan: !pan || PAN.test(pan) ? null : 'A PAN is 5 letters, 4 digits and a letter, like AAAPZ1234C.',
    udyam: !udyam || UDYAM.test(udyam) ? null : 'An Udyam number looks like UDYAM-GJ-01-0012345.',
  };
  const changedCount = Object.values(patch).reduce((count, group) => count + Object.keys(group).length, 0) + Object.keys(restaurantPatch).length;
  const settingsNeedReason = Object.keys(patch).length > 0;
  const canSave = changedCount > 0 && (!settingsNeedReason || reason.trim()) && !Object.values(problems).some(Boolean) && !save.isPending;

  return (
    <main className="min-h-full bg-ground px-4 py-4 text-ink sm:px-6">
      <div className="mx-auto flex max-w-[1300px] flex-col gap-6">
        <header className="flex items-center gap-3">
          <Link to="/settings" aria-label="Settings" className="flex size-12 items-center justify-center rounded-lg border border-line bg-surface hover:bg-sunken">
            <BackIcon />
          </Link>
          <div>
            <h1 className="type-title">Invoice layout</h1>
            <p className="type-caption text-muted">What a printed bill looks like and what it shows. Every figure stays the same whatever you choose.</p>
          </div>
        </header>

        <div role="tablist" aria-label="Invoice layout" className="flex flex-wrap gap-1 rounded-lg bg-sunken p-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={['type-label min-h-12 flex-1 rounded-lg px-4', tab === entry.id ? 'border border-line bg-surface' : 'text-muted'].join(' ')}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[1fr_minmax(0,560px)]">
          <div className="flex flex-col gap-6">
            {tab === 'invoice' && (
              <InvoiceTab
                layout={layout}
                chooseTheme={chooseTheme}
                setLayout={setLayout}
                setSwitch={setSwitch}
                form={form}
                setForm={setForm}
                details={details}
                setDetails={setDetails}
                problems={problems}
                accent={features.appearance?.accent ?? null}
                onToast={setToast}
              />
            )}
            {tab === 'print' && <PrintTab paper={paper} setPaper={setPaper} copy={copy} setCopy={setCopy} copyMarking={layout.show.copyMarking} />}
            {tab === 'thermal' && (
              <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
                <h2 className="type-heading">What the roll shows</h2>
                <p className="type-caption text-muted">
                  The thermal bill keeps the layout your guests know. The GSTIN, the FSSAI number and the captain follow Settings, Receipt.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {THERMAL_LABELS.map(([key, label]) => (
                    <Checkbox key={key} label={label} checked={Boolean(layout.thermalShow[key])} onChange={(value) => setSwitch('thermalShow', key, value)} />
                  ))}
                </div>
              </section>
            )}

            <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
              <Input
                label="Why are you changing this?"
                value={reason}
                maxLength={200}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Recorded against every change you just made"
                error={settingsNeedReason && !reason.trim() ? 'A reason is required before this can be saved.' : undefined}
              />
              <div className="flex items-center justify-between gap-3">
                <p className="type-caption text-muted">
                  {changedCount === 0 ? 'Saved as shown.' : `${changedCount} ${changedCount === 1 ? 'change' : 'changes'} to save.`}
                </p>
                <Button disabled={!canSave} isLoading={save.isPending} onClick={() => save.mutate({ patch, restaurantPatch })}>
                  Save invoice layout
                </Button>
              </div>
            </section>
          </div>

          <Preview
            tab={tab}
            invoice={invoice}
            latest={latest}
            layout={layout}
            terms={current.receipt.termsText}
            pan={PAN.test(pan) ? pan : null}
            udyam={UDYAM.test(udyam) ? udyam : null}
            accent={layout.useBrandAccent ? features.appearance?.accent ?? null : null}
            paper={paper}
            copy={copy}
            logoDataUrl={brand.logos?.LIGHT_GROUND?.dataUrl ?? null}
          />
        </div>
      </div>

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

