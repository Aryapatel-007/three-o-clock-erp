import { Fragment } from 'react';

import { formatTimeIst } from '../../utils/formatDate.js';
import { useEffect, useRef, useState } from 'react';

import { CrossIcon, TickIcon } from './icons/index.jsx';
import StateChip from './StateChip.jsx';
import TimeEdge, { ElapsedTime, useElapsed } from './TimeEdge.jsx';

/** P29 Part E. How long the whole-ticket button is held before it marks everything ready. */
const HOLD_MS = 500;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One kitchen ticket. DESIGN-SYSTEM sections 8b and 9.
 *
 *   ┌──────────────────┐
 *   │ KOT 412  T 14    │
 *   ├──────────────────┤
 *   │ 1  Creamy Pesto  │
 *   │ 2  Cheesy Tornado│
 *   │    + Extra cheese│
 *   ├──────────────────┤
 *   │ 12 min   Ready ✓ │
 *   │████████░░░░░░░░░░│
 *   └──────────────────┘
 *
 * Items in `ticket-item`, small and narrow, so a name fits one line (P41),
 * beside a compact switch with its word under the knob. A name too long even
 * then wraps; it is never cut off, because a cook must read all of it. P38: each item has a Cooking / Ready switch, at least 56 px
 * tall; switched on it is ready, switched off again it goes back to the
 * kitchen (P29's undo). Tapping the dish itself does nothing, so a brushed
 * row never marks food ready. A ready item stays, struck through and faded,
 * until the whole ticket is done.
 * Marking the whole ticket needs the footer held for half a second, the fill
 * showing how long is left; with reduced motion it asks "Mark all 6 ready?"
 * instead. The time edge runs against the station's target and turns `alert`
 * with "Late" once past it. Nothing else on the ticket is loud.
 */
export default function TicketCard({
  kotNumber,
  place,
  subtitle = null,
  firedAt,
  targetMinutes,
  lines,
  notPrinted = false,
  // P56. The order's note for every dish, read before the dishes.
  note = null,
  isBusy = false,
  onLineReady,
  onLineUndo = null,
  onAllReady,
  onReprint,
  // 2026-10-21. Small tiles, chosen on the kitchen screen for a rush: narrower and tighter, the switch without its word.
  compact = false,
}) {
  const outstanding = lines.filter((line) => line.status === 'PENDING');
  const { isLate } = useElapsed(firedAt, targetMinutes);

  return (
    <article
      className={[
        'relative flex h-full animate-[ticket-in_160ms_ease-out] flex-col overflow-hidden rounded-[10px] bg-surface text-ink',
        isLate ? 'border-[3px] border-alert' : 'border border-line',
      ].join(' ')}
    >
      <header className={['flex items-start justify-between gap-2 border-b border-line', compact ? 'px-2 py-1' : 'px-3 py-2'].join(' ')}>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="type-num font-semibold">KOT {kotNumber}</span>
            <span className="type-label truncate">{place}</span>
          </p>
          {subtitle && <p className={['type-caption text-muted', compact ? 'truncate' : ''].join(' ')}>{subtitle}</p>}
        </div>
        {onReprint && (
          <button type="button" onClick={onReprint} className="type-label min-h-12 flex-none rounded-lg px-2 text-muted hover:bg-sunken hover:text-ink">
            Reprint
          </button>
        )}
      </header>

      {notPrinted && (
        <p className="type-label border-b border-line bg-alert-tint px-4 py-2 text-alert">Not printed. Tap Reprint.</p>
      )}

      {note && (
        <p className="type-label border-b border-line bg-sunken px-3 py-2">
          <span className="font-semibold">For all items:</span> {note}
        </p>
      )}

      <ul className="flex flex-1 flex-col px-1 py-0.5">
        {lines.map((line, index) => {
          const isDone = line.status === 'READY';
          const isCancelled = line.status === 'CANCELLED';
          // P36. A later Send on the same ticket starts under its own caption.
          const startsRound = (line.round ?? 1) > 1 && (index === 0 || lines[index - 1].round !== line.round);
          return (
            <Fragment key={line.id}>
            {startsRound && (
              <li className="type-caption border-t border-line px-2 pt-2 text-muted">Added {formatTimeIst(line.firedAt)}</li>
            )}
            <li className="flex items-center gap-1 rounded-lg px-1">
              <div className={['flex min-w-0 flex-1 items-baseline gap-2', isDone ? 'opacity-60' : ''].join(' ')}>
                <span className={['type-num flex-none text-right font-semibold', compact ? 'w-5' : 'w-7'].join(' ')}>{line.quantity}</span>
                <span className="min-w-0 flex-1">
                  <span
                    title={line.variantName ? `${line.itemName} · ${line.variantName}` : line.itemName}
                    className={['type-ticket-item block break-words', isDone || isCancelled ? 'text-muted line-through' : ''].join(' ')}
                  >
                    {line.itemName}
                    {line.variantName && <span className="text-muted"> · {line.variantName}</span>}
                  </span>
                  {line.addOnNames?.length > 0 && <span className="type-body block pl-3 text-muted">+ {line.addOnNames.join(', ')}</span>}
                  {line.notes && <span className="type-body block pl-3 italic text-ink">{line.notes}</span>}
                  {isCancelled && <StateChip state="alert" word="Cancelled, do not make" size="sm" className="mt-1" />}
                  {/* P42. The floor changed its quantity or note after it was sent. */}
                  {!isCancelled && line.changedAt && <StateChip state="open" word="Changed" size="sm" className="mt-1" />}
                </span>
              </div>
              {isCancelled ? (
                <span className="mt-1 flex-none text-alert" aria-hidden="true">
                  <CrossIcon />
                </span>
              ) : (
                <ReadySwitch
                  compact={compact}
                  name={line.itemName}
                  isReady={isDone}
                  disabled={isBusy || (isDone && !onLineUndo)}
                  onChange={() => (isDone ? onLineUndo(line.id) : onLineReady(line.id))}
                />
              )}
            </li>
            </Fragment>
          );
        })}
      </ul>

      <footer className="border-t border-line">
        <HoldToConfirm count={outstanding.length} total={lines.length} disabled={isBusy || outstanding.length === 0} onConfirm={onAllReady}>
          <ElapsedTime since={firedAt} targetMinutes={targetMinutes} />
          <span className={[compact ? 'type-label whitespace-nowrap' : 'type-button', 'flex items-center gap-2'].join(' ')}>
            {outstanding.length === 0
              ? 'All ready'
              : compact
                ? outstanding.length === lines.length
                  ? 'Hold: all ready'
                  : `Hold: ${outstanding.length} left`
                : outstanding.length === lines.length
                  ? 'Hold for all ready'
                  : `Hold: ${outstanding.length} left ready`}
            <TickIcon />
          </span>
        </HoldToConfirm>
      </footer>
      <TimeEdge since={firedAt} targetMinutes={targetMinutes} state="open" />
    </article>
  );
}

/**
 * P38. One dish's switch: Cooking (off) or Ready (on). A real switch for
 * screen readers, named after the dish, with the state in words so it never
 * relies on colour. P41: the word sits under the knob, so the switch is
 * narrow and the dish name gets the width. The knob slides; nothing loops.
 */
function ReadySwitch({ name, isReady, disabled, onChange, compact = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isReady}
      aria-label={`${name} ready`}
      disabled={disabled}
      onClick={onChange}
      className={['flex min-h-12 flex-none flex-col items-center justify-center rounded-lg disabled:opacity-50', compact ? 'w-11' : 'w-12'].join(' ')}
    >
      <span
        aria-hidden="true"
        className={['relative flex h-6 w-10 flex-none items-center rounded-full border-2 transition-colors duration-150', isReady ? 'border-ok bg-ok' : 'border-line bg-sunken'].join(' ')}
      >
        <span
          className={['absolute top-0.5 size-4 rounded-full bg-surface shadow transition-transform duration-150', isReady ? 'translate-x-[1.1rem]' : 'translate-x-0.5'].join(' ')}
        />
      </span>
      {/* Small tiles drop the word to save height; the name's strike-through still says ready without colour. */}
      {!compact && <span className={`type-caption ${isReady ? 'text-ok' : 'text-muted'}`}>{isReady ? 'Ready' : 'Cooking'}</span>}
    </button>
  );
}

