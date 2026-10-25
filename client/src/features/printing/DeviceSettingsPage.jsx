import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext.jsx';
import { BILL_TEXT_SIZES, EDGE_MARGINS, PAPER_LENGTHS, PRINT_WIDTHS, PRINTER_KEYS, PRINTERS } from './printers.js';
import { BILL_PRINT_PLACES, billsPrintAtCounter, DENSITIES, TEXT_SIZES, THEMES, useDeviceSettings } from './useDeviceSettings.js';

const THEME_LABELS = { AUTO: 'Automatic', DAY: 'Day', NIGHT: 'Night' };
const DENSITY_LABELS = { COMFORTABLE: 'Comfortable', COMPACT: 'Compact' };
const BILL_PRINT_LABELS = { AUTO: 'Automatic', HERE: 'On this device', COUNTER: 'At the counter' };
const LANGUAGE_LABELS = { NONE: 'None', GUJARATI: 'Gujarati', HINDI: 'Hindi' };

/**
 * "This device". Every role. P05, extended in P20A with DESIGN-SYSTEM
 * section 11b: theme, density, text size and the second language.
 *
 * The printer and the look are properties of the computer or tablet, not of
 * whoever signs in, so these are kept on the device, under one storage key.
 * Nothing here goes to the server.
 */
