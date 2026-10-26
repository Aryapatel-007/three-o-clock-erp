import { useQuery } from '@tanstack/react-query';

import { getSyncStatus } from '../../api/sync.js';
import { useAuth } from '../../context/AuthContext.jsx';

const MANAGERS = ['OWNER', 'MANAGER'];

/**
 * P63. Sync status for owners and managers while two-way sync is on, read every
 * 30 seconds; null for everyone else, who never sees it.
 */
export function useSyncStatus() {
  const { user, features } = useAuth();
  const enabled = Boolean(user && MANAGERS.includes(user.role) && features?.sync?.mode === 'TWO_WAY');
  const query = useQuery({ queryKey: ['sync', 'status'], queryFn: getSyncStatus, enabled, refetchInterval: 30_000, staleTime: 10_000 });
  return enabled ? query : null;
}
