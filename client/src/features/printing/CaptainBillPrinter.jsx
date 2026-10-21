import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getPrintQueue } from '../../api/bills.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeProvider.jsx';
import { ROLES } from '../users/roles.js';

import { printBill } from './printBill.js';
import { readDeviceSettings, rememberPrinted, useDeviceSettings } from './useDeviceSettings.js';
import { useLiveInterval } from '../../api/live.js';

const TILL = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];
const POLL_MS = 5000;
// One printer of captains' bills at a time on this device, whatever the number of tabs.
const PRINT_LOCK = 'captain-bill-printer';

/**
 * Prints the bills captains send to the counter. P25 Part D, API-CONTRACT M3
 * section 16.3 and P59. Draws nothing.
 *
 * On a counter computer with "Print bills sent by captains" on, it reads the
 * queue every 5 seconds and prints each bill once on this device's printer.
 * Each print first claims its request on the server (P59), so of every device
 * and browser profile reading the queue exactly one prints it; the claim takes
 * the bill out of the queue, and the device also remembers the request it printed, so a reload in
 * the moment between printing and recording never prints it twice. A bill
 * asked for again later is a new request and prints again, as a Duplicate.
 */
export default function CaptainBillPrinter({ always = false, onPrinted } = {}) {
  const { user } = useAuth();
  const { brand } = useTheme();
  const [device, updateDevice] = useDeviceSettings();
  const queryClient = useQueryClient();
  // `always`: the cafe PC's print window (PrintStationPage), which prints whatever this device's switch says.
  const enabled = (always || Boolean(device.printCaptainBills)) && TILL.includes(user?.role);

  // P33. 5 seconds, or 60 while the live channel is healthy and announcing print requests.
  const interval = useLiveInterval(POLL_MS);
  const queue = useQuery({
    queryKey: ['print-queue'],
    queryFn: getPrintQueue,
    enabled,
    refetchInterval: interval,
    refetchIntervalInBackground: true,
  });

  const busy = useRef(false);
  useEffect(() => {
    if (!enabled || !queue.isSuccess || busy.current) return;
    const fresh = (queue.data ?? []).filter((bill) => !device.printedBillRequests.includes(`${bill.id}:${bill.printRequestedAt}`));
    if (fresh.length === 0) return;

    busy.current = true;
    const printFresh = async () => {
      for (const bill of fresh) {
        const key = `${bill.id}:${bill.printRequestedAt}`;
        // Read again from storage: another tab of this device may have printed it while this one waited.
        if (readDeviceSettings().printedBillRequests.includes(key)) continue;
        try {
          // P59. Claimed on the server first, so another device or Chrome profile never prints it too.
          await printBill(bill.id, {
            printer: device.printer,
            logoDataUrl: brand.logos?.LIGHT_GROUND?.dataUrl ?? null,
            forRequestAt: bill.printRequestedAt,
          });
        } catch {
          // Left in the queue: the next poll tries again.
          continue;
        }
        updateDevice((current) => ({ printedBillRequests: rememberPrinted(current.printedBillRequests, [key]) }));
        onPrinted?.(bill);
      }
    };
    (async () => {
      try {
        /**
         * Two tabs of the till on one computer each run this. The lock lets one
         * print at a time, and the check above skips what the other just
         * printed, so a captain's bill never prints twice on one device.
         */
        if (navigator.locks) await navigator.locks.request(PRINT_LOCK, printFresh);
        else await printFresh();
      } finally {
        busy.current = false;
        queryClient.invalidateQueries({ queryKey: ['print-queue'] });
      }
    })();
  }, [enabled, queue.isSuccess, queue.data, device.printedBillRequests, device.printer, brand, updateDevice, queryClient, onPrinted]);

  return null;
}
