/**
 * Environment configuration.
 *
 * This is the ONLY file in the server that is allowed to read the raw
 * environment. Everything else imports the frozen `config` object from here.
 * Run this to prove it:
 *
 *   grep -rn "process.env" server/ --exclude-dir=node_modules
 *
 * Every variable listed in .env.example is validated below. If anything is
 * missing or malformed the server prints exactly what is wrong and exits.
 * We fail loudly at boot, not quietly at 9pm on a Saturday.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { parseTrustProxy } from './trustProxy.js';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CONFIG_DIR, '..', '..');
const ENV_FILE = path.join(REPO_ROOT, '.env');

// dotenv never overwrites a variable that is already set, so a real deployment
// can inject values without a file on disk.
dotenv.config({ path: ENV_FILE });

const MIN_SECRET_LENGTH = 32;

const missingMessage = (name) =>
  `${name} is missing or empty. Add it to .env — copy .env.example and fill it in.`;

/** A variable that must be present and non-empty. */
function requiredVar(name) {
  return z.preprocess(
    (value) => (value === undefined || value === null ? '' : String(value).trim()),
    z.string().min(1, missingMessage(name)),
  );
}

/** A variable that falls back to a documented default when absent. */
function optionalVar(name, fallback) {
  return z.preprocess((value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    return text === '' ? fallback : text;
  }, z.string().min(1, missingMessage(name)));
}

/**
 * Wraps a check so it only runs on a value that is actually present. Without
 * this, one missing variable reports both "is missing" and "is malformed".
 */
const whenPresent = (predicate) => (value) => value.length === 0 || predicate(value);

/**
 * A whole number within bounds. All the checking happens in one refinement so
 * a bad value produces one clear sentence instead of three overlapping ones.
 */
function intVar(name, { min, max, fallback } = {}) {
  const base = fallback === undefined ? requiredVar(name) : optionalVar(name, String(fallback));
  const bounds = [];
  if (min !== undefined) bounds.push(`at least ${min}`);
  if (max !== undefined) bounds.push(`at most ${max}`);
  const rule = `${name} must be a whole number${bounds.length > 0 ? `, ${bounds.join(' and ')}` : ''}.`;

  return base
    .refine((text) => {
      if (!/^\d+$/.test(text)) return false;
      const parsed = Number(text);
      if (!Number.isSafeInteger(parsed)) return false;
      if (min !== undefined && parsed < min) return false;
      if (max !== undefined && parsed > max) return false;
      return true;
    }, rule)
    .transform((text) => Number(text));
}

function enumVar(name, allowed, fallback) {
  return optionalVar(name, fallback).refine(
    (value) => allowed.includes(value),
    `${name} must be one of: ${allowed.join(', ')}.`,
  );
}

function secretVar(name) {
  return requiredVar(name)
    .refine(
      whenPresent((value) => !/replace_me/i.test(value)),
      `${name} is still the placeholder from .env.example. Generate a real one with: openssl rand -base64 48`,
    )
    .refine(
      whenPresent((value) => value.length >= MIN_SECRET_LENGTH),
      `${name} must be at least ${MIN_SECRET_LENGTH} characters long.`,
    );
}

// The duration format the `ms` package understands, which is what
// jsonwebtoken accepts for expiresIn. A bare number means seconds.
const DURATION_PATTERN = /^\d+(?:\.\d+)?\s*(?:ms|s|m|h|d|w|y)?$/i;

function durationVar(name, fallback) {
  return optionalVar(name, fallback).refine(
    whenPresent((value) => DURATION_PATTERN.test(value)),
    `${name} must be a duration like 15m, 24h, 30d, or a plain number of seconds.`,
  );
}

/** An origin is scheme + host + port. No path, no trailing slash — CORS compares it literally. */
function isHttpOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin === value;
  } catch {
    return false;
  }
}

/**
 * TRUST_PROXY, parsed by config/trustProxy.js.
 *
 * Not `optionalVar`: that replaces an absent value with its fallback, and
 * production has to tell "absent" apart from "set to false" (see the refine on
 * the schema below). So the raw text travels alongside the parsed value until
 * that check has run, and only the parsed value reaches `config`.
 */
