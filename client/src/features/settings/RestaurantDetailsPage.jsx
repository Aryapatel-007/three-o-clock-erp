import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { getRestaurant, updateRestaurant } from '../../api/settings.js';
import Button from '../../components/ui/Button.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Input from '../../components/ui/Input.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';

/**
 * The restaurant's own details, typed by the owner. 2026-11-03.
 *
 * What prints on every bill and goes to the CA: the name, the legal name, GSTIN,
 * FSSAI, PAN, Udyam, the phone, the email and the address. They were set from the
 * setup file or by hand in the database; now the owner keeps them here
 * (PATCH /restaurant, owner only on the server). A blank field is left as it was.
 */
const FIELDS = [
  { key: 'name', label: 'Restaurant name', hint: 'As guests know it. Shown in the app and at the top of the bill.' },
  { key: 'legalName', label: 'Legal name', hint: 'The registered business name, for the tax invoice.' },
  { key: 'gstin', label: 'GSTIN', hint: '15 characters, like 24ABCDE1234F1Z5.', upper: true },
  { key: 'fssaiLicenseNumber', label: 'FSSAI licence number', hint: '14 digits.' },
  { key: 'panNumber', label: 'PAN', hint: 'Like ABCDE1234F.', upper: true },
  { key: 'msmeNumber', label: 'Udyam number', hint: 'MSME registration, like UDYAM-GJ-01-0012345.', upper: true },
  { key: 'contactPhone', label: 'Phone', hint: '10-digit mobile, printed on the bill.', inputMode: 'numeric' },
  { key: 'contactEmail', label: 'Email', type: 'email' },
];
const ADDRESS = [
  { key: 'line1', label: 'Address line 1' },
  { key: 'line2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'PIN code', inputMode: 'numeric' },
];

const blankToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

export default function RestaurantDetailsPage() {
  const queryClient = useQueryClient();
  const restaurant = useQuery({ queryKey: ['restaurant'], queryFn: getRestaurant });
  const [form, setForm] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!restaurant.data) return;
    const data = restaurant.data;
    setForm({
      ...Object.fromEntries(FIELDS.map(({ key }) => [key, data[key] ?? ''])),
      address: Object.fromEntries(ADDRESS.map(({ key }) => [key, data.address?.[key] ?? ''])),
    });
  }, [restaurant.data]);

  // Only what changed, and never a blank: the server refuses empty values.
  const patch = () => {
    if (!form || !restaurant.data) return {};
    const out = {};
    for (const { key, upper } of FIELDS) {
      const value = blankToNull(form[key]);
      const next = value && upper ? value.trim().toUpperCase() : value?.trim();
      if (next && next !== (restaurant.data[key] ?? '')) out[key] = next;
    }
    const address = {};
    for (const { key } of ADDRESS) {
      const next = blankToNull(form.address[key])?.trim();
      if (next && next !== (restaurant.data.address?.[key] ?? '')) address[key] = next;
    }
    if (Object.keys(address).length > 0) out.address = { ...restaurant.data.address, ...address };
    return out;
  };
  const changes = patch();

  const save = useMutation({
    mutationFn: () => updateRestaurant(changes),
    onSuccess: (saved) => {
      queryClient.setQueryData(['restaurant'], saved);
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      setToast({ tone: 'success', message: 'Restaurant details saved. New bills print them.' });
    },
    onError: () => setToast({ tone: 'error', message: 'Not saved. Check the fields marked below.' }),
  });
  const fieldError = (key) => save.error?.fields?.[key] ?? save.error?.fields?.[`body.${key}`];

  return (
    <main className="v2 min-h-full bg-ground px-4 py-6 text-ink lg:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header>
          <h1 className="type-title">Restaurant details</h1>
          <p className="type-caption text-muted">
            Printed on every bill and sent with the CA&apos;s reports. The bill&apos;s look, its header and footer lines and what it shows are
            in <Link to="/settings/invoice-layout" className="underline">Bill layout</Link>.
          </p>
        </header>

        {restaurant.isPending && <Spinner label="Loading the restaurant's details" />}
        {restaurant.isError && <ErrorMessage error={restaurant.error} />}

        {form && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
            className="flex flex-col gap-6"
          >
            <section className="grid gap-4 rounded-[10px] border border-line bg-surface p-4 sm:grid-cols-2 sm:p-6">
              {FIELDS.map(({ key, label, hint, type, inputMode }) => (
                <Input
                  key={key}
                  label={label}
                  hint={hint}
                  type={type ?? 'text'}
                  inputMode={inputMode}
                  value={form[key]}
                  error={fieldError(key)}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                />
              ))}
            </section>

            <section className="grid gap-4 rounded-[10px] border border-line bg-surface p-4 sm:grid-cols-2 sm:p-6">
              <h2 className="type-heading sm:col-span-2">Address</h2>
              {ADDRESS.map(({ key, label, inputMode }) => (
                <Input
                  key={key}
                  label={label}
                  inputMode={inputMode}
                  value={form.address[key]}
                  error={fieldError(`address.${key}`)}
                  onChange={(event) => setForm((current) => ({ ...current, address: { ...current.address, [key]: event.target.value } }))}
                />
              ))}
            </section>

            <div className="flex items-center justify-end gap-3">
              <p className="type-caption text-muted">
                {Object.keys(changes).length === 0 ? 'No changes yet.' : `${Object.keys(changes).length} to save.`}
              </p>
              <Button type="submit" size="lg" isLoading={save.isPending} disabled={Object.keys(changes).length === 0}>
                Save details
              </Button>
            </div>
          </form>
        )}
      </div>
      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </main>
  );
}
