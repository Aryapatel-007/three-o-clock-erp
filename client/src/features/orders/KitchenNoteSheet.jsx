import { useState } from 'react';

import Sheet from '../../components/ui/Sheet.jsx';
import { QUICK_NOTES } from './LineOptionsPanel.jsx';

/** The server's ceiling, KITCHEN_NOTE_MAX_LENGTH in server/models/Order.js. */
const MAX_LENGTH = 200;

/**
 * P56. One note for every dish on the order, like "Less spicy" for a whole
 * table. Printed at the top of every KOT as FOR ALL ITEMS, dishes already sent
 * included. The same one-tap requests as a dish's own note.
 *
 * 2026-11-03: also the note for one dish in the order, opened from the dish's own
 * Add note in the order (the same 200-character limit, LINE_NOTES_MAX_LENGTH).
 */
export default function KitchenNoteSheet({
  current,
  isBusy,
  onCancel,
  onSave,
  title = 'Note for all dishes',
  description = 'Printed at the top of every KOT for this order, dishes already sent included.',
  placeholder = 'What the whole table wants, like Less spicy',
}) {
  const [note, setNote] = useState(current ?? '');
  const chosen = note.split(',').map((part) => part.trim());
  const toggle = (word) =>
    setNote((value) => {
      const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
      const next = parts.includes(word) ? parts.filter((part) => part !== word) : [...parts, word];
      return next.join(', ').slice(0, MAX_LENGTH);
    });

  return (
    <Sheet
      title={title}
      onClose={onCancel}
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={isBusy || note.trim() === (current ?? '')}
            onClick={() => onSave(note.trim() || null)}
            className="type-button flex min-h-14 w-full items-center justify-center rounded-lg bg-accent text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            Save
          </button>
          {current && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => onSave(null)}
              className="type-label min-h-12 w-full rounded-lg text-ink hover:bg-sunken disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      }
    >
      <p className="type-caption mb-3 text-muted">{description}</p>
      <label className="block">
        <span className="type-label mb-2 block">{title}</span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={MAX_LENGTH}
          autoFocus
          placeholder={placeholder}
          className="type-body min-h-12 w-full rounded-lg border border-muted bg-surface px-3 py-2 text-ink placeholder:text-muted"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Quick notes">
        {QUICK_NOTES.map((word) => (
          <button
            key={word}
            type="button"
            aria-pressed={chosen.includes(word)}
            onClick={() => toggle(word)}
            className={[
              'type-label min-h-12 rounded-full border px-4',
              chosen.includes(word) ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
            ].join(' ')}
          >
            {word}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
