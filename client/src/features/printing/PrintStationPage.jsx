import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import BrandLogo from '../../components/ui/BrandLogo.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatTimeIst } from '../../utils/formatDate.js';
import CaptainBillPrinter from './CaptainBillPrinter.jsx';
import { CAFE_PC_PAPER } from './useDeviceSettings.js';

const KEPT = 8;

/**
 * The cafe PC's print window, /print-station. 2026-10-22, at Rishi's word: a
 * captain's one tap prints the bill, with nobody at the counter.
 *
 * box/windows/print-agent.ps1 opens this page by itself when Windows starts, in
 * a browser started with --kiosk-printing, so every captain's bill in the queue
 * prints on the PC's default printer (the Rugtek) with no dialog. It is the
 * counter's own printing (CaptainBillPrinter, the P59 claim) with the switch
 * always on, so a bill never prints twice even with a till open beside it.
 */
export default function PrintStationPage() {
  const { user } = useAuth();
  const [printed, setPrinted] = useState([]);
  // 2026-10-22. box/windows/print-agent.ps1 finds this window by its title and hides it.
  useEffect(() => {
    const before = document.title;
    document.title = 'Cafe POS printer';
    return () => {
      document.title = before;
    };
  }, []);
  const onPrinted = useCallback(
    (bill) => setPrinted((list) => [{ ...bill, at: new Date().toISOString() }, ...list].slice(0, KEPT)),
    [],
  );

  return (
    <main className="v2 min-h-full bg-ground p-6 text-ink">
      <CaptainBillPrinter always onPrinted={onPrinted} paper={CAFE_PC_PAPER} />
      <div className="mx-auto grid max-w-xl gap-4">
        <BrandLogo height={40} />
        <h1 className="type-title">Cafe POS printer</h1>
        <p className="type-body">
          Captains&apos; bills print here by themselves, on this computer&apos;s default printer. Leave this window open; it
          starts again by itself with Windows.
        </p>
        <p className="type-caption text-muted">Signed in as {user?.name}.</p>
        {/* 2026-10-22. This window has its own browser profile and no address bar, so its paper settings are reached from here. */}
        <Link to="/device" state={{ from: '/print-station' }} className="type-body text-accent underline">
          Printer settings for this window
        </Link>
        <section className="rounded-lg border border-line bg-surface p-4">
          <h2 className="type-heading">Printed in this window</h2>
          {printed.length === 0 ? (
            <p className="type-body mt-2 text-muted">Nothing yet.</p>
          ) : (
            <ul className="mt-2 grid gap-1">
              {printed.map((bill) => (
                <li key={`${bill.id}:${bill.printRequestedAt}`} className="type-body flex justify-between gap-4">
                  <span>
                    <span className="type-num-meta">{bill.billNumber}</span>
                    {bill.tableName ? ` · ${bill.tableName}` : ''}
                  </span>
                  <span className="type-num-meta text-muted">{formatTimeIst(bill.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
