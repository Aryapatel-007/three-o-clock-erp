import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import Spinner from '../../components/ui/Spinner.jsx';
import { invoiceHtml, invoiceStyles, THERMAL_BILL_STYLES, thermalBillHtml } from '../printing/invoiceHtml.js';
import { signatureDataUrl } from '../printing/printBill.js';
import { contentWidthMm, PRINTERS, THERMAL_SIDE_MM } from '../printing/printers.js';

/**
 * The Print settings tab and the preview of the Invoice layout page. P64.
 * The preview draws the most recent real bill with the printer's own
 * functions, so what it shows is what prints.
 */

const PAPERS = ['A4', 'A5'];

export function PrintTab({ paper, setPaper, copy, setCopy, copyMarking }) {
  return (
    <section className="flex flex-col gap-4 rounded-[10px] border border-line bg-surface p-4">
      <h2 className="type-heading">Paper and copy</h2>
      <p className="type-caption text-muted">
        These change only the preview. Each printer&apos;s paper, width and margins are chosen on that device&apos;s This device page.
      </p>
      <fieldset>
        <legend className="mb-2 type-label">Paper</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
          {PAPERS.map((key) => (
            <button key={key} type="button" aria-pressed={paper === key} onClick={() => setPaper(key)} className={['min-h-12 rounded-lg type-label', paper === key ? 'border border-line bg-surface' : 'text-muted'].join(' ')}>
              {PRINTERS[key].label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 type-label">Copy</legend>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-1">
          {[
            ['RECIPIENT', 'Original for recipient'],
            ['SUPPLIER', 'Duplicate for supplier'],
          ].map(([key, label]) => (
            <button key={key} type="button" aria-pressed={copy === key} onClick={() => setCopy(key)} className={['min-h-12 rounded-lg px-2 type-label', copy === key ? 'border border-line bg-surface' : 'text-muted'].join(' ')}>
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 type-caption text-muted">
          {copyMarking
            ? 'A restaurant supplies a service, so a tax invoice is made out in two copies. The guest gets the original; the receipt preview prints the supplier’s copy when you choose it there.'
            : 'The copy marking is off. Turn it on under Invoice settings.'}
        </p>
      </fieldset>
    </section>
  );
}

/** The most recent bill, drawn by the printer's own functions with the choices on screen. */
export function Preview({ tab, invoice, latest, layout, terms, pan, udyam, accent, paper, copy, logoDataUrl }) {
  const [slipHeight, setSlipHeight] = useState(600);
  const data = useMemo(() => {
    if (!invoice.data) return null;
    return {
      ...invoice.data,
      restaurant: { ...invoice.data.restaurant, termsText: terms, panNumber: pan, msmeNumber: udyam },
      layout: { ...invoice.data.layout, theme: layout.theme, show: layout.show, thermalShow: layout.thermalShow, accent },
    };
  }, [invoice.data, layout, terms, pan, udyam, accent]);
  const signature = useQuery({
    queryKey: ['signature', data?.signature?.hash ?? null, Boolean(layout.show.signatureLine)],
    queryFn: () => signatureDataUrl(data),
    enabled: Boolean(data),
  });

  if (latest.isPending || invoice.isPending) {
    return (
      <aside aria-label="Preview" className="rounded-[10px] border border-line bg-surface p-4">
        <Spinner label="Laying out the preview" />
      </aside>
    );
  }
  if (!data) {
    return (
      <aside aria-label="Preview" className="rounded-[10px] border border-line bg-surface p-4">
        <h2 className="type-heading">Preview</h2>
        <p className="type-body mt-2 text-muted">No bill in the last 60 days to preview. Make one bill and come back.</p>
      </aside>
    );
  }

  const thermal = tab === 'thermal';
  const width = contentWidthMm('THERMAL_80');
  return (
    <aside aria-label="Preview" className="flex flex-col gap-3 lg:sticky lg:top-4">
      <p className="type-caption text-muted">
        Preview of bill {data.billNumber} · {thermal ? 'Thermal 80 mm' : PRINTERS[paper].label}. Nothing is saved until you press Save.
      </p>
      {thermal ? (
        <iframe
          title="Thermal bill preview"
          className="mx-auto bg-surface shadow-float"
          style={{ width: `${width + 8}mm`, height: `${slipHeight}px` }}
          onLoad={(event) => setSlipHeight(event.currentTarget.contentDocument?.body?.scrollHeight ?? 600)}
          srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;background:white;color:black}body{padding:4mm}#slip{width:${width}mm;padding:0 ${THERMAL_SIDE_MM}mm;box-sizing:border-box}${THERMAL_BILL_STYLES}</style></head><body><div id="slip">${thermalBillHtml(data, { printer: 'THERMAL_80' })}</div></body></html>`}
        />
      ) : (
        <ScaledPage widthMm={PRINTERS[paper].widthMm} heightMm={PRINTERS[paper].heightMm}>
          <iframe
            title="Tax invoice preview"
            className="h-full w-full bg-surface"
            srcDoc={`<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;background:white;color:black}body{padding:12mm}${invoiceStyles(layout.theme)}</style></head><body>${invoiceHtml(data, { logoDataUrl, signatureDataUrl: signature.data ?? null, copy })}</body></html>`}
          />
        </ScaledPage>
      )}
    </aside>
  );
}

const PX_PER_MM = 96 / 25.4;

/**
 * The page laid out at the paper's real width and shrunk to the space there is,
 * as a print preview does. Laid out at a phone's width instead, an A4 invoice's
 * columns ran past the right edge and were cut off (2026-10-27).
 */
function ScaledPage({ widthMm, heightMm, children }) {
  const frame = useRef(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pageWidth = widthMm * PX_PER_MM;
  const pageHeight = heightMm * PX_PER_MM;
  const scale = available > 0 ? Math.min(1, available / pageWidth) : 0;
  return (
    // The full-size page is placed absolutely, so its width never counts towards the column's.
    <div ref={frame} className="relative w-full overflow-hidden shadow-float" style={{ height: pageHeight * scale }}>
      <div className="absolute left-0 top-0" style={{ width: pageWidth, height: pageHeight, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {children}
      </div>
    </div>
  );
}
