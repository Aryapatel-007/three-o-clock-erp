import { useId } from 'react';

/**
 * A labelled text input. DESIGN-SYSTEM: `surface` fill, a `muted` border
 * (never `line`, which is for dividers only), 8px corners.
 *
 * The label is required. An input with only a placeholder loses its label the
 * moment someone starts typing, which is exactly when a tired person needs it.
 * `error` is the message for this one field, from the server's `error.fields`.
 *
 * `leading` is an icon drawn inside the field on the left, for what kind of
 * value it takes; `trailing` sits inside on the right, the field's full height,
 * for a control such as Show password. Both are optional, and a field without
 * them is drawn exactly as before.
 */
export default function Input({ label, error, hint, id, type = 'text', className = '', leading = null, trailing = null, ...props }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className={className}>
      <label htmlFor={inputId} className="type-label block text-ink">
        {label}
      </label>

      <div className="relative mt-1">
        {leading && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center justify-center text-muted">
            {leading}
          </span>
        )}
        <input
          id={inputId}
          type={type}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
          className={[
            'type-body block min-h-12 w-full rounded-lg border bg-surface text-ink placeholder:text-muted',
            leading ? 'pl-12' : 'pl-3',
            trailing ? 'pr-24' : 'pr-3',
            error ? 'border-alert' : 'border-muted',
            'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted',
          ].join(' ')}
          {...props}
        />
        {trailing && <span className="absolute inset-y-0 right-0 flex items-center">{trailing}</span>}
      </div>

      {hint && !error && (
        <p id={hintId} className="type-caption mt-1 text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="type-caption mt-1 text-alert">
          {error}
        </p>
      )}
    </div>
  );
}
