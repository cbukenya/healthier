import React, { useMemo, useRef, useState } from 'react';
import { formatCivil, formatCivilRange, weekdayLetter, weekdayShort } from '../lib/date';
import { batteryTier } from '../pipeline/derive';
import { WHO_WEEK } from '../pipeline/goals';
import { monthSummary, needLabel, type PeriodSummary } from '../pipeline/insights';
import type { DailyRecord } from '../types/health';
import { useGoals } from '../hooks/useGoals';
import { DayRuler } from '../ui/DayRuler';
import { DOMAIN, Meter, fmtDuration, withUnits } from '../ui/primitives';
import { TIER_STYLE } from './BodyBattery';

/** Tallest bar in the week, at a battery of 100. */
const BAR_MAX_PX = 76;
/** The month's bars stand a pixel per point, under a line marking 100. */
const MONTH_MAX_PX = 100;
/** Room on the right for the line's "100". */
const GUTTER = 'right-[26px]';

/** A gap as "48 min" or "1h 12m". */
const gap = (mins: number) => (Math.round(mins) < 60 ? `${Math.round(mins)} min` : fmtDuration(mins));

type View = 'week' | 'month';

/** A morning's bar: its height and colour, dimmed unless it's the day in focus. */
const barStyle = (score: number | null, lit: boolean, maxPx = BAR_MAX_PX): React.CSSProperties => {
  const hex = score === null ? null : TIER_STYLE[batteryTier(score).tag].hex;
  return {
    height: score === null ? 3 : Math.max(4, (score / 100) * maxPx),
    background: hex ?? '#27272a',
    opacity: hex && !lit ? 0.55 : 1,
  };
};

/**
 * The last seven days at a glance, or with Month the last 30: the battery each morning, then
 * sleep, WHO minutes and steps against their bars. Where the numbers came from lives on the Data tab.
 */
