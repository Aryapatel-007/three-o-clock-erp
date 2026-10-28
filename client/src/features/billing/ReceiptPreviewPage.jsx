import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { getBill, getInvoice } from '../../api/bills.js';
import { useTheme } from '../../context/ThemeProvider.jsx';

import BillStatusBadge from './BillStatusBadge.jsx';
import { errorMessage } from './errorCopy.js';
import { LABELS } from '../i18n/labels.js';
import { invoiceHtml, invoiceStyles, THERMAL_BILL_STYLES, thermalBillHtml } from '../printing/invoiceHtml.js';
import { printBill, reviewQrSvg, signatureDataUrl, thermalLogoDataUrl } from '../printing/printBill.js';
import { COPY_WORDS } from '../printing/themes/shared.js';
import { billWidthMm, PRINTER_KEYS, PRINTERS, THERMAL_SIDE_MM } from '../printing/printers.js';
import { useDeviceSettings } from '../printing/useDeviceSettings.js';
import { placeLabel } from '../orders/orderLabel.js';
import Money, { moneyText } from '../../components/ui/Money.jsx';

/**
 * The receipt, exactly as it prints.
 *
 * On a thermal printer the slip is the thermal bill, drawn by the same
 * `thermalBillHtml` the printer gets, at the width the print head reaches. On
 * A4 or A5 it is the full-page tax invoice, drawn by the same `invoiceHtml`.
 * Both come from GET /bills/:billId/invoice (P25). Nothing on either is worked out here, so
 * the preview cannot disagree with the paper. Printing goes through the
 * browser like every other print in the product; the server never talks to a
 * printer.
 *
 * The printer is the device's setting (the "This device" page), so changing
 * it here changes it for every print from this device.
 */
