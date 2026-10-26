import { useMemo, useState } from 'react';

import { MinusIcon, PlusIcon } from '../../components/ui/icons/index.jsx';
import Money from '../../components/ui/Money.jsx';

import Spinner from '../../components/ui/Spinner.jsx';

/**
 * How well a dish's name matches the search, best first, or null for no match.
 * Every typed word must be in the name. A name starting with the search comes
 * first, then one with a word starting with it, then any other match: typing
 * "latte" lists Caffe Latte before Chole Kulcha Platter. 2026-10-17.
 */
function searchRank(name, needle) {
  const haystack = name.toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  if (!words.every((word) => haystack.includes(word))) return null;
  if (haystack.startsWith(needle)) return 0;
  const starts = haystack.split(/[^a-z0-9]+/);
  if (words.every((word) => starts.some((part) => part.startsWith(word)))) return 1;
  return 2;
}

/**
 * The menu, for adding lines to an order.
 *
 * Reads GET /menu, which is exactly what that endpoint is for: the sellable
 * menu, one request, no inactive records and, by default, nothing that is out
 * of stock. A waiter cannot order something that is not for sale, so nothing
 * that is not for sale is on this screen, and no card needs an availability
 * stamp to say so.
 *
 * Cards, filtered by category pills, because on this screen every dish is a
 * tap target. The search box lives in the order screen's header and is passed
 * in.
 *
 * A dish with nothing to choose shows a stepper once it is on the order and
 * not yet sent. The stepper edits that one line's quantity rather than adding
 * a second line of the same dish, so the kitchen ticket reads "3 × Latte", not
 * three separate lattes. `simpleLines` maps a menu item id to that line.
 *
 * Adding a dish always opens the options panel, `onOpen`, whether the dish or
 * its + is tapped: quantity, a note to the chef with one-tap requests, and the
 * sizes and extras where there are any (the owner's request, 2 October 2026).
 * Once a plain dish is on the order and not yet sent, its stepper changes the
 * quantity in one tap, with no panel. A dish with sizes or extras shows Choose.
 */
