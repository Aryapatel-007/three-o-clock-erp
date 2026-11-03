import Money from '../../components/ui/Money.jsx';
import { MinusIcon, PlusIcon } from '../../components/ui/icons/index.jsx';

import { describeReason, LINE_CANCEL_REASONS } from './cancelReasons.js';

/**
 * How far along a dish is, in a small dot and word beside it. Not sent has no
 * colour, the way a free table has none.
 */
const LINE_STATES = {
  PENDING: { dot: 'bg-muted', word: 'Not sent' },
  FIRED: { dot: 'bg-open', word: 'With the kitchen' },
  READY: { dot: 'bg-ok', word: 'Ready' },
  SERVED: { dot: 'bg-ok', word: 'Served' },
  CANCELLED: { dot: 'bg-alert', word: 'Cancelled' },
};

/** The same dish at the same price, at the same stage, shows as one row, "2 ×", as the bill prints it. Notes are listed under it. */
const sameDish = (line) => [line.status, line.itemName, line.variantName ?? '', line.addOns.map((addOn) => addOn.name).join('|'), line.unitPriceInPaise].join('\u0000');

function groupLines(lines, { hideCancelled }) {
  const groups = [];
  const byKey = new Map();
  for (const line of lines) {
    if (hideCancelled && line.status === 'CANCELLED') continue;
    // A dish not sent keeps its own row: its stepper and note are its own.
    if (line.status === 'PENDING' || line.status === 'CANCELLED') {
      groups.push({ key: line.id, lines: [line] });
      continue;
    }
    const key = sameDish(line);
    const group = byKey.get(key);
    if (group) group.lines.push(line);
    else {
      const created = { key: line.id, lines: [line] };
      byKey.set(key, created);
      groups.push(created);
    }
  }
  return groups.map((group) => ({
    ...group,
    line: group.lines[group.lines.length - 1],
    quantity: group.lines.reduce((sum, line) => sum + line.quantity, 0),
    totalInPaise: group.lines.reduce((sum, line) => sum + line.lineTotalInPaise, 0),
    notes: [...new Set(group.lines.map((line) => line.notes).filter(Boolean))].join('; ') || null,
  }));
}

/**
 * The lines on an order, read like the printed bill: "2 × Masala Chai" and its
 * amount, with how far along it is in a small word under it (2026-11-03). One
 * look for every state of the order, so a table looks the same before and after
 * its dishes are sent and served.
 *
 * A dish not sent has a small stepper (− at one removes it, P49) and its own note.
 * A sent dish has Change (P42): fewer of it, a new note, removing it, or swapping it.
 */
