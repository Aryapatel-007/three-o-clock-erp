import { useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeProvider.jsx';
import { rememberSignedOut } from '../features/auth/signedOut.js';
import { ROLE_LABELS } from '../features/users/roles.js';
import Button from './ui/Button.jsx';
import { ChevronDownIcon, DeviceIcon, SignOutIcon } from './ui/icons/index.jsx';

/**
 * Who is signed in, and Sign out. GLOSSARY section 42.
 *
 * The top bar shows the person's initials, and their name from 600px; tapping
 * it opens a small card with their name, role and restaurant, This device,
 * and Sign out. The card floats, so it casts the float shadow (DESIGN-SYSTEM
 * section 6). It closes on Escape, on a tap outside, and on choosing a place.
 */

const HOLD_MS = 700;

export function initialsOf(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] : (words[0][1] ?? '');
  return `${first}${last}`.toUpperCase();
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Sign out, held. A shared tablet is touched all day, so a stray tap must not
 * end someone's session: the button is held for 0.7 seconds while a bar fills
 * behind its words, and letting go early empties the bar and says to hold. The
 * fill answers the press, as DESIGN-SYSTEM section 10 allows, and loops never.
 *
 * From the keyboard, or with reduced motion on, it asks "Sign out now?" in
 * place instead, the same rule as the kitchen's Mark all ready (P29).
 */
export function SignOutButton({ className = '' }) {
  const { user, logout } = useAuth();
  const [holding, setHolding] = useState(false);
  const [asking, setAsking] = useState(false);
  const [hint, setHint] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);
  const pressedByPointer = useRef(false);
  const hintId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function signOut() {
    setLeaving(true);
    rememberSignedOut(user?.name);
    await logout();
  }

  function startHold(event) {
    if (event.button !== undefined && event.button !== 0) return;
    pressedByPointer.current = true;
    if (prefersReducedMotion()) return;
    setHint(false);
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      signOut();
    }, HOLD_MS);
  }

  function endHold() {
    if (!holding) return;
    clearTimeout(timer.current);
    setHolding(false);
    setHint(true);
  }

  function onClick(event) {
    // A pointer press is handled by the hold. A click with no pointer behind it is the keyboard.
    const fromKeyboard = event.detail === 0 && !pressedByPointer.current;
    pressedByPointer.current = false;
    if (fromKeyboard || prefersReducedMotion()) setAsking(true);
  }

  if (asking) {
    return (
      <div role="group" aria-label="Sign out now?" className={`flex flex-col gap-2 ${className}`}>
        <p className="type-label text-ink">Sign out now?</p>
        <div className="flex gap-2">
          <Button variant="danger" onClick={signOut} isLoading={leaving} className="flex-1" autoFocus>
            Sign out
          </Button>
          <Button variant="secondary" onClick={() => setAsking(false)} disabled={leaving} className="flex-1">
            Stay
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={endHold}
        onPointerCancel={endHold}
        onContextMenu={(event) => event.preventDefault()}
        onClick={onClick}
        disabled={leaving}
        aria-describedby={hintId}
        className="type-button relative flex min-h-12 w-full touch-none select-none items-center gap-2 overflow-hidden rounded-lg border border-ink bg-surface px-4 text-ink disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={[
            'absolute inset-0 origin-left bg-alert-tint',
            holding ? 'scale-x-100 transition-transform duration-[700ms] ease-linear' : 'scale-x-0 transition-transform duration-150 ease-out',
          ].join(' ')}
        />
        <span className="relative flex flex-1 items-center gap-2">
          <SignOutIcon />
          {leaving ? 'Signing out' : 'Sign out'}
        </span>
        <span className="type-caption relative text-muted">{holding ? 'Keep holding' : 'Hold'}</span>
      </button>
      <p id={hintId} className={`type-caption mt-1 ${hint ? 'text-ink' : 'sr-only'}`}>
        {hint ? 'Press and hold to sign out.' : 'Press and hold, or press Enter, to sign out.'}
      </p>
    </div>
  );
}

/** The person's initials in a circle, in the accent: the top bar's account button. */
function Initials({ name, size = 'sm' }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'type-label flex flex-none items-center justify-center rounded-full bg-accent text-on-accent',
        size === 'lg' ? 'size-12' : 'size-8',
      ].join(' ')}
    >
      {initialsOf(name)}
    </span>
  );
}

export default function AccountMenu() {
  const { user } = useAuth();
  const { name: restaurantName } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const cardId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((now) => !now)}
        aria-expanded={open}
        aria-controls={cardId}
        aria-label={`${user.name}, account`}
        className="flex min-h-12 items-center gap-2 rounded-lg px-2 text-ink hover:bg-sunken"
      >
        <Initials name={user.name} />
        <span className="type-label hidden max-w-40 truncate min-[600px]:inline">{user.name}</span>
        <ChevronDownIcon size={16} className={`text-muted transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          id={cardId}
          className="absolute right-0 top-full z-40 mt-2 w-72 animate-[ticket-in_160ms_ease-out] rounded-[10px] border border-line bg-surface p-4 shadow-float"
        >
          <div className="flex items-center gap-3">
            <Initials name={user.name} size="lg" />
            <div className="min-w-0">
              <p className="type-label truncate text-ink">{user.name}</p>
              <p className="type-caption truncate text-muted">
                {ROLE_LABELS[user.role] ?? user.role} · {restaurantName}
              </p>
            </div>
          </div>
          {/* P42. The kitchen login has only its ticket board, so no This device. */}
          {user.role !== 'KITCHEN' && (
            <NavLink
              to="/device"
              onClick={() => setOpen(false)}
              className="type-body mt-4 flex min-h-12 items-center gap-2 rounded-lg px-3 hover:bg-sunken"
            >
              <DeviceIcon />
              This device
            </NavLink>
          )}
          <SignOutButton className={user.role === 'KITCHEN' ? 'mt-4' : 'mt-2'} />
        </div>
      )}
    </div>
  );
}
