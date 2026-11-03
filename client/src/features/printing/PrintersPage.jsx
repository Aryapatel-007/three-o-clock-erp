import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { listInstalledPrinters } from '../../api/system.js';
import { PrintIcon } from '../../components/ui/icons/index.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import Choice from './Choice.jsx';
import { THERMAL_BILL_STYLES, thermalBillHtml } from './invoiceHtml.js';
import { findModel, matchingPrinters, OTHER_MODEL_ID, PRINTER_BRANDS, testBillData } from './printerModels.js';
import { BILL_TEXT_SIZES, EDGE_MARGINS, PAPER_LENGTHS, PRINT_WIDTHS, PRINTER_KEYS, PRINTERS } from './printers.js';
import { printDocument } from './printText.js';
import { BILL_PRINT_PLACES, billsPrintAtCounter, useDeviceSettings } from './useDeviceSettings.js';

const BILL_PRINT_LABELS = { AUTO: 'Automatic', HERE: 'On this device', COUNTER: 'At the counter' };

/**
 * Printers. 2026-11-03.
 *
 * Every restaurant has a different printer and driver, and each bill used to be
 * checked by hand. Here the printer at this device is set up in one place:
 *
 *   1. its make and model, which applies the settings that print best on it;
 *   2. its Windows driver: where to download it, the steps, and (on the restaurant
 *      PC) a check that Windows has it, or a way to add it by hand;
 *   3. a test bill, printed in the real bill layout, nothing saved anywhere;
 *   4. the fine settings, and where bills and KOTs print.
 *
 * Kept on this device, like the rest of This device: the printer belongs to the
 * computer, not to whoever signs in.
 */
