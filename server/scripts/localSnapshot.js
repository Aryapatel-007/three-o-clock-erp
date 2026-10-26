/**
 * Takes the box's local snapshot. P62 section 4.2.
 *
 *   npm run snapshot:local            take one now (the hourly timer runs this)
 *   npm run snapshot:local -- list    what is kept, and how much disk it uses
 *
 * Reads MONGO_URI and BOX_DATA_DIR. The archives go to BOX_DATA_DIR/snapshots.
 * Restoring is docs/RUNBOOK.md section 8, always with --oplogReplay.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { config } from '../config/env.js';
import { snapshotUsage, takeSnapshot } from '../services/replication/localSnapshot.js';

const dir = path.join(config.BOX_DATA_DIR, 'snapshots');

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  try {
    if (process.argv[2] === 'list') {
      const usage = await snapshotUsage(dir);
      for (const [tier, { count, bytes, newest }] of Object.entries(usage)) {
        console.log(`${tier.padEnd(8)} ${String(count).padStart(3)} kept, ${(bytes / 1024 ** 2).toFixed(1)} MB, newest ${newest ?? 'none'}`);
      }
    } else {
      const written = await takeSnapshot({ uri: config.MONGO_URI, dir });
      console.log(`Snapshot taken:\n  ${written.join('\n  ')}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
