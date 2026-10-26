import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { getKotTicket, listKots, markKotLineReady, markKotReady, undoKotLineReady, undoKotReady } from '../../api/kitchen.js';
import { listStations } from '../../api/stations.js';
import { useAuth } from '../../context/AuthContext.jsx';
import Sheet from '../../components/ui/Sheet.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import TicketCard from '../../components/ui/TicketCard.jsx';
import { packColumns, useColumnCount } from './ticketColumns.js';
import { useMinuteClock } from '../../components/ui/TimeEdge.jsx';
import { formatTimeIst } from '../../utils/formatDate.js';
import { errorMessage } from '../orders/errorCopy.js';
import { charactersFor, printText } from '../printing/printText.js';
import { rememberPrinted, useDeviceSettings } from '../printing/useDeviceSettings.js';
import EmptyState from '../../components/ui/EmptyState.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import { useLiveInterval } from '../../api/live.js';
import { kitchenBell, onUnlockChange, soundIsUnlocked, speak, unlockSound } from '../online/alertSound.js';

const ALL_STATIONS = 'ALL';

/** A station's target when it has none, or the ticket has no station. Matches the server default. */
const DEFAULT_TARGET_MINUTES = 15;

const ORDER_TYPE_LABELS = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** P29 Part E. How long the undo bar stays after a tick. */
const UNDO_BAR_MS = 10_000;
/** P41. How far back Recall looks for finished tickets: chosen on the sheet, 1 hour unless changed (2026-10-14). */
const RECALL_RANGES = [
  { key: '30m', label: 'Last 30 min', ms: 30 * 60_000 },
  { key: '1h', label: '1 hour', ms: 60 * 60_000 },
  { key: '3h', label: '3 hours', ms: 3 * 60 * 60_000 },
  { key: 'day', label: 'Today', ms: 24 * 60 * 60_000 },
];

