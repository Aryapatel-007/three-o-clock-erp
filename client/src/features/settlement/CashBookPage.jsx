import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { getCashBook, recordCashMovement, voidCashMovement } from '../../api/dayClose.js';
import Button from '../../components/ui/Button.jsx';
import Money, { moneyText } from '../../components/ui/Money.jsx';
import Sheet from '../../components/ui/Sheet.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import Toast from '../../components/ui/Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { formatBusinessDate, formatTimeIst } from '../../utils/formatDate.js';
import { errorMessage } from '../billing/errorCopy.js';
import { ROLES } from '../users/roles.js';
import CashFlow from './cashbook/CashFlow.jsx';
import { CheckSheet, ExpenseSheet, FloatSheet, TakeOutSheet, TopUpSheet, VoidEntrySheet } from './cashbook/CashSheets.jsx';
import CloseDaySheet from './cashbook/CloseDaySheet.jsx';
import InlineVoid from './InlineVoid.jsx';

/** On every screen a paid in is a top-up and a paid out an expense. GLOSSARY section 20. */
const WORDS = {
  OPENING_FLOAT: 'Opening float',
  PAID_IN: 'Top-up',
  PAID_OUT: 'Expense',
  CASH_TAKEN_OUT: 'Cash taken out',
  CASH_CHECK: 'Cash check',
};
const SOURCE_WORDS = { OWNER: 'From the owner', BANK: 'From the bank', CHANGE: 'Change', OTHER: 'Other' };
const DESTINATION_WORDS = { BANK_DEPOSIT: 'Bank deposit', OWNER: 'Given to the owner', OTHER: 'Other' };
const MINUS = ['PAID_OUT', 'CASH_TAKEN_OUT'];

/** What one entry was, after its kind: the source, the category, where it went, or the difference. */
function detailOf(entry) {
  if (entry.type === 'PAID_IN') return SOURCE_WORDS[entry.source];
  if (entry.type === 'PAID_OUT') return entry.categoryLabel;
  if (entry.type === 'CASH_TAKEN_OUT') return DESTINATION_WORDS[entry.destination];
  if (entry.type === 'OPENING_FLOAT' && entry.broughtForwardFrom) return `brought forward from ${formatBusinessDate(entry.broughtForwardFrom)}`;
  return null;
}

/**
 * The cash book. P29 Part F, API-CONTRACT M16 section 9. OWNER, MANAGER and
 * CASHIER; taking cash out and closing the day are the owner's and manager's.
 *
 * One page for the day's cash: the flow, the day's entries, and the record
 * buttons. The opening float is proposed from the cash kept at the last close.
 * The cash in the drawer, and every difference, reach only the people the
 * server sends them to. The old Cash drawer address opens this page.
 */
