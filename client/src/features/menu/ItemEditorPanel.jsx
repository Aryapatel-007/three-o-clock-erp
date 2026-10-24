import { useState } from 'react';

import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import { paiseToInput, parseRupeesToPaise } from '../../utils/formatMoney.js';
import PhotoField from './PhotoField.jsx';
import SubItemListEditor from './SubItemListEditor.jsx';

/**
 * The slide-over item editor.
 *
 * A panel, not a modal. A modal blocks the category rail, and someone editing
 * an item frequently needs to glance back at it mid-edit.
 *
 * The form works in rupees because that is what a person types. Everything
 * leaving here is whole paise.
 */

const EMPTY = {
  name: '',
  description: '',
  price: '',
  taxPercent: '5',
  displayOrder: '0',
  variants: [],
  addOns: [],
  isOpenItem: false,
  hsnCode: '',
};

const toEntry = (sub) => ({
  id: sub.id,
  name: sub.name,
  price: paiseToInput(sub.priceInPaise),
  isAvailable: sub.isAvailable,
});

/**
 * The form's starting values.
 *
 * Read straight into useState rather than pushed in by an effect, so the fields
 * are populated on the first paint. Filling them in an effect showed an empty
 * form for a frame every time the panel opened. The caller keys this component
 * on the item id, so switching items remounts it and this runs again.
 */
function buildForm(item) {
  if (!item) return EMPTY;
  return {
    name: item.name,
    description: item.description ?? '',
    price: paiseToInput(item.priceInPaise),
    taxPercent: String((item.taxRateBps ?? 0) / 100),
    displayOrder: String(item.displayOrder ?? 0),
    variants: (item.variants ?? []).map(toEntry),
    addOns: (item.addOns ?? []).map(toEntry),
    isOpenItem: item.isOpenItem === true,
    hsnCode: item.hsnCode ?? '',
  };
}

