// From install.ps1, once, on a new restaurant: loads the sample restaurant through the
// running server, signed in as the owner. setup/threeoclock.json gives the stations, tables,
// payment methods, settings and the standard staff logins (manager, cashier, waiter,
// kitchen, storekeeper); setup/threeoclock-menu.csv and threeoclock-addons.csv the sample menu.
// Skips anything already there, so it is safe to run again.
//
// Every login, the owner's included, is written to LOGINS_FILE: a new staff password
// exists only in this run's output, so the file is the one place it is kept.
//   CAFE_URL, CAFE_PHONE, CAFE_PASSWORD and LOGINS_FILE come from the installer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain imports, so a release bundles this file with these three into one (protect-server.mjs):
// one copy of the database models, as each would otherwise bring its own.
import { readMenu, planMenu, applyMenu } from '../../server/scripts/importMenu.js';
import { validateSetupConfig, planSetup, applySetup } from '../../server/scripts/setupRestaurant.js';
import { apiClient } from '../../server/scripts/lib/scriptApi.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const base = `${process.env.CAFE_URL}/api/v1`;
const send = async (method, route, { body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const setupFile = (name) => readFileSync(path.join(root, 'setup', name), 'utf8');

try {
  const login = await send('POST', '/auth/login', { body: { phone: process.env.CAFE_PHONE, password: process.env.CAFE_PASSWORD } });
  if (login.status !== 200) throw new Error('Could not sign in as the owner.');
  const client = apiClient(send, login.body.data.accessToken);

  // The installer already named the restaurant, so the sample's name and wordmark stay out.
  const raw = JSON.parse(setupFile('threeoclock.json'));
  delete raw.restaurant;
  if (raw.settings?.appearance) delete raw.settings.appearance.wordmark;
  const { config, toConfirm } = validateSetupConfig(raw);
  const { logins } = await applySetup(await planSetup(client, config, { toConfirm }));
  console.log(`Tables, stations, payment methods and settings loaded. ${logins.length} staff logins made.`);

  const menu = readMenu(setupFile('threeoclock-menu.csv'), setupFile('threeoclock-addons.csv'));
  const outcome = await applyMenu(await planMenu(client, menu, { config }));
  console.log(`Menu: ${outcome.create ?? 0} added, ${outcome.unchanged ?? 0} already there.`);

  // A second run makes no new logins; it must not overwrite the file that holds the first run's.
  if (process.env.LOGINS_FILE && (logins.length > 0 || !existsSync(process.env.LOGINS_FILE))) {
    const rows = [{ name: 'Owner', phone: process.env.CAFE_PHONE, role: 'OWNER', password: process.env.CAFE_PASSWORD }, ...logins];
    const lines = [
      'THREE O CLOCK LOGINS - keep this file private',
      '',
      'Sign in with the phone number and password. Change a password from',
      'Staff in the menu, and give each person their own phone number there.',
      '',
      ...rows.map((row) => `${row.role.padEnd(12)} ${row.name.padEnd(12)} phone ${String(row.phone).padEnd(11)} password ${row.password}`),
      '',
    ];
    writeFileSync(process.env.LOGINS_FILE, lines.join('\r\n'));
    console.log(`Logins saved to ${process.env.LOGINS_FILE}`);
  }
} catch (error) {
  console.error(`The sample restaurant was not loaded: ${error.message}`);
  process.exit(1);
}
