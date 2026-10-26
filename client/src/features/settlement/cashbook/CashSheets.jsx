import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { recordCashMovement, voidCashMovement } from '../../../api/dayClose.js';
import { listApprovers } from '../../../api/users.js';
import ApprovalStep, { useApproval } from '../../../components/ui/ApprovalStep.jsx';
import Input from '../../../components/ui/Input.jsx';
import Money, { moneyText } from '../../../components/ui/Money.jsx';
import Sheet, { SheetActions } from '../../../components/ui/Sheet.jsx';
import { errorMessage } from '../../billing/errorCopy.js';
import { formatBusinessDate } from '../../../utils/formatDate.js';
import { paiseToInput } from '../../../utils/formatMoney.js';
import AmountOrCount, { amountOf, bodyOf, emptyAmount } from './AmountOrCount.jsx';

/**
 * The cash book's record sheets. P29 Part F, API-CONTRACT M16 section 9.2.
 * Each one records one cash movement; the server dates it today, checks the
 * role and the PIN, and works out every total. Words from GLOSSARY section 20.
 */

const SOURCES = [
  ['OWNER', 'From the owner'],
  ['BANK', 'From the bank'],
  ['CHANGE', 'Change'],
  ['OTHER', 'Other'],
];
const DESTINATIONS = [
  ['BANK_DEPOSIT', 'Bank deposit'],
  ['OWNER', 'Given to the owner'],
  ['OTHER', 'Other'],
];

