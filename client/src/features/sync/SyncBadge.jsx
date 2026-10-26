import { Link } from 'react-router-dom';

import { useSyncStatus } from './useSyncStatus.js';

/**
 * P63. In the top bar, for owners and managers while two-way sync is on: how
 * many sync conflicts wait to be checked, and a way to them. Nothing when none.
 */
export default function SyncBadge() {
  const status = useSyncStatus();
  const count = status?.data?.conflictsUnseen ?? 0;
  if (!status || count === 0) return null;
  return (
    <Link
      to="/sync"
      className="type-label inline-flex min-h-10 items-center gap-2 rounded-full border border-open bg-open-tint px-3 text-open"
      aria-label={`${count} sync conflict${count === 1 ? '' : 's'} to check`}
    >
      <span className="font-mono">{count}</span>
      <span className="max-[599px]:hidden">to check</span>
    </Link>
  );
}
