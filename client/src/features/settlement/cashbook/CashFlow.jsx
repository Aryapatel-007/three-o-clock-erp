import Money from '../../../components/ui/Money.jsx';
import { formatBusinessDate, formatTimeIst } from '../../../utils/formatDate.js';

/**
 * The day's cash, as the owner drew it. P29 Part F, API-CONTRACT M16 section 9.
 *
 *   Brought forward + Top-ups + Cash sales - Expenses - Taken out = Cash in drawer
 *
 * With 1024 px of its own width the steps run left to right as cards joined
 * by large signs, ending in a wider Cash in drawer card. With less, a stacked
 * list (2026-10-21: by the space it has, not the window, so inside Day End's
 * narrow column on a wide screen it never squeezes six cards): the sign
 * in a wide left column, the amount on the right, and Cash in drawer last and
 * largest. Each step opens its entries. The server leaves the cash in the
 * drawer out for anyone who may not see it, and so does this.
 */
export function flowSteps(book) {
  const bf = book.broughtForward;
  const brought = bf?.confirmed?.broughtForwardFrom;
  return [
    {
      key: 'float',
      sign: '',
      label: brought ? 'Brought forward' : 'Opening float',
      amountInPaise: book.openingFloatInPaise,
      note: brought ? `from ${formatBusinessDate(bf.fromDate)}` : book.openingFloatInPaise > 0 ? 'counted' : 'not counted yet',
    },
    { key: 'topUps', sign: '+', label: 'Top-ups', amountInPaise: book.topUps.totalInPaise, note: `${book.topUps.count} ${book.topUps.count === 1 ? 'entry' : 'entries'}` },
    {
      key: 'cashSales',
      sign: '+',
      label: 'Cash sales',
      amountInPaise: book.cashSales.totalInPaise + book.cashCollections.totalInPaise,
      note: `${book.cashSales.billCount} ${book.cashSales.billCount === 1 ? 'bill' : 'bills'}${book.cashCollections.totalInPaise > 0 ? ', with On Hold collected' : ''}`,
    },
    { key: 'expenses', sign: '−', label: 'Expenses', amountInPaise: book.expenses.totalInPaise, note: `${book.expenses.count} ${book.expenses.count === 1 ? 'entry' : 'entries'}` },
    { key: 'takenOut', sign: '−', label: 'Cash taken out', amountInPaise: book.cashTakenOut.totalInPaise, note: `${book.cashTakenOut.count} ${book.cashTakenOut.count === 1 ? 'entry' : 'entries'}` },
  ];
}

function DrawerCard({ book, wide = false }) {
  const seesTotal = book.cashInDrawerInPaise !== undefined;
  return (
    <div className={['@container min-w-0 rounded-[10px] border-2 border-ink bg-surface p-4', wide ? 'flex-[1.4]' : ''].join(' ')}>
      <p className="type-label text-muted">Cash in drawer</p>
      {seesTotal ? (
        // Fits the card, as the stat tiles do: a lakh amount shrinks rather than running out of the box.
        <p className="type-num-fit mt-1 text-ink">
          <Money paise={book.cashInDrawerInPaise} tabular />
        </p>
      ) : (
        <p className="type-body mt-1 text-muted">Counted at Day Close. The owner sees the total.</p>
      )}
      {book.lastCheck && (
        <p className="type-caption mt-1 text-muted">
          checked <span className="type-num-meta">{formatTimeIst(book.lastCheck.at)}</span>
          {book.lastCheck.differenceInPaise !== undefined && book.lastCheck.differenceInPaise !== null && (
            <>
              , difference <Money paise={book.lastCheck.differenceInPaise} />
            </>
          )}
        </p>
      )}
    </div>
  );
}

export default function CashFlow({ book, onOpen }) {
  const steps = flowSteps(book);
  return (
    <div className="@container">
      {/* Wide: cards joined by signs, the way the owner drew it. */}
      <div className="hidden items-stretch gap-2 @5xl:flex">
        {steps.map((step) => (
          <div key={step.key} className="flex min-w-0 flex-1 items-center gap-2">
            {step.sign && <span aria-hidden="true" className="type-title flex-none text-muted">{step.sign}</span>}
            <button
              type="button"
              onClick={() => onOpen(step.key)}
              className="@container flex h-full min-h-12 min-w-0 flex-1 flex-col items-start rounded-[10px] border border-line bg-surface p-4 text-left hover:bg-sunken"
            >
              <span className="type-label text-muted">{step.label}</span>
              <span className="type-num-fit-tile">
                <Money paise={step.amountInPaise} tabular />
              </span>
              <span className="type-caption text-muted">{step.note}</span>
            </button>
          </div>
        ))}
        <span aria-hidden="true" className="type-title flex-none self-center text-muted">=</span>
        <DrawerCard book={book} wide />
      </div>

      {/* Phone and tablet: one line per step, the sign on the left, the amount on the right. */}
      <ul className="divide-y divide-line rounded-[10px] border border-line bg-surface @5xl:hidden">
        {steps.map((step) => (
          <li key={step.key}>
            <button type="button" onClick={() => onOpen(step.key)} className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-sunken">
              <span aria-hidden="true" className="type-heading w-6 flex-none text-center text-muted">{step.sign}</span>
              <span className="min-w-0 flex-1">
                <span className="type-body block">{step.label}</span>
                <span className="type-caption block text-muted">{step.note}</span>
              </span>
              <Money paise={step.amountInPaise} size="num" tabular />
            </button>
          </li>
        ))}
        <li className="p-2">
          <DrawerCard book={book} />
        </li>
      </ul>
    </div>
  );
}
