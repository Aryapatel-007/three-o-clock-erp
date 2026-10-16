import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { listPaymentMethods } from '../../api/paymentMethods.js';
import { changedSettings, getSettings, updateSettings } from '../../api/settings.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { businessDateToday } from '../../utils/formatDate.js';
import { errorMessage } from './errorCopy.js';
import PaymentMethodsSection from './PaymentMethodsSection.jsx';
import ServerCard from './ServerCard.jsx';
import OnlineSettingsSection from './OnlineSettingsSection.jsx';
import ExpenseCategoriesEditor, { RupeesInput } from './ExpenseCategoriesEditor.jsx';
import { Checkbox, Section } from './settingsParts.jsx';
import { clockToMinutes, minutesToClock } from './timeOfDay.js';

/**
 * A section of the form. One per group in the contract.
 */
/** Said next to the two settings that are stored and not yet read by anything. */
function NotYetWired() {
  return (
    <p className="type-caption text-muted">
      Saved now, and takes effect once billing is updated to read it.
    </p>
  );
}

/** "2026-27" for a "YYYY-MM-DD" date, the Indian financial year, 1 April to 31 March. */
function financialYearOf(isoDate) {
  const [year, month] = isoDate.split('-').map(Number);
  const start = month < 4 ? year - 1 : year;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * How the next bill will print under what is on screen.
 *
 * Exact for a new prefix series, whose first bill is the starting number. For a
 * series already running, or financial-year numbering, the next number depends
 * on how many bills have been issued, so the line says how the number is built.
 */
function invoicePreview(form, original) {
  const { mode, prefix, startingNumber } = form.invoice;

  if (mode === 'FINANCIAL_YEAR') {
    const year = financialYearOf(businessDateToday());
    return `Bills print like ${year}/000148: the financial year, then a number that starts again at 000001 every 1 April.`;
  }

  if (!prefix || !Number.isInteger(startingNumber)) {
    return 'Enter a prefix and a starting number to see how the next bill will print.';
  }

  const saved = original.invoice;
  const unchanged =
    saved.mode === 'PREFIX' && saved.prefix === prefix && saved.startingNumber === startingNumber;

  return unchanged
    ? `Bills continue the ${prefix} series, counting up from ${prefix}${startingNumber}. It never resets.`
    : `The next bill will print as ${prefix}${startingNumber}.`;
}

/**
 * The settings screen. Owner only, and the server is what enforces that.
 *
 * One section per group in the contract. The form loads the current
 * settings, keeps the loaded copy alongside the edited one, and sends only the
 * difference: an audit line per field is the point of this endpoint, and a
 * patch carrying fields nobody touched would fill the log with lines saying a
 * value was set to itself.
 *
 * A reason is required and the form will not submit without one. That is not a
 * client-side nicety; the server refuses the patch too, and both refuse for the
 * same reason. An owner changing the GST pricing mode with nothing recorded
 * about why is the exact gap the audit log exists to close.
 */
export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { refreshFeatures } = useAuth();
  const [form, setForm] = useState(null);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState(null);

  const query = useQuery({ queryKey: ['settings'], queryFn: getSettings });

  /**
   * The loaded copy is what the diff is taken against, so it is replaced only
   * when the server answers, never as the owner types.
   */
  const original = query.data ?? null;

  useEffect(() => {
    if (original) setForm(structuredClone(original));
  }, [original]);

  const save = useMutation({
    mutationFn: updateSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(['settings'], saved);
      setForm(structuredClone(saved));
      setReason('');
      setToast({ tone: 'success', message: 'Settings saved.' });
      // The feature switches decide which links show everywhere else.
      refreshFeatures().catch(() => {});
    },
    onError: (error) => setToast({ tone: 'error', message: errorMessage(error) }),
  });

  if (query.isLoading || !form) {
    return (
      <main className="min-h-full bg-ground p-6">
        <Spinner label="Loading settings" />
      </main>
    );
  }

  if (query.isError) {
    return (
      <main className="min-h-full bg-ground p-6">
        <p className="type-body text-alert">{errorMessage(query.error)}</p>
        <Button className="mt-4" onClick={() => query.refetch()}>
          Try again
        </Button>
      </main>
    );
  }

  const set = (group, field) => (value) =>
    setForm((current) => ({ ...current, [group]: { ...current[group], [field]: value } }));

  const patch = changedSettings(original, form);
  const changedCount = Object.values(patch).reduce(
    (total, group) => total + Object.keys(group).length,
    0,
  );
  const canSave = changedCount > 0 && reason.trim().length > 0 && !save.isPending;

  const submit = (event) => {
    event.preventDefault();
    if (!canSave) return;
    save.mutate({ reason: reason.trim(), ...patch });
  };

  return (
    <main className="min-h-full bg-ground">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto max-w-2xl">
          <h1 className="type-heading">Settings</h1>
          <p className="type-caption text-muted">
            How this restaurant is configured. Every change is recorded with who made it and why.
          </p>
        </div>
      </header>

      {/* Bottom padding clears the fixed save bar, which grows by the invoice
          warning when the series is being changed, so the last section's
          preview line is never hidden under it. */}
      <form onSubmit={submit} className="mx-auto grid max-w-2xl gap-6 px-4 py-6 pb-64">
        <Section title="Appearance" description="The accent colour, the name in the top bar, the second language and the Today tiles, with a live preview.">
          <Link to="/settings/appearance" className="type-button flex min-h-12 w-fit items-center rounded-lg border border-ink bg-surface px-4 hover:bg-sunken">
            Open Appearance
          </Link>
        </Section>

        {/* P30. The free server's starts, the owner's to read; this page is the owner's alone. */}
        <ServerCard />

        <Section title="Integrations" description="Delivery platforms, the card machine and Tally: connections, item mapping, exports and alerts.">
          <Link to="/settings/integrations" className="type-button flex min-h-12 w-fit items-center rounded-lg border border-ink bg-surface px-4 hover:bg-sunken">
            Open Integrations
          </Link>
        </Section>

        <Section
          title="Business day"
          description="When one day's takings stop and the next day's start. A restaurant that serves past midnight counts those sales under the day service began."
        >
          <Input
            label="The business day starts at"
            type="time"
            value={minutesToClock(form.business.businessDayStartsAtMinutes)}
            onChange={(event) => {
              const minutes = clockToMinutes(event.target.value);
              // A half-typed time is ignored rather than sent as a wrong number.
              if (minutes !== null) set('business', 'businessDayStartsAtMinutes')(minutes);
            }}
            hint="India time. Changing this moves which day future sales and shifts are counted under."
          />
        </Section>

        <Section title="Tax">
          <Select
            label="Menu prices are"
            value={form.tax.pricingMode}
            onChange={(event) => set('tax', 'pricingMode')(event.target.value)}
            options={[
              { value: 'EXCLUSIVE', label: 'Before GST (GST added at billing)' },
              { value: 'INCLUSIVE', label: 'After GST (GST already in the price)' },
            ]}
          />
          <NotYetWired />

          <Input
            label="Default GST rate on a new dish (%)"
            type="number"
            step="0.01"
            min="0"
            max="100"
            value={form.tax.defaultTaxRateBps / 100}
            onChange={(event) => {
              const percent = Number(event.target.value);
              if (!Number.isFinite(percent)) return;
              // Basis points on the wire. 5% is 500, and the rounding keeps a
              // typed 5.005 from becoming a fraction of a basis point.
              set('tax', 'defaultTaxRateBps')(Math.round(percent * 100));
            }}
            hint="Filled in when a new dish is added without its own rate. Dishes that already exist keep the rate they were created with."
          />

          <Checkbox
            label="Round the bill total to the nearest rupee"
            checked={form.tax.roundOffEnabled}
            onChange={set('tax', 'roundOffEnabled')}
          />
          <NotYetWired />
        </Section>

        <Section
          title="Receipt"
          description="Printed on every bill: thermal receipts and full-page invoices alike."
        >
          <Input
            label="Header line 1"
            maxLength={40}
            value={form.receipt.headerLine1 ?? ''}
            onChange={(event) => set('receipt', 'headerLine1')(event.target.value)}
            hint="Up to 40 characters. A longer line wraps on a thermal roll and breaks the layout."
          />
          <Input
            label="Header line 2"
            maxLength={40}
            value={form.receipt.headerLine2 ?? ''}
            onChange={(event) => set('receipt', 'headerLine2')(event.target.value)}
          />
          <Input
            label="Footer"
            maxLength={200}
            value={form.receipt.footerText ?? ''}
            onChange={(event) => set('receipt', 'footerText')(event.target.value)}
            hint="Up to 200 characters."
          />
          <Input
            label="Review link"
            type="url"
            inputMode="url"
            maxLength={300}
            placeholder="https://"
            value={form.receipt.reviewLinkUrl ?? ''}
            onChange={(event) => set('receipt', 'reviewLinkUrl')(event.target.value)}
            hint="An https address. Every bill ends with its QR code and the words Scan to review us. Leave empty for no code."
          />

          <Checkbox
            label="Print the GSTIN"
            checked={form.receipt.showGstin}
            onChange={set('receipt', 'showGstin')}
          />
          <Checkbox
            label="Print the FSSAI licence number"
            checked={form.receipt.showFssai}
            onChange={set('receipt', 'showFssai')}
          />
          <Checkbox
            label="Print who took the order"
            checked={form.receipt.showServerName}
            onChange={set('receipt', 'showServerName')}
          />
        </Section>

        <Section title="Inventory">
          <Checkbox
            label="Show low stock alerts"
            hint="Switching this off hides the low-stock list and the dashboard panel. Stock levels are still tracked exactly as before."
            checked={form.inventory.lowStockAlertsEnabled}
            onChange={set('inventory', 'lowStockAlertsEnabled')}
          />
        </Section>

        <Section
          title="Payment methods"
          description="How a bill can be paid. Each method saves on its own. A code and its kind never change once created, because reports and the Tally export group by them."
        >
          <PaymentMethodsSection onToast={setToast} />
          {/* P47. The modes Other offers one tap each. Saved with the rest of the settings. */}
          {form.payments && <OtherModesField value={form.payments.otherModes ?? []} onChange={set('payments', 'otherModes')} />}
        </Section>

        <Section
          title="Discounts"
          description="Who may give a discount at the till. Owners and managers always can."
        >
          <Checkbox
            label="Cashiers may apply platform discounts"
            hint="Zomato Gold, Dineout and EazyDiner only. Every other discount stays with a manager."
            checked={form.discounts.cashierMayApplyPlatformDiscounts}
            onChange={set('discounts', 'cashierMayApplyPlatformDiscounts')}
          />
        </Section>

        {/* P28. What needs an owner's or manager's PIN on someone else's screen. */}
        {form.approvals && (
          <Section
            title="Approvals"
            description="When a cashier or captain needs an owner's or manager's PIN, typed on the same screen. Owners and managers never need one. Each person's PIN is set on the Staff screen."
          >
            <Checkbox
              label="Cancelling a dish the kitchen has made"
              hint="A cashier or captain removing a dish the kitchen marked ready, or one they say was already made. A dish sent but not made yet, or never sent, needs no PIN."
              checked={form.approvals.lineCancel}
              onChange={set('approvals', 'lineCancel')}
            />
            <Checkbox
              label="Cash paid in"
              hint="A cashier putting cash into the drawer that is not a sale."
              checked={form.approvals.paidIn}
              onChange={set('approvals', 'paidIn')}
            />
            <Checkbox
              label="Let a cashier void, cancel an order, give No Charge and pay out, with a PIN"
              hint="Off: only owners and managers can do these at all."
              checked={form.approvals.managerTasks}
              onChange={set('approvals', 'managerTasks')}
            />
            {/* P29 Part B, and P40 for adding. */}
            <Checkbox
              label="Removing or adding items on a bill already printed"
              hint="The guest has seen the printed bill, so only a manager may change it. Lowering it after the guest paid in cash is the commonest till fraud, and the cash count cannot catch it. Captains cannot change a printed bill at all."
              checked={form.approvals.revisePrintedBill}
              onChange={set('approvals', 'revisePrintedBill')}
            />
          </Section>
        )}

        {/* P29 Parts B and D. */}
        {form.billing && (
          <Section title="Bills" description="How a bill changes before it is paid, and what the bill screen asks first.">
            <Checkbox
              label="Change an unpaid bill instead of voiding it"
              hint="An item removed or added on a bill nothing is paid on keeps the same invoice number, and is shown as a revision. Off: the bill is voided and a new one made, as before."
              checked={form.billing.reviseUnpaidBills}
              onChange={set('billing', 'reviseUnpaidBills')}
            />
            <Checkbox
              label="Print the bill before taking payment"
              hint="The bill screen asks for the print first, then the payment. A payment can still be taken without printing, and is shown in the reports."
              checked={form.billing.printBeforePayment}
              onChange={set('billing', 'printBeforePayment')}
            />
          </Section>
        )}

        {/* P44. Who gets the day-end message by email. */}
        {form.reports && (
          <Section title="Day-end email" description="The day's figures, in the day-end message, are emailed here when a day is closed, and whenever someone taps Email this report on the Day End page.">
            <DayEndEmailsField value={form.reports.dayEndEmails ?? []} onChange={set('reports', 'dayEndEmails')} />
          </Section>
        )}

        {/* P29 Part C. */}
        {form.kitchen && (
          <Section title="Kitchen" description="What the kitchen's tick means.">
            <Checkbox
              label="Ready means served"
              hint="When the kitchen marks a dish ready, it is served: captains have no Mark served step. Off: a captain marks each dish served."
              checked={form.kitchen.readyMeansServed}
              onChange={set('kitchen', 'readyMeansServed')}
            />
            {/* P36. */}
            <Checkbox
              label="One kitchen ticket per table"
              hint="Every round and every station on one ticket, under one KOT number; each station still sees only its own dishes. Off: a ticket for each station every time the captain sends."
              checked={form.kitchen.oneTicketPerOrder ?? true}
              onChange={set('kitchen', 'oneTicketPerOrder')}
            />
          </Section>
        )}

        {/* P51. */}
        {form.assistant && (
          <Section
            title="Assistant"
            description="The automated assistant on your WhatsApp number. It needs WhatsApp and an AI key connected in Integrations."
          >
            <Checkbox
              label="Answer guests on WhatsApp"
              hint="Questions about the menu, hours and bookings, from your own data. Anything else goes to Chats for a person. Off: nothing is sent, and every message waits in Chats."
              checked={form.assistant.enabled}
              onChange={set('assistant', 'enabled')}
            />
            <Checkbox
              label="Take table bookings on WhatsApp"
              hint="A booking from WhatsApp waits for staff to confirm it, like one from your online page."
              checked={form.assistant.bookingsEnabled}
              onChange={set('assistant', 'bookingsEnabled')}
            />
            <Input
              label="How to greet a new chat"
              maxLength={300}
              value={form.assistant.greeting ?? ''}
              onChange={(event) => set('assistant', 'greeting')(event.target.value)}
              hint="Optional, up to 300 characters. Like: Welcome to Three O'Clock!"
            />
            <Input
              label="When a person replies"
              maxLength={120}
              value={form.assistant.handoffHours ?? ''}
              onChange={(event) => set('assistant', 'handoffHours')(event.target.value)}
              hint="Told to a guest handed to a person, like: between 11 am and 11 pm. Empty: as soon as they can."
            />
            <Input
              label="AI replies a day, at most"
              type="number"
              min="0"
              max="5000"
              value={form.assistant.dailyAiLimit}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value)) set('assistant', 'dailyAiLimit')(value);
              }}
              hint="After this many, guests get the three fixed buttons until tomorrow. It keeps a free AI key inside its limits."
            />
          </Section>
        )}

        {/* P29 Part F. */}
        <Section title="Cash book" description="The float kept for tomorrow, who sees the cash in the drawer, and what expenses are for.">
          <RupeesInput label="Usual float, kept in the drawer for tomorrow" paise={form.cash.usualFloatInPaise} onChange={set('cash', 'usualFloatInPaise')} />
          <Checkbox
            label="Show staff the cash in the drawer"
            hint="Leave this off for a blind count. The owner always sees it."
            checked={form.cash.showDrawerTotalToStaff}
            onChange={set('cash', 'showDrawerTotalToStaff')}
          />
          <h3 className="type-heading mt-2">Expense categories</h3>
          <ExpenseCategoriesEditor categories={form.cash.expenseCategories} onChange={set('cash', 'expenseCategories')} />
        </Section>

        <Section
          title="Day Close"
          description="By default a manager counts the drawer without seeing what it should hold, and only the owner sees the difference."
        >
          <Checkbox
            label="Show managers the expected cash and the difference"
            hint="Leave this off for a blind count, the usual protection against cash going missing."
            checked={form.dayClose.showCashDifferenceToManager}
            onChange={set('dayClose', 'showCashDifferenceToManager')}
          />
        </Section>

        <Section
          title="Kitchen stations"
          description="Which counter cooks which dishes. Managed on its own page, so a manager can change it too."
        >
          <Link to="/stations" className="type-body inline-flex min-h-12 items-center underline underline-offset-4">
            Open kitchen stations
          </Link>
        </Section>

        <Section
          title="Features"
          description="Switch off a part of the system this restaurant does not use. Its screens disappear and its data stays where it is."
        >
          <Checkbox
            label="Inventory"
            hint="When off, firing an order does not deduct stock. Switching it back on does not catch up, so do a stock count first."
            checked={form.features.inventory}
            onChange={set('features', 'inventory')}
          />
          <Checkbox
            label="Attendance"
            hint="When off, the clock, the register and the hours report are hidden. Past shifts are kept."
            checked={form.features.attendance}
            onChange={set('features', 'attendance')}
          />
        </Section>

        <OnlineSettingsSection form={form} set={set} />

        <Section
          title="Invoice numbers"
          description="How bill numbers are formed. Every bill keeps the number it was issued with."
        >
          <fieldset className="grid gap-2">
            <legend className="sr-only">Numbering</legend>
            {[
              { value: 'FINANCIAL_YEAR', label: 'Financial year, like 2026-27/000148' },
              { value: 'PREFIX', label: 'Prefix, like CFA/C/22442' },
            ].map((choice) => (
              <label key={choice.value} className="flex min-h-12 items-center gap-3">
                <input
                  type="radio"
                  name="invoice-mode"
                  value={choice.value}
                  checked={form.invoice.mode === choice.value}
                  onChange={() => set('invoice', 'mode')(choice.value)}
                  className="h-5 w-5 border border-line text-open focus:ring-2 focus:ring-accent"
                />
                <span className="type-body">{choice.label}</span>
              </label>
            ))}
          </fieldset>

          {form.invoice.mode === 'PREFIX' && (
            <>
              <Input
                label="Prefix"
                maxLength={7}
                value={form.invoice.prefix ?? ''}
                onChange={(event) => set('invoice', 'prefix')(event.target.value.trim())}
                hint="Up to 7 characters: letters, numbers, / and -."
              />
              <Input
                label="Starting number"
                type="number"
                inputMode="numeric"
                min="1"
                max="999999999"
                step="1"
                value={form.invoice.startingNumber ?? ''}
                onChange={(event) => {
                  const typed = event.target.value;
                  set('invoice', 'startingNumber')(typed === '' ? null : Number(typed));
                }}
                hint="The first number a new series issues. Up to 9 digits."
              />
            </>
          )}

          <p className="font-mono type-caption">{invoicePreview(form, original)}</p>
        </Section>

        {/*
          The reason sits with the save button rather than at the top, because
          it is part of committing the change, not part of describing it.
        */}
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-ground px-4 py-3">
          <div className="mx-auto grid max-w-2xl gap-3">
            {patch.invoice && (
              <p className="rounded-lg border-2 border-alert px-3 py-2 type-caption text-ink">
                Invoice numbers are a legal record. Change this only before the first bill of a new
                series, and only after your accountant agrees.
              </p>
            )}
            <Input
              label="Why are you changing this?"
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Recorded against every change you just made"
              error={
                changedCount > 0 && reason.trim().length === 0
                  ? 'A reason is required before this can be saved.'
                  : undefined
              }
            />

            <div className="flex items-center justify-between gap-3">
              <p className="type-caption text-muted">
                {changedCount === 0
                  ? 'No changes yet.'
                  : `${changedCount} ${changedCount === 1 ? 'change' : 'changes'} to save.`}
              </p>
              <Button type="submit" disabled={!canSave} isLoading={save.isPending}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      </form>

      <Toast
        tone={toast?.tone}
        message={toast?.message}
        onDismiss={() => setToast(null)}
      />
    </main>
  );
}

