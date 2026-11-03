import { CashIcon, MenuBookIcon, ReceiptIcon } from '../../components/ui/icons/index.jsx';
import Bilingual from '../i18n/Bilingual.jsx';
import { METHOD_KEYS } from '../i18n/labels.js';

const METHOD_ICON = { CASH: CashIcon, UPI: ReceiptIcon, CARD: MenuBookIcon };

/**
 * One large button per payment method, in display order. P08.
 *
 * Shared by taking a payment and correcting one, so both draw the same tiles.
 * The built-in methods carry the second-language line while they keep their
 * built-in name; a renamed method, or one the owner added, shows its own name
 * alone, because it is a brand and is not translated.
 *
 * `onPartPayment` (2026-11-03): a Part payment tile after the methods, the same size,
 * filling the grid's empty place, opening the split.
 */
export default function MethodButtons({ methods, selected = null, onPick, onPartPayment = null }) {
  if (methods.length === 0) {
    return <p className="type-caption text-alert">No payment method can be used for this bill. An owner can add one in Settings.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {methods.map((method) => {
        const chosen = selected === method.code;
        const Icon = METHOD_ICON[method.code];
        return (
          <button
            key={method.code}
            type="button"
            aria-pressed={chosen}
            onClick={() => onPick(method)}
            className={[
              'flex min-h-20 items-center gap-3 rounded-lg border px-3 text-left transition-colors',
              chosen ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
            ].join(' ')}
          >
            {Icon && (
              <span className="text-muted">
                <Icon />
              </span>
            )}
            <Bilingual k={METHOD_KEYS[method.code] ?? method.code} en={method.name} size="md" />
          </button>
        );
      })}
      {onPartPayment && methods.length > 1 && (
        <button
          type="button"
          onClick={onPartPayment}
          className="flex min-h-20 items-center gap-3 rounded-lg border border-dashed border-ink bg-surface px-3 text-left transition-colors hover:bg-sunken"
        >
          <span className="text-muted">
            <CashIcon />
          </span>
          <span className="flex flex-col">
            <span className="type-label">Part payment</span>
            <span className="type-caption text-muted">Cash, UPI and more together</span>
          </span>
        </button>
      )}
    </div>
  );
}
