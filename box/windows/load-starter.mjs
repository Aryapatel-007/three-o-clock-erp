// P62. Optional, from install.ps1: loads the menu saved in setup/zchaat-menu.csv and
// a starter floor (T1 to T8 inside, O1 to O4 outside) through the running server,
// signed in as the owner. Skips anything already there.
//   CAFE_URL, CAFE_PHONE and CAFE_PASSWORD come from the installer's environment.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { readMenu, planMenu, applyMenu } = await load('server/scripts/importMenu.js');
const { apiClient } = await load('server/scripts/lib/scriptApi.js');

const base = `${process.env.CAFE_URL}/api/v1`;
const send = async (method, route, { body, token } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

try {
  const login = await send('POST', '/auth/login', { body: { phone: process.env.CAFE_PHONE, password: process.env.CAFE_PASSWORD } });
  if (login.status !== 200) throw new Error('Could not sign in as the owner.');
  const token = login.body.data.accessToken;

  const menu = readMenu(readFileSync(path.join(root, 'setup', 'zchaat-menu.csv'), 'utf8'));
  const config = JSON.parse(readFileSync(path.join(root, 'setup', 'zchaat.json'), 'utf8'));
  const outcome = await applyMenu(await planMenu(apiClient(send, token), menu, { config }));
  console.log(`Menu: ${outcome.create ?? 0} added, ${outcome.unchanged ?? 0} already there.`);

  const tables = [
    ...Array.from({ length: 8 }, (_, i) => ({ name: `T${i + 1}`, section: 'Inside', seats: 4 })),
    ...Array.from({ length: 4 }, (_, i) => ({ name: `O${i + 1}`, section: 'Outside', seats: 2 })),
  ];
  let made = 0;
  for (const table of tables) if ((await send('POST', '/tables', { token, body: table })).status === 201) made += 1;
  console.log(`Tables: ${made} added.`);
} catch (error) {
  console.error(`The starter menu was not loaded: ${error.message}`);
  process.exit(1);
}
