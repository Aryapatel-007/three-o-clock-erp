import { useEffect, useState } from 'react';

import Input from '../../components/ui/Input.jsx';
import { AtIcon, EyeIcon, EyeOffIcon, PersonIcon, PhoneIcon, TickIcon, TriangleIcon } from '../../components/ui/icons/index.jsx';
import { formatDayIst, formatTimeIst, istHour } from '../../utils/formatDate.js';

/**
 * The pieces of the sign-in screen, GLOSSARY section 42. Kept out of
 * LoginPage.jsx so that file stays about the page and its two layouts.
 *
 * Nothing here moves on its own: the clock's words change once a minute, and
 * every other change answers something the person typed or pressed.
 */

/** Now, re-read every 30 seconds, so the clock and the greeting stay right on a till left open. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The greeting for the hour in India: the day's shifts, not the calendar's. */
export function greetingFor(now) {
  const hour = istHour(now);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 23) return 'Good evening';
  return 'Working late';
}

/**
 * The time and the day, large, on the sign-in panel. `className` carries the
 * panel's text colour, which only LoginPage may name (DESIGN-SYSTEM 4d).
 */
export function ServiceClock({ now, className = '' }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="type-num-hero tabular-nums">{formatTimeIst(now)}</span>
      <span className="type-label">{formatDayIst(now)}</span>
    </div>
  );
}

/** What the phone-or-email field holds so far: nothing yet, a phone, or an email. */
export function identifierKind(value) {
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'EMPTY' };
  if (trimmed.includes('@')) return { kind: 'EMAIL' };
  let digits = trimmed.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  if (/^\d+$/.test(digits)) return { kind: 'PHONE', digits: digits.length };
  return { kind: 'EMAIL' };
}

const KIND_ICON = { EMPTY: PersonIcon, PHONE: PhoneIcon, EMAIL: AtIcon };

function identifierHint({ kind, digits }) {
  if (kind === 'EMAIL') return 'The email on your account';
  if (kind === 'PHONE') {
    if (digits === 10) return 'Mobile number, 10 digits';
    if (digits < 10) return `Mobile number, ${digits} of 10 digits`;
    return 'A mobile number has 10 digits';
  }
  return '10-digit mobile number, or the email on your account';
}

/**
 * Phone or email. The icon inside the field follows what is typed: a phone
 * for digits, an @ for an email, a person while it is empty. The hint counts a
 * phone's digits up to 10, and a tick shows once there are exactly 10.
 */
export function IdentifierField({ value, onChange, disabled, autoFocus }) {
  const read = identifierKind(value);
  const Icon = KIND_ICON[read.kind];
  const complete = read.kind === 'PHONE' && read.digits === 10;
  return (
    <Input
      label="Phone or email"
      name="identifier"
      type="text"
      autoComplete="username"
      autoCapitalize="none"
      spellCheck={false}
      required
      autoFocus={autoFocus}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      hint={identifierHint(read)}
      disabled={disabled}
      leading={<Icon />}
      trailing={
        complete ? (
          <span className="flex w-12 items-center justify-center text-ok">
            <TickIcon />
            <span className="sr-only">10 digits</span>
          </span>
        ) : null
      }
    />
  );
}

/**
 * The password, with Show beside it, and a warning while Caps Lock is on,
 * read from the keyboard as the person types.
 */
/** The password field's id, so the form can put the cursor back in it after a refusal. */
export const PASSWORD_FIELD_ID = 'sign-in-password';

export function PasswordField({ value, onChange, disabled }) {
  const [shown, setShown] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const readCaps = (event) => setCapsLock(Boolean(event.getModifierState?.('CapsLock')));

  return (
    <div>
      <Input
        id={PASSWORD_FIELD_ID}
        label="Password"
        name="password"
        type={shown ? 'text' : 'password'}
        autoComplete="current-password"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={readCaps}
        onKeyUp={readCaps}
        onBlur={() => setCapsLock(false)}
        disabled={disabled}
        trailing={
          <button
            type="button"
            onClick={() => setShown((now) => !now)}
            aria-pressed={shown}
            disabled={disabled}
            className="type-label flex min-h-12 items-center gap-1 rounded-r-lg px-3 text-muted hover:text-ink"
          >
            {shown ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
            {shown ? 'Hide' : 'Show'}
            <span className="sr-only"> password</span>
          </button>
        }
      />
      {capsLock && (
        <p role="status" className="type-caption mt-1 flex items-center gap-1 text-ink">
          <TriangleIcon size={16} />
          Caps Lock is on
        </p>
      )}
    </div>
  );
}

/** Shown once, after someone signs out on this device. */
export function SignedOutNote({ name }) {
  return (
    <p role="status" className="type-body mt-6 flex animate-[ticket-in_160ms_ease-out] items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-ink">
      <TickIcon className="text-ok" />
      {name ? `${name}, you are signed out. See you next shift.` : 'You are signed out. See you next shift.'}
    </p>
  );
}

/** How many of the floor's 12 tables are seated: one per digit or letter up to 10, the password, then Sign in. */
export function seatedTables({ identifier, password, isSubmitting }) {
  const read = identifierKind(identifier);
  const typed = read.kind === 'PHONE' ? read.digits : identifier.trim().length;
  return Math.min(typed, 10) + (password ? 1 : 0) + (isSubmitting ? 1 : 0);
}

/**
 * A small floor of 12 tables, drawn on the sign-in panel. Decorative, hidden
 * from screen readers. Each table takes its seat as the person types, its
 * colour changing over 200ms as a table tile's does on the floor
 * (DESIGN-SYSTEM section 10, item 3): the screen answers every key, and
 * nothing moves on its own. `emptyClass` and `seatedClass` carry the panel's
 * colours, which only LoginPage may name.
 */
export function FloorDoodle({ seated, emptyClass, seatedClass, className = '' }) {
  const shapes = ['rounded-full', 'rounded-[10px]', 'rounded-[10px]', 'rounded-full'];
  return (
    <div aria-hidden="true" className={`grid w-fit grid-cols-[repeat(4,48px)] gap-3 ${className}`}>
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          className={[
            'size-12 border-2 transition-colors duration-200',
            shapes[(index + Math.floor(index / 4)) % 4],
            index < seated ? seatedClass : emptyClass,
          ].join(' ')}
        />
      ))}
    </div>
  );
}
