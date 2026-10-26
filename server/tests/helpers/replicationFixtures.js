/**
 * P62. Small helpers the replication tests share.
 */
import { execFileSync } from 'node:child_process';

/** True when mongodump or mongorestore is not on this machine; the snapshot test is then skipped, and says why. */
export function localSnapshotToolsMissing() {
  try {
    execFileSync('mongodump', ['--version'], { stdio: 'ignore' });
    execFileSync('mongorestore', ['--version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'mongodump and mongorestore are not installed here (MongoDB Database Tools).';
  }
}
