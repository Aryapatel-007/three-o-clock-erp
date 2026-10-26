/**
 * Sets a restaurant up from one JSON file. P11. Phase 2 onboarding.
 *
 *   npm run setup:restaurant -- --config setup/zchaat.json --owner-phone 98xxxxxxxx
 *   npm run setup:restaurant -- --config setup/zchaat.json --owner-phone 98xxxxxxxx --apply
 *
 * Staging for training and production on cutover day have to be set up the
 * same way, so this reads one file and does it through the real API, signed in
 * as the owner. Rules:
 *
 * 1. The whole file is validated before anything changes, with the server's
 *    own request schemas, and every problem is listed at once.
 * 2. Without --apply it changes nothing and prints the plan.
 * 3. It is safe to run again. Everything is matched by name (a payment method
 *    by code) and updated to match the file, or left alone. Nothing is ever
 *    deleted or switched off.
 * 4. A value written "TO CONFIRM" is skipped and listed. A staff member with
 *    no confirmed phone is not created, because a login needs a phone.
 * 5. The invoice series is never set here. It is set by hand on cutover day.
 * 6. A new staff login gets a generated password, printed once at the end. An
 *    existing user's password is never touched. The owner's is typed hidden.
 * 7. P22. `logos` names an image file per slot, relative to the repository
 *    root. Each is checked in the dry run by the same `checkLogoFile` the
 *    upload endpoint uses, and uploaded through that endpoint, so every check
 *    runs. A logo already there with the same hash is left alone; a logo is
 *    never removed by this script.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import { ROLES } from '../config/roles.js';
import { LOGO_SLOT_NAMES } from '../models/Restaurant.js';
import { checkLogoFile } from '../services/brandLogoService.js';
import { checkBrandPair } from '../utils/colour.js';
import { createAccountSchema } from '../validators/accountValidators.js';
import { createPaymentMethodSchema } from '../validators/paymentMethodValidators.js';
import { createTableSchema } from '../validators/orderValidators.js';
import { updateRestaurantSchema } from '../validators/restaurantValidators.js';
import { updateSettingsSchema } from '../validators/settingsValidators.js';
import { createStationSchema } from '../validators/stationValidators.js';
import { createUserSchema } from '../validators/userValidators.js';
import { generatePassword } from './provisionRestaurant.js';
import {
  TO_CONFIRM,
  applySteps,
  countSteps,
  formatPlan,
  parseArgs,
  startOwnerSession,
} from './lib/scriptApi.js';

const SETTINGS_REASON = 'Restaurant setup file';

/** Logo files in a setup file are named relative to the repository root, like `docs/brand/...`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------------------------------------------------------ *
 * Reading the file
 * ------------------------------------------------------------------------ */

/**
 * Removes every "TO CONFIRM" value, returning the cleaned value and the dotted
 * path of each one removed. A staff member whose phone is unconfirmed is kept
 * here and skipped when planning, so the summary can name them.
 */
export function stripToConfirm(value, at = '', found = []) {
  if (value === TO_CONFIRM) {
    found.push(at);
    return { value: undefined, found };
  }
  if (Array.isArray(value)) {
    return { value: value.map((entry, index) => stripToConfirm(entry, `${at}[${index}]`, found).value), found };
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripToConfirm(entry, at ? `${at}.${key}` : key, found).value;
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return { value: out, found };
  }
  return { value, found };
}

const looseObject = z.record(z.string(), z.unknown());

const configShape = z
  .object({
    restaurant: looseObject.optional(),
    settings: z
      .object({
        businessDayStartsAtMinutes: z.unknown().optional(),
        features: looseObject.optional(),
        receipt: looseObject.optional(),
        delivery: looseObject.optional(),
        discounts: looseObject.optional(),
        dayClose: looseObject.optional(),
        floor: looseObject.optional(),
        appearance: looseObject.optional(),
      })
      .strict()
      .optional(),
    stations: z.array(looseObject).optional(),
    categoryStations: z.record(z.string(), z.string()).optional(),
    defaultStation: z.string().optional(),
    tables: z
      .object({ section: z.string().optional(), names: z.array(z.string()), seats: z.unknown().optional() })
      .strict()
      .optional(),
    paymentMethods: z.array(looseObject).optional(),
    accounts: z.array(looseObject).optional(),
    staff: z.array(looseObject).optional(),
    // P22. One image file per logo slot.
    logos: z.partialRecord(z.enum(LOGO_SLOT_NAMES, { error: `A logo slot is one of ${LOGO_SLOT_NAMES.join(', ')}.` }), z.string()).optional(),
  })
  .strict();