export default function ItemEditorPanel({
  item,
  categories,
  categoryId,
  onSave,
  onClose,
  onToggleActive,
  isSaving,
  saveError,
}) {
  const [form, setForm] = useState(() => buildForm(item));
  const [selectedCategoryId, setSelectedCategoryId] = useState(item?.categoryId ?? categoryId);
  const [fieldErrors, setFieldErrors] = useState({});

  const isEditing = Boolean(item);

  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));

  function handleSubmit(event) {
    event.preventDefault();

    const errors = {};
    const priceInPaise = parseRupeesToPaise(form.price);
    if (!form.name.trim()) errors.name = 'Give the item a name.';
    if (priceInPaise === null || priceInPaise < 0) errors.price = 'Enter a price like 240.00';

    const taxPercent = Number(form.taxPercent);
    if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
      errors.taxPercent = 'Enter a rate between 0 and 100.';
    }

    const buildSubs = (entries, label) =>
      entries.map((entry, index) => {
        const subPaise = parseRupeesToPaise(entry.price);
        if (!entry.name.trim()) errors[`${label}.${index}.name`] = 'Needs a name.';
        if (subPaise === null || subPaise < 0) errors[`${label}.${index}.price`] = 'Enter a price.';
        return {
          // Carrying the id back is what keeps a recipe attached to its variant.
          ...(entry.id ? { id: entry.id } : {}),
          name: entry.name.trim(),
          priceInPaise: subPaise ?? 0,
          isAvailable: entry.isAvailable !== false,
        };
      });

    // P64. Empty clears it: the restaurant's default SAC prints instead.
    const hsnCode = form.hsnCode.trim();
    if (hsnCode !== '' && !/^\d{4,8}$/.test(hsnCode)) errors.hsnCode = 'An HSN or SAC code is 4 to 8 digits.';

    const variants = buildSubs(form.variants, 'variants');
    const addOns = buildSubs(form.addOns, 'add-ons');

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    onSave({
      categoryId: selectedCategoryId,
      name: form.name.trim(),
      description: form.description.trim(),
      priceInPaise,
      // Basis points, so 5% is 500. Never a float rate.
      taxRateBps: Math.round(taxPercent * 100),
      displayOrder: Number(form.displayOrder) || 0,
      // P46. An open item has no sizes or extras: its name and price are typed when ordering.
      variants: form.isOpenItem ? [] : variants,
      addOns: form.isOpenItem ? [] : addOns,
      isOpenItem: form.isOpenItem,
      hsnCode: hsnCode === '' ? null : hsnCode,
    });
  }

  return (
    <aside className="flex w-full flex-col gap-4 overflow-y-auto border-ink bg-ground p-6 shadow-float md:w-[26rem] md:border-l-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-ink">{isEditing ? 'Edit item' : 'Add item'}</h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-12 px-1 type-caption text-muted underline-offset-4 hover:underline "
        >
          Close
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* P24. Saved on its own, so only for an item that exists. */}
        {isEditing && <PhotoField item={item} />}
        <Input label="Item name" required value={form.name} onChange={set('name')} error={fieldErrors.name} />
        <Input label="Description" value={form.description} onChange={set('description')} />

        <Select
          label="Category"
          value={selectedCategoryId ?? ''}
          onChange={(event) => setSelectedCategoryId(event.target.value)}
          options={categories.map((c) => ({
            value: c.id,
            label: c.isActive ? c.name : `${c.name} (turned off)`,
          }))}
        />

        {/* P46. */}
        <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface px-3 py-3">
          <input
            type="checkbox"
            checked={form.isOpenItem}
            onChange={(event) => setForm((f) => ({ ...f, isOpenItem: event.target.checked, ...(event.target.checked && f.price === '' ? { price: '0' } : {}) }))}
            className="mt-1 size-5 accent-[var(--color-accent)]"
          />
          <span>
            <span className="type-label block">Open item</span>
            <span className="type-caption text-muted">
              Staff type the name and price when ordering, for anything not on the menu. Its category sends it to the kitchen and its GST rate is used; the price here is not. It never shows on the online page.
            </span>
          </span>
        </label>

        <div className="flex gap-3">
          <Input
            className="flex-1"
            label="Price"
            inputMode="decimal"
            value={form.price}
            onChange={set('price')}
            error={fieldErrors.price}
          />
          <Input
            className="flex-1"
            label="GST rate %"
            inputMode="decimal"
            value={form.taxPercent}
            onChange={set('taxPercent')}
            error={fieldErrors.taxPercent}
          />
          <Input
            className="w-24"
            label="Order"
            inputMode="numeric"
            value={form.displayOrder}
            onChange={set('displayOrder')}
            hint="Lower first"
          />
        </div>

        {/* P64. Frozen onto each line when the dish is ordered. */}
        <Input
          label="HSN/SAC"
          inputMode="numeric"
          maxLength={8}
          value={form.hsnCode}
          onChange={set('hsnCode')}
          error={fieldErrors.hsnCode}
          hint="Leave empty to print the default SAC code from Invoice layout. Only dishes ordered from now take a change."
        />

        {/* P46. An open item has no sizes or extras. */}
        {!form.isOpenItem && (
          <>
            <SubItemListEditor
              title="Variants"
              addLabel="+ Add variant"
              entries={form.variants}
              fieldErrors={fieldErrors}
              onChange={(variants) => setForm((f) => ({ ...f, variants }))}
            />
            <SubItemListEditor
              title="Add-ons"
              addLabel="+ Add add-on"
              entries={form.addOns}
              fieldErrors={fieldErrors}
              onChange={(addOns) => setForm((f) => ({ ...f, addOns }))}
            />
          </>
        )}

        {saveError && <ErrorMessage error={{ message: saveError }} />}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" isLoading={isSaving}>
            {isEditing ? 'Save item' : 'Add item'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          {isEditing && (
            <button
              type="button"
              onClick={() => onToggleActive(item)}
              className="ml-auto min-h-12 type-caption text-alert underline-offset-4 hover:underline "
            >
              {item.isActive ? 'Take off the menu' : 'Put back on the menu'}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
