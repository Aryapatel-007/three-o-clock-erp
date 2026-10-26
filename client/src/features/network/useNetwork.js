import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

import { getNetworkSelf, getNetworkStatus } from '../../api/network.js';
import { setSignedIn, snapshot, startLinkMonitor, subscribe } from './linkMonitor.js';

/** This device's link to the server, live. Starts the monitor on first use. P62. */
export function useLink({ signedIn = false } = {}) {
  useEffect(() => {
    startLinkMonitor();
  }, []);
  useEffect(() => {
    setSignedIn(signedIn);
  }, [signedIn]);
  return useSyncExternalStore(subscribe, snapshot);
}

/** Whether this server may write, its clock, and the cloud copy. Every signed-in person. P62. */
export function useNetworkSelf(enabled) {
  return useQuery({
    queryKey: ['network', 'self'],
    queryFn: getNetworkSelf,
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });
}

/** The whole network picture. OWNER and MANAGER. */
export function useNetworkStatus(enabled = true) {
  return useQuery({
    queryKey: ['network', 'status'],
    queryFn: getNetworkStatus,
    enabled,
    refetchInterval: 15_000,
  });
}
