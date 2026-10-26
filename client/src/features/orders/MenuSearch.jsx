import { CrossIcon, SearchIcon } from '../../components/ui/icons/index.jsx';

/**
 * The menu's search box, on its own full-width row above the dishes and held
 * at the top while the menu scrolls. 2026-10-17: in the header it shared a
 * row with Switch table and the other buttons, and on a captain's phone it
 * shrank to a sliver. Larger text and a 56px height, so it is easy to hit and
 * read; a clear button once something is typed.
 */
export default function MenuSearch({ value, onChange }) {
  return (
    <div className="sticky top-0 z-10 -mx-1 bg-ground px-1 py-2">
      <label className="relative block w-full">
        <span className="sr-only">Search the menu</span>
        <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-muted">
          <SearchIcon size={22} />
        </span>
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search dishes"
          autoComplete="off"
          enterKeyHint="search"
          className="type-heading min-h-14 w-full rounded-lg border-2 border-muted bg-surface pl-12 pr-14 text-ink placeholder:font-normal placeholder:text-muted focus:border-ink [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear the search"
            className="absolute inset-y-0 right-1 my-auto flex size-12 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
          >
            <CrossIcon size={20} />
          </button>
        )}
      </label>
    </div>
  );
}