/** The PATCH /settings body this file asks for, in the API's shape. */
function settingsBody(settings = {}) {
  const { businessDayStartsAtMinutes, ...groups } = settings;
  const body = { ...groups };
  if (businessDayStartsAtMinutes !== undefined) body.business = { businessDayStartsAtMinutes };
  return body;
}

const issuesFrom = (prefix, error) =>
  error.issues.map((issue) => ({
    path: [prefix, ...issue.path.filter((part) => part !== 'body')].join('.'),
    message: issue.message,
  }));

/**
 * Validates the whole file, listing every problem. Returns
 * `{ config, toConfirm }` with "TO CONFIRM" values removed, or throws a
 * SetupConfigError carrying `issues`.
 */
export function validateSetupConfig(raw) {
  const issues = [];
  if (raw?.settings && 'invoice' in raw.settings) {
    issues.push({
      path: 'settings.invoice',
      message: 'The invoice series is never set by this script. Set it by hand on cutover day (GO-LIVE section 4).',
    });
  }

  const { value: config, found: toConfirm } = stripToConfirm(raw ?? {});
  // The invoice series is reported above in its own words, not as an unknown key.
  if (config.settings) delete config.settings.invoice;
  const shape = configShape.safeParse(config);
  if (!shape.success) issues.push(...issuesFrom('file', shape.error));

  if (shape.success) {
    const stationNames = new Set((config.stations ?? []).map((station) => station.name));

    if (config.restaurant && Object.keys(config.restaurant).length > 0) {
      const result = updateRestaurantSchema.safeParse({ body: config.restaurant });
      if (!result.success) issues.push(...issuesFrom('restaurant', result.error));
    }

    const body = settingsBody(config.settings);
    if (Object.keys(body).length > 0) {
      const result = updateSettingsSchema.safeParse({ body: { reason: SETTINGS_REASON, ...body } });
      if (!result.success) issues.push(...issuesFrom('settings', result.error));
    }

    // P22. The brand pair must read, as the settings service will insist.
    const appearance = config.settings?.appearance ?? {};
    if (appearance.brandHex && appearance.onBrandHex) {
      const verdict = checkBrandPair(appearance.brandHex, appearance.onBrandHex);
      if (!verdict.ok) issues.push({ path: 'settings.appearance.onBrandHex', message: verdict.message });
    }

    // P22. Every logo file, read and checked now, so a bad one never reaches --apply.
    const logos = {};
    for (const [slot, file] of Object.entries(config.logos ?? {})) {
      const at = `logos.${slot}`;
      let buffer;
      try {
        buffer = readFileSync(path.resolve(REPO_ROOT, file));
      } catch {
        issues.push({ path: at, message: `"${file}" cannot be read. Name it from the repository root.` });
        continue;
      }
      try {
        const checked = checkLogoFile(buffer);
        logos[slot] = { file, image: buffer.toString('base64'), sha256: checked.sha256, width: checked.width, height: checked.height };
      } catch (error) {
        issues.push({ path: at, message: error.fields?.image ?? error.message });
      }
    }
    if (config.logos) config.logos = logos;

    (config.stations ?? []).forEach((station, index) => {
      const result = createStationSchema.safeParse({ body: station });
      if (!result.success) issues.push(...issuesFrom(`stations[${index}]`, result.error));
    });

    for (const [category, station] of Object.entries(config.categoryStations ?? {})) {
      if (!stationNames.has(station)) {
        issues.push({ path: `categoryStations.${category}`, message: `"${station}" is not one of the stations in this file.` });
      }
    }
    if (config.defaultStation && !stationNames.has(config.defaultStation)) {
      issues.push({ path: 'defaultStation', message: `"${config.defaultStation}" is not one of the stations in this file.` });
    }

    if (config.tables) {
      const names = config.tables.names ?? [];
      const seen = new Set();
      names.forEach((name, index) => {
        if (seen.has(name.toLowerCase())) issues.push({ path: `tables.names[${index}]`, message: `"${name}" appears twice.` });
        seen.add(name.toLowerCase());
        const result = createTableSchema.safeParse({
          body: { name, section: config.tables.section, ...(config.tables.seats !== undefined ? { seats: config.tables.seats } : {}) },
        });
        if (!result.success) issues.push(...issuesFrom(`tables.names[${index}]`, result.error));
      });
    }

    (config.paymentMethods ?? []).forEach((method, index) => {
      const result = createPaymentMethodSchema.safeParse({ body: method });
      if (!result.success) issues.push(...issuesFrom(`paymentMethods[${index}]`, result.error));
    });

    (config.accounts ?? []).forEach((account, index) => {
      const result = createAccountSchema.safeParse({ body: account });
      if (!result.success) issues.push(...issuesFrom(`accounts[${index}]`, result.error));
    });

    (config.staff ?? []).forEach((person, index) => {
      const { station, ...rest } = person;
      if (station !== undefined && !stationNames.has(station)) {
        issues.push({ path: `staff[${index}].station`, message: `"${station}" is not one of the stations in this file.` });
      }
      if (rest.role === ROLES.OWNER) {
        issues.push({ path: `staff[${index}].role`, message: 'The owner is created by provisioning, not by this file.' });
      }
      if (rest.phone === undefined) return; // skipped when planning, and reported
      const result = createUserSchema.safeParse({ body: { ...rest, password: 'checked-placeholder' } });
      if (!result.success) issues.push(...issuesFrom(`staff[${index}]`, result.error));
    });
  }

  if (issues.length > 0) throw new SetupConfigError(issues);
  return { config, toConfirm };
}

