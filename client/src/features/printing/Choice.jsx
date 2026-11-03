/** A set of radio choices with a heading and a hint: the Printers and This device screens. */
export default function Choice({ legend, hint, options, value, onChange }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="type-heading mb-1">{legend}</legend>
      {hint && <p className="type-caption -mt-1 text-muted">{hint}</p>}
      {options.map((option) => (
        <label
          key={String(option.value)}
          className={[
            'flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3',
            value === option.value ? 'border-2 border-ink bg-sunken' : 'border-line bg-surface hover:bg-sunken',
          ].join(' ')}
        >
          <input
            type="radio"
            name={legend}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="size-5 accent-[var(--color-accent)]"
          />
          <span className="flex flex-col py-2">
            <span className="type-body">{option.label}</span>
            {option.detail && <span className="type-caption text-muted">{option.detail}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