/** P41. When the last dish of a ticket (of this station's dishes) was marked ready, or null. */
function finishedAt(lines) {
  const times = lines.filter((line) => line.status === 'READY' && line.readyAt).map((line) => Date.parse(line.readyAt));
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * The kitchen display.
 *
 * Polls every ten seconds. Not websockets: at one restaurant's scale polling is
 * enough, and it is one less thing to debug in a kitchen with bad wifi, where
 * a dropped socket that silently stops delivering tickets is far worse than a
 * ten second delay. This was a decision, not a shortcut. See PROJECT-STATE.md.
 *
 * Oldest ticket first, because that is the order a kitchen works in.
 *
 * P05: a station picker at the top filters the tickets to one station. It
 * opens on the signed-in user's station when they have one, and the choice is
 * remembered on the device. With auto-print on and one station chosen, every
 * ticket that appears for the first time prints once.
 *
 * P58. With `kitchen.splitTicketsByStation` off, there are no stations here:
 * no picker, every ticket whole, whatever station the device has saved, and
 * auto-print prints every new ticket whole.
 *
 * Everything here is sized for someone standing back from a screen with their
 * hands full: big type, whole rows as tap targets, and no nested navigation.
 */
export default function KitchenDisplayPage() {
  const queryClient = useQueryClient();
  const { user, features } = useAuth();
  const [device, updateDevice] = useDeviceSettings();
  const board = useRef(null);
  const smallTiles = device.kitchenTiles === 'SMALL';
  const columnCount = useColumnCount(board, { small: smallTiles });
  const [error, setError] = useState(null);
  // KOT ids whose print failed on this screen. Shown as "Not printed".
  const [notPrinted, setNotPrinted] = useState(() => new Set());

  // P58. Without stations, the device's saved station is kept but not used.
  const usesStations = features?.kitchen?.splitTicketsByStation !== false;
  const chosenStation = usesStations ? (device.kitchenStationId ?? user?.stationId ?? ALL_STATIONS) : ALL_STATIONS;
  const stationFilter = chosenStation === ALL_STATIONS ? undefined : chosenStation;

  const stations = useQuery({ queryKey: ['stations'], queryFn: () => listStations() });

  // P33. 10 seconds, or 60 while the live channel is healthy and announcing tickets.
  const ticketInterval = useLiveInterval(10_000);
  const tickets = useQuery({
    queryKey: ['kots', { status: 'PENDING,IN_PROGRESS', stationId: stationFilter ?? null }],
    queryFn: () => listKots({ status: 'PENDING,IN_PROGRESS', limit: 50, stationId: stationFilter }),
    refetchInterval: ticketInterval,
    // A ticket board that stops updating when the tab loses focus is a ticket
    // board that lies to a kitchen. Keep polling regardless.
    refetchIntervalInBackground: true,
  });

  /**
   * P29 Part E. The last tick, for the undo bar. A wrong tick is easy to take
   * back while the table is not yet billed.
   */
  const [lastTick, setLastTick] = useState(null);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    if (!lastTick) return undefined;
    const timer = setTimeout(() => setLastTick(null), UNDO_BAR_MS);
    return () => clearTimeout(timer);
  }, [lastTick]);

  /**
   * P41. Recall, as on PetPooja's kitchen display: the tickets finished in the
   * last hour, from every screen, newest first, any of which can be brought
   * back to the board. Read only while the sheet is open.
   */
  const [isRecalling, setIsRecalling] = useState(false);
  const recallRange = RECALL_RANGES.find((range) => range.key === device.recallRange) ?? RECALL_RANGES[1];
  const finished = useQuery({
    queryKey: ['kots', { status: 'COMPLETED', sort: 'recent', stationId: stationFilter ?? null }],
    // The most a page holds; the range below decides what of it is shown.
    queryFn: () => listKots({ status: 'COMPLETED', sort: 'recent', limit: 200, stationId: stationFilter }),
    enabled: isRecalling,
  });

  const markReady = useMutation({
    // P36. The whole ticket from a station's screen is that station's dishes only.
    mutationFn: ({ kotId, lineId }) =>
      lineId ? markKotLineReady(kotId, lineId) : markKotReady(kotId, { stationId: stationFilter }),
    onSuccess: (kot, { lineId, label }) => {
      setError(null);
      setNotice(null);
      setLastTick({ kotId: kot.id, lineId: lineId ?? null, label, at: Date.now() });
      queryClient.invalidateQueries({ queryKey: ['kots'] });
      // A floor screen holding this order now has a stale copy.
      queryClient.invalidateQueries({ queryKey: ['order'] });
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  const undo = useMutation({
    mutationFn: ({ kotId, lineId }) => (lineId ? undoKotLineReady(kotId, lineId) : undoKotReady(kotId, { stationId: stationFilter })),
    onSuccess: (kot) => {
      setError(null);
      setLastTick(null);
      setNotice(kot.platformAlreadyTold ? 'Back with the kitchen. The platform was already told it was ready.' : 'Back with the kitchen.');
      queryClient.invalidateQueries({ queryKey: ['kots'] });
      queryClient.invalidateQueries({ queryKey: ['order'] });
    },
    onError: (mutationError) => {
      setLastTick(null);
      setError(errorMessage(mutationError));
    },
  });

  /** Fetches the server-laid-out ticket and prints it. Never throws. */
  async function printKot(kotId, { reprint = false, round, stationId } = {}) {
    try {
      const { text } = await getKotTicket(kotId, { width: charactersFor(device.printer), reprint, round, stationId });
      await printText(text, device.printer);
      setNotPrinted((current) => {
        const next = new Set(current);
        next.delete(kotId);
        return next;
      });
    } catch {
      setNotPrinted((current) => new Set(current).add(kotId));
    }
  }

  /**
   * Auto-print. Only with one station chosen: "All stations" is a manager's
   * overview, not a printer's queue.
   *
   * The printed ids live on the device, the most recent 500, so a refresh or a
   * re-poll never prints a ticket twice. The first time this runs after
   * auto-print is switched on, or after the station changes, every ticket
   * already on screen is marked printed without printing, so turning it on in
   * the middle of service does not print a backlog. A print failure never
   * stops the polling; the ticket just shows "Not printed".
   */
  const printing = useRef(false);
  useEffect(() => {
    // P58. Without stations, every ticket is this device's to print.
    if (!device.autoPrintKots || (usesStations && !stationFilter) || !tickets.isSuccess || printing.current) return;
    /**
     * P36. One slip per round of a ticket with this station's dishes in it,
     * remembered as "ticket:round". A ticket id on its own, remembered before
     * P36, stands for its first round.
     */
    const onScreen = (tickets.data?.data ?? []).flatMap((kot) =>
      [...new Set(kot.lines.filter((line) => !stationFilter || line.stationId === stationFilter).map((line) => line.round ?? 1))].map((round) => `${kot.id}:${round}`),
    );
    const printedBefore = (key) => device.printedKotIds.includes(key) || (key.endsWith(':1') && device.printedKotIds.includes(key.slice(0, -2)));
    const seedKey = `${device.autoPrintArmedAt ?? 0}:${stationFilter ?? 'all'}`;

    if (device.autoPrintSeededFor !== seedKey) {
      updateDevice((current) => ({
        autoPrintSeededFor: seedKey,
        printedKotIds: rememberPrinted(current.printedKotIds, onScreen),
      }));
      return;
    }

    const fresh = onScreen.filter((key) => !printedBefore(key));
    if (fresh.length === 0) return;

    printing.current = true;
    // Recorded before printing, so a slow printer never gets the same ticket
    // again from the next poll.
    updateDevice((current) => ({ printedKotIds: rememberPrinted(current.printedKotIds, fresh) }));
    (async () => {
      for (const key of fresh) {
        const [id, round] = key.split(':');
        await printKot(id, { round: Number(round), stationId: stationFilter });
      }
      printing.current = false;
    })();
    // printKot reads the device width; the dependencies below are what decide
    // whether there is anything new to print.
  }, [tickets.data, device.autoPrintKots, device.autoPrintSeededFor, device.autoPrintArmedAt, stationFilter, usesStations]);

  const clock = useMinuteClock();
  const targets = new Map((stations.data ?? []).map((station) => [station.id, station.targetMinutes ?? DEFAULT_TARGET_MINUTES]));
  const targetFor = (kot) => targets.get(stationFilter ?? kot.stationId) ?? DEFAULT_TARGET_MINUTES;
  // P36. The ticket is timed from the oldest dish still to make, so a round added later is not late on arrival.
  const minutesOpen = (kot) => Math.floor((clock - new Date(kot.waitingSince).getTime()) / 60_000);
  const isLate = (kot) => minutesOpen(kot) >= targetFor(kot);

  // P36. A station sees only its own dishes on a ticket, and only while one is still to make.
  const kots = (tickets.data?.data ?? [])
    .map((kot) => {
      const lines = stationFilter ? kot.lines.filter((line) => line.stationId === stationFilter) : kot.lines;
      const pending = lines.filter((line) => line.status === 'PENDING');
      const since = (pending.length > 0 ? pending : lines).map((line) => new Date(line.firedAt ?? kot.firedAt).getTime());
      return { ...kot, lines, waitingSince: new Date(Math.min(...since, Date.parse(kot.lastFiredAt ?? kot.firedAt))) };
    })
    .filter((kot) => kot.lines.some((line) => line.status === 'PENDING'))
    // DESIGN-SYSTEM 8b: oldest first, late tickets moved to the front.
    .sort((a, b) => Number(isLate(b)) - Number(isLate(a)) || a.waitingSince - b.waitingSince);
  const lateCount = kots.filter(isLate).length;
  // P41. The finished tickets Recall offers: this station's dishes, the last finished within the hour.
  const recallable = (finished.data?.data ?? [])
    .map((kot) => {
      const lines = (stationFilter ? kot.lines.filter((line) => line.stationId === stationFilter) : kot.lines).filter((line) => line.status !== 'CANCELLED');
      return { ...kot, lines, doneAt: finishedAt(lines) };
    })
    .filter((kot) => kot.doneAt && Date.now() - kot.doneAt < recallRange.ms && kot.lines.every((line) => line.status === 'READY'))
    .sort((a, b) => b.doneAt - a.doneAt);
  const nameOf = (kot, lineId) => kot.lines.find((line) => line.id === lineId)?.itemName ?? 'That dish';

  /**
   * P45. A loud bell for a ticket, or a new round on one, this screen has not
   * shown before, then "KOT 12, Table 5" aloud when spoken alerts are on. The
   * tickets on the board when the screen opens are taken as seen, so opening
   * the screen in the middle of service is silent. One bell for a batch.
   */
  const seenRounds = useRef(null);
  const [soundUnlocked, setSoundUnlocked] = useState(soundIsUnlocked);
  useEffect(() => onUnlockChange(setSoundUnlocked), []);
  useEffect(() => {
    // Browsers allow sound only after a tap; any tap on the page will do.
    const onTap = () => unlockSound();
    document.addEventListener('pointerdown', onTap);
    return () => document.removeEventListener('pointerdown', onTap);
  }, []);
  // A station changed on this screen starts from what is on the board, silently.
  useEffect(() => {
    seenRounds.current = null;
  }, [stationFilter]);
  useEffect(() => {
    if (!tickets.isSuccess) return;
    const rounds = kots.flatMap((kot) => [...new Set(kot.lines.map((line) => line.round ?? 1))].map((round) => ({ key: `${kot.id}:${round}`, kot })));
    if (seenRounds.current === null) {
      seenRounds.current = new Set(rounds.map((entry) => entry.key));
      return;
    }
    const fresh = rounds.filter((entry) => !seenRounds.current.has(entry.key));
    for (const entry of fresh) seenRounds.current.add(entry.key);
    if (fresh.length === 0 || !device.kitchenSound) return;
    kitchenBell();
    if (device.speakAlerts) {
      const first = fresh[0].kot;
      speak(`KOT ${first.kotNumber}, ${first.tableName ?? `order ${first.orderNumber}`}`);
    }
    // `kots` is derived from tickets.data and the station; those decide whether anything is new.
  }, [tickets.data, stationFilter]);

  return (
    <main className="v2 min-h-full bg-ground text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="type-title">Kitchen</h1>
          <span className="type-caption text-muted">
            <span className="type-num-meta text-ink">{kots.length}</span> open
          </span>
          {lateCount > 0 && <StateChip state="alert" word={`${lateCount} late`} size="sm" />}
        </div>

        <div className="ml-auto flex items-center gap-3 text-right">
          {/* P45. The bell for a new ticket, on or off on this device. */}
          {/* 2026-10-21. Small tiles in a rush, so more tickets fit; kept on this device. */}
          <div role="group" aria-label="Tile size" className="flex gap-1">
            {[
              ['SMALL', 'Small tiles'],
              ['BIG', 'Big tiles'],
            ].map(([size, label]) => (
              <button
                key={size}
                type="button"
                aria-pressed={(device.kitchenTiles ?? 'BIG') === size}
                onClick={() => updateDevice({ kitchenTiles: size })}
                className={[
                  'type-button min-h-12 rounded-lg border px-3',
                  (device.kitchenTiles ?? 'BIG') === size ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={device.kitchenSound}
            onClick={() => updateDevice({ kitchenSound: !device.kitchenSound })}
            className="type-button min-h-12 rounded-lg border border-line bg-surface px-4 hover:bg-sunken"
          >
            {device.kitchenSound ? 'Sound on' : 'Sound off'}
          </button>
          {/* P41. Bring a finished ticket back, as on PetPooja. */}
          <button
            type="button"
            onClick={() => setIsRecalling(true)}
            className="type-button min-h-12 rounded-lg border border-line bg-surface px-4 hover:bg-sunken"
          >
            Recall
          </button>
          <div>
          <p className="type-num-tile">{formatTimeIst(clock)}</p>
          <p className="type-caption text-muted">
            Updates every 10 seconds
            {device.autoPrintKots && (stationFilter || !usesStations) && ' · Printing new tickets'}
          </p>
          </div>
        </div>

        {/* P05. The station picker. Remembered on this device. */}
        {usesStations && (stations.data ?? []).length > 0 && (
          <div className="-mx-1 flex w-full gap-2 overflow-x-auto px-1" role="tablist" aria-label="Station">
            {[{ id: ALL_STATIONS, name: 'All stations' }, ...(stations.data ?? [])].map((station) => {
              const active = chosenStation === station.id;
              return (
                <button
                  key={station.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => updateDevice({ kitchenStationId: station.id })}
                  className={[
                    'type-label min-h-12 flex-none whitespace-nowrap rounded-lg border px-4 transition-colors',
                    active ? 'border-ink bg-sunken text-ink' : 'border-line bg-surface text-muted hover:text-ink',
                  ].join(' ')}
                >
                  {station.name}
                </button>
              );
            })}
          </div>
        )}

        {device.kitchenSound && !soundUnlocked && (
          <p role="status" className="type-label w-full rounded-lg border border-open bg-open-tint px-4 py-3 text-ink">
            Tap anywhere to turn on the sound for new tickets.
          </p>
        )}
        {error && <p className="type-body w-full text-alert">{error}</p>}
        {notice && <p className="type-body w-full text-muted">{notice}</p>}
      </header>

      <div className="p-4 sm:p-6">
        {tickets.isPending && <Spinner label="Loading tickets" />}

        {tickets.isError && <p className="type-body text-alert">{errorMessage(tickets.error)}</p>}

        {tickets.isSuccess && kots.length === 0 && (
          <EmptyState title="All caught up" description="Nothing is waiting. New tickets appear here on their own." />
        )}

        {/* P48. Dense, as PetPooja's, up to six across. 2026-10-21: each column stacks on its own, so a
            short ticket never leaves a gap beside a long one, and the board's width sets how many fit. */}
        <div ref={board} className="flex items-start gap-2">
          {packColumns(kots, columnCount).map((column, index) => (
            <ul key={index} className="flex min-w-0 flex-1 flex-col gap-2">
              {column.map((kot) => (
                <li key={kot.id}>
                  <TicketCard
                    kotNumber={kot.kotNumber}
                    place={kot.tableName ?? `Order ${kot.orderNumber}`}
                    subtitle={[ORDER_TYPE_LABELS[kot.orderType] ?? kot.orderType, `#${kot.orderNumber}`, kot.stationName, `Fired ${formatTimeIst(kot.firedAt)}`, kot.rounds > 1 ? `${kot.rounds} rounds` : null]
                      .filter(Boolean)
                      .join(' · ')}
                    firedAt={kot.waitingSince}
                    targetMinutes={targetFor(kot)}
                    lines={kot.lines}
                    notPrinted={notPrinted.has(kot.id)}
                    note={kot.kitchenNote}
                    onReprint={() => printKot(kot.id, { reprint: true })}
                    isBusy={markReady.isPending || undo.isPending}
                    onLineReady={(lineId) => markReady.mutate({ kotId: kot.id, lineId, label: `${nameOf(kot, lineId)} marked ready.` })}
                    onLineUndo={(lineId) => undo.mutate({ kotId: kot.id, lineId })}
                    onAllReady={() => markReady.mutate({ kotId: kot.id, label: `KOT ${kot.kotNumber} marked ready.` })}
                    compact={smallTiles}
                  />
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>

      {/* P41. Recall: the tickets finished in the last hour, newest first. */}
      {isRecalling && (
        <Sheet title="Recall" subtitle="Finished tickets. Recall puts one back on the board." onClose={() => setIsRecalling(false)}>
          {/* 2026-10-14. How far back to look, as the kitchen chooses; kept on this device. */}
          <div role="group" aria-label="How far back" className="mb-3 flex flex-wrap gap-2">
            {RECALL_RANGES.map((range) => (
              <button
                key={range.key}
                type="button"
                aria-pressed={recallRange.key === range.key}
                onClick={() => updateDevice({ recallRange: range.key })}
                className={[
                  'type-label min-h-12 rounded-lg border px-4',
                  recallRange.key === range.key ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
                ].join(' ')}
              >
                {range.label}
              </button>
            ))}
          </div>
          {finished.isPending && <Spinner label="Loading finished tickets" />}
          {finished.isError && <p className="type-body text-alert">{errorMessage(finished.error)}</p>}
          {finished.isSuccess && recallable.length === 0 && (
            <EmptyState title="Nothing to recall" description={`No ticket finished in this range (${recallRange.label.toLowerCase()}).`} />
          )}
          <ul className="flex flex-col gap-2">
            {recallable.map((kot) => (
              <li key={kot.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="type-body">
                    <span className="type-num-meta">KOT {kot.kotNumber}</span> · {kot.tableName ?? `Order ${kot.orderNumber}`}
                    <span className="type-caption text-muted"> · finished {formatTimeIst(new Date(kot.doneAt))}</span>
                  </p>
                  <p className="type-caption truncate text-muted">
                    {kot.lines.map((line) => `${line.quantity} ${line.itemName}`).join(', ')}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={undo.isPending}
                  onClick={() =>
                    undo.mutate(
                      { kotId: kot.id },
                      { onSuccess: () => finished.refetch() },
                    )
                  }
                  className="type-button min-h-12 flex-none rounded-lg bg-accent px-4 text-on-accent hover:brightness-110 disabled:opacity-50"
                >
                  Recall
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="type-body mt-3 text-alert">{error}</p>}
        </Sheet>
      )}

      {/* P29 Part E. The last tick, with a large Undo, for ten seconds. */}
      {lastTick && (
        <div role="status" className="sticky bottom-0 z-20 flex items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2 shadow-float sm:px-6">
          <span className="type-body">{lastTick.label}</span>
          <button
            type="button"
            disabled={undo.isPending}
            onClick={() => undo.mutate({ kotId: lastTick.kotId, lineId: lastTick.lineId })}
            className="type-button min-h-14 rounded-lg bg-accent px-6 text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            Undo
          </button>
        </div>
      )}
    </main>
  );
}