/**
 * P44. The day-end addresses, one per line. The text is kept as typed, so a
 * new line can be started; the list sent is the text split on spaces, commas
 * and lines. The server checks each address and lowercases it.
 */
function DayEndEmailsField({ value, onChange }) {
  const [text, setText] = useState(() => value.join('\n'));
  return (
    <label className="flex flex-col gap-1">
      <span className="type-label">Day-end email addresses</span>
      <textarea
        rows={3}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value.split(/[\s,]+/).map((address) => address.trim()).filter(Boolean));
        }}
        placeholder="One per line, at most 5"
        className="type-body rounded-lg border border-muted bg-surface px-3 py-2"
      />
      <span className="type-caption text-muted">Until a domain is verified in Resend, only the Resend account's own address receives it.</span>
    </label>
  );
}

/**
 * P47. The modes the payment screen offers one tap each under Other: remove
 * one with ×, add one with the box. Saved with Save settings, with its reason.
 * Whether Other itself is on is the payment method's own switch, above.
 */
function OtherModesField({ value, onChange }) {
  const [typed, setTyped] = useState('');
  const others = useQuery({ queryKey: ['payment-methods', 'all'], queryFn: () => listPaymentMethods({ includeInactive: true }) });
  const otherIsOn = (others.data ?? []).some((method) => method.code === 'OTHER' && method.isActive);
  const trimmed = typed.trim();
  const duplicate = value.some((mode) => mode.toLowerCase() === trimmed.toLowerCase());
  const add = () => {
    if (!trimmed || duplicate || value.length >= 12) return;
    onChange([...value, trimmed.slice(0, 40)]);
    setTyped('');
  };

  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="type-heading">Other modes</h3>
        <p className="type-caption text-muted">
          One tap each on the payment screen under Other, like Swiggy Dineout or EazyDiner. A mode not listed can still be typed there.
        </p>
        {others.isSuccess && !otherIsOn && (
          <p className="type-caption mt-1 text-alert">Other is switched off, so these are not shown. Switch Other on in the list above.</p>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {value.map((mode) => (
          <li key={mode} className="type-label flex min-h-12 items-center gap-1 rounded-lg border border-line bg-surface pl-3">
            {mode}
            <button
              type="button"
              aria-label={`Remove ${mode}`}
              onClick={() => onChange(value.filter((entry) => entry !== mode))}
              className="flex size-12 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
            >
              ×
            </button>
          </li>
        ))}
        {value.length === 0 && <li className="type-body text-muted">No modes yet. Add one below.</li>}
      </ul>
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="New mode"
          value={typed}
          maxLength={40}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder="e.g. Paytm"
          className="type-body min-h-12 flex-1 rounded-lg border border-muted bg-surface px-3"
        />
        <button
          type="button"
          disabled={!trimmed || duplicate || value.length >= 12}
          onClick={add}
          className="type-button min-h-12 rounded-lg border border-ink px-4 hover:bg-sunken disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {duplicate && trimmed && <p className="type-caption text-alert">That mode is already listed.</p>}
      {value.length >= 12 && <p className="type-caption text-muted">At most 12 modes.</p>}
      <p className="type-caption text-muted">Changes here are kept when you save the settings below, with a reason.</p>
    </div>
  );
}

