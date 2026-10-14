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
 */
export function DayRuler({ dates, gapPx }: { dates: CivilDate[]; gapPx: number }) {
  const n = dates.length;
  const step = rulerStep(n);
  return (
    <div aria-hidden="true" className="mt-1 h-[26px] grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, columnGap: gapPx }}>
      {dates.map((date, i) => {
        const dated = (n - 1 - i) % step === 0;
        const latest = i === n - 1;
        return (
          <div key={date} className="relative flex justify-center">
            <div className={`w-px ${dated ? 'h-1.5' : 'h-[3px]'} ${latest ? 'bg-zinc-200' : dated ? 'bg-zinc-500' : 'bg-zinc-700'}`} />
            {dated && (
              <span className={`absolute top-[9px] left-1/2 -translate-x-1/2 whitespace-nowrap text-note ${latest ? 'font-bold text-zinc-200' : 'text-zinc-500'}`}>
                {formatCivil(date)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
