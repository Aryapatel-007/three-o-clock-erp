import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { listUsers, setUserStatus } from '../../api/users.js';
import StateChip from '../../components/ui/StateChip.jsx';
import Button from '../../components/ui/Button.jsx';
import EmptyState from '../../components/ui/EmptyState.jsx';
import ErrorMessage from '../../components/ui/ErrorMessage.jsx';
import Input from '../../components/ui/Input.jsx';
import Select from '../../components/ui/Select.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import ConfirmDeactivateDialog from './ConfirmDeactivateDialog.jsx';
import ResetPasswordDialog from './ResetPasswordDialog.jsx';
import { ROLE_LABELS, ROLE_VALUES } from './roles.js';

const PAGE_SIZE = 50;

const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All roles' },
  ...ROLE_VALUES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
];

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All staff' },
  { value: 'true', label: 'Active only' },
  { value: 'false', label: 'Deactivated only' },
];

export default function StaffListPage() {
  const navigate = useNavigate();

  const [filters, setFilters] = useState({ search: '', role: '', isActive: '' });
  const [page, setPage] = useState(1);

  const [staff, setStaff] = useState([]);
  const [meta, setMeta] = useState({ page: 1, limit: PAGE_SIZE, total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [deactivating, setDeactivating] = useState(null);
  const [resetting, setResetting] = useState(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const { data, meta: nextMeta } = await listUsers({
        page,
        limit: PAGE_SIZE,
        search: filters.search,
        role: filters.role,
        isActive: filters.isActive,
      });
      setStaff(data);
      setMeta(nextMeta);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setIsLoading(false);
    }
  }, [page, filters]);

  // Debounced, so typing in the search box does not fire a request per keypress.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  const setFilter = (field) => (event) => {
    setPage(1);
    setFilters((current) => ({ ...current, [field]: event.target.value }));
  };

  async function reactivate(member) {
    try {
      await setUserStatus(member.id, true);
      await load();
    } catch (statusError) {
      setError(statusError);
    }
  }

  const hasFilters = Boolean(filters.search || filters.role || filters.isActive);
  const lastPage = Math.max(1, Math.ceil(meta.total / meta.limit));

  return (
    <main className="min-h-full bg-sunken p-6">
      <div className="mx-auto w-full max-w-5xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">Staff</h1>
            <p className="text-sm text-muted">
              {meta.total} {meta.total === 1 ? 'person' : 'people'}
            </p>
          </div>
          <Button onClick={() => navigate('/staff/new')}>Add staff member</Button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Input
            label="Search"
            type="search"
            placeholder="Name or phone"
            value={filters.search}
            onChange={setFilter('search')}
          />
          <Select label="Role" value={filters.role} onChange={setFilter('role')} options={ROLE_FILTER_OPTIONS} />
          <Select
            label="Status"
            value={filters.isActive}
            onChange={setFilter('isActive')}
            options={STATUS_FILTER_OPTIONS}
          />
        </div>

        <div className="mt-6">
          {isLoading && <Spinner label="Loading staff" />}

          {error && !isLoading && <ErrorMessage error={error} onRetry={load} />}

          {!isLoading && !error && staff.length === 0 && (
            <EmptyState
              title="Nobody here"
              description={
                hasFilters
                  ? 'No staff match these filters. Try clearing them.'
                  : 'Add your first staff member to get started.'
              }
              action={<Button onClick={() => navigate('/staff/new')}>Add staff member</Button>}
            />
          )}

          {!isLoading && !error && staff.length > 0 && (
            <>
            {/* On a phone each person is a card, so the actions are on screen, not past its right edge. */}
            <ul className="divide-y divide-line rounded-lg bg-surface ring-1 ring-line sm:hidden">
              {staff.map((member) => (
                <li key={member.id} className={['flex flex-col gap-2 px-4 py-3', member.isActive ? '' : 'bg-sunken text-muted'].join(' ')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{member.name}</p>
                      <p className="text-sm text-muted">
                        <span className="tabular-nums">{member.phone}</span> · {ROLE_LABELS[member.role] ?? member.role}
                      </p>
                    </div>
                    <StateChip state={member.isActive ? 'ok' : 'free'} word={member.isActive ? 'Active' : 'Deactivated'} size="sm" />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      to={`/staff/${member.id}/edit`}
                      className="flex min-h-12 items-center rounded-lg px-2 text-sm font-medium text-accent hover:bg-sunken"
                    >
                      Edit
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setResetting(member)}>
                      Reset password
                    </Button>
                    {member.isActive ? (
                      <Button size="sm" variant="ghost" onClick={() => setDeactivating(member)}>
                        Deactivate
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => reactivate(member)}>
                        Reactivate
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto rounded-lg bg-surface ring-1 ring-line sm:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Phone</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {staff.map((member) => (
                    <tr key={member.id} className={member.isActive ? '' : 'bg-sunken text-muted'}>
                      <td className="px-4 py-3 font-medium text-ink">{member.name}</td>
                      <td className="px-4 py-3 tabular-nums">{member.phone}</td>
                      <td className="px-4 py-3">{ROLE_LABELS[member.role] ?? member.role}</td>
                      <td className="px-4 py-3">
                        <StateChip state={member.isActive ? 'ok' : 'free'} word={member.isActive ? 'Active' : 'Deactivated'} size="sm" />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <Link
                            to={`/staff/${member.id}/edit`}
                            className="rounded-lg px-2 py-1 text-sm font-medium text-accent hover:bg-sunken"
                          >
                            Edit
                          </Link>
                          <Button size="sm" variant="ghost" onClick={() => setResetting(member)}>
                            Reset password
                          </Button>
                          {member.isActive ? (
                            <Button size="sm" variant="ghost" onClick={() => setDeactivating(member)}>
                              Deactivate
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => reactivate(member)}>
                              Reactivate
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}

          {lastPage > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted">
                Page {meta.page} of {lastPage}
              </span>
              <Button size="sm" variant="secondary" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </div>
      </div>

      {deactivating && (
        <ConfirmDeactivateDialog
          staff={deactivating}
          onClose={() => setDeactivating(null)}
          onDone={() => {
            setDeactivating(null);
            load();
          }}
        />
      )}

      {resetting && <ResetPasswordDialog staff={resetting} onClose={() => setResetting(null)} />}
    </main>
  );
}