const trustProxyVar = z
  .preprocess((value) => (value === undefined || value === null ? '' : String(value).trim()), z.string())
  .transform((raw, ctx) => {
    try {
      return { raw, value: parseTrustProxy(raw) };
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

/** Present text, or null when absent or empty. */
const nullableText = z.preprocess((value) => {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text === '' ? null : text;
}, z.string().nullable());

/** P54. A backup key: 32 random bytes in base64, never the .env.example placeholder. */
export function backupKeyProblem(name, value) {
  if (/replace_me/i.test(value)) return `${name} is still the placeholder from .env.example. Make a key with: npm run backup:key`;
  if (Buffer.from(value, 'base64').length !== 32) return `${name} must be 32 random bytes in base64. Make one with: npm run backup:key`;
  return null;
}

/** P54. What backups need to run, in the order a person would fill them in. */
export const BACKUP_REQUIRED = Object.freeze([
  'BACKUP_ENCRYPTION_KEY',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_REGION',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_KEY_ID',
  'BACKUP_S3_SECRET',
]);

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z
  .object({
    NODE_ENV: enumVar('NODE_ENV', ['development', 'test', 'production'], 'development'),
    PORT: intVar('PORT', { min: 1, max: 65535, fallback: 5000 }),

    MONGO_URI: requiredVar('MONGO_URI').refine(
      whenPresent((value) => /^mongodb([+]srv)?:[/][/].+/.test(value)),
      'MONGO_URI must start with mongodb:// or mongodb+srv://',
    ),

    JWT_ACCESS_SECRET: secretVar('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secretVar('JWT_REFRESH_SECRET'),
    ACCESS_TOKEN_TTL: durationVar('ACCESS_TOKEN_TTL', '15m'),
    // 2026-10-14: a year, renewed on every refresh, so a device in use stays signed in until Sign out.
    REFRESH_TOKEN_TTL: durationVar('REFRESH_TOKEN_TTL', '365d'),
    BCRYPT_ROUNDS: intVar('BCRYPT_ROUNDS', { min: 10, max: 15, fallback: 12 }),

    CLIENT_ORIGIN: requiredVar('CLIENT_ORIGIN').refine(
      whenPresent(isHttpOrigin),
      'CLIENT_ORIGIN must be a bare origin with no trailing slash, for example http://localhost:5173',
    ),

    LOGIN_RATE_LIMIT_WINDOW_MINUTES: intVar('LOGIN_RATE_LIMIT_WINDOW_MINUTES', {
      min: 1,
      max: 1440,
      fallback: 15,
    }),
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: intVar('LOGIN_RATE_LIMIT_MAX_ATTEMPTS', {
      min: 1,
      max: 1000,
      fallback: 10,
    }),

    DISPLAY_TIMEZONE: optionalVar('DISPLAY_TIMEZONE', 'Asia/Kolkata').refine(
      whenPresent(isValidTimeZone),
      'DISPLAY_TIMEZONE must be an IANA time zone name, for example Asia/Kolkata.',
    ),

    TRUST_PROXY: trustProxyVar,

    /**
     * P24. The key that encrypts each cafe's Razorpay secrets in the database:
     * 32 random bytes, base64. Optional: without it, connecting a gateway is
     * refused and the page takes requests without payment.
     * Generate with: openssl rand -base64 32
     */
    PAYMENT_SECRETS_KEY: z.preprocess(
      (value) => {
        const text = value === undefined || value === null ? '' : String(value).trim();
        return text === '' ? null : text;
      },
      z
        .string()
        .refine((value) => Buffer.from(value, 'base64').length === 32 && !/replace_me/i.test(value), {
          message: 'PAYMENT_SECRETS_KEY must be 32 random bytes in base64. Generate one with: openssl rand -base64 32',
        })
        .nullable(),
    ),

    /**
     * P25 Part G. Encrypts every partner credential (Pine Labs, Swiggy, Zomato)
     * in the database: 32 random bytes, base64. Required in production; in
     * development and test a fixed development key stands in, with a warning.
     * Separate from PAYMENT_SECRETS_KEY so rotating one never touches the other.
     */
    INTEGRATION_SECRETS_KEY: z.preprocess(
      (value) => {
        const text = value === undefined || value === null ? '' : String(value).trim();
        return text === '' ? null : text;
      },
      z
        .string()
        .refine((value) => Buffer.from(value, 'base64').length === 32 && !/replace_me/i.test(value), {
          message: 'INTEGRATION_SECRETS_KEY must be 32 random bytes in base64. Make one with: openssl rand -base64 32',
        })
        .nullable(),
    ),

    /**
     * P33. The live channel: `on` (default) or `off`. Off is the rollback: no
     * socket, nothing announced, every screen polls as before P33.
     */
    LIVE_CHANNEL: optionalVar('LIVE_CHANNEL', 'on').refine((value) => ['on', 'off'].includes(value), 'LIVE_CHANNEL must be on or off.'),

    /**
     * P33. The address screens open the live channel on, when it is not the
     * page's own: a page on Vercel reaches the API through a rewrite that does
     * not carry a WebSocket. Falls back to RENDER_EXTERNAL_URL, which Render
     * sets itself, then to null, meaning the page's own address.
     */
    LIVE_ORIGIN: z.preprocess((value) => {
      const given = value === undefined || value === null || String(value).trim() === '' ? process.env.RENDER_EXTERNAL_URL : value;
      const text = given === undefined || given === null ? '' : String(given).trim();
      return text === '' ? null : text;
    }, z.string().regex(/^https?:[/][/][^/]+$/, 'LIVE_ORIGIN must be a bare origin with no trailing slash.').nullable()),

    /**
     * P44. The day-end email, through Resend. Without RESEND_API_KEY nothing is
     * emailed and the Day End page says so; the rest works. Until a domain is
     * verified in Resend, onboarding@resend.dev delivers only to the Resend
     * account's own address.
     */
    RESEND_API_KEY: z.preprocess((value) => (value === undefined || value === '' ? null : value), z.string().nullable()),
    DAY_END_EMAIL_FROM: optionalVar('DAY_END_EMAIL_FROM', "Three O'Clock <onboarding@resend.dev>"),
    RESEND_API_BASE: optionalVar('RESEND_API_BASE', 'https://api.resend.com').refine(
      whenPresent((value) => /^https?:[/][/][^/]+$/.test(value)),
      'RESEND_API_BASE must be a bare origin with no trailing slash.',
    ),

    /**
     * P54. Backups to Backblaze B2 through its S3 API. Off by default, and
     * always off under NODE_ENV=test, where tests call the services directly.
     * With on, every variable in BACKUP_REQUIRED must be set: see the refine
     * below. The drill key is for the restore tools only, never the server.
     */
    BACKUP_ENABLED: enumVar('BACKUP_ENABLED', ['on', 'off'], 'off'),
    BACKUP_ENCRYPTION_KEY: nullableText,
    BACKUP_OLD_KEYS: nullableText.transform((value) => (value ? value.split(',').map((key) => key.trim()).filter(Boolean) : [])),
    BACKUP_S3_ENDPOINT: nullableText,
    BACKUP_S3_REGION: nullableText,
    BACKUP_S3_BUCKET: nullableText,
    BACKUP_S3_KEY_ID: nullableText,
    BACKUP_S3_SECRET: nullableText,
    BACKUP_DRILL_KEY_ID: nullableText,
    BACKUP_DRILL_SECRET: nullableText,

    /**
     * P62. Where this process runs, and so what it may write.
     *   CLOUD   the hosted server of P12 to P61: the only writer, in the cloud. The default,
     *           so nothing changes for a deployment that sets nothing.
     *   BOX     the cafe box: the only writer, on the cafe's LAN, shipping its changes up.
     *   MIRROR  the cloud copy: read-only except intake, the replication receiver and sign-in,
     *           until a person promotes it (docs/RUNBOOK.md).
     */
    DEPLOYMENT_ROLE: enumVar('DEPLOYMENT_ROLE', ['CLOUD', 'BOX', 'MIRROR'], 'CLOUD'),
    // P63. TWO_WAY on a BOX and a CLOUD: both write, and the box keeps them in step.
    SYNC_MODE: enumVar('SYNC_MODE', ['ONE_WAY', 'TWO_WAY'], 'ONE_WAY'),
    /**
     * P63. How often the cafe PC syncs with the website during SYNC_HOURS, in seconds. BOX only.
     * Every request keeps Render's free server awake, so the hours matter more than the seconds.
     */
    SYNC_EVERY_SECONDS: intVar('SYNC_EVERY_SECONDS', { min: 10, max: 3600, fallback: 60 }),
    /**
     * P63. The hours, India time, when the PC syncs on its own pace, like 08:30-02:30 (past
     * midnight is fine), or "always". Outside them it syncs only when it has something to send,
     * at most every 15 minutes, so Render's free server sleeps at night. BOX only.
     */
    SYNC_HOURS: optionalVar('SYNC_HOURS', '08:30-02:30').refine(
      (value) => value === 'always' || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value),
      'SYNC_HOURS must be like 08:30-02:30, or always.',
    ),
    /** P62. The mirror's replication address, as the box reaches it, e.g. https://cafe-mirror.example.com. BOX only. */
    MIRROR_URL: nullableText.refine((value) => value === null || /^https?:[/][/][^/]+$/.test(value), 'MIRROR_URL must be a bare origin with no trailing slash.'),
    /** P62. The secret the box and the mirror sign every replication request with. Both sides hold the same value. */
    REPLICATION_SECRET: nullableText.refine((value) => value === null || value.length >= MIN_SECRET_LENGTH, `REPLICATION_SECRET must be at least ${MIN_SECRET_LENGTH} characters. Make one with: openssl rand -base64 48`),
    /** P62. The box's own data folder: local snapshots and the network settings file. BOX only. */
    BOX_DATA_DIR: optionalVar('BOX_DATA_DIR', path.join(REPO_ROOT, 'box-data')),
    /** P62. The address staff type on a tablet, shown on the setup card, e.g. http://192.168.1.10. BOX only. */
    BOX_PUBLIC_URL: nullableText.refine((value) => value === null || /^https?:[/][/][^/]+$/.test(value), 'BOX_PUBLIC_URL must be a bare origin with no trailing slash.'),
    /** P62. The box's second name, without the internet's DNS: avahi's mDNS name, e.g. http://cafezza.local. Optional. */
    BOX_LOCAL_NAME_URL: nullableText.refine((value) => value === null || /^https?:[/][/][^/]+$/.test(value), 'BOX_LOCAL_NAME_URL must be a bare origin with no trailing slash.'),
    /** P62. The network adapter the box uses for WiFi (wlan0, en0, Wi-Fi). Found by itself when unset. */
    BOX_WIFI_INTERFACE: nullableText,
    /** P62. `on` lets the owner change the box's WiFi from the dashboard. Off by default: it needs the box set up for it. */
    BOX_WIFI_CONTROL: enumVar('BOX_WIFI_CONTROL', ['on', 'off'], 'off'),

    /** P24. Razorpay's API address. Tests and the e2e server point it at a fake. */
    RAZORPAY_API_BASE: optionalVar('RAZORPAY_API_BASE', 'https://api.razorpay.com').refine(
      whenPresent((value) => /^https?:[/][/][^/]+$/.test(value)),
      'RAZORPAY_API_BASE must be a bare origin with no trailing slash.',
    ),

    /**
     * P12. The git commit being deployed, shown on GET /api/v1/health so a
     * smoke check can tell which version answered. Optional; null when unset.
     */
    RELEASE_VERSION: z.preprocess((value) => {
      // P30. Render sets RENDER_GIT_COMMIT itself on every deploy, so a start
      // can be told apart from a wake from sleep without setting this by hand.
      const given = value === undefined || value === null || String(value).trim() === '' ? process.env.RENDER_GIT_COMMIT : value;
      const text = given === undefined || given === null ? '' : String(given).trim();
      return text === '' ? null : text;
    }, z.string().max(100, 'RELEASE_VERSION must be at most 100 characters.').nullable()),
  })
  .refine((values) => values.JWT_ACCESS_SECRET !== values.JWT_REFRESH_SECRET, {
    error: 'JWT_REFRESH_SECRET must be a different value from JWT_ACCESS_SECRET.',
    path: ['JWT_REFRESH_SECRET'],
  })
  // P25 Part G. Partner credentials are never stored under a key everyone knows.
  .refine((values) => values.NODE_ENV !== 'production' || values.INTEGRATION_SECRETS_KEY, {
    error: 'INTEGRATION_SECRETS_KEY must be set in production. Make one with: openssl rand -base64 32',
    path: ['INTEGRATION_SECRETS_KEY'],
  })
  // P54. Backups switched on with something missing would fail quietly at the
  // first copy; fail loudly at boot instead, naming what is missing.
  .superRefine((values, ctx) => {
    if (values.BACKUP_ENABLED !== 'on' || values.NODE_ENV === 'test') return;
    for (const name of BACKUP_REQUIRED) {
      if (!values[name]) ctx.addIssue({ code: 'custom', path: [name], message: `${name} must be set when BACKUP_ENABLED is on. See docs/DEPLOYMENT.md section 8.` });
    }
    if (values.BACKUP_ENCRYPTION_KEY) {
      const problem = backupKeyProblem('BACKUP_ENCRYPTION_KEY', values.BACKUP_ENCRYPTION_KEY);
      if (problem) ctx.addIssue({ code: 'custom', path: ['BACKUP_ENCRYPTION_KEY'], message: problem });
    }
    for (const old of values.BACKUP_OLD_KEYS) {
      const problem = backupKeyProblem('BACKUP_OLD_KEYS', old);
      if (problem) ctx.addIssue({ code: 'custom', path: ['BACKUP_OLD_KEYS'], message: problem });
    }
  })
  // P62. A box that ships, and a mirror that receives, both need the shared secret.
  .superRefine((values, ctx) => {
    if (values.NODE_ENV === 'test') return;
    if (values.DEPLOYMENT_ROLE === 'MIRROR' && !values.REPLICATION_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['REPLICATION_SECRET'], message: 'REPLICATION_SECRET must be set on the mirror. See docs/REPLICATION.md section 5.' });
    }
    if (values.SYNC_MODE === 'TWO_WAY' && values.DEPLOYMENT_ROLE === 'MIRROR') {
      ctx.addIssue({ code: 'custom', path: ['SYNC_MODE'], message: 'SYNC_MODE=TWO_WAY is for a BOX and a CLOUD, never a MIRROR. See docs/REPLICATION.md section 13.' });
    }
    if (values.SYNC_MODE === 'TWO_WAY' && !values.REPLICATION_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['REPLICATION_SECRET'], message: 'REPLICATION_SECRET must be set for SYNC_MODE=TWO_WAY, the same on the box and the cloud.' });
    }
    if (values.DEPLOYMENT_ROLE === 'BOX' && values.MIRROR_URL && !values.REPLICATION_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['REPLICATION_SECRET'], message: 'REPLICATION_SECRET must be set when MIRROR_URL is. See docs/REPLICATION.md section 5.' });
    }
  })
  // In development and test an absent TRUST_PROXY means false. In production
  // someone has to have decided, even if the decision is false.
  .refine((values) => values.NODE_ENV !== 'production' || values.TRUST_PROXY?.raw !== '', {
    error:
      'TRUST_PROXY must be set in production. Use 1 when the host puts one proxy in front of the ' +
      'server, or false when nothing sits in front of it.',
    path: ['TRUST_PROXY'],
  });

