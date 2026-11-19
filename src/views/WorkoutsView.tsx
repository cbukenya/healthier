import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { CivilDate } from '../lib/date';
import { t } from '../i18n';
import { bucketLabel, formatCivil, formatCivilLong, formatInteger, formatMonthYear } from '../i18n/format';
import { ZONE_NAMES } from '../charts/heartRate';
import { readiness } from '../pipeline/derive';
import {
  LEVELS, kindOf, kindsIn, levelHistory, mainKinds, levelIndex, levelStarts, progressOf, restingKcalPerMinute, workoutHeart,
  workoutLevel, workoutLoad, workoutsIn, zoneMinutesOf, type DatedWorkout, type LevelPeriod, type Progress,
  type WorkoutKind,
} from '../pipeline/workouts';
import type { SyncResult } from '../pipeline/sync';
import type { IntradayDays } from '../pipeline/labs';
import type { DailyRecord } from '../types/health';
import { Card, EmptyState, fmtNum } from '../ui/primitives';
import { SpanSelector, useSpan, type SpanId } from '../ui/span';
import { useHistory } from '../hooks/useHistory';
import { useGoals } from '../hooks/useGoals';
import { useCycle } from '../hooks/useCycle';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  FigureBox, HeartChart, HeartKey, LEVEL_COLOUR, kindColour, LatestWorkoutCard, LevelCard, LoadCard, Ruler, ScrubReadout, WORKOUT, WorkoutIcon,
  ZONE_COLOURS, ZONE_KEYS, allFigures, bigFigure, formatPace, heartLabel, kindName, levelName, spanLabel, workoutName,
  workoutTime, zoneRange, type HeartScrub,
} from './WorkoutCards';

/**
 * The Activity page's Workouts tab: the workout level, the load against the usual week with the
 * body battery, the latest workout, then over the span picked, how the level has moved, what the
 * workouts were, and each workout with its heart rate, zones and splits. On a phone a workout
 * opens on a page of its own, with a way back.
 */
