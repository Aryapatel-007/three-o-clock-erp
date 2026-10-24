import ErrorState from '../../components/ui/ErrorState.jsx';
import Spinner from '../../components/ui/Spinner.jsx';
import StateChip from '../../components/ui/StateChip.jsx';
import { formatDateIst } from '../../utils/formatDate.js';
import { errorMessage } from './errorCopy.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10" as "October 2026". */
export function monthWords(period) {
  const [year, month] = String(period).split('-').map(Number);
  return MONTHS[month - 1] ? `${MONTHS[month - 1]} ${year}` : String(period);
}

const STATUS = {
  SENT: { word: 'Sent', state: 'ok' },
  SENDING: { word: 'Sending', state: 'open' },
  FAILED: { word: 'Failed', state: 'alert' },
  REFUSED: { word: 'Refused', state: 'alert' },
};

/** Why a month went, or did not, in words. */
export function sendWords(send) {
  if (send.status === 'SENT') return `Sent ${formatDateIst(send.sentAt)} to ${send.to.join(', ')}, ${send.files.length} ${send.files.length === 1 ? 'file' : 'files'}.`;
  if (send.status === 'REFUSED' && send.openDates.length > 0) return `Not sent: ${send.openDates.length} ${send.openDates.length === 1 ? 'day is' : 'days are'} still open, from ${send.openDates[0]}. Close them and it goes within the hour.`;
  if (send.status === 'REFUSED') return `Not sent: ${send.refusedReason}`;
  if (send.status === 'FAILED') return `The email service refused it: ${send.lastError ?? 'no reason given'}. Tried again within the hour.`;
  return 'Being sent now.';
}

/** The last twelve months sent, newest first. P65. */
export function CaSendHistory({ sends }) {
  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
      <h2 className="type-heading">Sent</h2>
      {sends.isPending && <Spinner label="Loading the months sent" />}
      {sends.isError && <ErrorState error={errorMessage(sends.error)} onRetry={() => sends.refetch()} />}
      {sends.data && sends.data.sends.length === 0 && <p className="type-body text-muted">Nothing sent yet. The first pack goes on the 1st, once switched on.</p>}
      {sends.data && sends.data.sends.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {sends.data.sends.map((send) => (
            <li key={send.period} className="flex flex-col gap-1 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="type-label">{monthWords(send.period)}</span>
                <StateChip state={STATUS[send.status]?.state ?? 'open'} word={STATUS[send.status]?.word ?? send.status} />
              </div>
              <p className="type-caption text-muted">{sendWords(send)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