function reportAndExit(error) {
  const lines = new Set(
    error.issues.map((issue) => {
      const name = issue.path.length > 0 ? String(issue.path[0]) : 'environment';
      return `  - ${name}: ${issue.message}`;
    }),
  );

  // console, not the logger. The logger imports this file, and a half-configured
  // process should say what is wrong in the plainest way available.
  console.error('');
  console.error('The server cannot start. The environment is not configured correctly.');
  console.error(`Looked for a .env file at: ${ENV_FILE}`);
  console.error('');
  console.error(`Problems found (${lines.size}):`);
  for (const line of lines) console.error(line);
  console.error('');
  console.error('Fix these in .env and start again. .env.example lists every variable.');
  console.error('');
  process.exit(1);
}

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) reportAndExit(parsed.error);

export const config = Object.freeze({
  ...parsed.data,
  // false, a number of proxies, or an array of trusted addresses.
  TRUST_PROXY: parsed.data.TRUST_PROXY.value,
  isDevelopment: parsed.data.NODE_ENV === 'development',
  isTest: parsed.data.NODE_ENV === 'test',
  isProduction: parsed.data.NODE_ENV === 'production',
  // P54. Never under test: the tests drive the backup services themselves.
  backupsOn: parsed.data.BACKUP_ENABLED === 'on' && parsed.data.NODE_ENV !== 'test',
  // P62. Which machine this is. Read through these, never by comparing the string again.
  isBox: parsed.data.DEPLOYMENT_ROLE === 'BOX',
  isMirror: parsed.data.DEPLOYMENT_ROLE === 'MIRROR',
});
