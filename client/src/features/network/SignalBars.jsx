/**
 * Four bars, filled to the link's strength. P62.
 *
 * Never colour alone (DESIGN-SYSTEM section 4b): the bars are drawn filled or
 * hollow, and the caller always puts the word beside them.
 */
const TONE = { 4: 'text-ok', 3: 'text-ok', 2: 'text-open', 1: 'text-alert', 0: 'text-alert' };

export default function SignalBars({ bars = 0, size = 18, className = '', tone = null }) {
  const filled = Math.max(0, Math.min(4, bars ?? 0));
  const colour = tone ?? TONE[filled] ?? 'text-muted';
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" className={`flex-none ${colour} ${className}`}>
      {[0, 1, 2, 3].map((index) => {
        const height = 5 + index * 4;
        const x = 1.5 + index * 4.75;
        const on = index < filled;
        return (
          <rect
            key={index}
            x={x}
            y={18 - height}
            width="3.5"
            height={height}
            rx="1"
            fill={on ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.25"
            opacity={on ? 1 : 0.45}
          />
        );
      })}
    </svg>
  );
}