export function WorkoutsView({ data, intraday, clock, openId, onOpen }: {
  data: SyncResult;
  intraday?: IntradayDays;
  /** Demo mode's clock, for the insights. */
  clock?: Clock;
  /** The workout open, by id, from the address. */
  openId: string | null;
  /** Opens a workout, or closes it with null: `push` makes it a step Back returns from. */
  onOpen: (id: string | null, push: boolean) => void;
}) {
  const days = data.days;
  const wide = useMediaQuery('(min-width: 768px)');
  // The list and the workout picked from it sit side by side on the widest screens; narrower ones open it on its own.
  const split = useMediaQuery('(min-width: 1024px)');
  const goals = useGoals();
  const { judged } = useCycle();
  const spanState = useSpan(data, '90');
  const history = useHistory();
  const today = days.at(-1)?.date ?? null;
  const insights = usePageInsights(data, 'workouts', clock, intraday);

  const level = useMemo(() => workoutLevel(days), [days]);
  const load = useMemo(() => workoutLoad(days), [days]);
  const battery = useMemo(() => readiness(days, goals.sleepNeed, judged, data.profile?.age ?? null).score, [days, goals.sleepNeed, judged, data.profile]);
  const recent = useMemo(() => workoutsIn(days), [days]);

  // Every day there is, for the span's workouts and for the 4 weeks before its first week.
  const source = history.days && history.days.length > days.length ? history.days : days;
  const spanFrom = spanState.days[0]?.date ?? today;
  const inSpan = useMemo(() => (spanFrom ? workoutsIn(source.filter((d) => d.date >= spanFrom)) : []), [source, spanFrom]);
  const all = useMemo(() => new Map([...workoutsIn(source), ...recent].map((w) => [w.id, w])), [source, recent]);

  const open = openId ? all.get(openId) ?? null : null;
  // Side by side, one is always shown: the one asked for, else the latest in the span.
  const picked = open ?? (split ? inSpan[0] ?? null : null);

  if (!recent.length && !inSpan.length) {
    return (
      <Card>
        <EmptyState title={t('workouts.empty.title')} detail={t('workouts.empty.detail')} />
      </Card>
    );
  }

  const latest = recent[0] ?? null;
  const detail = (dw: DatedWorkout) => <WorkoutDetail dw={dw} days={source} intraday={intraday} wide={wide} />;

  // Narrower screens show an open workout on a page of its own.
  if (!split && open) {
    return (
      <div className="space-y-3">
        <button type="button" onClick={() => (window.history.state?.workout ? window.history.back() : onOpen(null, false))} className="flex min-h-11 items-center gap-1 px-1 text-body-sm font-medium" style={{ color: WORKOUT }}>
          <ChevronLeft size={16} strokeWidth={2.4} aria-hidden="true" />
          {t('workouts.detail.back')}
        </button>
        {detail(open)}
      </div>
    );
  }

  const latestDay = latest ? days.find((d) => d.date === latest.date) ?? null : null;

  return (
    <div className="space-y-3">
      {level && <LevelCard level={level} hero={wide} />}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {load && <LoadCard load={load} battery={battery} wide={wide} />}
        {latest && (
          <LatestWorkoutCard
            dw={latest}
            heart={workoutHeart(latest.workout, latest.date, intraday, latestDay?.hrZones ?? null)}
            zones={latestDay?.hrZones ?? null}
            restingPerMinute={restingKcalPerMinute(days, latest.date)}
            today={today}
            onOpen={() => onOpen(latest.id, true)}
            wide={wide}
          />
        )}
      </div>

      <div className="flex items-center justify-between px-1 pt-1">
        <h2 className="text-section uppercase text-page-ink">{t('workouts.overTime.title')}</h2>
        <SpanSelector state={spanState} />
      </div>

      <LevelShiftCard days={source} from={spanFrom ?? days[0].date} span={spanState.span} wide={wide} />
      {inSpan.length > 0 && <WhatYouDoCard workouts={inSpan} wide={wide} />}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-stretch">
        <WorkoutList workouts={inSpan} span={spanState.span} picked={picked?.id ?? null} onPick={(id) => onOpen(id, !split)} wide={split} />
        {split && picked && detail(picked)}
      </div>

      <InsightsCarousel observations={insights} page="workouts" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the level's history

/** The level's five bands, Wildfire at the top, each an equal height on the chart. */
const BAND = 40;

/** Where zone minutes a week sit on the banded scale, from the top. */
function bandY(v: number): number {
  const starts = Object.values(levelStarts());
  const i = levelIndex(v);
  const from = starts[i];
  const to = starts[i + 1] ?? starts[i] * 2;
  const within = Math.min(1, Math.max(0, (v - from) / (to - from)));
  return (LEVELS.length - i - within) * BAND;
}

/**
 * How the level has moved, on the Workout level trend: a bar for each week (or the average week of each month, over a year
 * or more), coloured by the step it reached, under the line of the 4-week average that sets the
 * level. The scale gives each step the same height, so a move between steps shows wherever it is.
 */
function LevelShiftCard({ days, from, span, wide }: { days: DailyRecord[]; from: CivilDate; span: SpanId; wide: boolean }) {
  const by = span === '365' || span === 'all' ? 'month' : 'week';
  const periods = useMemo(() => levelHistory(days, from, by), [days, from, by]);
  const [hover, setHover] = useState<number | null>(null);
  if (!periods.length) return null;
  const H = LEVELS.length * BAND;
  const n = periods.length;
  const lined = periods.map((p, i) => ({ p, i })).filter((x): x is { p: LevelPeriod & { line: number }; i: number } => x.p.line !== null);
  const at = ({ p, i }: (typeof lined)[number]) => `${(((i + 0.5) / n) * 1000).toFixed(1)} ${bandY(p.line).toFixed(1)}`;
  // The settled weeks as a solid line; the week under way dashed, since today's level can still move either way by its end.
  const settled = lined.filter((x) => !x.p.partial);
  const path = settled.map((x, k) => `${k ? 'L' : 'M'}${at(x)}`).join(' ');
  const moving = lined.at(-1)?.p.partial && settled.length ? `M${at(settled.at(-1)!)} L${at(lined.at(-1)!)}` : null;
  const first = lined[0]?.p.line ?? null;
  const last = lined.at(-1)?.p.line ?? null;
  const moved = first === null || last === null ? 0 : levelIndex(last) - levelIndex(first);
  const every = Math.ceil(n / (wide ? 12 : 6));
  const label = (p: LevelPeriod) => (by === 'month' ? bucketLabel(p.date, 'month') : formatCivil(p.date));
  return (
    <Card className="px-[18px] pt-4 pb-[18px] md:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className="card-title-detail text-zinc-50">{t('workouts.shift.title')}</h3>
          <div className="mt-0.5 text-detail text-zinc-500">{t(by === 'month' ? 'workouts.shift.byMonth' : 'workouts.shift.byWeek')}</div>
        </div>
        {hover !== null ? (
          // The period under the pointer: the level its 4-week average reached, and its own zone minutes.
          <div className="text-right">
            <div className="font-display text-number-xs text-zinc-50">{periods[hover].line === null ? '—' : levelName(LEVELS[levelIndex(periods[hover].line!)])}</div>
            <div className="text-caption text-zinc-500">
              {t('workouts.shift.readout', {
                by,
                date: by === 'month' ? formatMonthYear(periods[hover].date) : formatCivil(periods[hover].date),
                minutes: formatInteger(periods[hover].bar),
                partial: periods[hover].partial ? 'yes' : 'no',
              })}
            </div>
          </div>
        ) : last !== null && (
          <div className="text-right">
            <div className="font-display text-number-xs text-zinc-50">{levelName(LEVELS[levelIndex(last)])}</div>
            <div className="text-caption text-zinc-500">
              {first !== null &&
                t('workouts.shift.from', { moved: moved > 0 ? 'up' : moved < 0 ? 'down' : 'same', level: levelName(LEVELS[levelIndex(first)]), date: by === 'month' ? formatMonthYear(lined[0].p.date) : formatCivil(lined[0].p.date) })}
            </div>
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-2.5">
        <div className="flex w-[70px] shrink-0 flex-col" aria-hidden="true">
          {[...LEVELS].reverse().map((id) => (
            <div key={id} className="flex items-center gap-1.5 text-caption text-zinc-400" style={{ height: BAND }}>
              <i className="size-[7px] shrink-0 rounded-full" style={{ background: LEVEL_COLOUR[id] }} />
              <span className="truncate">{levelName(id)}</span>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative cursor-crosshair touch-pan-y"
            style={{ height: H }}
            onPointerMove={(e) => setHover(periodAt(e, n))}
            onPointerDown={(e) => setHover(periodAt(e, n))}
            onPointerLeave={() => setHover(null)}
            onPointerUp={(e) => e.pointerType !== 'mouse' && setHover(null)}
            role="img"
            aria-label={t('workouts.shift.label', {
              periods: periods
                .map((p) => t('workouts.shift.period', { date: label(p), minutes: Math.round(p.bar), level: p.line === null ? 'none' : levelName(LEVELS[levelIndex(p.line)]) }))
                .join(t('workouts.shift.separator')),
            })}
          >
            <div className="absolute inset-0 flex flex-col" aria-hidden="true">
              {LEVELS.map((id) => <div key={id} className="border-t border-rule" style={{ height: BAND }} />)}
            </div>
            {hover !== null && (
              <div className="absolute inset-y-0 rounded-md bg-panel-raised" style={{ left: `${(hover / n) * 100}%`, width: `${100 / n}%` }} aria-hidden="true" />
            )}
            <div className="absolute inset-0 flex items-end" aria-hidden="true">
              {periods.map((p) => (
                <div key={p.date} className="flex h-full flex-1 items-end justify-center">
                  {/* The week (or month) under way gets no bar until it's over: only the dashed line to today. */}
                  {!p.partial && (
                    <div
                      className="rounded-t-[5px] rounded-b-[1px]"
                      style={{ width: '58%', height: Math.max(2, H - bandY(p.bar)), background: LEVEL_COLOUR[LEVELS[levelIndex(p.bar)]], opacity: 0.45 }}
                    />
                  )}
                </div>
              ))}
            </div>
            <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <path d={path} fill="none" stroke="var(--color-zinc-200)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              {moving && <path d={moving} fill="none" stroke="var(--color-zinc-200)" strokeWidth={2} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
            </svg>
            {lined.map(({ p, i }, k) => {
              const size = k === lined.length - 1 ? 14 : 9;
              return (
                <span
                  key={p.date}
                  className="absolute rounded-full ring-2 ring-zinc-950"
                  style={{ left: `${((i + 0.5) / n) * 100}%`, top: bandY(p.line), width: size, height: size, margin: `${-size / 2}px 0 0 ${-size / 2}px`, background: LEVEL_COLOUR[LEVELS[levelIndex(p.line)]] }}
                  aria-hidden="true"
                />
              );
            })}
          </div>
          {/* A tick under every bar, a longer one with a date every few, counted back from now, which is bright. */}
          <Ruler
            marks={periods.map((_, i) => ((i + 0.5) / n) * 100)}
            labels={periods.flatMap((p, i) => ((n - 1 - i) % every === 0 ? [{ at: ((i + 0.5) / n) * 100, text: label(p), strong: i === n - 1 }] : []))}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 md:ml-20">
        <span className="flex items-center gap-1.5 text-caption text-zinc-300">
          <i className="size-2.5 rounded-sm" style={{ background: LEVEL_COLOUR.blaze, opacity: 0.45 }} />
          {t(by === 'month' ? 'workouts.shift.barMonth' : 'workouts.shift.barWeek')}
        </span>
        <span className="flex items-center gap-1.5 text-caption text-zinc-300">
          <i className="h-0.5 w-4 rounded-[1px] bg-zinc-200" />
          {t('workouts.shift.line')}
        </span>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────── what you do

/**
 * Where the span's zone minutes came from, kind by kind, biggest share first. Each kind is a tab:
 * the chart beside the list shows how it's going, a dot a session.
 */
function WhatYouDoCard({ workouts, wide }: { workouts: DatedWorkout[]; wide: boolean }) {
  // The span's main kinds: the few behind most of its zone minutes, four at most.
  const kinds = useMemo(() => mainKinds(workouts), [workouts]);
  const [pick, setPick] = useState<string | null>(null);
  const keyOf = (k: { kind: WorkoutKind; type: string | null }) => `${k.kind}|${k.type ?? ''}`;
  const shown = kinds.find((k) => keyOf(k) === pick) ?? kinds[0];
  const total = useMemo(() => kindsIn(workouts).reduce((a, k) => a + k.zoneMinutes, 0), [workouts]);
  const progress = useMemo(() => (shown ? progressOf(shown.sessions) : null), [shown]);
  if (!shown) return null;
  return (
    <Card className="px-[18px] pt-4 pb-[18px] md:px-5">
      <h3 className="card-title-detail text-zinc-50">{t('workouts.kindsCard.title')}</h3>
      <div className="mt-0.5 text-detail text-zinc-500">{t('workouts.kindsCard.hint')}</div>
      <div className="mt-4 flex flex-wrap gap-7">
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1" role="tablist" aria-label={t('workouts.kindsCard.tabs')}>
          {kinds.map((k) => {
            const on = keyOf(k) === keyOf(shown);
            const share = total ? (k.zoneMinutes / total) * 100 : 0;
            return (
              <button
                key={keyOf(k)}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setPick(keyOf(k))}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${on ? '' : 'border-transparent hover:bg-panel'}`}
                style={on ? { background: `color-mix(in srgb, ${WORKOUT} 7%, transparent)`, borderColor: `color-mix(in srgb, ${WORKOUT} 28%, transparent)` } : undefined}
              >
                <WorkoutIcon kind={k.kind} />
                <span className="block min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body-sm font-medium text-zinc-100">{kindName(k.kind, k.type)}</span>
                    <span className="font-display text-body tabular-nums text-zinc-50">{t('workouts.kindsCard.share', { percent: Math.round(share) })}</span>
                  </span>
                  <span className="mt-1.5 mb-1 block h-[5px] overflow-hidden rounded-[3px] bg-faint">
                    <span className="block h-full rounded-[3px]" style={{ width: `${share}%`, background: kindColour(k.kind) }} />
                  </span>
                  <span className="block text-caption text-zinc-500">
                    {t('workouts.kindsCard.detail', { count: k.sessions.length, time: workoutTime(k.minutes) })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {progress && (
          <div className="min-w-0 flex-[1.7_1_440px]">
            <ProgressChart progress={progress} kind={kindName(shown.kind, shown.type)} wide={wide} />
          </div>
        )}
      </div>
    </Card>
  );
}

/** A progress figure's value and unit. */
function progressValue(p: Progress, v: number): { value: string; unit: string } {
  switch (p.measure) {
    case 'pace':
      return { value: formatPace(v), unit: t('workouts.units.perKm') };
    case 'swimPace':
      return { value: formatPace(v), unit: t('workouts.units.per100m') };
    case 'speed':
      return { value: fmtNum(v, 1), unit: t('workouts.units.kmh') };
    default:
      return { value: formatInteger(v), unit: t('workouts.units.zoneMin') };
  }
}

/**
 * How a kind of workout is going, a dot a session and a dashed line through them. A pace is
 * drawn faster upward, so up is better on every one of these charts.
 */
function ProgressChart({ progress, kind, wide }: { progress: Progress; kind: string; wide: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const { points, trend } = progress;
  const vals = points.map((p) => p.value);
  const lower = progress.measure === 'pace' || progress.measure === 'swimPace';
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, lower ? 10 : 2);
  lo -= pad;
  hi += pad;
  if (!lower) lo = Math.max(0, lo);
  const yOf = (v: number) => (lower ? (v - lo) / (hi - lo) : (hi - v) / (hi - lo)) * 100;
  const first = points[0].date;
  const last = points.at(-1)!.date;
  const spanDays = Math.max(1, (Date.parse(last) - Date.parse(first)) / 86_400_000);
  const xOf = (date: CivilDate) => (points.length === 1 ? 50 : ((Date.parse(date) - Date.parse(first)) / 86_400_000 / spanDays) * 100);
  const ticks = [lo + (hi - lo) * 0.2, (lo + hi) / 2, lo + (hi - lo) * 0.8];
  const latest = progressValue(progress, vals.at(-1)!);
  const title = { pace: 'workouts.progress.pace', swimPace: 'workouts.progress.swimPace', speed: 'workouts.progress.speed', zoneMinutes: 'workouts.progress.zoneMinutes' } as const;
  const mid = points[Math.floor(points.length / 2)].date;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-eyebrow uppercase text-zinc-400">{t(title[progress.measure])}</div>
          <div className="mt-0.5 text-detail text-zinc-500">
            {progress.band ? t('workouts.progress.band', { kind, from: progress.band[0], to: progress.band[1] }) : t('workouts.progress.each', { kind })}
          </div>
        </div>
        {(() => {
          // The session under the pointer, else the latest.
          const p = hover === null ? null : points[hover];
          const shown = p ? progressValue(progress, p.value) : latest;
          return (
            <div className="text-right">
              <div className="whitespace-nowrap font-display text-number-xs text-zinc-50">
                {shown.value}
                <span className="font-sans text-caption font-normal text-zinc-400"> {shown.unit}</span>
              </div>
              <div className="whitespace-nowrap text-caption text-zinc-500">
                {p
                  ? p.avgHr === null
                    ? formatCivilLong(p.date)
                    : t('workouts.progress.session', { date: formatCivilLong(p.date), bpm: p.avgHr })
                  : t('workouts.progress.latest')}
              </div>
            </div>
          );
        })()}
      </div>
      <div className="relative mt-3.5 pr-11" style={{ height: wide ? 200 : 170 }}>
        <div
          className="absolute inset-y-0 left-0 right-11 cursor-crosshair touch-pan-y"
          onPointerMove={(e) => setHover(nearestPoint(e, points.map((p) => xOf(p.date))))}
          onPointerDown={(e) => setHover(nearestPoint(e, points.map((p) => xOf(p.date))))}
          onPointerLeave={() => setHover(null)}
          onPointerUp={(e) => e.pointerType !== 'mouse' && setHover(null)}
        >
          {hover !== null && (
            <div className="pointer-events-none absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${xOf(points[hover].date)}%` }} aria-hidden="true" />
          )}
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 border-t border-rule" style={{ top: `${yOf(v)}%` }} />
          ))}
          {trend && (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
              <path d={`M0 ${yOf(trend[0])} L100 ${yOf(trend[1])}`} stroke={WORKOUT} strokeWidth={2} strokeDasharray="5 4" fill="none" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {points.map((p, i) => (
            <span
              key={i}
              className={`pointer-events-none absolute rounded-full ${i === hover ? '-ml-[6px] -mt-[6px] size-3 ring-2 ring-zinc-950' : '-ml-[4.5px] -mt-[4.5px] size-[9px]'}`}
              style={{ left: `${xOf(p.date)}%`, top: `${yOf(p.value)}%`, background: WORKOUT, opacity: i === hover ? 1 : 0.85 }}
              aria-hidden="true"
            />
          ))}
        </div>
        {ticks.map((v) => (
          <span key={v} className="absolute right-0 -translate-y-1/2 text-caption text-zinc-500" style={{ top: `${yOf(v)}%` }}>
            {progressValue(progress, v).value}
          </span>
        ))}
      </div>
      {/* A tick under every session, and the first, middle and last dated. */}
      <div className="pr-11">
        <Ruler
          marks={points.map((p) => xOf(p.date))}
          labels={
            points.length === 1
              ? [{ at: 50, text: formatCivil(first) }]
              : [
                  { at: 0, text: formatCivil(first), align: 'start' as const },
                  ...(points.length > 2 ? [{ at: xOf(mid), text: formatCivil(mid) }] : []),
                  { at: 100, text: formatCivil(last), align: 'end' as const },
                ]
          }
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the list

/**
 * The span's workouts, newest first: a name, its big figure, when, how long, its zone minutes,
 * and the zones as a thin bar. On wide screens it's as tall as the workout beside it and scrolls
 * inside; on a phone it shows five and a half, so the next one peeks in.
 */
function WorkoutList({ workouts, span, picked, onPick, wide }: {
  workouts: DatedWorkout[];
  span: SpanId;
  picked: string | null;
  onPick: (id: string) => void;
  wide: boolean;
}) {
  return (
    <Card className="flex min-w-0 flex-col px-3 pt-4 pb-3">
      <div className="flex items-baseline justify-between gap-2 px-2 pb-2">
        <h3 className="card-title-detail text-zinc-50">{t('workouts.list.title')}</h3>
        <span className="text-detail text-zinc-500">{t('workouts.list.count', { count: workouts.length, span: span === 'all' ? 'all' : span === '365' ? 'year' : 'days', days: Number(span) || 0 })}</span>
      </div>
      {workouts.length ? (
        <div className={`relative ${wide ? 'min-h-[360px] flex-1' : 'h-[372px]'}`}>
          <div className={`absolute inset-0 overflow-y-auto ${wide ? '' : '[mask-image:linear-gradient(to_bottom,black_88%,transparent)]'}`}>
            {workouts.map((dw) => {
              const w = dw.workout;
              const on = dw.id === picked;
              const big = bigFigure(w);
              const z = w.zones;
              const total = z ? ZONE_KEYS.reduce((a, k) => a + z[k], 0) : 0;
              return (
                <button
                  key={dw.id}
                  type="button"
                  aria-pressed={wide ? on : undefined}
                  onClick={() => onPick(dw.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-[11px] text-left transition-colors ${on ? '' : 'border-transparent hover:bg-panel'}`}
                  style={on ? { background: `color-mix(in srgb, ${WORKOUT} 7%, transparent)`, borderColor: `color-mix(in srgb, ${WORKOUT} 28%, transparent)` } : undefined}
                >
                  <WorkoutIcon kind={kindOf(w)} />
                  <span className="block min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body-sm font-medium text-zinc-100">{workoutName(w)}</span>
                      <span className="whitespace-nowrap text-body-sm text-zinc-200 tabular-nums">
                        {big.value}
                        {big.unit && <span className="text-caption text-zinc-500"> {big.unit}</span>}
                      </span>
                    </span>
                    <span className="mt-px flex justify-between gap-2 text-caption text-zinc-500">
                      <span className="truncate">{formatCivilLong(dw.date)}</span>
                      <span className="whitespace-nowrap">{t('workouts.list.row', { time: workoutTime(w.activeMin), minutes: formatInteger(zoneMinutesOf(w)) })}</span>
                    </span>
                    {total > 0 && (
                      <span className="mt-[7px] flex h-1 gap-px overflow-hidden rounded-sm" aria-hidden="true">
                        {ZONE_KEYS.map((k, i) => <i key={k} style={{ width: `${(z![k] / total) * 100}%`, background: ZONE_COLOURS[i] }} />)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="px-2 pb-2 text-body-sm text-zinc-500">{t('workouts.list.none')}</p>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────── one workout

/**
 * One workout: its heart rate first, with the 5 minutes after it, then every figure it has, the
 * minutes in each zone with the day's bpm for each, and its kilometre splits.
 */
function WorkoutDetail({ dw, days, intraday, wide }: { dw: DatedWorkout; days: DailyRecord[]; intraday?: IntradayDays; wide: boolean }) {
  const w = dw.workout;
  const day = days.find((d) => d.date === dw.date) ?? null;
  const zones = day?.hrZones ?? null;
  const heart = workoutHeart(w, dw.date, intraday, zones);
  const figures = allFigures(w, heart, restingKcalPerMinute(days, dw.date));
  const [scrub, setScrub] = useState<HeartScrub | null>(null);
  const z = w.zones;
  const zoneMax = z ? Math.max(1, ...ZONE_KEYS.map((k) => z[k])) : 1;
  return (
    <Card className="min-w-0 px-[18px] pt-4 pb-5 md:px-5">
      <div className="flex items-start gap-3">
        <WorkoutIcon kind={kindOf(w)} />
        <div className="min-w-0">
          <h3 className="card-title-detail text-zinc-50">{workoutName(w)}</h3>
          <div className="text-detail text-zinc-500">{spanLabel(dw)}</div>
        </div>
      </div>

      {heart && (
        <div className="mt-3.5">
          <div className="flex h-[18px] items-center justify-between gap-3">
            <span className="text-eyebrow uppercase text-zinc-400">{t('workouts.heart.title')}</span>
            <ScrubReadout scrub={scrub} startMin={w.startMin} zones={zones} />
          </div>
          <div className="mt-6">
            <HeartChart heart={heart} zones={zones} height={wide ? 230 : 180} marks ticks startMin={w.startMin} onScrub={setScrub} label={heartLabel(heart)} />
          </div>
          <div className="mt-2.5">
            <HeartKey />
          </div>
        </div>
      )}

      <div className={`mt-4 grid gap-2 ${wide ? 'grid-cols-4' : 'grid-cols-2'}`}>
        {figures.map((f) => <FigureBox key={f.label} {...f} />)}
      </div>

      {z && (
        <div className="mt-[18px]">
          <div className="text-eyebrow uppercase text-zinc-400">{t('workouts.zones.title')}</div>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {ZONE_KEYS.map((k, i) => {
              const range = zoneRange(i, zones);
              return (
                <div key={k}>
                  <div className="flex justify-between text-detail">
                    <span className="text-zinc-200">
                      {t(ZONE_NAMES[i])}
                      {range && <span className="text-zinc-500"> {range}</span>}
                    </span>
                    <span className="font-medium text-zinc-100">{t('workouts.units.minutes', { minutes: z[k] })}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-[3px] bg-faint">
                    <div className="h-full rounded-[3px]" style={{ width: `${(z[k] / zoneMax) * 100}%`, background: ZONE_COLOURS[i] }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {w.splits.length > 0 && (
        <div className="mt-[18px]">
          <div className="text-eyebrow uppercase text-zinc-400">{t('workouts.splits.title')}</div>
          <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1.5">
            {w.splits.map((s, i) => (
              <div key={i} className="rounded-[10px] border border-card-edge bg-panel px-2 pt-2 pb-[9px]">
                <div className="text-caption text-zinc-500">{t('workouts.splits.km', { n: i + 1 })}</div>
                <div className="text-body-sm font-medium text-zinc-100 tabular-nums">{formatPace(s.seconds / s.distanceKm)}</div>
                {s.avgHr !== null && <div className="text-caption text-zinc-500">{t('workouts.splits.bpm', { bpm: s.avgHr })}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/** Which of `n` equal columns the pointer is over. */
function periodAt(e: React.PointerEvent<HTMLElement>, n: number): number {
  const box = e.currentTarget.getBoundingClientRect();
  return Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * n)));
}

/** The point nearest the pointer, by its position across in percent. */
function nearestPoint(e: React.PointerEvent<HTMLElement>, xs: number[]): number {
  const box = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * 100;
  return xs.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(xs[best] - x) ? i : best), 0);
}

/** Today's latest workout and the level, for the Overview tab: the same cards, a little smaller. */
export function useWorkoutsOverview(data: SyncResult, intraday?: IntradayDays) {
  const days = data.days;
  return useMemo(() => {
    const latest = workoutsIn(days)[0] ?? null;
    const day = latest ? days.find((d) => d.date === latest.date) ?? null : null;
    return {
      latest,
      zones: day?.hrZones ?? null,
      heart: latest ? workoutHeart(latest.workout, latest.date, intraday, day?.hrZones ?? null) : null,
      restingPerMinute: latest ? restingKcalPerMinute(days, latest.date) : null,
      level: latest ? workoutLevel(days) : null,
    };
  }, [days, intraday]);
}
