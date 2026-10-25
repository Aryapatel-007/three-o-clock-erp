import { useEffect, useState } from 'react';

/** How long a captain's print request may wait before the screen says why it may not be printing. */
export const COUNTER_PRINT_WAIT_MS = 30_000;

/**
 * Shown to a captain whose "Print at counter" has waited 30 seconds. A captain's
 * phone cannot reach the bill printer; the counter computer prints the request,
 * only when "Print bills sent by captains" is on in its This device. That switch
 * is kept per browser and per address, so it is off on a counter that has just
 * moved to a new address (the cafe PC) until someone switches it on again.
 */
export default function CounterNotPrinting({ requestedAt }) {
  const [late, setLate] = useState(false);

  useEffect(() => {
    setLate(false);
    if (!requestedAt) return undefined;
    const waitMs = Date.parse(requestedAt) + COUNTER_PRINT_WAIT_MS - Date.now();
    if (waitMs <= 0) {
      setLate(true);
      return undefined;
    }
    const timer = setTimeout(() => setLate(true), waitMs);
    return () => clearTimeout(timer);
  }, [requestedAt]);

  if (!late) return null;
  return (
    <p role="status" className="type-caption mt-2 text-alert">
      Not printed yet. On the cafe PC the till must be open and signed in; on any other counter computer, the till open with "Print bills sent by captains" on in This device.
    </p>
  );
}