export default function PrintersPage() {
  const { user, features } = useAuth();
  const { name: restaurantName } = useTheme();
  const [settings, update] = useDeviceSettings();
  const [toast, setToast] = useState(null);
  const isTill = ['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role);
  const isKitchen = ['KITCHEN', 'OWNER', 'MANAGER'].includes(user?.role);
  const kotsPrint = features?.kitchen?.printKots !== false;
  const onRestaurantPc = features?.sync?.server === 'BOX';

  const model = settings.printerModel && settings.printerModel !== OTHER_MODEL_ID ? findModel(settings.printerModel) : null;
  const brandOfModel = model?.brand ?? (settings.printerModel === OTHER_MODEL_ID ? OTHER_MODEL_ID : '');
  const [brand, setBrand] = useState(brandOfModel);
  const brandEntry = PRINTER_BRANDS.find((entry) => entry.brand === brand) ?? null;

  const chooseModel = (id) => {
    if (id === OTHER_MODEL_ID) {
      update({ printerModel: OTHER_MODEL_ID });
      return;
    }
    const picked = findModel(id);
    if (!picked) return;
    // The model's best settings, at once: the point of choosing it.
    update({ printerModel: id, ...picked.settings });
    setToast({ tone: 'success', message: `Set up for the ${picked.brand} ${picked.name}. Print a test bill to check it.` });
  };

  const check = useMutation({ mutationFn: listInstalledPrinters });
  const installed = check.data?.printers ?? [];
  const matches = model ? matchingPrinters(model, installed) : [];

  const [testing, setTesting] = useState(false);
  const printTest = async () => {
    setTesting(true);
    try {
      const data = testBillData({ restaurantName });
      if (PRINTERS[settings.printer]?.thermal === false) {
        await printDocument({ printer: settings.printer, bodyHtml: testPageHtml(data), styles: TEST_PAGE_STYLES });
      } else {
        await printDocument({
          printer: settings.printer,
          bodyHtml: thermalBillHtml(data, { printer: settings.printer, textSize: settings.billTextSize }),
          styles: THERMAL_BILL_STYLES,
          bill: true,
        });
      }
    } catch {
      setToast({ tone: 'error', message: 'The test bill did not print. Check the printer is on and is the default printer.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="v2 min-h-full bg-ground px-4 py-6 text-ink lg:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="type-title">Printers</h1>
            <p className="type-caption text-muted">The printer at this device. Saved on this computer or tablet, whoever signs in.</p>
          </div>
          <button
            type="button"
            onClick={printTest}
            disabled={testing}
            className="type-button flex min-h-12 items-center gap-2 rounded-lg bg-accent px-5 text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            <PrintIcon />
            {testing ? 'Printing…' : 'Print a test bill'}
          </button>
        </header>

        {/* 1. Make and model: the best settings for it. */}
        <section className="flex flex-col gap-4 rounded-[10px] border border-line bg-surface p-4 sm:p-6">
          <div>
            <h2 className="type-heading">1. Your printer</h2>
            <p className="type-caption text-muted">Choose its make and model: Three O’Clock sets the paper, width and margins that print its bill best.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="type-label">Company</span>
              <select
                value={brand}
                onChange={(event) => {
                  setBrand(event.target.value);
                  if (event.target.value === OTHER_MODEL_ID) chooseModel(OTHER_MODEL_ID);
                }}
                className="type-body min-h-12 rounded-lg border border-muted bg-surface px-3"
              >
                <option value="">Choose the company</option>
                {PRINTER_BRANDS.map((entry) => (
                  <option key={entry.brand} value={entry.brand}>
                    {entry.brand}
                  </option>
                ))}
                <option value={OTHER_MODEL_ID}>Another company, not listed</option>
              </select>
            </label>
            {brandEntry && (
              <label className="flex flex-col gap-1">
                <span className="type-label">Model</span>
                <select
                  value={model?.brand === brandEntry.brand ? settings.printerModel : ''}
                  onChange={(event) => chooseModel(event.target.value)}
                  className="type-body min-h-12 rounded-lg border border-muted bg-surface px-3"
                >
                  <option value="">Choose the model</option>
                  {brandEntry.models.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {model && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sunken px-3 py-2">
              <p className="type-body">
                <span className="font-semibold">
                  {model.brand} {model.name}
                </span>{' '}
                · {PRINTERS[settings.printer]?.label}
              </p>
              <button
                type="button"
                onClick={() => chooseModel(model.id)}
                className="type-label min-h-12 rounded-lg border border-ink bg-surface px-3 hover:bg-sunken"
              >
                Use the best settings again
              </button>
            </div>
          )}
          {settings.printerModel === OTHER_MODEL_ID && (
            <p className="type-caption text-muted">Set the paper and width below by hand, print a test bill, and adjust until it prints right.</p>
          )}
        </section>

        {/* 2. The driver: download, steps, check. */}
        <section className="flex flex-col gap-4 rounded-[10px] border border-line bg-surface p-4 sm:p-6">
          <div>
            <h2 className="type-heading">2. The printer&apos;s driver</h2>
            <p className="type-caption text-muted">Windows needs the maker&apos;s driver to print to it. Install it once on the computer the printer is plugged into.</p>
          </div>
          {model ? (
            <p className="type-body">
              Best driver: <span className="font-semibold">{model.driverName}</span>
            </p>
          ) : (
            <p className="type-body text-muted">Choose the printer above to see its driver.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {model?.site && (
              <a
                href={model.site}
                target="_blank"
                rel="noreferrer"
                className="type-button flex min-h-12 items-center rounded-lg border border-ink bg-surface px-4 hover:bg-sunken"
              >
                Download from {model.brand}
              </a>
            )}
            {model && model.driverKeywords.length > 0 && (
              <a href={model.searchUrl} target="_blank" rel="noreferrer" className="type-label flex min-h-12 items-center rounded-lg px-3 text-ink hover:bg-sunken">
                Search for the driver
              </a>
            )}
          </div>
          <ol className="type-body flex list-decimal flex-col gap-1 pl-5">
            <li>Plug the printer into this computer with its USB cable and switch it on.</li>
            <li>Download the driver, open it and follow its steps. Choose this model and the USB port when it asks.</li>
            <li>
              In Windows Settings, Printers, click the printer and choose <span className="font-semibold">Set as default</span>: Three O’Clock prints to the
              default printer.
            </li>
            <li>Check it below, then print a test bill.</li>
          </ol>

          {onRestaurantPc ? (
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => check.mutate()}
                  disabled={check.isPending}
                  className="type-button min-h-12 rounded-lg bg-ink px-4 text-surface hover:brightness-110 disabled:opacity-50"
                >
                  {check.isPending ? 'Checking…' : 'Check this computer’s printers'}
                </button>
                <a href="ms-settings:printers" className="type-label flex min-h-12 items-center rounded-lg border border-ink px-3 hover:bg-sunken">
                  Add a printer by hand
                </a>
              </div>
              {check.isError && <p className="type-caption text-alert">The printers could not be read. Try again.</p>}
              {check.data && !check.data.checked && <p className="type-caption text-alert">Windows did not answer. Try again in a moment.</p>}
              {check.data?.checked && (
                <>
                  {model && model.driverKeywords.length > 0 && (
                    <p className={`type-body font-semibold ${matches.length > 0 ? 'text-ok' : 'text-alert'}`}>
                      {matches.length > 0
                        ? `Ready: ${matches[0].name} is installed.`
                        : `Not found yet. Install the ${model.brand} driver, or add the printer by hand.`}
                    </p>
                  )}
                  <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
                    {installed.length === 0 && <li className="type-body px-3 py-2 text-muted">No printers installed on this computer.</li>}
                    {installed.map((printer) => (
                      <li key={printer.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span className="min-w-0">
                          <span className="type-body block">{printer.name}</span>
                          <span className="type-caption block text-muted">
                            {printer.driverName}
                            {printer.portName ? ` · ${printer.portName}` : ''}
                          </span>
                        </span>
                        {matches.includes(printer) && <span className="type-label text-ok">This printer</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : (
            <p className="type-caption border-t border-line pt-4 text-muted">
              Checking the installed printers works on the restaurant PC with the offline app. Here, print a test bill to check.
            </p>
          )}
        </section>

        {/* 3. Fine settings. */}
        <section className="flex flex-col gap-6 rounded-[10px] border border-line bg-surface p-4 sm:p-6">
          <div>
            <h2 className="type-heading">3. Fine settings</h2>
            <p className="type-caption text-muted">Set by the model above. Change one only if the test bill shows a problem.</p>
          </div>
          <Choice
            legend="Paper"
            options={PRINTER_KEYS.map((value) => ({ value, label: PRINTERS[value].label, detail: PRINTERS[value].hint }))}
            value={settings.printer}
            onChange={(printer) => update({ printer })}
          />
          {settings.printer === 'THERMAL_80' && (
            <Choice
              legend="Print width"
              options={Object.entries(PRINT_WIDTHS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
              value={settings.printWidth}
              onChange={(printWidth) => update({ printWidth })}
            />
          )}
          {PRINTERS[settings.printer]?.thermal && (
            <>
              <Choice
                legend="Edge margin"
                options={Object.entries(EDGE_MARGINS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
                value={settings.edgeMargin}
                onChange={(edgeMargin) => update({ edgeMargin })}
              />
              <Choice
                legend="Bill text size"
                options={Object.entries(BILL_TEXT_SIZES).map(([value, entry]) => ({ value, label: entry.label }))}
                value={settings.billTextSize}
                onChange={(billTextSize) => update({ billTextSize })}
              />
              <Choice
                legend="Paper length"
                options={Object.entries(PAPER_LENGTHS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
                value={settings.paperLength}
                onChange={(paperLength) => update({ paperLength })}
              />
            </>
          )}
        </section>

        {/* 4. Where bills and KOTs print. */}
        {(isTill || isKitchen) && (
          <section className="flex flex-col gap-4 rounded-[10px] border border-line bg-surface p-4 sm:p-6">
            <h2 className="type-heading">4. What prints here</h2>
            {isTill && (
              <Choice
                legend="Bills print"
                hint={`Now: ${billsPrintAtCounter(settings, features) ? 'at the counter' : 'on this device'}.`}
                options={BILL_PRINT_PLACES.map((value) => ({ value, label: BILL_PRINT_LABELS[value] }))}
                value={settings.billPrintsAt}
                onChange={(billPrintsAt) => update({ billPrintsAt })}
              />
            )}
            {isTill && (
              <Toggle
                checked={settings.printCaptainBills}
                onChange={(printCaptainBills) => update({ printCaptainBills })}
                label="Print bills sent by captains"
                hint="For the counter computer. Each bill a captain sends prints here once."
              />
            )}
            {isTill && kotsPrint && (
              <Toggle
                checked={Boolean(settings.printKotsAtCounter)}
                onChange={(on) => update({ printKotsAtCounter: on, counterKotsArmedAt: Date.now() })}
                label="Print every new KOT here"
                hint="For the counter computer when the kitchen has no printer of its own."
              />
            )}
            {isKitchen && kotsPrint && (
              <Toggle
                checked={settings.autoPrintKots}
                onChange={(on) => update({ autoPrintKots: on, autoPrintArmedAt: Date.now() })}
                label="Kitchen screen: print new tickets automatically"
                hint="For a kitchen screen showing one station. Each new ticket prints once."
              />
            )}
            {!kotsPrint && <p className="type-caption text-muted">KOTs do not print: the kitchen reads them on screen (Settings, Kitchen).</p>}
          </section>
        )}
      </div>
      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex min-h-12 items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 size-5 accent-[var(--color-accent)]" />
      <span>
        <span className="type-body block">{label}</span>
        <span className="type-caption block text-muted">{hint}</span>
      </span>
    </label>
  );
}

/** The test bill on an A4 or A5 printer: the same dishes on a plain page. */
const TEST_PAGE_STYLES = `
  .test { font: 11pt/1.4 system-ui, sans-serif; color: black; }
  .test h1 { font-size: 16pt; margin: 0 0 4mm; }
  .test table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  .test td { padding: 1.5mm 0; border-bottom: 0.3mm solid gray; }
  .test td.r { text-align: right; }
`;
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function testPageHtml(data) {
  const money = (paise) => (paise / 100).toFixed(2);
  const rows = data.lines.map((line) => `<tr><td>${line.quantity} × ${escape(line.itemName)}</td><td class="r">${money(line.lineTotalInPaise)}</td></tr>`).join('');
  return `<div class="test"><h1>${escape(data.restaurant.name)}: test page</h1><p>${escape(data.footerText)}</p><table>${rows}<tr><td><b>Total</b></td><td class="r"><b>${money(data.billTotalInPaise)}</b></td></tr></table></div>`;
}
