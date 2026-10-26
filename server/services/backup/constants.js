/**
 * The numbers backups live by. P54, docs/prompts/P54-constant-backups.md.
 * Each is named here once, with why, so a change is one line in one place.
 */

/**
 * Never copied, never in the diary: sessions must not come back after a restore, and the backups' own records would record themselves.
 * P62: nor replication's own state, which belongs to one machine. The changelog itself stays in the copy (it is the box's history)
 * but out of the diary, where every entry would only repeat a change the diary already holds.
 */
export const EXCLUDED_COLLECTIONS = Object.freeze(['refreshtokens', 'backupruns', 'backupstate', 'replicationstate']);
/** P62. Left out of the change diary only. */
export const DIARY_ONLY_EXCLUDED = Object.freeze(['changelog', 'changelogcounters']);

/** The file format, written in every snapshot's manifest and every file's header. */
export const FORMAT_VERSION = 1;

/** Documents read per batch: Atlas M0 allows 100 operations a second, shared with the restaurant. */
export const READ_BATCH = 500;

/** A RUNNING copy older than this was interrupted, and the next one may run. */
export const SNAPSHOT_STALE_MS = 30 * 60_000;

/** The slow-down rule: a week's reading for copies every 6 hours, in bytes. */
export const COPIES_A_WEEK_EVERY_6_HOURS = 28;
export const SLOW_DOWN_ABOVE_BYTES = 4 * 1024 ** 3;
export const SPEED_UP_BELOW_BYTES = 3 * 1024 ** 3;

/** The diary uploads every 5 minutes, or sooner at 5,000 events or 5 MB. */
export const FLUSH_EVERY_MS = 5 * 60_000;
export const FLUSH_AT_EVENTS = 5000;
export const FLUSH_AT_BYTES = 5 * 1024 ** 2;
/** Past this many bytes waiting, the diary stops: Render's free instance has 512 MB and serves the restaurant too. */
export const MAX_WAITING_BYTES = 20 * 1024 ** 2;
/** A failed upload is tried again after these, then every 10 minutes. */
export const FLUSH_RETRY_MS = Object.freeze([30_000, 2 * 60_000, 10 * 60_000]);
/**
 * After a failed full copy, the wait before the next: every try reads the
 * whole database, which counts against Atlas M0's weekly read limit, so a
 * wrong key must not read it once a minute until someone notices.
 */
export const SNAPSHOT_RETRY_MS = Object.freeze([2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000]);

/** How long the bucket keeps each folder (its lifecycle rules, DEPLOYMENT.md section 8). Null is forever. */
export const KEEP_DAYS = Object.freeze({ '6h': 11, daily: 91, monthly: null, journal: null });

/** Atlas M0's storage limit. It changes if the cluster's tier does. */
export const ATLAS_M0_LIMIT_BYTES = 512 * 1024 ** 2;
/** Backblaze B2's free storage. */
export const B2_FREE_BYTES = 10_000_000_000;

/** LATE: a change waiting this long, or no full copy for this long. */
export const LATE_WAITING_MS = 15 * 60_000;
export const LATE_SNAPSHOT_MS = { EVERY_6_HOURS: 7 * 3600_000, DAILY: 25 * 3600_000 };
