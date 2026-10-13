import React from 'react';

/** Each chip's share of a 12-column row: four chips share one row, more go three to a row. */
const SPAN = { 3: 'col-span-3', 4: 'col-span-4', 6: 'col-span-6', 12: 'col-span-12' } as const;

function spanOf(i: number, n: number): keyof typeof SPAN {
  if (n === 4) return 3;
  // The last row shares out the width its chips leave, so a fifth chip isn't left beside a gap.
  const lastRow = Math.floor((n - 1) / 3) * 3;
  return (12 / (i >= lastRow ? n - lastRow : 3)) as keyof typeof SPAN;
}

/**
 * How a phone shows an "over time" section: one chart at a time, picked from a row of chips,
 * so the page doesn't scroll through every chart. Wider screens show the charts side by side.
 */
export function ChartChips<K extends string>({ label, options, value, onChange }: {
  /** What the chips choose, for screen readers. */
  label: string;
  options: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-12 gap-2">
      {options.map((o, i) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={`${SPAN[spanOf(i, options.length)]} min-h-11 px-1.5 rounded-xl border text-[13px] font-medium transition-colors ${
            value === o.key ? 'bg-zinc-800 border-zinc-700 text-zinc-50' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