export default function DeviceSettingsPage() {
  const { user, features } = useAuth();
  const location = useLocation();
  const [settings, update] = useDeviceSettings();
  const isKitchen = user?.role === 'KITCHEN' || user?.role === 'OWNER' || user?.role === 'MANAGER';
  const isTill = ['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role);
  const restaurantLanguage = features.appearance?.secondLanguage ?? 'NONE';

  return (
    <main className="v2 min-h-full bg-ground px-4 py-4 text-ink sm:px-6">
      <div className="mx-auto flex max-w-xl flex-col gap-6">
        <header>
          <h1 className="type-title">This device</h1>
          <p className="type-caption text-muted">Saved on this computer or tablet only, whoever signs in.</p>
          {location.state?.from === '/print-station' && (
            <Link to="/print-station" className="type-body text-accent underline">
              Back to the printer window
            </Link>
          )}
        </header>

        <Choice
          legend="Theme"
          hint="Automatic is Day on every screen, the kitchen included. Choose Night for a dim counter."
          options={THEMES.map((value) => ({ value, label: THEME_LABELS[value] }))}
          value={settings.theme}
          onChange={(theme) => update({ theme })}
        />

        <Choice
          legend="Density"
          hint="Compact tightens the spacing. Text stays the same size."
          options={DENSITIES.map((value) => ({ value, label: DENSITY_LABELS[value] }))}
          value={settings.density}
          onChange={(density) => update({ density })}
        />

        <Choice
          legend="Text size"
          options={TEXT_SIZES.map((value) => ({ value, label: `${value}%` }))}
          value={settings.textSize}
          onChange={(textSize) => update({ textSize })}
        />

        <Choice
          legend="Second language"
          hint="A second line under the fixed words on service screens: Pay, Print bill, Send to kitchen, and the states."
          options={[
            { value: null, label: `The restaurant's choice, ${LANGUAGE_LABELS[restaurantLanguage]}` },
            ...['NONE', 'GUJARATI', 'HINDI'].map((value) => ({ value, label: LANGUAGE_LABELS[value] })),
          ]}
          value={settings.secondLanguage}
          onChange={(secondLanguage) => update({ secondLanguage })}
        />

        <Choice
          legend="Printer"
          hint="Bills, kitchen tickets and the Day Close print on this. Choose the width of the roll in the printer at this device."
          options={PRINTER_KEYS.map((value) => ({ value, label: PRINTERS[value].label, detail: PRINTERS[value].hint }))}
          value={settings.printer}
          onChange={(printer) => update({ printer })}
        />

        {settings.printer === 'THERMAL_80' && (
          <Choice
            legend="Print width"
            hint="How wide the bill and kitchen tickets print on the 80 mm roll."
            options={Object.entries(PRINT_WIDTHS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
            value={settings.printWidth}
            onChange={(printWidth) => update({ printWidth })}
          />
        )}

        {PRINTERS[settings.printer]?.thermal && (
          <Choice
            legend="Paper length"
            hint="How long each thermal print is."
            options={Object.entries(PAPER_LENGTHS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
            value={settings.paperLength}
            onChange={(paperLength) => update({ paperLength })}
          />
        )}

        {PRINTERS[settings.printer]?.thermal && (
          <Choice
            legend="Bill text size"
            hint="Normal fills the roll like a usual restaurant bill. Long dish names wrap onto a second line."
            options={Object.entries(BILL_TEXT_SIZES).map(([value, entry]) => ({ value, label: entry.label }))}
            value={settings.billTextSize}
            onChange={(billTextSize) => update({ billTextSize })}
          />
        )}

        {PRINTERS[settings.printer]?.thermal && (
          <Choice
            legend="Edge margin"
            hint="Space kept clear at each side of the bill."
            options={Object.entries(EDGE_MARGINS).map(([value, entry]) => ({ value, label: entry.label, detail: entry.hint }))}
            value={settings.edgeMargin}
            onChange={(edgeMargin) => update({ edgeMargin })}
          />
        )}

        {/* 2026-10-10. A page cannot skip Chrome's print dialog; Chrome started with --kiosk-printing can. */}
        {isTill && (
          <section aria-labelledby="no-dialog" className="flex flex-col gap-1">
            <h2 id="no-dialog" className="type-heading">Printing with no dialog</h2>
            <p className="type-caption text-muted">
              Chrome asks before every print, and this page cannot turn that off. To print bills straight to the bill printer, make it this
              computer&apos;s default printer and open the till with the launcher from the repository&apos;s tools/silent-printing folder, one file for a Mac and
              one for Windows. The till then opens in its own Chrome window that prints with no dialog, and everyday Chrome is left as it is.
            </p>
          </section>
        )}

        {/* P25 Part I. Which card machine sits beside this device. */}
        {(features.terminals ?? []).length > 0 && (
          <Choice
            legend="Card machine"
            hint="Card and UPI payments taken here are sent to this machine."
            options={[{ value: null, label: 'None at this device' }, ...features.terminals.map((terminal) => ({ value: terminal.clientId, label: terminal.name }))]}
            value={settings.terminalClientId}
            onChange={(terminalClientId) => update({ terminalClientId })}
          />
        )}

        {/* P23. The online alert, per device: a captain's phone or a second till can be quiet. */}
        <label className="flex min-h-12 items-start gap-3">
          <input
            type="checkbox"
            checked={settings.onlineAlerts}
            onChange={(event) => update({ onlineAlerts: event.target.checked })}
            className="mt-1 size-5 accent-[var(--color-accent)]"
          />
          <span>
            <span className="type-body block">Online alerts on this device</span>
            <span className="type-caption block text-muted">A chime and a banner when an online order or booking arrives.</span>
          </span>
        </label>
        <label className="flex min-h-12 items-start gap-3">
          <input
            type="checkbox"
            checked={settings.speakAlerts}
            disabled={!settings.onlineAlerts}
            onChange={(event) => update({ speakAlerts: event.target.checked })}
            className="mt-1 size-5 accent-[var(--color-accent)] disabled:opacity-50"
          />
          <span>
            <span className="type-body block">Speak alerts</span>
            <span className="type-caption block text-muted">Reads the new order aloud, for example "New takeaway order, W 42, 3 items".</span>
          </span>
        </label>

        {/* 2026-10-25. A phone has no bill printer; its bills can print at the counter, as a captain's. */}
        {isTill && (
          <Choice
            legend="Bills print"
            hint={`Automatic: at the counter on the cafe PC, except on the computer that prints captains' bills; on this device everywhere else. Now: ${
              billsPrintAtCounter(settings, features) ? 'at the counter' : 'on this device'
            }.`}
            options={BILL_PRINT_PLACES.map((value) => ({ value, label: BILL_PRINT_LABELS[value] }))}
            value={settings.billPrintsAt}
            onChange={(billPrintsAt) => update({ billPrintsAt })}
          />
        )}

        {/* P25 Part D. The counter prints what captains send it. */}
        {isTill && (
          <label className="flex min-h-12 items-start gap-3">
            <input
              type="checkbox"
              checked={settings.printCaptainBills}
              onChange={(event) => update({ printCaptainBills: event.target.checked })}
              className="mt-1 size-5 accent-[var(--color-accent)]"
            />
            <span>
              <span className="type-body block">Print bills sent by captains</span>
              <span className="type-caption block text-muted">For the counter computer. Each bill a captain sends prints here once, on this device's printer.</span>
            </span>
          </label>
        )}


        {isKitchen && (
          <label className="flex min-h-12 items-start gap-3">
            <input
              type="checkbox"
              checked={settings.autoPrintKots}
              onChange={(event) =>
                // Turning it on starts fresh: the kitchen screen marks what is
                // already on screen as printed, so no backlog comes out.
                update({ autoPrintKots: event.target.checked, autoPrintArmedAt: Date.now() })
              }
              className="mt-1 size-5 accent-[var(--color-accent)]"
            />
            <span>
              <span className="type-body block">Print new tickets automatically</span>
              <span className="type-caption block text-muted">For a kitchen screen showing one station. Each new ticket prints once.</span>
            </span>
          </label>
        )}
      </div>
    </main>
  );
}

function Choice({ legend, hint, options, value, onChange }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="type-heading mb-1">{legend}</legend>
      {hint && <p className="type-caption -mt-1 text-muted">{hint}</p>}
      {options.map((option) => (
        <label
          key={String(option.value)}
          className={[
            'flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3',
            value === option.value ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
          ].join(' ')}
        >
          <input
            type="radio"
            name={legend}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="size-5 accent-[var(--color-accent)]"
          />
          <span className="flex flex-col py-2">
            <span className="type-body">{option.label}</span>
            {option.detail && <span className="type-caption text-muted">{option.detail}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