export default function CashBookPage() {
  const queryClient = useQueryClient();
  const { user, features } = useAuth();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? undefined;
  const isManager = [ROLES.OWNER, ROLES.MANAGER].includes(user?.role);
  const approvals = features?.approvals ?? { lineCancel: true, paidIn: true, managerTasks: true };
  const denominations = features?.cash?.denominations ?? [];
  const categories = features?.cash?.expenseCategories ?? [];
  const [sheet, setSheet] = useState(() => (params.get('close') === '1' ? 'close' : null));
  const [toast, setToast] = useState(null);
  const [voidingEntry, setVoidingEntry] = useState(null);

  const query = useQuery({ queryKey: ['cash-book', date ?? 'today'], queryFn: () => getCashBook(date) });
  const book = query.data;

  const done = (message) => {
    setSheet(null);
    queryClient.invalidateQueries({ queryKey: ['cash-book'] });
    queryClient.invalidateQueries({ queryKey: ['cash-movements'] });
    queryClient.invalidateQueries({ queryKey: ['day-close'] });
    setToast({ tone: 'success', message });
  };
  const fail = (error) => setToast({ tone: 'error', message: errorMessage(error) });

  const confirmFloat = useMutation({
    mutationFn: () => recordCashMovement({ type: 'OPENING_FLOAT', broughtForward: true }),
    onSuccess: () => done('Opening float confirmed.'),
    onError: fail,
  });
  const voiding = useMutation({
    mutationFn: ({ id, reason }) => voidCashMovement(id, reason),
    onSuccess: () => done('Entry voided.'),
    onError: fail,
  });

  if (query.isPending) return <Shell><Spinner label="Loading the cash book" /></Shell>;
  if (query.isError) return <Shell><p className="type-body text-alert">{errorMessage(query.error)}</p></Shell>;

  const forward = book.broughtForward;
  const hasFloat = book.movements.some((entry) => entry.type === 'OPENING_FLOAT' && !entry.isVoided);
  const proposesFloat = !book.isClosed && !hasFloat && forward && forward.keptInPaise > 0;
  const keptNotes = (forward?.keptCount ?? [])
    .map((row) => `${row.count} × ${moneyText(row.valueInPaise)}`)
    .join(', ');
  const live = book.movements.filter((entry) => !entry.isVoided);
  const y = book.yesterday;

  return (
    <Shell>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="type-title">Cash book</h1>
          <p className="type-caption text-muted">
            {formatBusinessDate(book.businessDate)}
            {book.isClosed ? ', closed' : '. Cash sales are added automatically.'}
          </p>
        </div>
        {date && (
          <button type="button" onClick={() => setParams({})} className="type-label min-h-12 rounded-lg px-3 text-accent underline-offset-4 hover:underline">
            Back to today
          </button>
        )}
      </header>

      {/* The float for today: yesterday's kept cash, confirmed with one tap, or counted again. */}
      {proposesFloat && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border-2 border-ink bg-surface p-4">
          <div>
            <p className="type-label text-muted">Brought forward</p>
            <p className="type-body">
              From {formatBusinessDate(forward.fromDate)}: <Money paise={forward.keptInPaise} size="num" />
              {keptNotes && <span className="text-muted">, {keptNotes}</span>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSheet('recount')} className="type-button min-h-12 rounded-lg border border-ink bg-surface px-4 hover:bg-sunken">
              Count again
            </button>
            <Button size="lg" isLoading={confirmFloat.isPending} onClick={() => confirmFloat.mutate()}>
              Confirm
            </Button>
          </div>
        </section>
      )}
      {!book.isClosed && !hasFloat && !proposesFloat && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line bg-surface p-4">
          <p className="type-body">No opening float yet today. Count the drawer to start.</p>
          <Button onClick={() => setSheet('float')}>Count the float</Button>
        </section>
      )}

      <CashFlow book={book} onOpen={(key) => setSheet(`entries:${key}`)} />

      {y && (
        <p className="type-caption text-muted">
          <Link to={`/day-close?date=${y.businessDate}`} className="inline-flex min-h-12 items-center underline-offset-4 hover:underline">
            <span>
              Yesterday: counted <Money paise={y.countedCashInPaise} />
              {y.keptForTomorrowInPaise !== null && (
                <>
                  , kept <Money paise={y.keptForTomorrowInPaise} />
                  {y.takenOutAtCloseInPaise > 0 && (
                    <>
                      , taken out <Money paise={y.takenOutAtCloseInPaise} /> {y.takenOutTo === 'BANK_DEPOSIT' ? 'to the bank' : y.takenOutTo === 'OWNER' ? 'to the owner' : ''}
                    </>
                  )}
                </>
              )}
            </span>
          </Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Today" className="rounded-[10px] border border-line bg-surface p-4">
          <h2 className="type-heading mb-2">Today</h2>
          {book.movements.length === 0 ? (
            <p className="type-body text-muted">Nothing recorded yet. Start with the opening float.</p>
          ) : (
            <ul className="divide-y divide-line">
              {book.movements.map((entry) => (
                <li key={entry.id} className={`flex items-center justify-between gap-3 py-2 ${entry.isVoided ? 'text-muted line-through' : ''}`}>
                  <span className="min-w-0">
                    <span className="type-body block">
                      <span className="type-num-meta mr-2">{formatTimeIst(entry.at)}</span>
                      {WORDS[entry.type]}
                      {detailOf(entry) ? ` · ${detailOf(entry)}` : ''}
                    </span>
                    <span className="type-caption block text-muted">
                      {entry.reason ?? ''}
                      {entry.type === 'CASH_CHECK' && entry.differenceInPaise !== undefined && entry.differenceInPaise !== null && (
                        <>
                          {' '}difference <Money paise={entry.differenceInPaise} />
                        </>
                      )}
                      {entry.isVoided ? ` · voided: ${entry.voidReason}` : ''}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-3">
                    <span className="type-num tabular-nums">
                      {MINUS.includes(entry.type) ? '− ' : ''}
                      <Money paise={entry.amountInPaise} />
                    </span>
                    {isManager && !entry.isVoided && !book.isClosed && (
                      <InlineVoid isBusy={voiding.isPending} onConfirm={(reason) => voiding.mutate({ id: entry.id, reason })} />
                    )}
                    {!isManager && approvals.managerTasks && !entry.isVoided && !book.isClosed && (
                      <button type="button" onClick={() => setVoidingEntry(entry)} className="min-h-12 type-caption text-alert underline">
                        Void
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {book.expenses.byCategory.length > 0 && (
            <div className="mt-4">
              <h3 className="type-label mb-1 text-muted">Expenses by category</h3>
              <p className="type-body flex flex-wrap gap-x-4 gap-y-1">
                {book.expenses.byCategory.map((row) => (
                  <span key={row.code}>
                    {row.label} <Money paise={row.amountInPaise} />
                  </span>
                ))}
              </p>
            </div>
          )}
        </section>

        {!book.isClosed && (
          <section aria-label="Record" className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface p-4">
            <h2 className="type-heading mb-1">Record</h2>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
              <RecordButton onClick={() => setSheet('topUp')}>+ Top-up</RecordButton>
              {(isManager || approvals.managerTasks) && <RecordButton onClick={() => setSheet('expense')}>− Expense</RecordButton>}
              {isManager && <RecordButton onClick={() => setSheet('takeOut')}>Take cash out</RecordButton>}
              <RecordButton onClick={() => setSheet('check')}>Check cash</RecordButton>
            </div>
            {isManager && (
              <button type="button" onClick={() => setSheet('close')} className="type-button mt-2 min-h-14 rounded-lg border-2 border-ink bg-surface px-4 hover:bg-sunken">
                Close the day
              </button>
            )}
          </section>
        )}
      </div>

      {sheet === 'topUp' && (
        <TopUpSheet denominations={denominations} needsApproval={!isManager && approvals.paidIn} onCancel={() => setSheet(null)} onDone={() => done('Top-up recorded.')} />
      )}
      {sheet === 'expense' && (
        <ExpenseSheet
          categories={categories}
          lastUsed={book.lastUsedExpense ?? {}}
          denominations={denominations}
          needsApproval={!isManager}
          onCancel={() => setSheet(null)}
          onDone={() => done('Expense recorded.')}
        />
      )}
      {sheet === 'takeOut' && <TakeOutSheet denominations={denominations} currentUserId={user?.id} onCancel={() => setSheet(null)} onDone={() => done('Cash taken out recorded.')} />}
      {sheet === 'check' && (
        <CheckSheet
          denominations={denominations}
          onCancel={() => setSheet(null)}
          onDone={(check) =>
            done(
              check.differenceInPaise === undefined || check.differenceInPaise === null
                ? 'Check saved.'
                : check.differenceInPaise === 0
                  ? 'Check saved. The drawer matches.'
                  : `Check saved. ${check.differenceInPaise < 0 ? 'Short' : 'Over'} by ${moneyText(Math.abs(check.differenceInPaise))}.`,
            )
          }
        />
      )}
      {voidingEntry && (
        <VoidEntrySheet
          entry={voidingEntry}
          label={WORDS[voidingEntry.type]}
          onCancel={() => setVoidingEntry(null)}
          onDone={() => {
            setVoidingEntry(null);
            done('Entry voided.');
          }}
        />
      )}
      {sheet === 'float' && <FloatSheet denominations={denominations} onCancel={() => setSheet(null)} onDone={() => done('Opening float recorded.')} />}
      {sheet === 'recount' && <FloatSheet denominations={denominations} broughtForward={forward} onCancel={() => setSheet(null)} onDone={() => done('Opening float recorded.')} />}
      {sheet === 'close' && isManager && (
        <CloseDaySheet
          businessDate={book.businessDate}
          denominations={denominations}
          usualFloatInPaise={features?.cash?.usualFloatInPaise ?? 200000}
          onCancel={() => setSheet(null)}
          onDone={() => done(`${formatBusinessDate(book.businessDate)} is closed.`)}
        />
      )}
      {sheet?.startsWith('entries:') && <EntriesSheet book={book} kind={sheet.slice('entries:'.length)} live={live} isManager={isManager} onClose={() => setSheet(null)} />}

      <Toast tone={toast?.tone} message={toast?.message} onDismiss={() => setToast(null)} />
    </Shell>
  );
}

/** One step's entries, from a card or a line of the flow. */
function EntriesSheet({ book, kind, live, isManager, onClose }) {
  const types = { float: ['OPENING_FLOAT'], topUps: ['PAID_IN'], expenses: ['PAID_OUT'], takenOut: ['CASH_TAKEN_OUT'] }[kind] ?? [];
  const entries = live.filter((entry) => types.includes(entry.type));
  const title = { float: 'Opening float', topUps: 'Top-ups', cashSales: 'Cash sales', expenses: 'Expenses', takenOut: 'Cash taken out' }[kind] ?? 'Entries';

  return (
    <Sheet title={title} subtitle={formatBusinessDate(book.businessDate)} onClose={onClose}>
      {kind === 'cashSales' ? (
        <div className="flex flex-col gap-3">
          <p className="type-body">
            <Money paise={book.cashSales.totalInPaise} size="num" /> in cash on {book.cashSales.billCount} {book.cashSales.billCount === 1 ? 'bill' : 'bills'}.
          </p>
          {book.cashCollections.totalInPaise > 0 && (
            <p className="type-body">
              <Money paise={book.cashCollections.totalInPaise} size="num" /> collected in cash on On Hold accounts.
            </p>
          )}
          {isManager && (
            <Link
              to={`/reports/bills?from=${book.businessDate}&to=${book.businessDate}&method=CASH`}
              className="type-label inline-flex min-h-12 items-center text-accent underline-offset-4 hover:underline"
            >
              See the cash bills
            </Link>
          )}
        </div>
      ) : entries.length === 0 ? (
        <p className="type-body text-muted">Nothing recorded.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {kind === 'expenses' && (
            <dl className="flex flex-col gap-1">
              {book.expenses.byCategory.map((row) => (
                <div key={row.code} className="flex justify-between gap-3">
                  <dt className="type-body">
                    {row.label} <span className="text-muted">({row.count})</span>
                  </dt>
                  <dd className="type-num">
                    <Money paise={row.amountInPaise} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <ul className="divide-y divide-line">
            {entries.map((entry) => (
              <li key={entry.id} className="flex justify-between gap-3 py-2">
                <span className="type-body">
                  <span className="type-num-meta mr-2">{formatTimeIst(entry.at)}</span>
                  {detailOf(entry) ?? WORDS[entry.type]}
                  {entry.reason ? <span className="text-muted"> · {entry.reason}</span> : null}
                </span>
                <Money paise={entry.amountInPaise} tabular />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

function RecordButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="type-button min-h-14 rounded-lg border border-line bg-surface px-4 text-left hover:bg-sunken">
      {children}
    </button>
  );
}

function Shell({ children }) {
  return (
    <main className="v2 min-h-full bg-ground px-4 py-4 text-ink lg:px-6">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4">{children}</div>
    </main>
  );
}
