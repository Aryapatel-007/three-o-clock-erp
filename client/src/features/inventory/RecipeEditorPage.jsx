import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import Toast from '../../components/ui/Toast.jsx';
import { listIngredients } from '../../api/inventory.js';
import { listMenuItems } from '../../api/menu.js';
import RecipeLineEditor from './RecipeLineEditor.jsx';
import Spinner from '../../components/ui/Spinner.jsx';

/**
 * The recipe editor. The one back-office screen in M4, and it is allowed to
 * be denser than the rest: nobody edits a recipe standing up mid-queue.
 *
 * A menu item list on the left, per DESIGN-SYSTEM section 6's "lists, not
 * cards, for anything staff scan". Selecting an item shows its variants as
 * tabs; the recipe editor on the right always edits exactly one
 * (menuItemId, variantId) pair, matching how the API itself is shaped.
 */
export default function RecipeEditorPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // { item, variantId }
  const [toast, setToast] = useState(null);

  const itemsQuery = useQuery({
    queryKey: ['menu-items', { search }],
    queryFn: () => listMenuItems({ search: search || undefined, limit: 200 }),
  });

  const ingredientsQuery = useQuery({
    queryKey: ['ingredients', { forRecipeEditor: true }],
    queryFn: () => listIngredients({ limit: 200 }),
  });

  const items = itemsQuery.data?.data ?? [];
  const ingredients = ingredientsQuery.data?.data ?? [];

  const variantTabs = useMemo(() => {
    if (!selected) return [];
    return [
      { variantId: null, label: 'Item level' },
      ...selected.item.variants.map((variant) => ({ variantId: variant.id, label: variant.name })),
    ];
  }, [selected]);

  return (
    <main className="min-h-full bg-ground">
      <header className="sticky top-0 z-10 border-b border-line bg-ground px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <h1 className="type-heading">Recipes</h1>
          <Link
            to="/inventory"
            className="flex min-h-12 items-center rounded-lg px-3 type-caption text-muted hover:bg-sunken "
          >
            Stock
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 px-4 py-6 md:grid-cols-[280px_1fr]">
        <div>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search dishes"
            className="mb-3 min-h-12 w-full rounded-lg border border-muted bg-surface px-3 type-body placeholder:text-muted"
          />
          {itemsQuery.isPending && <Spinner label="Loading" size="sm" />}
          <ul className="divide-y divide-line border-y border-line">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected({ item, variantId: null })}
                  className={[
                    'flex min-h-12 w-full items-center px-2 text-left type-label ',
                    selected?.item.id === item.id ? 'bg-sunken font-semibold' : '',
                  ].join(' ')}
                >
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          {!selected && (
            <p className="rounded-lg border-2 border-dashed border-muted px-4 py-8 text-center type-body text-muted">
              Pick a dish to see or edit its recipe.
            </p>
          )}

          {selected && (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                {variantTabs.map((tab) => (
                  <button
                    key={tab.variantId ?? 'item'}
                    type="button"
                    onClick={() => setSelected({ item: selected.item, variantId: tab.variantId })}
                    className={[
                      'min-h-12 rounded-lg border-2 px-3 type-caption',
                      selected.variantId === tab.variantId
                        ? 'border-ink bg-sunken'
                        : 'border-muted text-muted',
                    ].join(' ')}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <RecipeLineEditor
                key={`${selected.item.id}:${selected.variantId ?? 'item'}`}
                menuItemId={selected.item.id}
                variantId={selected.variantId}
                ingredients={ingredients}
                onSaved={() => {
                  queryClient.invalidateQueries({ queryKey: ['recipes'] });
                  setToast({ tone: 'success', message: 'Recipe saved.' });
                }}
                onDeleted={() => {
                  queryClient.invalidateQueries({ queryKey: ['recipes'] });
                  setToast({ tone: 'success', message: 'Recipe removed.' });
                }}
                onError={(message) => setToast({ tone: 'error', message })}
              />
            </>
          )}
        </div>
      </div>

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}