/** A row of large choice buttons. */
function Choices({ legend, options, value, onChange }) {
  return (
    <fieldset>
      <legend className="type-label mb-2 text-muted">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map(([code, label]) => (
          <button
            key={code}
            type="button"
            aria-pressed={value === code}
            onClick={() => onChange(code)}
            className={[
              'type-label min-h-12 rounded-lg border px-3 text-left',
              value === code ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The shell every record sheet shares: save, and the server's own message on a refusal. */
function useRecord(onDone) {
  return useMutation({ mutationFn: (body) => recordCashMovement(body), onSuccess: onDone });
}

export function TopUpSheet({ denominations, needsApproval, onCancel, onDone }) {
  const [amount, setAmount] = useState(emptyAmount());
  const [source, setSource] = useState(null);
  const [note, setNote] = useState('');
  const approval = useApproval(needsApproval);
  const save = useRecord(onDone);
  const paise = amountOf(amount, denominations);
  const ready = paise > 0 && source && (source !== 'OTHER' || note.trim()) && approval.ready;

  return (
    <Sheet
      title="Top-up"
      subtitle="Cash added to the drawer that is not a sale."
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Saving…' : `Add ${paise > 0 ? moneyText(paise) : 'top-up'}`}
          disabled={!ready || save.isPending}
          onConfirm={() => save.mutate({ type: 'PAID_IN', ...bodyOf(amount, denominations), source, reason: note.trim() || null, ...approval.body })}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <AmountOrCount value={amount} onChange={setAmount} denominations={denominations} />
        <Choices legend="Where it came from" options={SOURCES} value={source} onChange={setSource} />
        <Input label={source === 'OTHER' ? 'Note, required' : 'Note, optional'} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
        <ApprovalStep approval={approval} />
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}

export function ExpenseSheet({ categories, lastUsed = {}, denominations, needsApproval, onCancel, onDone }) {
  const [amount, setAmount] = useState(emptyAmount());
  const [category, setCategory] = useState(null);
  const [note, setNote] = useState('');
  const approval = useApproval(needsApproval);
  const save = useRecord(onDone);
  const paise = amountOf(amount, denominations);
  const ready = paise > 0 && category && (category !== 'OTHER' || note.trim()) && approval.ready;
  // The most used first: the ones spent on in the last 7 days, then the rest in the owner's order.
  const ordered = [...categories].sort((a, b) => Number(b.code in lastUsed) - Number(a.code in lastUsed));
  const sameAsLast = category && lastUsed[category];

  return (
    <Sheet
      title="Expense"
      subtitle="Cash spent from the drawer."
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Saving…' : `Record ${paise > 0 ? moneyText(paise) : 'expense'}`}
          disabled={!ready || save.isPending}
          onConfirm={() => save.mutate({ type: 'PAID_OUT', ...bodyOf(amount, denominations), category, reason: note.trim() || null, ...approval.body })}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Choices legend="What it was for" options={ordered.map((entry) => [entry.code, entry.label])} value={category} onChange={setCategory} />
        {sameAsLast && (
          <button
            type="button"
            onClick={() => setAmount({ byNotes: false, typed: paiseToInput(lastUsed[category]), counts: {}, key: Date.now() })}
            className="type-label min-h-12 self-start rounded-lg border border-line px-4 hover:bg-sunken"
          >
            Same as last time, <Money paise={lastUsed[category]} />
          </button>
        )}
        <AmountOrCount key={amount.key ?? 'amount'} value={amount} onChange={setAmount} denominations={denominations} allowNotes={false} />
        <Input label={category === 'OTHER' ? 'Note, required' : 'Note, optional'} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
        <ApprovalStep approval={approval} />
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}

export function TakeOutSheet({ denominations, currentUserId, onCancel, onDone }) {
  const [amount, setAmount] = useState(emptyAmount());
  const [destination, setDestination] = useState(null);
  const [takenBy, setTakenBy] = useState(currentUserId);
  const [note, setNote] = useState('');
  const people = useQuery({ queryKey: ['approvers'], queryFn: listApprovers });
  const save = useRecord(onDone);
  const paise = amountOf(amount, denominations);
  const ready = paise > 0 && destination && (destination !== 'OTHER' || note.trim());

  return (
    <Sheet
      title="Take cash out"
      subtitle="Cash removed that is not an expense, like a bank deposit."
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Saving…' : `Take out ${paise > 0 ? moneyText(paise) : 'cash'}`}
          disabled={!ready || save.isPending}
          onConfirm={() => save.mutate({ type: 'CASH_TAKEN_OUT', ...bodyOf(amount, denominations), destination, takenBy, reason: note.trim() || null })}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <AmountOrCount value={amount} onChange={setAmount} denominations={denominations} />
        <Choices legend="Where it goes" options={DESTINATIONS} value={destination} onChange={setDestination} />
        <Choices legend="Who took it" options={(people.data ?? []).map((person) => [person.id, person.name])} value={takenBy} onChange={setTakenBy} />
        <Input label={destination === 'OTHER' ? 'Note, required' : 'Note, optional'} maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}

export function CheckSheet({ denominations, onCancel, onDone }) {
  const [amount, setAmount] = useState(emptyAmount(true));
  const save = useRecord(onDone);
  const paise = amountOf(amount, denominations);

  return (
    <Sheet
      title="Check cash"
      subtitle="Count the drawer without closing the day. Nothing is moved."
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Saving…' : 'Save the check'}
          disabled={paise === null || paise < 0 || save.isPending}
          onConfirm={() => save.mutate({ type: 'CASH_CHECK', ...bodyOf(amount, denominations) })}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <AmountOrCount value={amount} onChange={setAmount} denominations={denominations} title="Cash in the drawer now" />
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}

/**
 * The opening float: counted, or yesterday's kept cash counted again
 * (`broughtForward`). A recount that differs from what was kept needs a note,
 * which the owner reads.
 */
export function FloatSheet({ denominations, broughtForward = null, onCancel, onDone }) {
  const [amount, setAmount] = useState(emptyAmount(true));
  const [note, setNote] = useState('');
  const save = useRecord(onDone);
  const paise = amountOf(amount, denominations);
  const differs = broughtForward && paise !== null && paise !== broughtForward.keptInPaise;
  const ready = paise > 0 && (!differs || note.trim());

  return (
    <Sheet
      title={broughtForward ? 'Count the float again' : 'Opening float'}
      subtitle={broughtForward ? `${moneyText(broughtForward.keptInPaise)} was kept in the drawer on ${formatBusinessDate(broughtForward.fromDate)}.` : 'The cash in the drawer as the day starts.'}
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Saving…' : `Start with ${paise > 0 ? moneyText(paise) : 'the float'}`}
          disabled={!ready || save.isPending}
          onConfirm={() =>
            save.mutate({ type: 'OPENING_FLOAT', ...bodyOf(amount, denominations), ...(broughtForward ? { broughtForward: true, reason: note.trim() || null } : {}) })
          }
        />
      }
    >
      <div className="flex flex-col gap-4">
        <AmountOrCount value={amount} onChange={setAmount} denominations={denominations} title="Cash in the drawer" />
        {differs && (
          <Input label="Note, required: why is it not what was kept?" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
        )}
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}

/** A cashier's void of a cash entry: the reason and a manager's PIN. Owners and managers void inline. */
export function VoidEntrySheet({ entry, label, onCancel, onDone }) {
  const [reason, setReason] = useState('');
  const approval = useApproval(true);
  const save = useMutation({ mutationFn: () => voidCashMovement(entry.id, reason.trim(), approval.body), onSuccess: onDone });
  const ready = reason.trim() && approval.ready;

  return (
    <Sheet
      title="Void this entry"
      subtitle={<>{label} · <Money paise={entry.amountInPaise} /></>}
      onCancel={onCancel}
      footer={
        <SheetActions
          onCancel={onCancel}
          confirmLabel={save.isPending ? 'Voiding…' : 'Void it'}
          disabled={!ready || save.isPending}
          onConfirm={() => save.mutate()}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Input label="Why is this being voided?" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
        <ApprovalStep approval={approval} />
        {save.isError && <p className="type-body text-alert">{errorMessage(save.error)}</p>}
      </div>
    </Sheet>
  );
}