export function ThisWeek({ week, days, needMin, className = '' }: {
  week: PeriodSummary;
  /** The window, for the month view, worked out only when someone opens it. */
  days: DailyRecord[];
  needMin: number;
  className?: string;
}) {
  const goals = useGoals();
  const [view, setView] = useState<View>('week');
  const month = useMemo(() => (view === 'month' ? monthSummary(days, goals) : null), [view, days, goals]);
  // The month's chart scrubs: the bar under the pointer is the one in focus, today's otherwise.
  const [picked, setPicked] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const p = month ?? week;
  const isMonth = view === 'month' && month !== null;
  const first = p.battery[0].date;
  const today = p.battery[p.battery.length - 1].date;
  // An estimate from your nights reads "about"; a need you set is exact.
  const need = `${goals.sleepNeed === null ? '~' : ''}${needLabel(needMin)}`;
  const span = isMonth ? 'in the last 30 days' : 'this week';

  const sleep = p.sleep;
  const short = sleep ? needMin - sleep.avgMin : 0;
  const sleepNote = !sleep
    ? `No nights recorded ${span}`
    : `${
      Math.abs(short) < 10 ? `About your ${need} need` : short > 0 ? `${gap(short)} under your ${need} need` : `${gap(-short)} over your ${need} need`
    }, on average${sleep.nights < p.length ? ` · ${sleep.nights} of ${p.length} nights recorded` : ''}`;

  // The WHO's bar is weekly, so a month reads as its average week against it.
  const active = p.activeMinutes;
  const perWeek = active ? (isMonth ? (active.total / p.length) * 7 : active.total) : null;
  const doubled = active?.unit === 'brisk' ? 'vigorous minutes count double' : 'harder minutes count double';
  const activeNote = perWeek === null
    ? `No activity minutes recorded ${span}`
    : isMonth
      ? perWeek >= WHO_WEEK
        ? `Past the WHO's weekly bar on average; ${doubled}`
        : `${Math.ceil(WHO_WEEK - perWeek)} a week short of the WHO's bar on average; ${doubled}`
      : perWeek >= WHO_WEEK
        ? `Past the WHO's weekly bar; ${doubled}`
        : `${Math.ceil(WHO_WEEK - perWeek)} to go for the WHO's weekly bar; ${doubled}`;

  const steps = p.steps;
  const stepsNote = !steps
    ? `No finished days with steps ${span}`
    : `${goals.steps.toLocaleString('en-GB')} or more on ${steps.atGoal} of ${steps.days} full day${steps.days === 1 ? '' : 's'}`;

  const n = p.battery.length;
  const focus = picked === null ? n - 1 : Math.min(picked, n - 1);
  const focusDay = p.battery[focus];
  const pickAt = (clientX: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (box && box.width > 0) setPicked(Math.max(0, Math.min(n - 1, Math.floor(((clientX - box.left) / box.width) * n))));
  };
  const onKey = (e: React.KeyboardEvent) => {
    const to = { ArrowLeft: focus - 1, ArrowRight: focus + 1, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setPicked(Math.max(0, Math.min(n - 1, to)));
  };

  const scores = p.battery.map((b) => b.score).filter((s): s is number => s !== null);
  const range = scores.length
    ? { avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), min: Math.min(...scores), max: Math.max(...scores) }
    : null;

  return (
    <section aria-label={isMonth ? 'This month' : 'This week'} className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[20px] px-4 pt-[18px] pb-4 md:px-5 md:pt-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-title text-zinc-50">{isMonth ? 'This month' : 'This week'}</h2>
          <p className="text-detail text-zinc-500">{formatCivilRange(first, today)}</p>
        </div>
        {/* Tall enough to tap, pulled back so the header keeps its height. */}
        <div role="tablist" aria-label="Period" className="flex shrink-0 -mt-2.5 -mr-2">
          {(['week', 'month'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => { setView(v); setPicked(null); }}
              className={`min-h-11 px-2 text-body-sm transition-colors ${view === v ? 'font-semibold text-zinc-50' : 'font-medium text-zinc-500 hover:text-zinc-300'}`}
            >
              <span className={`inline-block pb-1 border-b-2 ${view === v ? 'border-zinc-50' : 'border-transparent'}`}>{v === 'week' ? 'Week' : 'Month'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3.5 text-eyebrow uppercase text-[#6b6f78]">Body battery</div>
      {isMonth ? (
        <>
          <div className="mt-2 relative h-[116px]">
            {/* Full charge, so each bar reads against it. */}
            <div aria-hidden="true" className={`absolute left-0 ${GUTTER} bottom-[100px] border-t border-dashed border-zinc-400/60`} />
            <span aria-hidden="true" className="absolute right-0 bottom-[100px] translate-y-1/2 text-note leading-none text-zinc-500">100</span>
            {/* Hover, drag or use the arrow keys to read any morning; a touch keeps its pick, a mouse leaving lets go. */}
            <div
              ref={plotRef}
              role="slider"
              tabIndex={0}
              aria-label={`Body battery each morning over the last 30 days${range ? `, averaged ${range.avg}, between ${range.min} and ${range.max}` : ''}`}
              aria-valuemin={1}
              aria-valuemax={n}
              aria-valuenow={focus + 1}
              aria-valuetext={`${weekdayShort(focusDay.date)} ${formatCivil(focusDay.date)}: ${focusDay.score ?? 'no score'}`}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pickAt(e.clientX); }}
              onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons) pickAt(e.clientX); }}
              onPointerLeave={(e) => { if (e.pointerType === 'mouse') setPicked(null); }}
              onKeyDown={onKey}
              className={`absolute inset-y-0 left-0 ${GUTTER} grid gap-0.5 items-end touch-pan-y select-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-zinc-600`}
              style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
            >
              {p.battery.map((b, i) => (
                <div key={b.date} className="h-full flex flex-col items-center justify-end gap-1">
                  {i === focus && <span className="text-caption leading-tight font-bold tabular-nums text-zinc-50">{b.score ?? '—'}</span>}
                  <div className="w-full rounded-[3px]" style={barStyle(b.score, i === focus, MONTH_MAX_PX)} />
                </div>
              ))}
            </div>
          </div>
          {/* Thirty bars are too narrow to date one by one, so a ruler marks the days. */}
          <DayRuler dates={p.battery.map((b) => b.date)} gapPx={2} active={focus} className="mr-[26px]" />
          {range && <p className="mt-1.5 text-caption text-zinc-500">Averaged {range.avg}, between {range.min} and {range.max}</p>}
        </>
      ) : (
        <div
          role="img"
          aria-label={`Body battery each morning: ${p.battery.map((b) => `${weekdayShort(b.date)} ${b.score ?? 'no score'}`).join(', ')}`}
          className="mt-2 h-[112px] grid grid-cols-7 gap-1.5 items-end"
        >
          {p.battery.map((b) => {
            const isToday = b.date === today;
            return (
              <div key={b.date} className="h-full flex flex-col items-center justify-end gap-1">
                <span className={`text-caption tabular-nums ${isToday ? 'font-bold text-zinc-50' : 'text-zinc-400'}`}>{b.score ?? '—'}</span>
                <div className="w-full rounded-[6px]" style={barStyle(b.score, isToday)} />
                <span className={`text-note ${isToday ? 'font-bold text-zinc-200' : 'text-zinc-500'}`}>{weekdayLetter(b.date)}</span>
              </div>
            );
          })}
        </div>
      )}

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
          value={perWeek === null ? '—' : Math.round(perWeek).toLocaleString('en-GB')}
          unit={isMonth ? 'a week' : `of ${WHO_WEEK}`}
          pct={perWeek === null ? null : (perWeek / WHO_WEEK) * 100}
          color="#10b981"
          note={activeNote}
        />
        <WeekRow
          label="Steps"
          value={steps ? Math.round(steps.avg).toLocaleString('en-GB') : '—'}
          unit={steps ? 'a day' : undefined}
          pct={steps ? (steps.avg / goals.steps) * 100 : null}
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
        <span className="text-body text-zinc-200">{label}</span>
        <span className="text-body font-semibold text-zinc-50 tabular-nums">
          {withUnits(value, 'text-caption font-normal text-zinc-500')}
          {unit && <span className="font-normal text-zinc-500"> {unit}</span>}
        </span>
      </div>
      <Meter pct={pct} color={color} className="mt-2" />
      <p className="mt-1.5 text-caption text-zinc-500">{note}</p>
    </div>
  );
}
