/**
 * 2026-11-03. When the restaurant PC last pulled from the online copy (its online
 * orders and bookings), for Push and pull. Held in memory: a restart starts again
 * with "not yet", and the first pull a few seconds later fills it.
 */
let state = { at: null, error: null, errorAt: null };

export function markPulled(at, error = null) {
  state = error ? { ...state, error: error.message ?? String(error), errorAt: at } : { at, error: null, errorAt: null };
}

export function pullState() {
  return state;
}