export default function ReceiptPreviewPage() {
  const { billId } = useParams();
  const [device, updateDevice] = useDeviceSettings();
  const [toast, setToast] = useState(null);
  const [printing, setPrinting] = useState(false);
  // P64. Which copy a full-page invoice is: the guest's, or the restaurant's own.
  const [copy, setCopy] = useState('RECIPIENT');

  const { brand } = useTheme();
  const printer = device.printer;
  const thermal = PRINTERS[printer].thermal;
  const logoDataUrl = brand.logos?.LIGHT_GROUND?.dataUrl ?? null;

  const bill = useQuery({ queryKey: ['bill', billId], queryFn: () => getBill(billId) });
  const invoice = useQuery({ queryKey: ['invoice', billId], queryFn: () => getInvoice(billId) });
  const shown = invoice;
  const thermalLogo = useQuery({
    queryKey: ['thermal-logo', logoDataUrl],
    queryFn: () => thermalLogoDataUrl(logoDataUrl),
    enabled: thermal && Boolean(logoDataUrl),
  });
  const [slipHeight, setSlipHeight] = useState(600);
  const reviewLinkUrl = shown.data?.reviewLinkUrl ?? null;
  const qr = useQuery({ queryKey: ['review-qr', reviewLinkUrl], queryFn: () => reviewQrSvg(reviewLinkUrl), enabled: Boolean(reviewLinkUrl) });
  const signature = useQuery({
    queryKey: ['signature', shown.data?.signature?.hash ?? null, shown.data?.layout?.show?.signatureLine ?? false],
    queryFn: () => signatureDataUrl(shown.data),
    enabled: !thermal && Boolean(shown.data),
  });
  const marksCopy = Boolean(shown.data?.layout?.show?.copyMarking);

  const print = async () => {
    if (!shown.data) return;
    setPrinting(true);
    try {
      await printBill(billId, { printer, logoDataUrl, copy });
      setToast({ tone: 'success', message: 'Sent to the printer.' });
    } catch (error) {
      setToast({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <main className="v2 text-ink min-h-full bg-ground px-4 py-6 lg:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link
              to={`/bills/${billId}`}
              aria-label="Back to the bill"
              className="flex size-10 items-center justify-center rounded-full bg-sunken type-heading hover:bg-sunken"
            >
              ←
            </Link>
            <div>
              <p className="type-caption text-muted">Bills / Receipt</p>
              <h1 className="type-title">Receipt preview</h1>
            </div>
          </div>
          {bill.data && (
            <div className="flex items-center gap-2 rounded-lg bg-sunken px-4 py-2 border border-line">
              <span className="type-num-meta">{bill.data.billNumber}</span>
              <span className="text-muted">·</span>
              <span className="type-caption text-muted">
                {placeLabel(bill.data)}
              </span>
              <BillStatusBadge bill={bill.data} />
            </div>
          )}
        </header>

        <div className="grid grid-cols-12 items-start gap-6">
          <div className="col-span-12 flex flex-col gap-4 xl:col-span-4">
            <section className="flex flex-col gap-4 rounded-[10px] bg-surface p-4 border border-line">
              <div>
                <p className="type-caption text-muted">This device</p>
                <h2 className="type-heading">Print the receipt</h2>
              </div>

              <button
                type="button"
                onClick={print}
                disabled={printing || !shown.data}
                className="flex min-h-14 w-full items-center justify-center rounded-lg bg-accent type-button text-on-accent disabled:opacity-50"
              >
                {printing ? 'Printing…' : LABELS.printReceipt}
              </button>

              <fieldset>
                <legend className="mb-2 type-caption text-muted">Printer</legend>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
                  {PRINTER_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={printer === key}
                      onClick={() => updateDevice({ printer: key })}
                      className={[
                        'min-h-12 rounded-lg type-caption',
                        printer === key ? 'bg-surface border border-line' : 'text-muted',
                      ].join(' ')}
                    >
                      {PRINTERS[key].label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 type-caption text-muted">{PRINTERS[printer].hint}</p>
                <p className="mt-1 type-caption text-muted">
                  Saved for this device, like the setting on the This device page.
                </p>
              </fieldset>

              {!thermal && marksCopy && (
                <fieldset>
                  <legend className="mb-2 type-caption text-muted">Copy</legend>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
                    {Object.entries(COPY_WORDS).map(([key, words]) => (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={copy === key}
                        onClick={() => setCopy(key)}
                        className={['min-h-12 rounded-lg px-2 type-caption', copy === key ? 'bg-surface border border-line' : 'text-muted'].join(' ')}
                      >
                        {key === 'RECIPIENT' ? 'Original for recipient' : 'Duplicate for supplier'}
                        <span className="sr-only"> ({words})</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              <Link
                to={`/bills/${billId}`}
                className="flex min-h-12 items-center justify-center rounded-lg bg-sunken type-caption hover:bg-sunken"
              >
                Back to the bill
              </Link>
            </section>
          </div>

          <div className="col-span-12 flex flex-col items-center xl:col-span-5">
            <p className="mb-3 rounded-lg bg-sunken/70 px-4 py-2 type-num-meta">
              As printed · {PRINTERS[printer].label}{thermal ? ` · ${billWidthMm(printer, device.edgeMargin, device.printWidth)} mm printed width` : ''}
            </p>

            {shown.isPending && <Spinner label="Laying out the receipt" />}
            {shown.isError && <p className="type-body text-alert">{errorMessage(shown.error)}</p>}

            {!thermal && invoice.data && (
              <iframe
                title="Tax invoice as printed"
                className="w-full max-w-[210mm] bg-surface shadow-float"
                style={{ aspectRatio: `${PRINTERS[printer].widthMm} / ${PRINTERS[printer].heightMm}` }}
                srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;background:white;color:black}body{padding:12mm}${invoiceStyles(invoice.data.layout?.theme)}</style></head><body>${invoiceHtml(invoice.data, { qrSvg: qr.data ?? null, logoDataUrl, signatureDataUrl: signature.data ?? null, copy })}</body></html>`}
              />
            )}

            {thermal && invoice.data && (
              <iframe
                title="Bill as printed"
                className="bg-surface shadow-float"
                style={{ width: `${billWidthMm(printer, device.edgeMargin, device.printWidth) + 8}mm`, height: `${slipHeight}px` }}
                onLoad={(event) => setSlipHeight(event.currentTarget.contentDocument?.body?.scrollHeight ?? 600)}
                srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;background:white;color:black}body{padding:4mm}#slip{width:${billWidthMm(printer, device.edgeMargin, device.printWidth)}mm;padding:0 ${THERMAL_SIDE_MM}mm;box-sizing:border-box}${THERMAL_BILL_STYLES}</style></head><body><div id="slip">${thermalBillHtml(invoice.data, { printer, logoDataUrl: thermalLogo.data ?? null, qrSvg: qr.data ?? null, textSize: device.billTextSize })}</div></body></html>`}
              />
            )}
          </div>

          <div className="col-span-12 flex flex-col gap-4 xl:col-span-3">
            {bill.data && (
              <section className="flex flex-col gap-3 rounded-[10px] bg-surface p-4 border border-line">
                <p className="type-caption text-muted">On this bill</p>
                <dl className="flex flex-col gap-2 type-caption">
                  <Row label="Item total" value={<Money paise={bill.data.subtotalInPaise} />} />
                  {bill.data.discount && (
                    <Row
                      label="Discount"
                      value={`− ${moneyText(bill.data.discount.amountInPaise)}`}
                      tone="text-ok"
                    />
                  )}
                  <Row label="GST" value={<Money paise={bill.data.totalTaxInPaise} />} />
                  {bill.data.roundOffInPaise !== 0 && (
                    <Row label="Round-off" value={<Money paise={bill.data.roundOffInPaise} />} />
                  )}
                  <div className="mt-1 flex items-baseline justify-between border-t border-line pt-2">
                    <dt className="font-semibold">Bill total</dt>
                    <dd className="type-num-tile"><Money paise={bill.data.grandTotalInPaise} /></dd>
                  </div>
                </dl>
              </section>
            )}

            <p className="rounded-[10px] bg-sunken p-4 type-caption text-muted">
              The receipt is laid out by the server from the bill as it was frozen. Its header lines
              come from Settings, under Receipt.
            </p>
          </div>
        </div>
      </div>

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

function Row({ label, value, tone = 'text-muted' }) {
  return (
    <div className="flex justify-between">
      <dt className={tone}>{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}
