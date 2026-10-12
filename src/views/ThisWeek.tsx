import React from 'react';
import { formatCivil, weekdayLetter, weekdayShort, type CivilDate } from '../lib/date';
import { batteryTier } from '../pipeline/derive';
import { needLabel, type WeekSummary } from '../pipeline/insights';
import { DOMAIN, Meter, fmtDuration } from '../ui/primitives';
import { TIER_STYLE } from './BodyBattery';

/** The WHO's weekly bar: 150 moderate minutes, vigorous ones counting double. */
const WHO_WEEK = 150;
const STEP_GOAL = 10000;
/** Tallest bar, at a battery of 100. */
const BAR_MAX_PX = 76;

/** "12–18 Aug", or "29 Jul – 4 Aug" across a month. */
const span = (from: CivilDate, to: CivilDate) =>
  from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8))}–${formatCivil(to)}` : `${formatCivil(from)} – ${formatCivil(to)}`;

/** A gap as "48 min" or "1h 12m". */
const gap = (mins: number) => (Math.round(mins) < 60 ? `${Math.round(mins)} min` : fmtDuration(mins));

/**
 * The last seven days at a glance: the battery each morning, then the week's sleep, WHO minutes
 * and steps against their bars. Replaces the card listing where the numbers came from, which
 * now sits as one line under the page.
 */
export function ThisWeek({ week, needMin, className = '' }: { week: WeekSummary; needMin: number; className?: string }) {
  const first = week.battery[0].date;
  const today = week.battery[week.battery.length - 1].date;
  const need = `~${needLabel(needMin)}`;

  const sleep = week.sleep;
  const short = sleep ? needMin - sleep.avgMin : 0;
  const sleepNote = !sleep
    ? 'No nights recorded this week'
    : `${
      Math.abs(short) < 10 ? `About your ${need} need` : short > 0 ? `${gap(short)} under your ${need} need` : `${gap(-short)} over your ${need} need`
    }, on average${sleep.nights < 7 ? ` · ${sleep.nights} of 7 nights recorded` : ''}`;

  const active = week.activeMinutes;
  const doubled = active?.unit === 'brisk' ? 'vigorous minutes count double' : 'harder minutes count double';
  const activeNote = !active
    ? 'No activity minutes recorded this week'
    : active.total >= WHO_WEEK
      ? `Past the WHO's weekly bar; ${doubled}`
      : `${Math.ceil(WHO_WEEK - active.total)} to go for the WHO's weekly bar; ${doubled}`;

  const steps = week.steps;
  const stepsNote = !steps
    ? 'No finished days with steps this week'
    : `10,000 or more on ${steps.atGoal} of ${steps.days} full day${steps.days === 1 ? '' : 's'}`;

  return (
    <section aria-label="This week" className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[20px] px-4 pt-[18px] pb-4 md:px-5 md:pt-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-zinc-50">This week</h2>
        <span className="text-[12px] text-zinc-500">{span(first, today)}</span>
      </div>

      <div className="mt-3.5 text-[10.5px] font-semibold tracking-[0.2em] uppercase text-[#6b6f78]">Body battery</div>
      <div
        role="img"
        aria-label={`Body battery each morning: ${week.battery.map((b) => `${weekdayShort(b.date)} ${b.score ?? 'no score'}`).join(', ')}`}
        className="mt-2 h-[112px] grid grid-cols-7 gap-1.5 items-end"
      >
        {week.battery.map((b) => {
          const isToday = b.date === today;
          const hex = b.score === null ? null : TIER_STYLE[batteryTier(b.score).tag].hex;
          return (
            <div key={b.date} className="h-full flex flex-col items-center justify-end gap-1">
              <span className={`text-[11px] tabular-nums ${isToday ? 'font-bold text-zinc-50' : 'text-zinc-400'}`}>{b.score ?? '—'}</span>
              <div
                className="w-full rounded-[6px]"
                style={{
                  height: b.score === null ? 3 : Math.max(4, (b.score / 100) * BAR_MAX_PX),
                  background: hex ?? '#27272a',
                  opacity: hex && !isToday ? 0.55 : 1,
                }}
              />
              <span className={`text-[10.5px] ${isToday ? 'font-bold text-zinc-200' : 'text-zinc-500'}`}>{weekdayLetter(b.date)}</span>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <WeekRow
          label="Sleep"
          value={sleep ? fmtDuration(sleep.avgMin) : '—'}
          unit={sleep ? 'a night' : undefined}
          pct={sleep ? (sleep.avgMin / needMin) * 100 : null}
          color={DOMAIN.sleep.hex}
          note={sleepNote}
        />
        <WeekRow
          label={active?.unit === 'brisk' ? 'Brisk minutes' : 'Active zone minutes'}
          value={active ? Math.round(active.total).toLocaleString('en-GB') : '—'}
          unit={`of ${WHO_WEEK}`}
          pct={active ? (active.total / WHO_WEEK) * 100 : null}
          color="#10b981"
          note={activeNote}
        />
        <WeekRow
          label="Steps"
          value={steps ? Math.round(steps.avg).toLocaleString('en-GB') : '—'}
          unit={steps ? 'a day' : undefined}
          pct={steps ? (steps.avg / STEP_GOAL) * 100 : null}
          color={DOMAIN.movement.hex}
          note={stepsNote}
        />
      </div>
    </section>
  );
}

function WeekRow({ label, value, unit, pct, color, note }: {
  label: string;
  value: string;
  unit?: string;
  pct: number | null;
  color: string;
  note: string;
}) {
  return (
    <div className="py-[11px] border-t border-[#18181b] last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] text-zinc-200">{label}</span>
        <span className="text-[13.5px] font-semibold text-zinc-50 tabular-nums">
          {value}
          {unit && <span className="font-normal text-zinc-500"> {unit}</span>}
        </span>
      </div>
      <Meter pct={pct} color={color} className="mt-2" />
      <p className="mt-1.5 text-[11.5px] leading-[1.45] text-zinc-500">{note}</p>
    </div>
  );
}
