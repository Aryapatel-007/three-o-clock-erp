import { useEffect, useState } from 'react';

/**
 * The kitchen board's columns. 2026-10-21: a grid lined every row up to its
 * tallest ticket, so a two-dish ticket beside a twelve-dish one left a screen
 * of empty paper and pushed the next row out of sight (Z Chaat, test site).
 * Now each column stacks on its own, as a masonry board.
 *
 * The number of columns comes from the board's own width, so every ticket is at
 * least 320 px wide: wide enough for a dish name on one line beside its switch
 * and "Hold for all ready" on one line, whatever the rail and window take.
 * At most six, as P48's densest board.
 */
const MIN_TICKET_PX = 320;
const GAP_PX = 8;
const MAX_COLUMNS = 6;
// Small tiles, for a rush: 220 px a ticket and up to eight across, so more fit one screen.
const SMALL_TICKET_PX = 220;
const SMALL_MAX_COLUMNS = 8;

function columnsFor(width, small) {
  const ticket = small ? SMALL_TICKET_PX : MIN_TICKET_PX;
  const most = small ? SMALL_MAX_COLUMNS : MAX_COLUMNS;
  return Math.min(most, Math.max(1, Math.floor((width + GAP_PX) / (ticket + GAP_PX))));
}

/** `ref` is the board; the count follows its width as the window or the rail changes. */
export function useColumnCount(ref, { small = false } = {}) {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const board = ref.current;
    if (!board) return undefined;
    const update = () => setCount(columnsFor(board.clientWidth, small));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(board);
    return () => observer.disconnect();
  }, [ref, small]);
  return count;
}

/** About how tall a ticket draws, in dish rows: the header, footer and note, and each dish with its extras. */
function weightOf(kot) {
  let weight = 3 + (kot.kitchenNote ? 1 : 0);
  let round = null;
  for (const line of kot.lines) {
    weight += 1 + (line.notes ? 0.5 : 0) + (line.addOnNames?.length ? 0.5 : 0) + (line.status === 'CANCELLED' || line.changedAt ? 0.5 : 0);
    if (round !== null && line.round !== round) weight += 0.5;
    round = line.round;
  }
  return weight;
}

/**
 * Deals the tickets, in board order, each onto the shortest column so far.
 * The first tickets go across the top, left to right, so the oldest are still
 * read first; after that a ticket fills whichever column has room.
 */
export function packColumns(kots, count) {
  const columns = Array.from({ length: Math.max(1, count) }, () => ({ height: 0, kots: [] }));
  for (const kot of kots) {
    let shortest = columns[0];
    for (const column of columns) if (column.height < shortest.height) shortest = column;
    shortest.kots.push(kot);
    shortest.height += weightOf(kot);
  }
  return columns.map((column) => column.kots);
}
