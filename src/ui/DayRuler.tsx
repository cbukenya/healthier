import React from 'react';
import { formatCivil, type CivilDate } from '../lib/date';

/**
 * How often a dated tick lands, counted back from the latest day, for a run of daily bars too
 * narrow to label one by one: every few days for a fortnight, weekly up to a month.
 */
export const rulerStep = (n: number) => (n <= 20 ? 3 : 7);

/**
 * A ruler under a row of daily bars, the way a ruler marks millimetres: a short tick under every
 * bar and a longer one under each dated bar, so a date sits under its own day. Pass the same
 * dates as the bars, with the bars' gap, so each tick centres on its bar.
 *
 * The active day (the latest unless one is picked) gets a bright tick and its date in bold; a
 * dated label too close to it steps aside so the two never collide.
 */
export function DayRuler({ dates, gapPx, active, className = '' }: {
  dates: CivilDate[];
  gapPx: number;
  active?: number;
  className?: string;
}) {
  const n = dates.length;
  const step = rulerStep(n);
  const on = active ?? n - 1;
  return (
    <div aria-hidden="true" className={`mt-1 h-[26px] grid ${className}`} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, columnGap: gapPx }}>
      {dates.map((date, i) => {
        const dated = (n - 1 - i) % step === 0;
        const isActive = i === on;
        const label = isActive || (dated && Math.abs(i - on) >= 4);
        return (
          <div key={date} className="relative flex justify-center">
            <div className={`w-px ${dated || isActive ? 'h-1.5' : 'h-[3px]'} ${isActive ? 'bg-zinc-200' : dated ? 'bg-zinc-500' : 'bg-zinc-700'}`} />
            {label && (
              <span className={`absolute top-[9px] left-1/2 -translate-x-1/2 whitespace-nowrap text-note ${isActive ? 'font-bold text-zinc-200' : 'text-zinc-500'}`}>
                {formatCivil(date)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