export class SetupConfigError extends Error {
  constructor(issues) {
    super(`The setup file has ${issues.length} problem${issues.length === 1 ? '' : 's'}:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'SetupConfigError';
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------------ */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const lower = (text) => String(text).trim().toLowerCase();

/** Only the fields in `wanted` whose value differs from `current`. */
function changedFields(current, wanted) {
  const changes = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value === undefined) continue;
    const now = current?.[key];
    const isObject = value && typeof value === 'object' && !Array.isArray(value);
    if (isObject) {
      const inner = changedFields(now ?? {}, value);
      if (Object.keys(inner).length > 0) changes[key] = inner;
    } else if (!same(now, value)) {
      changes[key] = value;
    }
  }
  return changes;
}

const describeChanges = (changes) => Object.keys(changes).join(', ');

/**
 * What applying the file would do, as steps. Nothing changes until each
 * step's `run` is called. Station ids are looked up when a step runs, so a
 * station created earlier in the same run is found.
 */
export async function planSetup(client, config, { toConfirm = [] } = {}) {
  const steps = [];
  const [restaurant, settings, stations, tables, methods, accounts, users, categories] = await Promise.all([
    client.get('/restaurant'),
    client.get('/settings'),
    client.get('/stations?includeInactive=true'),
    client.get('/tables?includeInactive=true'),
    client.get('/payment-methods?includeInactive=true'),
    client.get('/accounts?includeInactive=true'),
    client.getAll('/users'),
    client.get('/categories?includeInactive=true'),
  ]);

  const stationIds = new Map(stations.map((station) => [lower(station.name), station.id]));
  const stationId = (name) => stationIds.get(lower(name)) ?? null;

  // The restaurant's profile.
  if (config.restaurant && Object.keys(config.restaurant).length > 0) {
    const changes = changedFields(restaurant, config.restaurant);
    if (changes.address) changes.address = { ...(restaurant.address ?? {}), ...config.restaurant.address };
    steps.push(
      Object.keys(changes).length === 0
        ? { section: 'Restaurant', name: restaurant.name, action: 'unchanged' }
        : {
            section: 'Restaurant',
            name: config.restaurant.name ?? restaurant.name,
            action: 'update',
            detail: describeChanges(changes),
            run: () => client.patch('/restaurant', changes),
          },
    );
  }

  // Settings, only the fields that differ.
  const wantedSettings = settingsBody(config.settings);
  if (Object.keys(wantedSettings).length > 0) {
    const changes = changedFields(settings, wantedSettings);
    steps.push(
      Object.keys(changes).length === 0
        ? { section: 'Settings', name: 'settings', action: 'unchanged' }
        : {
            section: 'Settings',
            name: 'settings',
            action: 'update',
            detail: Object.entries(changes).map(([group, fields]) => `${group}.${Object.keys(fields).join(`, ${group}.`)}`).join(', '),
            run: () => client.patch('/settings', { reason: SETTINGS_REASON, ...changes }),
          },
    );
  }

  // Stations.
  for (const station of config.stations ?? []) {
    const existing = stations.find((row) => lower(row.name) === lower(station.name));
    if (!existing) {
      steps.push({
        section: 'Stations',
        name: station.name,
        action: 'create',
        run: async () => {
          const created = await client.post('/stations', station);
          stationIds.set(lower(created.name), created.id);
          return created;
        },
      });
      continue;
    }
    const changes = changedFields(existing, { displayOrder: station.displayOrder, printsTickets: station.printsTickets });
    steps.push(
      Object.keys(changes).length === 0
        ? { section: 'Stations', name: station.name, action: 'unchanged' }
        : { section: 'Stations', name: station.name, action: 'update', detail: describeChanges(changes), run: () => client.patch(`/stations/${existing.id}`, changes) },
    );
  }

  // Category routing, for categories that already exist. The menu import routes the ones it creates.
  steps.push(...planCategoryRouting(client, categories, config, { stationId, stationIds }));

  // Tables.
  if (config.tables) {
    const { section = null, seats } = config.tables;
    config.tables.names.forEach((name, index) => {
      const existing = tables.find((row) => lower(row.name) === lower(name));
      const wanted = { section, displayOrder: index, ...(seats !== undefined ? { seats } : {}) };
      if (!existing) {
        steps.push({ section: 'Tables', name, action: 'create', run: () => client.post('/tables', { name, ...wanted }) });
        return;
      }
      const changes = changedFields(existing, wanted);
      steps.push(
        Object.keys(changes).length === 0
          ? { section: 'Tables', name, action: 'unchanged' }
          : { section: 'Tables', name, action: 'update', detail: describeChanges(changes), run: () => client.patch(`/tables/${existing.id}`, changes) },
      );
    });
  }

  // Payment methods, matched by code. Code and kind never change.
  for (const method of config.paymentMethods ?? []) {
    const existing = methods.find((row) => row.code === method.code);
    if (!existing) {
      steps.push({ section: 'Payment methods', name: `${method.code} ${method.name}`, action: 'create', run: () => client.post('/payment-methods', method) });
      continue;
    }
    if (existing.kind !== method.kind) {
      steps.push({ section: 'Payment methods', name: method.code, action: 'skip', detail: `it is ${existing.kind} here and a kind never changes` });
      continue;
    }
    const { code: _code, kind: _kind, ...editable } = method;
    const changes = changedFields(existing, editable);
    steps.push(
      Object.keys(changes).length === 0
        ? { section: 'Payment methods', name: `${method.code} ${method.name}`, action: 'unchanged' }
        : { section: 'Payment methods', name: `${method.code} ${method.name}`, action: 'update', detail: describeChanges(changes), run: () => client.patch(`/payment-methods/${existing.id}`, changes) },
    );
  }

  // On Hold accounts. An opening balance is set once, at creation.
  for (const account of config.accounts ?? []) {
    const existing = accounts.find((row) => lower(row.name) === lower(account.name));
    if (!existing) {
      steps.push({ section: 'Accounts', name: account.name, action: 'create', run: () => client.post('/accounts', account) });
      continue;
    }
    const { name: _name, openingBalanceInPaise, ...editable } = account;
    if (openingBalanceInPaise !== undefined && openingBalanceInPaise !== existing.openingBalanceInPaise) {
      steps.push({ section: 'Accounts', name: account.name, action: 'note', detail: 'the opening balance is set once and differs; adjust the balance by hand if it is wrong' });
    }
    const changes = changedFields(existing, editable);
    steps.push(
      Object.keys(changes).length === 0
        ? { section: 'Accounts', name: account.name, action: 'unchanged' }
        : { section: 'Accounts', name: account.name, action: 'update', detail: describeChanges(changes), run: () => client.patch(`/accounts/${existing.id}`, changes) },
    );
  }

  // Staff, matched by name. A password is generated only for a new login.
  for (const person of config.staff ?? []) {
    if (!person.phone) {
      steps.push({ section: 'Staff', name: person.name, action: 'skip', detail: 'no confirmed phone, and a login needs one' });
      continue;
    }
    const existing = users.find((row) => lower(row.name) === lower(person.name));
    if (!existing) {
      steps.push({
        section: 'Staff',
        name: `${person.name} (${person.role})`,
        action: 'create',
        run: async () => {
          const password = generatePassword();
          const created = await client.post('/users', {
            name: person.name,
            phone: person.phone,
            role: person.role,
            password,
            ...(person.station ? { stationId: stationId(person.station) } : {}),
          });
          return { login: { name: created.name, phone: created.phone, role: created.role, password } };
        },
      });
      continue;
    }
    const roleChanged = existing.role !== person.role;
    const stationWanted = person.role === ROLES.KITCHEN && person.station ? person.station : null;
    const currentStation = stations.find((station) => station.id === existing.stationId)?.name ?? null;
    const stationChanged = stationWanted !== null && lower(stationWanted) !== lower(currentStation ?? '');
    if (!roleChanged && !stationChanged) {
      steps.push({ section: 'Staff', name: person.name, action: 'unchanged' });
      continue;
    }
    steps.push({
      section: 'Staff',
      name: person.name,
      action: 'update',
      detail: [roleChanged ? 'role' : null, stationChanged ? 'station' : null].filter(Boolean).join(', '),
      run: () =>
        client.patch(`/users/${existing.id}`, {
          ...(roleChanged ? { role: person.role } : {}),
          ...(stationWanted ? { stationId: stationId(stationWanted) } : {}),
        }),
    });
  }

  // P22. Logos, through the same endpoint and checks as the Appearance page.
  if (config.logos && Object.keys(config.logos).length > 0) {
    const me = await client.get('/auth/me');
    for (const [slot, logo] of Object.entries(config.logos)) {
      const current = me.appearance?.logos?.[slot]?.hash ?? null;
      const name = `${slot} ${logo.file} (${logo.width} x ${logo.height})`;
      steps.push(
        current === logo.sha256
          ? { section: 'Logos', name, action: 'unchanged' }
          : {
              section: 'Logos',
              name,
              action: current ? 'update' : 'create',
              run: () => client.put(`/settings/appearance/logo/${slot}`, { reason: SETTINGS_REASON, image: logo.image }),
            },
      );
    }
  }

  for (const at of toConfirm) {
    steps.push({ section: 'Still TO CONFIRM, not sent', name: at, action: 'skip' });
  }

  return steps;
}

/**
 * Routes each category to its station: the file's map, or the default
 * station. Shared with the menu import, which routes the categories it makes.
 */
export function planCategoryRouting(client, categories, config, { stationId }) {
  if (!config.categoryStations && !config.defaultStation) return [];
  return categories.map((category) => {
    const wantedName = config.categoryStations?.[category.name] ?? config.defaultStation;
    if (!wantedName) return { section: 'Category stations', name: category.name, action: 'unchanged' };
    const current = category.stationId ?? null;
    const known = stationId(wantedName);
    if (known && known === current) {
      return { section: 'Category stations', name: `${category.name} -> ${wantedName}`, action: 'unchanged' };
    }
    return {
      section: 'Category stations',
      name: `${category.name} -> ${wantedName}`,
      action: 'update',
      run: () => client.patch(`/categories/${category.id}`, { stationId: stationId(wantedName) }),
    };
  });
}

/** Applies the plan. Returns the counts and the new logins with their passwords. */
export async function applySetup(steps) {
  const results = await applySteps(steps);
  const logins = results.map(({ result }) => result?.login).filter(Boolean);
  return { counts: countSteps(steps), logins };
}

/* ------------------------------------------------------------------------ *
 * The command line
 * ------------------------------------------------------------------------ */

function printLogins(logins) {
  if (logins.length === 0) return;
  console.log('\nNew staff logins. Each password is shown once, now. Hand them over privately.\n');
  const width = Math.max(...logins.map((login) => login.name.length), 4);
  console.log(`  ${'Name'.padEnd(width)}  Phone          Role        Password`);
  for (const login of logins) {
    console.log(`  ${login.name.padEnd(width)}  ${String(login.phone).padEnd(13)}  ${login.role.padEnd(10)}  ${login.password}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error('Give the setup file with --config, for example --config setup/zchaat.json.');
  const file = path.resolve(process.env.INIT_CWD ?? process.cwd(), args.config);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const { config, toConfirm } = validateSetupConfig(raw);

  const session = await startOwnerSession(args['owner-phone']);
  try {
    console.log(`\nRestaurant: ${session.restaurantName}`);
    const steps = await planSetup(session.client, config, { toConfirm });
    console.log(formatPlan(steps));

    if (!args.apply) {
      const counts = countSteps(steps);
      console.log(`\nDry run. Nothing was changed. Would create ${counts.create}, update ${counts.update}, leave ${counts.unchanged} as they are, skip ${counts.skip}.`);
      console.log('Run again with --apply to make these changes.');
      return;
    }

    const { counts, logins } = await applySetup(steps);
    console.log(`\nDone. Created ${counts.create}, updated ${counts.update}, unchanged ${counts.unchanged}, skipped ${counts.skip}.`);
    printLogins(logins);
  } finally {
    await session.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
