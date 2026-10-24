import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import { removeLogo, uploadLogo } from '../../api/brand.js';
import { THEMES } from '../printing/themes/index.js';
import { Checkbox } from './settingsParts.jsx';
import { errorMessage } from './errorCopy.js';
import { checkLogoFile } from './logoFile.js';

/**
 * The Invoice settings tab of the Invoice layout page. P64, GLOSSARY section
 * 48: the theme, what the full page shows, the default SAC, the PAN, the
 * Udyam number, the terms, and the signature image.
 */

const THEME_WORDS = {
  CLASSIC: 'The invoice as it has always printed.',
  GST_DETAILED: 'HSN/SAC, a rate summary, the amount in words, the declaration and a signature line. What a CA asks for.',
  MODERN: 'Classic with a band in your accent colour and lighter rules.',
  COMPACT: 'Tighter, for A5 paper. The same content.',
};

/** The switches, by what they print, in the order the invoice prints them. */
const SHOW_LABELS = [
  ['time', 'Time issued', 'Off prints the invoice date alone.'],
  ['orderType', 'Order type'],
  ['table', 'Table'],
  ['captain', 'Captain', 'Prints only while Settings, Receipt shows the captain.'],
  ['covers', 'Covers'],
  ['cashier', 'Cashier'],
  ['customerName', 'Guest name'],
  ['customerMobileMasked', 'Guest mobile, last four digits only'],
  ['hsn', 'HSN/SAC column'],
  ['itemNote', 'Note on each dish'],
  ['paymentBreakdown', 'Paid with'],
  ['onHoldOutstanding', 'Account balance on an On Hold bill'],
  ['amountInWords', 'Amount in words'],
  ['pan', 'PAN'],
  ['msme', 'Udyam number'],
  ['terms', 'Terms and conditions'],
  ['declaration', 'Declaration'],
  ['signatureLine', 'Authorised signatory, with the signature image'],
  ['copyMarking', 'Original for recipient, or Duplicate for supplier'],
  ['reviewQr', 'Review link QR code'],
];

export function InvoiceTab({ layout, chooseTheme, setLayout, setSwitch, form, setForm, details, setDetails, problems, accent, onToast }) {
  return (
    <>
      <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
        <h2 className="type-heading">Invoice theme</h2>
        <p className="type-caption text-muted">For A4 and A5. Picking a theme turns on what it usually shows; change anything below before saving.</p>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Invoice theme">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={layout.theme === theme.id}
              onClick={() => chooseTheme(theme.id)}
              className={['flex min-h-20 flex-col gap-1 rounded-lg border p-3 text-left', layout.theme === theme.id ? 'border-2 border-ink bg-sunken' : 'border-line hover:bg-sunken'].join(' ')}
            >
              <span className="type-label">{theme.title}</span>
              <span className="type-caption text-muted">{THEME_WORDS[theme.id]}</span>
            </button>
          ))}
        </div>
        <Checkbox
          label="Use the accent colour"
          hint={accent ? 'The accent chosen on Appearance, on the Modern theme’s band and rules.' : 'Choose an accent on Appearance first.'}
          checked={layout.useBrandAccent}
          onChange={(value) => setLayout({ useBrandAccent: value })}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
        <h2 className="type-heading">What the invoice shows</h2>
        <p className="type-caption text-muted">
          The name, address and GSTIN, TAX INVOICE, the number and date, each line, the tax by rate and the bill total always print: a tax invoice needs them.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SHOW_LABELS.map(([key, label, hint]) => (
            <Checkbox key={key} label={label} hint={hint} checked={Boolean(layout.show[key])} onChange={(value) => setSwitch('show', key, value)} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
        <h2 className="type-heading">On the invoice</h2>
        <Input
          label="Default SAC code"
          hint="Printed for any dish with no HSN or SAC code of its own. 996331 is restaurant service. Changes only dishes ordered from now."
          value={form.invoice.defaultSacCode}
          maxLength={8}
          inputMode="numeric"
          error={problems.sac ?? undefined}
          onChange={(event) => setForm((current) => ({ ...current, invoice: { defaultSacCode: event.target.value } }))}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="PAN" value={details.panNumber} maxLength={10} error={problems.pan ?? undefined} onChange={(event) => setDetails((current) => ({ ...current, panNumber: event.target.value }))} />
          <Input
            label="Udyam number"
            value={details.msmeNumber}
            maxLength={19}
            placeholder="UDYAM-GJ-01-0012345"
            error={problems.udyam ?? undefined}
            onChange={(event) => setDetails((current) => ({ ...current, msmeNumber: event.target.value }))}
          />
        </div>
        <label className="flex flex-col gap-1">
          <span className="type-label">Terms and conditions</span>
          <textarea
            value={form.receipt.termsText}
            maxLength={600}
            rows={4}
            onChange={(event) => setForm((current) => ({ ...current, receipt: { termsText: event.target.value } }))}
            className="type-body rounded-lg border border-line bg-surface p-3"
          />
          <span className="type-caption text-muted">{form.receipt.termsText.length} of 600 characters.</span>
        </label>
      </section>

      <SignatureSection onToast={onToast} />
    </>
  );
}

/** The signature image: the logo slot rules, through the logo endpoints with the slot SIGNATURE. */
function SignatureSection({ onToast }) {
  const queryClient = useQueryClient();
  const input = useRef(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  const run = async (action, message) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['invoice'] });
      onToast({ tone: 'success', message });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const checked = await checkLogoFile(file);
    if (!checked.ok) return setProblem(checked.message);
    return run(() => uploadLogo('SIGNATURE', { image: checked.image, reason: reason.trim() }), 'Signature saved.');
  };

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <h2 className="type-heading">Signature image</h2>
      <p className="type-caption text-muted">
        Printed above the signature line when Authorised signatory is on. PNG, WebP or JPEG, at most 200 KB and 1024 pixels, at least 128. Not SVG.
        The preview shows the one saved now.
      </p>
      <Input label="Why are you changing the signature?" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
      {problem && (
        <p role="alert" className="type-body rounded-lg border border-line border-l-[3px] border-l-alert p-3">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input ref={input} type="file" accept="image/png,image/webp,image/jpeg" className="hidden" onChange={choose} />
        <Button variant="secondary" disabled={busy || !reason.trim()} isLoading={busy} onClick={() => input.current?.click()}>
          Upload
        </Button>
        <Button variant="secondary" disabled={busy || !reason.trim()} onClick={() => run(() => removeLogo('SIGNATURE', reason.trim()), 'Signature removed.')}>
          Remove
        </Button>
      </div>
    </section>
  );
}

