import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getKotTicket, listKots } from '../../api/kitchen.js';
import { useLiveInterval } from '../../api/live.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { ROLES } from '../users/roles.js';

import { kotCharactersFor, printText } from './printText.js';
import { readDeviceSettings, rememberPrinted, useDeviceSettings } from './useDeviceSettings.js';

const TILL = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];
const POLL_MS = 5000;
// One printer of tickets at a time on this device, whatever the number of tabs.
const PRINT_LOCK = 'counter-kot-printer';

/**
 * Prints every new kitchen ticket on the counter's printer, whatever screen the
 * counter is on. 2026-10-27, Three O'Clock: a captain's Send printed nothing,
 * because only the Kitchen screen printed tickets, and only with one station
 * chosen, while the counter sits on the floor or a bill. Draws nothing.
 *
 * On with "Print every new KOT here" on This device, which the till window
 * (`?till=1`) turns on by itself. Each Send is printed once, whole, as
 * "ticket:round", the same keys the Kitchen screen and KOT & Print remember on
 * this device, so none of the three prints a round another already printed.
 * The first run marks what is already there as printed, so switching it on
 * mid-service prints no backlog. A failed print is tried again on the next poll.
 */
export default function CounterKotPrinter() {
  const { user } = useAuth();
  const [device, updateDevice] = useDeviceSettings();
  const enabled = Boolean(device.printKotsAtCounter) && TILL.includes(user?.role);

  // P33. 5 seconds, or 60 while the live channel is healthy and announcing tickets.
  const interval = useLiveInterval(POLL_MS);
  const tickets = useQuery({
    queryKey: ['kots', { sort: 'recent', counter: true }],
    // The most recently changed tickets, ready or not: a round the kitchen marks
    // ready within seconds is still printed.
    queryFn: () => listKots({ sort: 'recent', limit: 50 }),
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: true,
  });

  const busy = useRef(false);
  useEffect(() => {
    if (!enabled || !tickets.isSuccess || busy.current) return;
    // A round whose dishes were all taken back (Undo after Send) has nothing to cook.
    const rounds = (tickets.data?.data ?? []).flatMap((kot) =>
      [...new Set(kot.lines.filter((line) => line.status !== 'CANCELLED').map((line) => line.round ?? 1))].map((round) => `${kot.id}:${round}`),
    );
    const seedKey = `counter:${device.counterKotsArmedAt ?? 0}`;
    if (device.counterKotsSeededFor !== seedKey) {
      updateDevice((current) => ({ counterKotsSeededFor: seedKey, printedKotIds: rememberPrinted(current.printedKotIds, rounds) }));
      return;
    }
    const printedBefore = (printed, key) => printed.includes(key) || (key.endsWith(':1') && printed.includes(key.slice(0, -2)));
    if (rounds.every((key) => printedBefore(device.printedKotIds, key))) return;

    busy.current = true;
    const printFresh = async () => {
      // Read again inside the lock: KOT & Print or another tab may have printed it meanwhile.
      const fresh = rounds.filter((key) => !printedBefore(readDeviceSettings().printedKotIds, key)).reverse();
      // Recorded before printing, so a slow printer never gets the same round again from the next poll.
      updateDevice((current) => ({ printedKotIds: rememberPrinted(current.printedKotIds, fresh) }));
      const settings = readDeviceSettings();
      for (const key of fresh) {
        const [id, round] = key.split(':');
        try {
          const { text } = await getKotTicket(id, { width: kotCharactersFor(settings.printer), round: Number(round) });
          await printText(text, settings.printer, { kot: true });
        } catch {
          // Forgotten again, so the next poll tries it once more.
          updateDevice((current) => ({ printedKotIds: current.printedKotIds.filter((printed) => printed !== key) }));
        }
      }
    };
    (async () => {
      try {
        if (navigator.locks) await navigator.locks.request(PRINT_LOCK, printFresh);
        else await printFresh();
      } finally {
        busy.current = false;
      }
    })();
  }, [enabled, tickets.isSuccess, tickets.data, device.printedKotIds, device.counterKotsSeededFor, device.counterKotsArmedAt, updateDevice]);

  return null;
}
