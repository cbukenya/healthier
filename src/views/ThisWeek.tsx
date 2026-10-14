import React, { useMemo, useState } from 'react';
import { formatCivilRange, weekdayLetter, weekdayShort } from '../lib/date';
import { batteryTier } from '../pipeline/derive';
import { STEP_GOAL, monthSummary, needLabel, type PeriodSummary } from '../pipeline/insights';
import type { DailyRecord } from '../types/health';
import { DayRuler } from '../ui/DayRuler';
import { DOMAIN, Meter, fmtDuration, withUnits } from '../ui/primitives';
import { TIER_STYLE } from './BodyBattery';

/** The WHO's weekly bar: 150 moderate minutes, vigorous ones counting double. */
const WHO_WEEK = 150;
/** Tallest bar, at a battery of 100. */
const BAR_MAX_PX = 76;

/** A gap as "48 min" or "1h 12m". */
const gap = (mins: number) => (Math.round(mins) < 60 ? `${Math.round(mins)} min` : fmtDuration(mins));

type View = 'week' | 'month';

/** A morning's bar: its height and colour, and a dimmed one for every day but today. */
const barStyle = (score: number | null, isToday: boolean): React.CSSProperties => {
  const hex = score === null ? null : TIER_STYLE[batteryTier(score).tag].hex;
  return {
    height: score === null ? 3 : Math.max(4, (score / 100) * BAR_MAX_PX),
    background: hex ?? '#27272a',
    opacity: hex && !isToday ? 0.55 : 1,
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
  const [view, setView] = useState<View>('week');
  const month = useMemo(() => (view === 'month' ? monthSummary(days) : null), [view, days]);
  const p = month ?? week;
  const isMonth = view === 'month' && month !== null;
  const first = p.battery[0].date;
  const today = p.battery[p.battery.length - 1].date;
  const need = `~${needLabel(needMin)}`;
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
    : `10,000 or more on ${steps.atGoal} of ${steps.days} full day${steps.days === 1 ? '' : 's'}`;

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
              onClick={() => setView(v)}
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
          <div
            role="img"
            aria-label={`Body battery each morning over the last 30 days${range ? `: averaged ${range.avg}, between ${range.min} and ${range.max}` : ''}`}
            className="mt-2 h-[96px] grid gap-0.5 items-end"
            style={{ gridTemplateColumns: `repeat(${p.battery.length}, minmax(0, 1fr))` }}
          >
            {p.battery.map((b) => {
              const isToday = b.date === today;
              return (
                <div key={b.date} className="h-full flex flex-col items-center justify-end gap-1">
                  {isToday && <span className="text-caption font-bold tabular-nums text-zinc-50">{b.score ?? '—'}</span>}
                  <div className="w-full rounded-[3px]" style={barStyle(b.score, isToday)} />
                </div>
              );
            })}
          </div>
          {/* Thirty bars are too narrow to date one by one, so a ruler marks the days. */}
          <DayRuler dates={p.battery.map((b) => b.date)} gapPx={2} />
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
