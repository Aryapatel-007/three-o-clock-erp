import Sheet from '../../components/ui/Sheet.jsx';
import { formatTimeIst } from '../../utils/formatDate.js';

/**
 * A free table held for a booking soon: are these the booking's guests?
 *
 * P59. Every other free table opens at once; the number of guests is asked
 * with the guest's name and mobile on the first Send (GuestDetailsSheet). Only
 * a booking needs a question at seating, because seating it opens the order
 * with its party, name and mobile (P23).
 */
export default function SeatTablePanel({ table, isBusy, onCancel, onSeatOthers, reservation, onSeatReservation }) {
  return (
    <Sheet
      title={`Seat guests at ${table.name}`}
      subtitle={[table.section, table.seats != null && `${table.seats} seats`].filter(Boolean).join(' · ') || null}
      onClose={onCancel}
      footer={
        <button
          type="button"
          disabled={isBusy}
          onClick={onSeatOthers}
          className="type-label min-h-12 w-full rounded-lg border border-line text-ink hover:bg-sunken disabled:opacity-50"
        >
          {isBusy ? 'Opening…' : 'Seat other guests'}
        </button>
      }
    >
      <div className="grid gap-2 rounded-lg border border-open bg-open-tint p-3 text-open">
        <p className="type-label">
          Reserved for {reservation.guestName}, {reservation.partySize} at {formatTimeIst(reservation.at)} ({reservation.reference})
        </p>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onSeatReservation(reservation)}
          className="type-button min-h-12 rounded-lg bg-accent px-4 text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          Seat {reservation.reference}, {reservation.partySize} {reservation.partySize === 1 ? 'guest' : 'guests'}
        </button>
      </div>
    </Sheet>
  );
}
