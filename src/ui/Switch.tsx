/**
 * An on/off switch: on, its track takes its section's colour under a white knob; off, a plain grey
 * track. Track and knob are in the same units, so a browser's larger default text size scales both
 * together, and the knob is centred by the track rather than placed by offsets. The ::before
 * widens what a finger can hit to 44px tall.
 */
export function Switch({ on, onToggle, tone, labelledBy, disabled, className = '' }: {
  on: boolean;
  onToggle: () => void;
  /** Classes for the track when on and for the focus outline, such as a Data section's. */
  tone: { fill: string; focus: string };
  /** The id of the words that name what it switches. */
  labelledBy: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onToggle}
      className={`relative shrink-0 inline-flex items-center w-11 h-6 p-0.5 rounded-full transition-colors before:absolute before:-inset-x-1.5 before:-inset-y-2.5 before:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-default ${tone.focus} ${on ? tone.fill : 'bg-switch-off hover:bg-switch-off-hover'} ${className}`}
    >
      <span aria-hidden="true" className={`size-5 rounded-full bg-knob shadow-sm shadow-knob-shadow transition-transform ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}
