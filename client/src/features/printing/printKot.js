import { getKotTicket } from '../../api/kitchen.js';

import { kotCharactersFor, printText } from './printText.js';

/**
 * One Send's kitchen tickets, as the counter prints them. 2026-11-03, Arya: the whole
 * KOT first, with every dish, then one slip for each section (station) the Send has
 * dishes for, headed with the section's name, to hand to that section; a Send for one
 * section prints two, the whole and that section's (Arya). A restaurant with no
 * sections prints the whole KOT only.
 *
 * `kot` is a ticket from the kitchen list, with its lines; `round` is the Send on it
 * (a ticket written before every Send had its own number may hold several).
 */
export async function printKotWithSections(kot, { round = 1, printer, reprint = false } = {}) {
  const width = kotCharactersFor(printer);
  const whole = await getKotTicket(kot.id, { width, round, reprint });
  await printText(whole.text, printer, { kot: true });

  const sections = [
    ...new Set(
      (kot.lines ?? [])
        .filter((line) => (line.round ?? 1) === round && line.status !== 'CANCELLED' && line.stationId)
        .map((line) => String(line.stationId)),
    ),
  ];
  if (sections.length === 0) return;
  for (const stationId of sections) {
    const slip = await getKotTicket(kot.id, { width, round, stationId, reprint });
    await printText(slip.text, printer, { kot: true });
  }
}
