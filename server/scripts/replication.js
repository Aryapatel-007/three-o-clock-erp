/**
 * Replication by hand. P62 section 8, docs/RUNBOOK.md sections 5 to 7.
 *
 *   npm run replication -- status
 *   npm run replication -- promote --confirm PROMOTE        (on the mirror)
 *   npm run replication -- demote --confirm DEMOTE          (on the mirror)
 *   npm run replication -- adopt-epoch --epoch 2 --confirm ADOPT   (on a rebuilt box)
 *   npm run replication -- reset-cursor --restaurant <id> --seq <n> --confirm RESET   (on the mirror, after adopt-epoch)
 *   npm run replication -- baseline --confirm BASELINE      (on the box)
 *
 * Each changing command needs its word typed after --confirm, so it cannot be
 * run by a slip of the up-arrow. Each prints what it changed.
 */
import { pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { config } from '../config/env.js';
import { ChangelogEntry } from '../models/ChangelogEntry.js';
import { ChangelogWriter } from '../services/replication/changelogWriter.js';
import { adoptEpoch, appliedPositions, demoteMirror, promoteMirror, resetCursor } from '../services/replication/epoch.js';
import { shippingLag } from '../services/replication/shipper.js';
import { loadWriterState } from '../services/replication/writerState.js';
import { databaseHost } from './listRestaurants.js';

const when = (date) => (date ? new Date(date).toLocaleString('en-IN', { timeZone: config.DISPLAY_TIMEZONE }) : 'never');

export function parseArgs(argv) {
  const args = { command: argv[0] ?? 'status', confirm: null, epoch: null, restaurant: null, seq: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--confirm') args.confirm = argv[++i] ?? null;
    else if (argv[i] === '--epoch') args.epoch = argv[++i] ?? null;
    else if (argv[i] === '--restaurant') args.restaurant = argv[++i] ?? null;
    else if (argv[i] === '--seq') args.seq = argv[++i] ?? null;
    else throw new Error(`Unknown argument ${argv[i]}.`);
  }
  return args;
}

function needWord(args, word) {
  if (args.confirm !== word) throw new Error(`Type --confirm ${word} to do this. Nothing was changed.`);
}

async function printPositions(log) {
  for (const row of await appliedPositions()) {
    log(`  ${row.name} (${row.restaurantId}): last applied entry ${row.appliedSeq}, made on the box at ${when(row.lastCapturedAt)}${row.gap ? `; STOPPED AT A GAP, expects ${row.gap.expectedSeq}` : ''}`);
  }
}

export async function run(argv, log = console.log) {
  const args = parseArgs(argv);
  log(`Database: ${databaseHost()}  Role: ${config.DEPLOYMENT_ROLE}`);
  const writer = await loadWriterState();
  log(`Epoch ${writer.epoch}${writer.promoted ? ', promoted (this mirror is the writer)' : ''}${writer.fenced ? `, STOOD DOWN: ${writer.fencedReason}` : ''}`);

  if (args.command === 'status') {
    if (config.DEPLOYMENT_ROLE === 'MIRROR') return printPositions(log);
    for (const restaurantId of await ChangelogEntry.distinct('restaurantId', { restaurantId: { $exists: true } })) {
      const lag = await shippingLag(restaurantId);
      log(`  ${restaurantId}: newest entry ${lag.newestSeq}, mirror has ${lag.shippedSeq}, ${lag.entriesWaiting} waiting (${lag.secondsBehind}s)${lag.lastError ? `; last error: ${lag.lastError}` : ''}`);
    }
    return undefined;
  }
  if (args.command === 'promote') {
    if (config.DEPLOYMENT_ROLE !== 'MIRROR') throw new Error('Promote runs on the cloud mirror, with DEPLOYMENT_ROLE=MIRROR.');
    log('What the cloud copy has, per restaurant. Anything the box made after these times is not here:');
    await printPositions(log);
    needWord(args, 'PROMOTE');
    const outcome = await promoteMirror();
    log(outcome.already ? `Already promoted at epoch ${outcome.epoch}. Nothing changed.` : `Promoted. This mirror is the writer at epoch ${outcome.epoch}. Restart the mirror's server so it picks this up within 10 seconds, then follow docs/RUNBOOK.md section 6 step 6.`);
    return outcome;
  }
  if (args.command === 'demote') {
    if (config.DEPLOYMENT_ROLE !== 'MIRROR') throw new Error('Demote runs on the cloud mirror.');
    needWord(args, 'DEMOTE');
    const after = await demoteMirror();
    log(`Read-only again at epoch ${after.epoch}. The box must hold epoch ${after.epoch}: npm run replication -- adopt-epoch --epoch ${after.epoch} --confirm ADOPT on the box.`);
    return after;
  }
  if (args.command === 'adopt-epoch') {
    if (config.DEPLOYMENT_ROLE !== 'BOX') throw new Error('adopt-epoch runs on the box.');
    needWord(args, 'ADOPT');
    const after = await adoptEpoch(args.epoch);
    log(`This box now holds epoch ${after.epoch} and may write. Its changes from before the rebuild will not be sent.`);
    log('Now, on the cloud, for each restaurant:');
    for (const row of after.resume) log(`  npm run replication -- reset-cursor --restaurant ${row.restaurantId} --seq ${row.seq} --confirm RESET    (${row.name})`);
    log('Then on this box: npm run replication -- baseline --confirm BASELINE, and start the server.');
    return after;
  }
  if (args.command === 'reset-cursor') {
    if (config.DEPLOYMENT_ROLE !== 'MIRROR') throw new Error('reset-cursor runs on the cloud mirror.');
    needWord(args, 'RESET');
    const after = await resetCursor(args.restaurant, args.seq);
    log(`The cloud copy takes ${after.restaurantId}'s changes from entry ${after.appliedSeq + 1}.`);
    return after;
  }
  if (args.command === 'baseline') {
    if (config.DEPLOYMENT_ROLE !== 'BOX') throw new Error('baseline runs on the box.');
    needWord(args, 'BASELINE');
    const count = await new ChangelogWriter({ db: mongoose.connection.db }).baseline();
    log(`Captured ${count} documents into the changelog. The shipper sends them next.`);
    return count;
  }
  throw new Error(`Unknown command ${args.command}. Use status, promote, demote, adopt-epoch, reset-cursor or baseline.`);
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  try {
    await connectDatabase();
    await run(process.argv.slice(2));
    await disconnectDatabase();
  } catch (error) {
    console.error(error.message);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  }
}
