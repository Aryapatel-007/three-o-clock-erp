import { Link, useLocation } from 'react-router-dom';

import { PrintIcon } from '../../components/ui/icons/index.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import Choice from './Choice.jsx';
import { PRINTERS } from './printers.js';
import { findModel } from './printerModels.js';
import { DENSITIES, TEXT_SIZES, THEMES, useDeviceSettings } from './useDeviceSettings.js';

const THEME_LABELS = { AUTO: 'Automatic', DAY: 'Day', NIGHT: 'Night' };
const DENSITY_LABELS = { COMFORTABLE: 'Comfortable', COMPACT: 'Compact' };
const LANGUAGE_LABELS = { NONE: 'None', GUJARATI: 'Gujarati', HINDI: 'Hindi' };

/**
 * "This device". Every role. P05, extended in P20A with DESIGN-SYSTEM
 * section 11b: theme, density, text size and the second language.
 *
 * The look, the card machine and the alerts are properties of the computer or
 * tablet, not of whoever signs in, so they are kept on the device. Nothing here
 * goes to the server. 2026-11-03: everything about printing moved to Printers.
 */
export default function DeviceSettingsPage() {
  const { user, features } = useAuth();
  const location = useLocation();
  const [settings, update] = useDeviceSettings();
  const restaurantLanguage = features.appearance?.secondLanguage ?? 'NONE';
  const model = settings.printerModel ? findModel(settings.printerModel) : null;

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

        {user?.role !== 'KITCHEN' && (
          <Link
            to="/printers"
            className="flex min-h-16 items-center justify-between gap-3 rounded-[10px] border border-line bg-surface px-4 py-3 hover:bg-sunken"
          >
            <span className="flex items-center gap-3">
              <PrintIcon />
              <span>
                <span className="type-heading block">Printers</span>
                <span className="type-caption block text-muted">
                  {model ? `${model.brand} ${model.name}` : PRINTERS[settings.printer]?.label} · test bill, drivers and where things print
                </span>
              </span>
            </span>
            <span className="type-label text-muted" aria-hidden="true">
              →
            </span>
          </Link>
        )}

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
            <span className="type-caption block text-muted">Reads the new order aloud, for example &quot;New takeaway order, W 42, 3 items&quot;.</span>
          </span>
        </label>
      </div>
    </main>
  );
}
