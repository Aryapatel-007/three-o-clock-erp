/**
 * The kitchen display. Shapes come from Part 4 section M2.4.
 *
 * A KOT is created by firing an order and never directly, so there is no POST
 * in this file. The kitchen reads tickets and marks food ready; everything else
 * about a ticket is decided on the floor.
 */
import mongoose from 'mongoose';

import { Kot, KOT_LINE_STATUSES } from '../models/Kot.js';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { KOT_STATUSES, lineStationId, loadKotInTenant, markKotLinesReady, serialiseKot, undoKotReady } from '../services/kitchenService.js';
import { renderKotTicket } from '../services/kotTicketService.js';
import { BusinessRuleError } from '../utils/errors.js';
import { sendList, sendSuccess } from '../utils/response.js';
import { scoped } from '../utils/scopedQuery.js';

/**
 * GET /kots
 *
 * Sorted oldest first, which is the opposite of every other list in this
 * product and is correct here: a kitchen works the oldest ticket first.
 *
 * The status filter is applied in memory, because a ticket's status is derived
 * from its lines and the database has no field to filter on. That costs a page
 * that can come back shorter than its limit, and the alternatives are worse: an
 * aggregation that recomputes the rule in a second language, or a stored status
 * that can drift from the lines it describes.
 */
export async function listKots(req, res) {
  const { page, limit, status, stationId, sort } = req.query;

  const filter = { ...scoped(req) };
  /**
   * P05. One station's tickets, or "none" for the ones with no station.
   * P36: a ticket can hold several stations' dishes, so a station's tickets
   * are those with a line there; a line from before P36 has no station of its
   * own and goes by the ticket's.
   */
  if (stationId === 'none') {
    filter.stationId = null;
    filter['lines.stationId'] = null;
  } else if (stationId !== undefined) {
    const station = new mongoose.Types.ObjectId(stationId);
    filter.$or = [{ 'lines.stationId': station }, { stationId: station }];
  }

  /**
   * The status is derived from the lines, but "still to cook" is a plain fact
   * about them: a ticket is PENDING or IN_PROGRESS exactly when one of its
   * lines is still PENDING, and COMPLETED when none is. That part of the filter
   * goes into the query. It used to be applied after reading the oldest page,
   * so once a kitchen had more than one page of finished tickets the board
   * read only finished ones and showed nothing, and a new ticket never
   * appeared (found 2 October 2026 with ten days of data).
   */
  if (status !== undefined) {
    const wantsOpen = status.includes(KOT_STATUSES.PENDING) || status.includes(KOT_STATUSES.IN_PROGRESS);
    const wantsDone = status.includes(KOT_STATUSES.COMPLETED);
    if (wantsOpen && !wantsDone) filter['lines.status'] = KOT_LINE_STATUSES.PENDING;
    if (wantsDone && !wantsOpen) filter['lines.status'] = { $ne: KOT_LINE_STATUSES.PENDING };
  }

  const [tickets, total] = await Promise.all([
    Kot.find(filter)
      // P41. `recent`: the tickets that changed last first, for Recall. Otherwise the queue, oldest first.
      .sort(sort === 'recent' ? { updatedAt: -1, _id: -1 } : { createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Kot.countDocuments(filter),
  ]);

  const serialised = tickets.map(serialiseKot);
  const data = status === undefined ? serialised : serialised.filter((kot) => status.includes(kot.status));

  return sendList(res, data, { page, limit, total });
}

/** GET /kots/:kotId */
export async function getKot(req, res) {
  const kot = await loadKotInTenant(req, req.params.kotId);
  return sendSuccess(res, serialiseKot(kot));
}

/**
 * PATCH /kots/:kotId/lines/:lineId/ready
 *
 * All six roles. Whoever is standing at the pass marks the food ready, and
 * asking them what their job title is while a dish goes cold helps nobody.
 */
export async function markKotLineReady(req, res) {
  const kot = await markKotLinesReady(req, {
    kotId: req.params.kotId,
    lineId: req.params.lineId,
  });

  return sendSuccess(res, kot);
}

/** PATCH /kots/:kotId/ready */
export async function markKotReady(req, res) {
  const kot = await markKotLinesReady(req, { kotId: req.params.kotId, stationId: req.query.stationId ?? null });
  return sendSuccess(res, kot);
}

/** POST /kots/:kotId/lines/:lineId/undo-ready. P29 Part E. All six roles, like marking ready. */
export async function undoKotLineReady(req, res) {
  return sendSuccess(res, await undoKotReady(req, { kotId: req.params.kotId, lineId: req.params.lineId }));
}

/** POST /kots/:kotId/undo-ready. P29 Part E. Every READY line on the ticket. */
export async function undoKotTicketReady(req, res) {
  return sendSuccess(res, await undoKotReady(req, { kotId: req.params.kotId, stationId: req.query.stationId ?? null }));
}

/**
 * GET /kots/:kotId/ticket. P05.
 *
 * The ticket as plain text, laid out on the server like the receipt. The
 * guest count, the customer and the name of whoever fired it are read here,
 * for printing only; none of them is a figure anything adds up.
 */
export async function getKotTicket(req, res) {
  const kot = await loadKotInTenant(req, req.params.kotId);
  const [order, firedBy] = await Promise.all([
    Order.findOne({ ...scoped(req), _id: kot.orderId })
      .select('guestCount customerName platform origin')
      .lean(),
    User.findOne({ restaurantId: req.restaurantId, _id: kot.firedBy }).select('name').lean(),
  ]);

  const { width, reprint, round, stationId } = req.query;

  // P36. One round, one station's dishes, or both; neither prints the whole ticket.
  const whole = serialiseKot(kot);
  const lines = whole.lines.filter(
    (line) => (round === undefined || line.round === round) && (!stationId || lineStationId(kot, line) === String(stationId)),
  );
  if (lines.length === 0) throw new BusinessRuleError('Nothing on this ticket is for that round or station.');
  // 2026-11-03: the whole ticket is always headed for all sections; a section's slip with its name.
  const station = stationId ? lines[0].stationName : null;
  const text = renderKotTicket({
    kot: {
      ...whole,
      lines,
      stationName: station,
      round: round ?? null,
      firedAt: round === undefined ? whole.firedAt : lines[0].firedAt,
    },
    order,
    firedByName: firedBy?.name ?? null,
    width,
    reprint: Boolean(reprint),
  });

  return sendSuccess(res, { width, text });
}