export default function MenuPicker({
  tree,
  isPending,
  isError,
  search,
  compact = false,
  disabled,
  simpleLines,
  pendingCounts,
  onOpen,
  onStep,
  onRemove,
}) {
  const [categoryId, setCategoryId] = useState(null);

  const categories = tree ?? [];
  const needle = search.trim().toLowerCase();

  const visible = useMemo(() => {
    const items = categories
      .filter((category) => needle || categoryId === null || category.id === categoryId)
      .flatMap((category) => category.items);
    if (!needle) return items;
    return items
      .map((item) => ({ item, rank: searchRank(item.name, needle) }))
      .filter((entry) => entry.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.item);
  }, [categories, categoryId, needle]);

  const totalItems = categories.reduce((sum, category) => sum + category.items.length, 0);

  return (
    <section aria-label="Menu" className={compact ? 'flex flex-col gap-4 lg:flex-row lg:items-start' : 'flex flex-col gap-4'}>
      {/* P48. On the counter, PetPooja's category list down the left. */}
      {categories.length > 1 && !needle && (
        <div
          className={[
            '-mx-1 flex items-center gap-2 overflow-x-auto px-1 py-1',
            compact ? 'lg:sticky lg:top-4 lg:mx-0 lg:max-h-[calc(100vh-10rem)] lg:w-44 lg:flex-none lg:flex-col lg:items-stretch lg:overflow-y-auto lg:overflow-x-visible lg:px-0' : '',
          ].join(' ')}
        >
          <CategoryPill
            label="All"
            count={totalItems}
            isActive={categoryId === null}
            onClick={() => setCategoryId(null)}
          />
          {categories.map((category) => (
            <CategoryPill
              key={category.id}
              label={category.name}
              count={category.items.length}
              isActive={categoryId === category.id}
              onClick={() => setCategoryId(category.id)}
            />
          ))}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-4">
      {isPending && <Spinner label="Loading the menu" />}

      {isError && (
        <p className="type-body text-alert">The menu could not be loaded. Check your connection.</p>
      )}

      {!isPending && !isError && visible.length === 0 && (
        <p className="type-body text-muted">
          {needle
            ? `Nothing on the menu matches “${search.trim()}”.`
            : 'Nothing on the menu is available right now.'}
        </p>
      )}

      <ul
        className={[
          'grid grid-cols-2 gap-3',
          compact ? 'xl:grid-cols-3' : 'md:grid-cols-3 xl:grid-cols-4',
        ].join(' ')}
      >
        {visible.map((item) => (
          <li key={item.id}>
            <DishCard
              compact={compact}
              item={item}
              line={simpleLines.get(item.id)}
              pendingCount={pendingCounts.get(item.id) ?? 0}
              disabled={disabled}
              onOpen={() => (onOpen ?? onPick)(item)}
              onStep={onStep}
              onRemove={onRemove}
            />
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}

function DishCard({ item, line, pendingCount, disabled, onOpen, onStep, onRemove, compact = false }) {
  const hasChoices = item.variants.length > 0 || item.addOns.length > 0;
  const onOrder = Boolean(line) || (hasChoices && pendingCount > 0);

  return (
    <div
      className={[
        'flex h-full flex-col justify-between rounded-[10px] bg-surface p-3 transition-colors',
        onOrder ? 'border-[3px] border-open' : 'border border-line',
      ].join(' ')}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        aria-label={`${item.name}: choose quantity${hasChoices ? ', size or extras' : ''} and add a note`}
        className="min-h-12 min-w-0 text-left disabled:opacity-60"
      >
        <h3 className="type-body line-clamp-2 break-words font-semibold" title={item.name}>
          {item.name}
        </h3>
        {item.description && <p className="type-caption mt-1 line-clamp-2 text-muted">{item.description}</p>}
        {hasChoices && (
          <span className="type-caption mt-1 block text-muted">{item.variants.length > 0 ? `${item.variants.length} sizes` : 'Extras'}</span>
        )}
      </button>

      {/* P48. On the counter the middle column is narrow: the price sits above the stepper, so + is never cut off. */}
      <div className={compact ? 'mt-3 flex flex-col gap-2' : 'mt-3 flex flex-col gap-2 min-[600px]:flex-row min-[600px]:items-center min-[600px]:justify-between'}>
        {/* P46. An open item's price is typed when it is added. */}
        {item.isOpenItem ? <span className="type-caption text-muted">Type name and price</span> : <Money paise={item.priceInPaise} size="num" />}

        {line ? (
          <div className="flex items-center justify-between rounded-lg border border-ink">
            <StepButton
              label={line.quantity === 1 ? `Remove ${item.name}` : 'One fewer'}
              icon={<MinusIcon />}
              disabled={disabled}
              onClick={() => (line.quantity === 1 ? onRemove(line) : onStep(line, line.quantity - 1))}
            />
            <span aria-live="polite" className="type-num min-w-8 text-center">
              {line.quantity}
            </span>
            <StepButton label="One more" icon={<PlusIcon />} disabled={disabled} onClick={() => onStep(line, line.quantity + 1)} />
          </div>
        ) : hasChoices ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onOpen}
            className="type-label flex min-h-12 items-center gap-1 rounded-lg border border-ink px-3 hover:bg-sunken disabled:opacity-60"
          >
            {pendingCount > 0 ? `${pendingCount} added · Choose` : 'Choose'}
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Add ${item.name}`}
            disabled={disabled}
            onClick={onOpen}
            className="flex size-12 items-center justify-center self-end rounded-lg border border-ink hover:bg-sunken disabled:opacity-60 min-[600px]:self-auto"
          >
            <PlusIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function StepButton({ label, icon, onClick, disabled }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-12 items-center justify-center rounded-lg hover:bg-sunken disabled:opacity-50"
    >
      {icon}
    </button>
  );
}

function CategoryPill({ label, count, isActive, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={[
        'type-label flex min-h-12 flex-none items-center gap-2 whitespace-nowrap rounded-lg border px-4 transition-colors',
        isActive ? 'border-ink bg-sunken text-ink' : 'border-line bg-surface text-muted hover:text-ink',
      ].join(' ')}
    >
      {label}
      <span className="type-num-meta">{count}</span>
    </button>
  );
}
