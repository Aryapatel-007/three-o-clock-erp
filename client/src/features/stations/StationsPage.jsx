import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createStation, listStations, updateStation } from '../../api/stations.js';
import Button from '../../components/ui/Button.jsx';
import Input from '../../components/ui/Input.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';

/**
 * Kitchen stations. OWNER and MANAGER. P05.
 *
 * Add, rename, reorder, set "prints tickets", switch off. A station is never
 * deleted. Switching one off sends its categories to the first active station
 * until someone moves them, and the toast says how many.
 *
 * Reached from Settings and the dashboard. It is its own page rather than a
 * section of Settings, because Settings is owner-only and a manager runs the
 * kitchen.
 */
export default function StationsPage() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [toast, setToast] = useState(null);

  const stations = useQuery({
    queryKey: ['stations', 'all'],
    queryFn: () => listStations({ includeInactive: true }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['stations'] });
  const onError = (error) => setToast({ tone: 'error', message: error.message });

  const create = useMutation({
    mutationFn: () =>
      createStation({ name: newName.trim(), displayOrder: (stations.data ?? []).length }),
    onSuccess: () => {
      setNewName('');
      refresh();
    },
    onError,
  });

  const update = useMutation({
    mutationFn: ({ id, changes }) => updateStation(id, changes),
    onSuccess: ({ meta }) => {
      refresh();
      if (meta?.categoriesFallingBack > 0) {
        setToast({
          tone: 'success',
          message: `${meta.categoriesFallingBack} categories now go to the first active station. Move them in the menu.`,
        });
      }
    },
    onError,
  });

  const list = stations.data ?? [];

  return (
    <main className="min-h-full bg-ground">
      <header className="border-b border-line px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div>
            <h1 className="type-title">Kitchen stations</h1>
            <p className="type-caption text-muted">
              Each category&rsquo;s dishes go to its station. The first station takes anything not
              routed.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-2xl gap-4 px-4 py-6">
        {stations.isPending && <Spinner label="Loading stations" />}

        <ul className="divide-y divide-line border-y border-line">
          {list.map((station, index) => (
            <li key={station.id} className={['flex flex-wrap items-center gap-3 py-3', station.isActive ? '' : 'opacity-55'].join(' ')}>
              <span className="w-6 type-num-meta text-muted">{index + 1}</span>
              <input
                aria-label={`Name of ${station.name}`}
                defaultValue={station.name}
                maxLength={40}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== station.name) update.mutate({ id: station.id, changes: { name } });
                }}
                className="min-h-12 min-w-40 flex-1 basis-40 rounded-lg border border-muted bg-surface px-3 type-body"
              />
              {/* P20A. The kitchen ticket's time edge turns Late at this many minutes. */}
              <label className="flex items-center gap-2 type-caption">
                Late after
                <input
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={120}
                  step={1}
                  aria-label={`Minutes before a ticket at ${station.name} is late`}
                  defaultValue={station.targetMinutes ?? 15}
                  onBlur={(event) => {
                    const minutes = Number(event.target.value);
                    if (Number.isInteger(minutes) && minutes !== station.targetMinutes) {
                      update.mutate({ id: station.id, changes: { targetMinutes: minutes } });
                    }
                  }}
                  className="type-num min-h-12 w-20 rounded-lg border border-muted bg-surface px-3"
                />
                min
              </label>
              <label className="flex items-center gap-2 type-caption">
                <input
                  type="checkbox"
                  checked={station.printsTickets}
                  onChange={(event) =>
                    update.mutate({ id: station.id, changes: { printsTickets: event.target.checked } })
                  }
                  className="size-5 accent-[var(--color-accent)]"
                />
                Prints tickets
              </label>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={index === 0}
                  onClick={() => update.mutate({ id: station.id, changes: { displayOrder: Math.max(0, station.displayOrder - 1) } })}
                >
                  Up
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ id: station.id, changes: { displayOrder: station.displayOrder + 1 } })}
                >
                  Down
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => update.mutate({ id: station.id, changes: { isActive: !station.isActive } })}
                >
                  {station.isActive ? 'Turn off' : 'Turn on'}
                </Button>
              </div>
            </li>
          ))}
        </ul>

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim()) create.mutate();
          }}
        >
          <Input
            className="flex-1"
            label="New station"
            value={newName}
            maxLength={40}
            onChange={(event) => setNewName(event.target.value)}
            hint="Live Kitchen, Beverages"
          />
          <Button type="submit" isLoading={create.isPending} disabled={!newName.trim()}>
            Add station
          </Button>
        </form>
      </div>

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}