/**
 * P29 Part E. The whole-ticket button, held for half a second, the fill
 * growing across it as it is held; let go early and nothing happens. With
 * reduced motion, or from the keyboard, it asks in words instead, on the
 * ticket itself, never in a browser dialog.
 */
function HoldToConfirm({ count, total, disabled, onConfirm, children }) {
  const [holding, setHolding] = useState(false);
  const [asking, setAsking] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const cancel = () => {
    clearTimeout(timer.current);
    setHolding(false);
  };
  const start = (event) => {
    if (disabled || event.button > 0) return;
    if (prefersReducedMotion()) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  };

  if (asking) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
        <span className="type-body">Mark all {count} ready?</span>
        <span className="flex gap-2">
          <button type="button" onClick={() => setAsking(false)} className="type-button min-h-14 rounded-lg border border-line px-4 hover:bg-sunken">
            No
          </button>
          <button
            type="button"
            onClick={() => {
              setAsking(false);
              onConfirm();
            }}
            className="type-button min-h-14 rounded-lg bg-accent px-4 text-on-accent hover:brightness-110"
          >
            Yes
          </button>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(event) => event.preventDefault()}
      // A keyboard press, or a tap with reduced motion, asks in words. A held pointer never reaches here.
      onClick={(event) => {
        if (disabled) return;
        if (event.detail === 0 || prefersReducedMotion()) setAsking(true);
      }}
      aria-label={total > 0 ? `Mark all ${count} ready. Hold to confirm.` : undefined}
      className="relative flex min-h-12 w-full touch-none select-none items-center justify-between gap-2 overflow-hidden px-3 pb-2 pt-1 hover:bg-sunken disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-ok-tint transition-[width] ease-linear"
        style={{ width: holding ? '100%' : '0%', transitionDuration: holding ? `${HOLD_MS}ms` : '0ms' }}
      />
      <span className="relative flex w-full items-center justify-between gap-3">{children}</span>
    </button>
  );
}
