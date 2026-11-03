import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import Toast from '../../components/ui/Toast.jsx';
import { listTables, saveTableLayout } from '../../api/orders.js';
import { updateSettings } from '../../api/settings.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { ROLES } from '../users/roles.js';
import { errorMessage } from './errorCopy.js';
import Spinner from '../../components/ui/Spinner.jsx';

const COLUMNS = 24;
const ROWS = 16;
const UNASSIGNED = 'Unassigned';

const SIZES = [
  { w: 1, h: 1, label: '1 × 1' },
  { w: 2, h: 1, label: '2 × 1' },
  { w: 2, h: 2, label: '2 × 2' },
  { w: 3, h: 1, label: '3 × 1' },
  { w: 4, h: 2, label: '4 × 2' },
];
const SHAPES = [
  { value: 'SQUARE', label: 'Square' },
  { value: 'ROUND', label: 'Round' },
  { value: 'LONG', label: 'Long' },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Arrange tables. M20, built in P19. OWNER and MANAGER.
 *
 * Each section is a 24 by 16 grid. Drag a table from the tray onto the grid,
 * or move it on the grid; it snaps to whole cells. Pointer events, so a mouse
 * and a finger work the same, and no drag library. A table that overlaps
 * another turns red and Save stays off until none does; the server checks
 * again and its message is shown as it came. Save sends the whole section.
 *
 * Section order is set here too, by moving sections up and down. Saving it is
 * a settings change, which is the owner's; a manager sees the order.
 */
export default function TableArrangePage() {
  const queryClient = useQueryClient();
  const { user, features, refreshFeatures } = useAuth();
  const isOwner = user?.role === ROLES.OWNER;
  const [toast, setToast] = useState(null);

  const tables = useQuery({ queryKey: ['tables', { includeInactive: false }], queryFn: () => listTables() });
  const rows = tables.data ?? [];

  const sectionNames = useMemo(() => {
    const names = [...new Set(rows.map((table) => table.section || UNASSIGNED))];
    const order = (features?.floor?.sectionOrder ?? []).map((name) => name.toLowerCase());
    const rank = (name) => (order.indexOf(name.toLowerCase()) === -1 ? order.length : order.indexOf(name.toLowerCase()));
    return names.filter((name) => name !== UNASSIGNED).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [rows, features?.floor?.sectionOrder]);

  const [section, setSection] = useState(null);
  const active = section ?? sectionNames[0] ?? null;

  return (
    <main className="v2 text-ink min-h-full bg-ground px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="type-label text-muted">
              <Link to="/tables" className="hover:underline">
                Table setup
              </Link>{' '}
              › Arrange tables
            </p>
            <h1 className="type-title">Arrange tables</h1>
            <p className="type-caption text-muted">Place each section&apos;s tables where they stand in the room.</p>
          </div>
          <Link to="/floor" className="flex min-h-12 items-center rounded-lg bg-surface px-4 type-caption border border-line hover:bg-sunken">
            Open the floor
          </Link>
        </header>

        {tables.isPending && <Spinner label="Loading tables" />}
        {tables.isError && <p className="type-body text-alert">{errorMessage(tables.error)}</p>}
        {tables.isSuccess && sectionNames.length === 0 && (
          <p className="rounded-[10px] bg-surface p-6 type-label border border-line">
            Give tables a section on the Table setup screen first. A plan is drawn per section.
          </p>
        )}

        {sectionNames.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {sectionNames.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={active === name}
                onClick={() => setSection(name)}
                className={['min-h-12 rounded-lg px-4 type-label border border-line', active === name ? 'bg-ink text-surface' : 'bg-surface text-muted'].join(' ')}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {active && (
          <SectionEditor
            key={active}
            section={active}
            tables={rows.filter((table) => (table.section || UNASSIGNED) === active)}
            onSaved={(message) => {
              queryClient.invalidateQueries({ queryKey: ['tables'] });
              setToast({ tone: 'success', message });
            }}
            onError={(message) => setToast({ tone: 'error', message })}
          />
        )}

        {sectionNames.length > 1 && (
          <SectionOrder
            names={sectionNames}
            canSave={isOwner}
            onSaved={async () => {
              await refreshFeatures();
              setToast({ tone: 'success', message: 'Section order saved.' });
            }}
            onError={(message) => setToast({ tone: 'error', message })}
          />
        )}
      </div>
      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}

function SectionEditor({ section, tables, onSaved, onError }) {
  const initial = useMemo(() => Object.fromEntries(tables.map((table) => [table.id, table.layout ?? null])), [tables]);
  const [draft, setDraft] = useState(initial);
  const [selectedId, setSelectedId] = useState(null);
  const [drag, setDrag] = useState(null);
  const gridRef = useRef(null);

  useEffect(() => setDraft(initial), [initial]);

  const nameOf = useMemo(() => Object.fromEntries(tables.map((table) => [table.id, table.name])), [tables]);
  const placed = Object.entries(draft).filter(([, layout]) => layout);
  const tray = tables.filter((table) => !draft[table.id]);

  // While dragging, the moving table is drawn at its preview place.
  const positionOf = (id) => (drag?.id === id && drag.preview ? { ...draft[id], ...drag.preview } : draft[id]);

  // Cheap at tens of tables, so worked out on every render, drag included.
  const clashing = new Set();
  const entries = Object.keys(draft)
    .map((id) => [id, positionOf(id)])
    .filter(([, layout]) => layout);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (overlaps(entries[i][1], entries[j][1])) {
        clashing.add(entries[i][0]);
        clashing.add(entries[j][0]);
      }
    }
  }

  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  /** The grid cell under a pointer, for a table of w by h grabbed at (grabX, grabY) cells. */
  const cellAt = (event, w, h, grabX, grabY) => {
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) return null;
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * COLUMNS) - grabX;
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * ROWS) - grabY;
    return { x: clamp(col, 0, COLUMNS - w), y: clamp(row, 0, ROWS - h) };
  };

  useEffect(() => {
    if (!drag) return undefined;
    const onMove = (event) => {
      const preview = cellAt(event, drag.w, drag.h, drag.grabX, drag.grabY);
      setDrag((current) => (current ? { ...current, preview } : current));
    };
    const onUp = (event) => {
      const preview = cellAt(event, drag.w, drag.h, drag.grabX, drag.grabY);
      if (preview) {
        setDraft((current) => ({
          ...current,
          [drag.id]: { shape: current[drag.id]?.shape ?? 'SQUARE', w: drag.w, h: drag.h, ...preview },
        }));
        setSelectedId(drag.id);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }); // re-bound each render so the handlers see the current drag

  const startFromTray = (event, table) => {
    event.preventDefault();
    setDrag({ id: table.id, w: 2, h: 2, grabX: 1, grabY: 1, preview: null });
  };

  const startOnGrid = (event, id) => {
    event.preventDefault();
    const layout = draft[id];
    const rect = gridRef.current.getBoundingClientRect();
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * COLUMNS);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * ROWS);
    setSelectedId(id);
    setDrag({ id, w: layout.w, h: layout.h, grabX: clamp(col - layout.x, 0, layout.w - 1), grabY: clamp(row - layout.y, 0, layout.h - 1), preview: { x: layout.x, y: layout.y } });
  };

  const update = (id, change) =>
    setDraft((current) => {
      const next = { ...current[id], ...change };
      if (next.shape === 'LONG' && next.w === next.h) next.shape = 'SQUARE';
      next.x = clamp(next.x, 0, COLUMNS - next.w);
      next.y = clamp(next.y, 0, ROWS - next.h);
      return { ...current, [id]: next };
    });

  const save = useMutation({
    mutationFn: () =>
      saveTableLayout({
        section,
        tables: tables.map((table) => {
          const layout = draft[table.id];
          return layout ? { tableId: table.id, x: layout.x, y: layout.y, w: layout.w, h: layout.h, shape: layout.shape } : { tableId: table.id, layout: null };
        }),
      }),
    onSuccess: () => onSaved(`${section} saved.`),
    onError: (error) => onError(errorMessage(error)),
  });

  const selected = selectedId && draft[selectedId] ? draft[selectedId] : null;

  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="flex flex-col gap-3">
        <div
          ref={gridRef}
          className="relative w-full touch-none select-none overflow-hidden rounded-[10px] bg-surface border border-line"
          style={{
            aspectRatio: `${COLUMNS} / ${ROWS}`,
            backgroundImage:
              'linear-gradient(to right, color-mix(in srgb, var(--color-line) 100%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-line) 100%, transparent) 1px, transparent 1px)',
            backgroundSize: `${100 / COLUMNS}% ${100 / ROWS}%`,
          }}
          aria-label={`${section} floor plan, ${COLUMNS} by ${ROWS} cells`}
        >
          {[...placed.map(([id]) => id), ...(drag && !draft[drag.id] && drag.preview ? [drag.id] : [])].map((id) => {
            const layout = drag?.id === id && drag.preview ? { shape: draft[id]?.shape ?? 'SQUARE', w: drag.w, h: drag.h, ...drag.preview } : draft[id];
            if (!layout) return null;
            const bad = clashing.has(id);
            return (
              <button
                key={id}
                type="button"
                onPointerDown={(event) => startOnGrid(event, id)}
                onClick={() => setSelectedId(id)}
                aria-label={`${nameOf[id]}, column ${layout.x + 1}, row ${layout.y + 1}`}
                className={[
                  'absolute flex touch-none items-center justify-center p-1 font-mono text-[clamp(9px,1.4vw,15px)] font-bold',
                  'focus-visible:outline-2 focus-visible:outline-accent',
                ].join(' ')}
                style={{
                  left: `${(layout.x / COLUMNS) * 100}%`,
                  top: `${(layout.y / ROWS) * 100}%`,
                  width: `${(layout.w / COLUMNS) * 100}%`,
                  height: `${(layout.h / ROWS) * 100}%`,
                  cursor: 'grab',
                }}
              >
                <span
                  className={[
                    'flex h-full w-full items-center justify-center border border-line',
                    layout.shape === 'ROUND' ? 'rounded-full' : 'rounded-lg',
                    bad ? 'border-[3px] border-alert bg-alert-tint text-alert' : selectedId === id ? 'border-2 border-ink bg-surface text-ink' : 'border border-line bg-surface text-ink',
                  ].join(' ')}
                >
                  {nameOf[id]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={clashing.size > 0 || save.isPending || !changed}
            onClick={() => save.mutate()}
            className="min-h-12 rounded-lg bg-accent px-6 type-button text-on-accent disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {clashing.size > 0 && <span className="type-caption text-alert">Two tables overlap. Move one before saving.</span>}
          {!changed && clashing.size === 0 && <span className="type-caption text-muted">Saved as shown.</span>}
        </div>
      </div>

      <aside className="flex flex-col gap-4">
        <div className="rounded-[10px] bg-surface p-4 border border-line">
          <h2 className="mb-2 type-label text-muted">Not on the plan</h2>
          {tray.length === 0 ? (
            <p className="type-caption text-muted">Every table in {section} is on the plan.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {tray.map((table) => (
                <li key={table.id}>
                  <button
                    type="button"
                    onPointerDown={(event) => startFromTray(event, table)}
                    className="flex min-h-12 min-w-12 touch-none items-center justify-center rounded-lg bg-sunken px-3 type-num border border-line"
                    style={{ cursor: 'grab' }}
                  >
                    {table.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 type-caption text-muted">Drag a table onto the grid.</p>
        </div>

        {selected && (
          <div className="rounded-[10px] bg-surface p-4 border border-line">
            <h2 className="mb-3 type-body font-semibold">{nameOf[selectedId]}</h2>
            <p className="mb-1 type-label text-muted">Size</p>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {SIZES.map((size) => (
                <button
                  key={size.label}
                  type="button"
                  aria-pressed={selected.w === size.w && selected.h === size.h}
                  onClick={() => update(selectedId, { w: size.w, h: size.h })}
                  className={['min-h-12 rounded-lg type-num-meta', selected.w === size.w && selected.h === size.h ? 'bg-ink text-surface' : 'bg-sunken'].join(' ')}
                >
                  {size.label}
                </button>
              ))}
            </div>
            <p className="mb-1 type-label text-muted">Shape</p>
            <div className="mb-4 grid grid-cols-3 gap-2">
              {SHAPES.map((shape) => {
                const disabled = shape.value === 'LONG' && selected.w === selected.h;
                return (
                  <button
                    key={shape.value}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected.shape === shape.value}
                    onClick={() => update(selectedId, { shape: shape.value })}
                    title={disabled ? 'A long table has a different width and height.' : undefined}
                    className={['min-h-12 rounded-lg type-caption disabled:opacity-40', selected.shape === shape.value ? 'bg-ink text-surface' : 'bg-sunken'].join(' ')}
                  >
                    {shape.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                setDraft((current) => ({ ...current, [selectedId]: null }));
                setSelectedId(null);
              }}
              className="min-h-12 w-full rounded-lg bg-alert-tint type-caption text-alert"
            >
              Remove from plan
            </button>
          </div>
        )}
      </aside>
    </section>
  );
}

/** Sections up and down. Saving is a settings change, so the owner's. */
function SectionOrder({ names, canSave, onSaved, onError }) {
  const [order, setOrder] = useState(names);
  useEffect(() => setOrder(names), [names]);
  const moved = order.join('|') !== names.join('|');

  const save = useMutation({
    mutationFn: () => updateSettings({ reason: 'Floor section order', floor: { sectionOrder: order } }),
    onSuccess: onSaved,
    onError: (error) => onError(errorMessage(error)),
  });

  const swap = (index, by) =>
    setOrder((current) => {
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });

  return (
    <section className="rounded-[10px] bg-surface p-4 border border-line">
      <h2 className="mb-1 type-body font-semibold">Section order</h2>
      <p className="mb-3 type-caption text-muted">The order the floor shows its sections in.</p>
      <ol className="flex flex-col gap-2">
        {order.map((name, index) => (
          <li key={name} className="flex items-center justify-between gap-3 rounded-lg bg-sunken px-3 py-2">
            <span className="type-label">
              <span className="mr-2 font-mono text-muted">{index + 1}</span>
              {name}
            </span>
            {canSave && (
              <span className="flex gap-1">
                <button type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => swap(index, -1)} className="size-12 rounded-lg bg-surface type-body border border-line disabled:opacity-40">
                  ↑
                </button>
                <button type="button" aria-label={`Move ${name} down`} disabled={index === order.length - 1} onClick={() => swap(index, 1)} className="size-12 rounded-lg bg-surface type-body border border-line disabled:opacity-40">
                  ↓
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {canSave ? (
        <button
          type="button"
          disabled={!moved || save.isPending}
          onClick={() => save.mutate()}
          className="type-label mt-3 min-h-12 rounded-lg border border-ink bg-surface text-ink hover:bg-sunken px-4 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save section order'}
        </button>
      ) : (
        <p className="mt-3 type-caption text-muted">Only the owner changes the section order, because it is a setting.</p>
      )}
    </section>
  );
}