export default function OrderLineList({
  lines,
  isBusy,
  onChangeQuantity,
  onCancelLine,
  // P49. A dish not sent yet is removed with no reason; without this it is cancelled as before.
  onRemoveDraft = null,
  // P42. A sent dish changes through the Change sheet: quantity, note, remove or swap.
  onChangeSentLine = null,
  onServeLine,
  // P29. The order has a bill: its lines change only through the bill.
  locked = false,
  // P29 Part C. The kitchen's ready serves the line: no served step.
  readyMeansServed = false,
  // A dish not sent yet takes its note here, in the order.
  onNoteLine = null,
  // Everything sent or served: cancelled dishes are left off, as on the bill.
  billView = false,
}) {
  if (lines.length === 0) {
    return <p className="type-body px-4 py-8 text-muted">Nothing on this order yet. Pick something from the menu.</p>;
  }

  const groups = groupLines(lines, { hideCancelled: billView });
  if (groups.length === 0) return <p className="type-body px-4 py-8 text-muted">Every dish on this order was cancelled.</p>;

  return (
    <ul className="flex flex-col px-4 py-1">
      {groups.map(({ key, line, quantity, totalInPaise, notes }) => {
        const isCancelled = line.status === 'CANCELLED';
        const isPending = line.status === 'PENDING';
        const state = LINE_STATES[line.status] ?? LINE_STATES.PENDING;
        const canChange = !isCancelled && !isPending && !locked && (line.status !== 'SERVED' || readyMeansServed);
        const reason = isCancelled ? describeReason(LINE_CANCEL_REASONS, line.cancelReasonCode, line.cancelReason) : null;

        return (
          <li key={key} className={['flex items-start gap-2 border-b border-dashed border-line py-2 last:border-b-0', isCancelled ? 'opacity-60' : ''].join(' ')}>
            {isPending && !locked ? (
              <MiniStepper
                value={line.quantity}
                disabled={isBusy}
                onLess={() => (line.quantity > 1 ? onChangeQuantity(line, line.quantity - 1) : onRemoveDraft ? onRemoveDraft(line) : onCancelLine(line))}
                onMore={() => onChangeQuantity(line, line.quantity + 1)}
                name={line.itemName}
              />
            ) : (
              <span className="type-num w-9 flex-none pt-px">{quantity} ×</span>
            )}

            <div className="min-w-0 flex-1">
              <p className={['type-body break-words leading-snug', isCancelled ? 'line-through' : ''].join(' ')}>
                {line.itemName}
                {line.variantName && <span className="text-muted"> · {line.variantName}</span>}
              </p>
              {line.addOns.length > 0 && <p className="type-caption text-muted">{line.addOns.map((addOn) => addOn.name).join(', ')}</p>}
              {notes && <p className="type-caption text-ink">Note: {notes}</p>}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted">
                  <span className={`size-1.5 rounded-full ${state.dot}`} aria-hidden="true" />
                  {state.word}
                  {isCancelled && line.wasPrepared === true && ' · was made'}
                  {isCancelled && line.wasPrepared === false && ' · not made'}
                </span>
                {/* Always in sight on a dish not yet sent, so a request for the kitchen is never forgotten. */}
                {isPending && !locked && onNoteLine && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onNoteLine(line)}
                    className="text-[11px] font-semibold leading-4 text-ink underline decoration-dotted underline-offset-2 disabled:opacity-60"
                  >
                    {line.notes ? 'Edit note' : '+ Add note'}
                  </button>
                )}
              </p>
              {reason && <p className="type-caption text-muted">{reason}</p>}
            </div>

            <span className="flex flex-none flex-col items-end">
              <Money paise={totalInPaise} size="num" tabular className={isCancelled ? 'line-through' : ''} />
              {quantity > 1 && (
                <span className="text-[11px] leading-4 text-muted">
                  <Money paise={line.unitPriceInPaise} /> each
                </span>
              )}
            </span>

            {line.status === 'READY' && !readyMeansServed && !locked && (
              <SmallAction disabled={isBusy} onClick={() => onServeLine(line)}>
                Serve
              </SmallAction>
            )}
            {canChange && onChangeSentLine && (
              <SmallAction disabled={isBusy} onClick={() => onChangeSentLine(line)}>
                Change
              </SmallAction>
            )}
            {canChange && !onChangeSentLine && (
              <SmallAction disabled={isBusy} onClick={() => onCancelLine(line)}>
                Cancel
              </SmallAction>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SmallAction({ children, ...props }) {
  return (
    <button type="button" className="type-label -my-1 min-h-10 flex-none rounded-lg px-2 text-muted hover:bg-sunken hover:text-ink disabled:opacity-60" {...props}>
      {children}
    </button>
  );
}

/** A dish not sent: − and + around its quantity, small enough to sit in the row. */
function MiniStepper({ value, onLess, onMore, disabled, name }) {
  return (
    <span className="-my-0.5 inline-flex flex-none items-center rounded-lg border border-line">
      <button
        type="button"
        aria-label={value > 1 ? `One fewer ${name}` : `Remove ${name}`}
        disabled={disabled}
        onClick={onLess}
        className="flex size-8 items-center justify-center rounded-lg hover:bg-sunken disabled:opacity-40"
      >
        <MinusIcon size={14} />
      </button>
      <span aria-live="polite" className="type-num w-5 text-center">
        {value}
      </span>
      <button
        type="button"
        aria-label={`One more ${name}`}
        disabled={disabled}
        onClick={onMore}
        className="flex size-8 items-center justify-center rounded-lg hover:bg-sunken disabled:opacity-40"
      >
        <PlusIcon size={14} />
      </button>
    </span>
  );
}
