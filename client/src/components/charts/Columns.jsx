import { useState } from 'react';

/**
 * A single-series column chart, in plain HTML and CSS. No charting library,
 * and deliberately no SVG: an earlier version positioned SVG rects with
 * `min()` and `calc()` inside width attributes, which browsers support
 * unevenly -- the bars rendered at the wrong width and sat left of the labels
 * they belonged to. Flexbox does the same job with geometry the browser is
 * certain about, and centring becomes `justify-center` rather than arithmetic.
 *
 * Single series on purpose, and that decides the colour: with nothing to tell
 * apart, the mark carries no identity, so it uses `ink` per DESIGN-SYSTEM
 * section 3 -- `chana`, `mirch` and `patta` are functional colour and a data
 * mark that means nothing in particular is not allowed to borrow one. There is
 * no legend, because one series needs none: the caption says what is plotted.
 *
 * Mark specs are fixed: columns cap at 24px wide however much room the band
 * has, a 4px rounded cap at the data end and square at the baseline, a hairline
 * solid grid one step off the surface, and air either side of each column so
 * the surface itself does the separating. Never a stroke around a mark, which
 * would add ink that is not data.
 *
 * Values are NOT labelled on every column. A number over every bar is chaos and
 * goes unread; the axis carries orientation, the tooltip carries the exact
 * figure, and the table view underneath carries all of them for anyone who
 * cannot hover at all.
 */
const TICK_COUNT = 4;

export default function Columns({
  data,
  valueKey = 'value',
  labelKey = 'label',
  formatValue = (value) => String(value),
  formatTick = (value) => String(value),
  height = 200,
  caption,
  emptyMessage = 'Nothing in this range.',
}) {
  const [hovered, setHovered] = useState(null);

  const rows = data ?? [];
  const max = Math.max(0, ...rows.map((row) => row[valueKey] ?? 0));

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border-2 border-dashed border-muted px-4 py-8 text-center type-caption text-muted">
        {emptyMessage}
      </p>
    );
  }

  const niceMax = max === 0 ? 1 : niceCeiling(max);
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_unused, index) => (niceMax / TICK_COUNT) * index);

  /**
   * Show every nth label, so a 30-day range does not try to print 30 dates
   * into 30 narrow bands. The ones that do print are allowed to overflow
   * their own band -- their neighbours are blank, so there is room, and an
   * ellipsis in the middle of a date is worse than no date at all.
   */
  const labelEvery = rows.length <= 12 ? 1 : Math.ceil(rows.length / 12);
  // A phone has room for about six labels ("10pm" is four characters wide), so a
  // 24-hour axis there prints every fourth hour instead of running them together.
  const phoneEvery = Math.max(labelEvery, rows.length <= 6 ? 1 : Math.ceil(rows.length / 6));

  return (
    <figure className="m-0">
      <div className="flex">
        {/* Y-axis ticks. Tabular figures, because this is a column of numbers
            that has to align vertically. */}
        <div
          className="flex w-16 shrink-0 flex-col-reverse justify-between pr-2 text-right"
          style={{ height }}
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="type-num-meta tabular-nums text-muted"
              style={{ transform: 'translateY(50%)' }}
            >
              {formatTick(Math.round(tick))}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1" style={{ height }}>
          {/* Gridlines: hairline, solid, one step off the surface. Never dashed. */}
          <div className="absolute inset-0 flex flex-col-reverse justify-between" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick} className="h-px w-full bg-line" />
            ))}
          </div>

          {/* The columns. Each band is an equal flex share; the column is
              centred in it and capped, so the leftover width is air. */}
          <div className="absolute inset-0 flex items-end">
            {rows.map((row, index) => {
              const value = row[valueKey] ?? 0;
              const percent = niceMax > 0 ? (value / niceMax) * 100 : 0;
              const isDimmed = hovered !== null && hovered !== index;

              return (
                <button
                  key={row[labelKey] ?? index}
                  type="button"
                  // The hit target is the whole band at full height, so a
                  // quiet day with a zero-height column is as hoverable as
                  // the busiest one.
                  className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center px-px focus-visible:outline-2 focus-visible:outline-accent"
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(index)}
                  onBlur={() => setHovered(null)}
                  aria-label={`${row[labelKey]}: ${formatValue(value)}`}
                >
                  <span
                    aria-hidden="true"
                    className="w-full max-w-[24px] rounded-t-[4px] bg-ink transition-opacity"
                    style={{ height: `${percent}%`, opacity: isDimmed ? 0.45 : 1 }}
                  />
                </button>
              );
            })}
          </div>

          {hovered !== null && (
            <div
              role="status"
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded-[8px] border border-line bg-surface px-3 py-2 shadow-float"
              style={{
                left: `${((hovered + 0.5) / rows.length) * 100}%`,
                bottom: '100%',
                transform: 'translate(-50%, -8px)',
              }}
            >
              <p className="type-caption text-muted">{rows[hovered][labelKey]}</p>
              <p className="type-num text-ink">
                {formatValue(rows[hovered][valueKey] ?? 0)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* The x-axis band sits inside the figure, so a card never grows a nested
          scrollbar to reach its own labels. */}
      <div className="ml-16 mt-2 flex">
        {rows.map((row, index) => (
          <span
            key={row[labelKey] ?? index}
            className="flex min-w-0 flex-1 justify-center overflow-visible whitespace-nowrap type-num-meta text-muted"
          >
            {index % labelEvery === 0 && (
              <span className={index % phoneEvery === 0 ? '' : 'hidden sm:inline'}>{row[labelKey]}</span>
            )}
          </span>
        ))}
      </div>

      {caption && (
        <figcaption className="ml-16 mt-2 type-caption text-muted">{caption}</figcaption>
      )}
    </figure>
  );
}

/** Rounds an axis maximum up to a clean 1/2/5 × 10^n, so ticks read as round numbers. */
function niceCeiling(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}
