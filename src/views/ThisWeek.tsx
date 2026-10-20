import React, { useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { formatCivilLong, formatCivilRange, formatHours, formatInteger, weekdayLetter, weekdayShort } from '../i18n/format';
import { batteryTier } from '../pipeline/derive';
import { WHO_WEEK } from '../pipeline/goals';
import { monthSummary, type PeriodSummary } from '../pipeline/insights';
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
const gap = (mins: number) => (Math.round(mins) < 60 ? `${Math.round(mins)} ${t('units.minutes')}` : fmtDuration(mins));

type View = 'week' | 'month';

/** A morning's bar: its height and colour, dimmed unless it's the day in focus. */
const barStyle = (score: number | null, lit: boolean, maxPx = BAR_MAX_PX): React.CSSProperties => {
  const hex = score === null ? null : TIER_STYLE[batteryTier(score).tag].hex;
  return {
    height: score === null ? 3 : Math.max(4, (score / 100) * maxPx),
    background: hex ?? 'var(--color-zinc-800)',
    opacity: hex && !lit ? 0.55 : 1,
  };
};

/**
 * The last seven days at a glance, or with Month the last 30: the battery each morning, then
 * sleep, WHO minutes and steps against their bars. Where the numbers came from lives on the Settings page.
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
  const need = goals.sleepNeed === null ? t('today.week.sleep.needApprox', { need: formatHours(needMin) }) : formatHours(needMin);
  const period = isMonth ? 'month' : 'week';

  const sleep = p.sleep;
  const short = sleep ? needMin - sleep.avgMin : 0;
  // The nights recorded, when some are missing.
  const coverage = { coverage: sleep && sleep.nights < p.length ? 'partial' : 'full', nights: sleep?.nights ?? 0, count: p.length };
  const sleepNote = !sleep
    ? t('today.week.sleep.none', { period })
    : Math.abs(short) < 10
      ? t('today.week.sleep.about', { need, ...coverage })
      : short > 0
        ? t('today.week.sleep.under', { gap: gap(short), need, ...coverage })
        : t('today.week.sleep.over', { gap: gap(-short), need, ...coverage });

  // The WHO's bar is weekly, so a month reads as its average week against it.
  const active = p.activeMinutes;
  const perWeek = active ? (isMonth ? (active.total / p.length) * 7 : active.total) : null;
  // Brisk minutes count vigorous ones double; zone minutes count harder ones double.
  const unit = active?.unit ?? null;
  const activeNote = perWeek === null
    ? t('today.week.active.none', { period })
    : isMonth
      ? perWeek >= WHO_WEEK
        ? t('today.week.active.pastMonth', { unit })
        : t('today.week.active.shortMonth', { unit, minutes: Math.ceil(WHO_WEEK - perWeek) })
      : perWeek >= WHO_WEEK
        ? t('today.week.active.pastWeek', { unit })
        : t('today.week.active.toGo', { unit, minutes: Math.ceil(WHO_WEEK - perWeek) });

  const steps = p.steps;
  const stepsNote = !steps
    ? t('today.week.steps.none', { period })
    : t('today.week.steps.reached', { goal: formatInteger(goals.steps), days: steps.atGoal, count: steps.days });

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

  const title = t(isMonth ? 'today.week.title.month' : 'today.week.title.week');

  return (
    <section aria-label={title} className={`bg-card border border-card-edge rounded-[20px] px-4 pt-[18px] pb-4 md:px-5 md:pt-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="card-title-detail text-zinc-50">{title}</h2>
          <p className="text-detail text-zinc-500">{formatCivilRange(first, today)}</p>
        </div>
        {/* Tall enough to tap, pulled back so the header keeps its height. */}
        <div role="tablist" aria-label={t('today.week.period')} className="flex shrink-0 -mt-2.5 -mr-2">
          {(['week', 'month'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => { setView(v); setPicked(null); }}
              className={`min-h-11 px-2 text-body-sm transition-colors ${view === v ? 'font-semibold text-zinc-50' : 'font-medium text-zinc-500 hover:text-zinc-300'}`}
            >
              <span className={`inline-block pb-1 border-b-2 ${view === v ? 'border-zinc-50' : 'border-transparent'}`}>
                {t(v === 'week' ? 'today.week.tabs.week' : 'today.week.tabs.month')}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3.5 text-eyebrow uppercase text-zinc-500">{t('today.week.battery')}</div>
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
              aria-label={range ? t('today.week.monthChartRange', range) : t('today.week.monthChart')}
              aria-valuemin={1}
              aria-valuemax={n}
              aria-valuenow={focus + 1}
              aria-valuetext={focusDay.score === null
                ? t('today.week.monthDayEmpty', { date: formatCivilLong(focusDay.date) })
                : t('today.week.monthDay', { date: formatCivilLong(focusDay.date), score: focusDay.score })}
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
          {range && <p className="mt-1.5 text-caption text-zinc-500">{t('today.week.average', range)}</p>}
        </>
      ) : (
        <div
          role="img"
          aria-label={t('today.week.weekChart', {
            days: p.battery
              .map((b) => (b.score === null
                ? t('today.week.weekDayEmpty', { day: weekdayShort(b.date) })
                : t('today.week.weekDay', { day: weekdayShort(b.date), score: b.score })))
              .reduceRight((rest, first) => t('today.week.weekDays', { first, rest })),
          })}
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
          label={t('today.week.sleep.label')}
          value={sleep ? fmtDuration(sleep.avgMin) : '—'}
          unit={sleep ? t('today.week.sleep.unit') : undefined}
          pct={sleep ? (sleep.avgMin / needMin) * 100 : null}
          color={DOMAIN.sleep.hex}
          note={sleepNote}
        />
        <WeekRow
          label={t(active?.unit === 'brisk' ? 'today.week.active.brisk' : 'today.week.active.zone')}
          value={perWeek === null ? '—' : formatInteger(perWeek)}
          unit={isMonth ? t('today.week.active.perWeek') : t('today.week.active.ofWho', { target: WHO_WEEK })}
          pct={perWeek === null ? null : (perWeek / WHO_WEEK) * 100}
          color="var(--emerald-500)"
          note={activeNote}
        />
        <WeekRow
          label={t('today.week.steps.label')}
          value={steps ? formatInteger(steps.avg) : '—'}
          unit={steps ? t('today.week.steps.unit') : undefined}
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
    <div className="py-[11px] border-t border-faint last:pb-0">
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
