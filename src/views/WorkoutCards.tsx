import React, { useId, useState } from 'react';
import {
  Activity, Bike, ChartNoAxesColumnIncreasing, ChevronRight, Dumbbell, Feather, Flower2, Footprints, Gauge, Hand,
  HeartPulse, Infinity as Loop, Kayak, Leaf, Mountain, MountainSnow, Music, PersonStanding, Sailboat, Ship, Snowflake,
  Volleyball, Waves, Wind, Zap, type LucideIcon,
} from 'lucide-react';
import { addDays, type CivilDate } from '../lib/date';
import { hasMessage, t } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivilLong, formatClock, formatHours, formatInteger } from '../i18n/format';
import { ZONE_NAMES, zoneOf, zoneStarts, zoneStops } from '../charts/heartRate';
import { batteryTier } from '../pipeline/derive';
import {
  COOL_DOWN_MIN, KINDS, LEVELS, calorieBurn, familyOf, goesADistance, hardMinutesOf, kindOf, levelStarts, loadAdvice,
  paceOf, zoneMinutesOf, type DatedWorkout, type LevelId, type WorkoutHeart, type WorkoutKind, type WorkoutLevel,
  type WorkoutLoad,
} from '../pipeline/workouts';
import type { HeartRateZones, Workout } from '../types/health';
import { Card, EFFORT, fmtNum, tint } from '../ui/primitives';

/**
 * The workout cards the Activity page's two tabs share: the workout level, the workout load, the
 * latest workout, and the heart rate chart every workout has.
 */

/** The page's workout colour: what's picked, a workout card's glow. */
export const WORKOUT = 'var(--workout)';

export const LEVEL_COLOUR: Record<LevelId, string> = {
  embers: 'var(--level-embers)',
  spark: 'var(--level-spark)',
  flame: 'var(--level-flame)',
  blaze: 'var(--level-blaze)',
  wildfire: 'var(--level-wildfire)',
};

const ZONE_COLOURS = [EFFORT.light, EFFORT.moderate, EFFORT.vigorous, EFFORT.peak] as const;
const ZONE_KEYS = ['light', 'moderate', 'vigorous', 'peak'] as const;

export const levelName = (id: LevelId) => t(`workouts.level.names.${id}`);

// ─────────────────────────────────────────────────────────────── words

/** One icon a kind, none shared. */
const ICONS: Record<WorkoutKind, LucideIcon> = {
  run: Footprints,
  walk: PersonStanding,
  hike: Mountain,
  ride: Bike,
  indoorRide: Gauge,
  row: Ship,
  paddle: Kayak,
  skate: Wind,
  swim: Waves,
  waterSport: Sailboat,
  winter: Snowflake,
  strength: Dumbbell,
  climbing: MountainSnow,
  hiit: Zap,
  cardio: HeartPulse,
  elliptical: Loop,
  stairs: ChartNoAxesColumnIncreasing,
  dance: Music,
  martialArts: Hand,
  sport: Volleyball,
  yoga: Flower2,
  pilates: Feather,
  mobility: Leaf,
  other: Activity,
};

/**
 * A Google exercise type's name: the language file's (workouts.types), else Google's own for a
 * type added since, else just "Workout".
 */
export function typeName(type: string, displayName: string | null = null): string {
  const key = `workouts.types.${type}`;
  return hasMessage(key) ? t(key) : displayName ?? t('workouts.types.OTHER');
}

/** A workout's name: its own type's, so a trail run is a "Trail run". */
export const workoutName = (w: Pick<Workout, 'type' | 'displayName'>) => typeName(w.type, w.displayName);

/** The name of a kind as `kindsIn` groups it: the kind's, or the type's for a kind that gathers several sports. */
export const kindName = (kind: WorkoutKind, type: string | null) => (type ? typeName(type) : t(`workouts.kinds.${kind}`));

/**
 * Each kind's colour: the level's five colours in turn, down the list of kinds and round again,
 * starting from the Blaze lime with the run, so neighbouring kinds rarely share one.
 */
export function kindColour(kind: WorkoutKind): string {
  const i = (Object.keys(KINDS) as WorkoutKind[]).indexOf(kind);
  return LEVEL_COLOUR[LEVELS[(i + LEVELS.indexOf('blaze')) % LEVELS.length]];
}

/** The kind's icon in a small square tinted in its colour; the icon a touch toward the text, so the darkest colour still reads. */
export function WorkoutIcon({ kind, size = 32 }: { kind: WorkoutKind; size?: number }) {
  const Icon = ICONS[kind];
  const colour = kindColour(kind);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[10px]"
      style={{ width: size, height: size, background: tint(colour, 16), color: `color-mix(in srgb, ${colour} 75%, var(--color-zinc-50))` }}
      aria-hidden="true"
    >
      <Icon size={Math.round(size / 2)} strokeWidth={2} />
    </span>
  );
}

/** Minutes as a workout's time: "45 min", or "4h 30m" from an hour. */
export const workoutTime = (mins: number) => (mins < 60 ? t('workouts.units.minutes', { minutes: Math.round(mins) }) : formatHours(mins));

/** Seconds a kilometre (or a hundred metres) as a pace: "6:47". */
export function formatPace(seconds: number): string {
  const s = Math.round(seconds);
  return t('workouts.units.paceValue', { minutes: Math.floor(s / 60), seconds: String(s % 60).padStart(2, '0') });
}

/** A pace or speed with its unit, as a figure's value and unit. */
export function paceFigure(measure: 'pace' | 'speed' | 'swimPace', value: number): { value: string; unit: string } {
  if (measure === 'speed') return { value: fmtNum(value, 1), unit: t('workouts.units.kmh') };
  return { value: formatPace(value), unit: t(measure === 'pace' ? 'workouts.units.perKm' : 'workouts.units.per100m') };
}

/** When a workout started, for a card's corner: "Yesterday, 18:15" or "Sun 11 Oct, 18:15". */
export function startedLabel(dw: DatedWorkout, today: CivilDate | null): string {
  const time = formatClock(dw.workout.startMin);
  if (dw.date === today) return t('workouts.when.today', { time });
  if (today && dw.date === addDays(today, -1)) return t('workouts.when.yesterday', { time });
  return t('workouts.when.day', { date: formatCivilLong(dw.date), time });
}

/** A workout's day and times: "Sun 11 Oct · 18:15–19:00". */
export const spanLabel = (dw: DatedWorkout) =>
  t('workouts.when.span', {
    date: formatCivilLong(dw.date),
    start: formatClock(dw.workout.startMin),
    end: formatClock((dw.workout.startMin + dw.workout.elapsedMin) % 1440),
  });

/** A workout's big figure: its distance when it goes one, else its time. */
export function bigFigure(w: Workout): { value: string; unit?: string } {
  if (goesADistance(w)) return { value: fmtNum(w.distanceKm, 2), unit: t('units.km') };
  return { value: workoutTime(w.activeMin) };
}

// ─────────────────────────────────────────────────────────────── figures

export interface Figure {
  label: string;
  value: string;
  unit?: string;
}

const bpm = (v: number | null | undefined): Pick<Figure, 'value' | 'unit'> =>
  v === null || v === undefined ? { value: '—' } : { value: formatInteger(v), unit: t('units.bpm') };

/** Every figure a workout has, in the detail's order: time and distance first, heart rate, then the rest. */
export function allFigures(w: Workout, heart: WorkoutHeart | null, restingPerMinute: number | null): Figure[] {
  const out: Figure[] = [{ label: t('workouts.figures.time'), value: workoutTime(w.activeMin) }];
  if (w.distanceKm !== null) out.push({ label: t('workouts.figures.distance'), value: fmtNum(w.distanceKm, 2), unit: t('units.km') });
  const pace = paceOf(w);
  if (pace) out.push({ label: t(pace.measure === 'speed' ? 'workouts.figures.speed' : 'workouts.figures.pace'), ...paceFigure(pace.measure, pace.value) });
  const burn = calorieBurn(w, restingPerMinute);
  if (burn !== null) out.push({ label: t('workouts.figures.burn'), value: formatInteger(burn), unit: t('units.kcal') });
  if (w.avgHr !== null) out.push({ label: t('workouts.figures.avgHr'), ...bpm(w.avgHr) });
  if (heart) {
    out.push({ label: t('workouts.figures.lowHr'), ...bpm(heart.low.bpm) }, { label: t('workouts.figures.peakHr'), ...bpm(heart.peak.bpm) });
    if (heart.recovery !== null) out.push({ label: t('workouts.figures.recovery'), ...bpm(heart.recovery) });
  }
  out.push({ label: t('workouts.figures.zoneMinutes'), value: formatInteger(zoneMinutesOf(w)) });
  if (w.climbM !== null) out.push({ label: t('workouts.figures.climb'), value: formatInteger(w.climbM), unit: t('workouts.units.metres') });
  if (w.cadence !== null) out.push({ label: t('workouts.figures.cadence'), value: formatInteger(w.cadence), unit: t('workouts.units.spm') });
  else if (w.steps !== null) out.push({ label: t('workouts.figures.steps'), value: formatInteger(w.steps) });
  if (w.swimLengths !== null) out.push({ label: t('workouts.figures.lengths'), value: formatInteger(w.swimLengths) });
  return out;
}

/**
 * The latest workout's four figures, by its family: time, pace or speed and heart rate for one
 * that goes a distance; for weights the burn, heart rate and recovery; for intervals, classes and
 * sports the hard minutes; for yoga and the like, how low heart rate went.
 */
export function latestFigures(w: Workout, heart: WorkoutHeart | null, restingPerMinute: number | null): Figure[] {
  const time = { label: t('workouts.figures.time'), value: workoutTime(w.activeMin) };
  const avg = { label: t('workouts.figures.avgHr'), ...bpm(w.avgHr) };
  const peak = { label: t('workouts.figures.peakHr'), ...bpm(heart?.peak.bpm) };
  const burnValue = calorieBurn(w, restingPerMinute);
  const burn = { label: t('workouts.figures.burn'), ...(burnValue === null ? { value: '—' } : { value: formatInteger(burnValue), unit: t('units.kcal') }) };
  const pace = paceOf(w);
  switch (familyOf(w)) {
    case 'foot':
    case 'speed':
    case 'water':
      if (pace) return [time, { label: t(pace.measure === 'speed' ? 'workouts.figures.speed' : 'workouts.figures.pace'), ...paceFigure(pace.measure, pace.value) }, avg, peak];
      return [time, burn, avg, peak];
    case 'strength':
      return [burn, avg, peak, { label: t('workouts.figures.recovery'), ...bpm(heart?.recovery) }];
    case 'cardio': {
      const hard = hardMinutesOf(w);
      return [{ label: t('workouts.figures.hard'), value: hard === null ? '—' : formatInteger(hard), unit: hard === null ? undefined : t('units.minutes') }, avg, peak, burn];
    }
    default:
      return [time, avg, { label: t('workouts.figures.lowHr'), ...bpm(heart?.low.bpm) }, burn];
  }
}

/** A figure in a tinted box: a grey label, the value in the display face, a grey unit. */
export function FigureBox({ label, value, unit }: Figure) {
  return (
    <div className="min-w-0 rounded-xl border border-card-edge bg-panel px-3 py-2">
      <div className="truncate text-eyebrow-sm uppercase text-zinc-400">{label}</div>
      <div className="mt-0.5 whitespace-nowrap font-display text-number-xs leading-tight text-zinc-50 tabular-nums">
        {value}
        {unit && <span className="font-sans text-caption font-normal text-zinc-400"> {unit}</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── zones

/** The zones a workout reached, as a bar in their colours and a key: a dot, the name, the minutes. */
export function ZoneBar({ w }: { w: Workout }) {
  if (!w.zones) return null;
  const z = w.zones;
  const total = ZONE_KEYS.reduce((a, k) => a + z[k], 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded" aria-hidden="true">
        {ZONE_KEYS.map((k, i) => (z[k] > 0 ? <div key={k} style={{ width: `${(z[k] / total) * 100}%`, background: ZONE_COLOURS[i] }} /> : null))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
        {ZONE_KEYS.map((k, i) =>
          z[k] > 0 ? (
            <span key={k} className="flex items-center gap-1.5 whitespace-nowrap text-caption text-zinc-400">
              <i className="size-[7px] shrink-0 rounded-full" style={{ background: ZONE_COLOURS[i] }} />
              {t(ZONE_NAMES[i])}
              <span className="font-medium text-zinc-100">{t('workouts.units.minutes', { minutes: z[k] })}</span>
            </span>
          ) : null,
        )}
        <span className="ml-auto whitespace-nowrap text-caption text-zinc-400">{t('workouts.zones.total', { minutes: formatInteger(zoneMinutesOf(w)) })}</span>
      </div>
    </div>
  );
}

/** The key under a heart rate chart: each zone's dot and name, then the cool-down's shading. */
export function HeartKey({ coolDown = true }: { coolDown?: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {ZONE_NAMES.map((name, i) => (
        <span key={name} className="flex items-center gap-1.5 whitespace-nowrap text-caption text-zinc-400">
          <i className="size-[7px] shrink-0 rounded-full" style={{ background: ZONE_COLOURS[i] }} />
          {t(name)}
        </span>
      ))}
      {coolDown && (
        <span className="flex items-center gap-1.5 whitespace-nowrap text-caption text-zinc-400">
          <i className="h-2.5 w-3 shrink-0 rounded-r-sm border-l border-dashed border-zinc-500 bg-panel-raised" />
          {t('workouts.heart.coolDown')}
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── heart rate

/** Every workout's heart rate chart shares one scale, unless a workout goes past it. */
const SCALE: [number, number] = [60, 180];

/** Where the pointer is on a heart rate chart, for the readout beside it. */
export interface HeartScrub {
  at: number;
  bpm: number;
}

/**
 * A workout's heart rate: the line in each zone's colour, the area under it tinted the same way,
 * faint dashes where the zones change, and the 5 minutes after the end shaded, behind a dashed
 * line where it stopped. `marks` puts dots on the lowest and highest points; `scrub` follows the
 * pointer, and reports where it is.
 */
export function HeartChart({ heart, zones, height, marks = false, ticks = false, startMin, onScrub, label }: {
  heart: WorkoutHeart;
  zones: HeartRateZones | null;
  height: number;
  marks?: boolean;
  /** Times under it: the start, the middle and the end. */
  ticks?: boolean;
  startMin: number;
  onScrub?: (p: HeartScrub | null) => void;
  label: string;
}) {
  const id = useId().replace(/:/g, '');
  const [hover, setHover] = useState<HeartScrub | null>(null);
  const span = heart.end + COOL_DOWN_MIN;
  const lo = Math.min(SCALE[0], heart.low.bpm - 5, ...heart.points.map((p) => p.bpm - 5));
  const hi = Math.max(SCALE[1], heart.peak.bpm + 5);
  const H = 140;
  const x = (at: number) => (at / span) * 600;
  const y = (v: number) => ((hi - v) / (hi - lo)) * H;
  const line = heart.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)} ${y(p.bpm).toFixed(1)}`).join(' ');
  const area = `${line} L${x(heart.points.at(-1)!.at).toFixed(1)} ${H} L${x(heart.points[0].at).toFixed(1)} ${H} Z`;
  const stops = zoneStops(zones, lo, hi, ZONE_COLOURS, WORKOUT, 0);
  // Fainter under the easier zones: peak, vigorous, moderate, light.
  const fill = [14, 18, 26, 34];
  const fillStops = stops.map((s) => {
    const k = ZONE_COLOURS.indexOf(s.color as (typeof ZONE_COLOURS)[number]);
    return { ...s, opacity: (k < 0 ? 20 : fill[k]) / 100 };
  });
  const endPct = (heart.end / span) * 100;
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * span;
    const near = heart.points.reduce((a, p) => (Math.abs(p.at - at) < Math.abs(a.at - at) ? p : a));
    setHover(near);
    onScrub?.(near);
  };
  const leave = () => {
    setHover(null);
    onScrub?.(null);
  };
  const dot = (p: { at: number; bpm: number }) => (zones ? ZONE_COLOURS[zoneOf(p.bpm, zones)] : WORKOUT);

  return (
    <div>
      <div
        className={`relative ${onScrub ? 'cursor-crosshair touch-pan-y' : ''}`}
        style={{ height }}
        role="img"
        aria-label={label}
        onPointerMove={onScrub ? scrubTo : undefined}
        onPointerDown={onScrub ? scrubTo : undefined}
        onPointerLeave={onScrub ? leave : undefined}
        onPointerUp={onScrub ? (e) => e.pointerType !== 'mouse' && leave() : undefined}
      >
        <svg viewBox={`0 0 600 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}l`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
              {stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} />)}
            </linearGradient>
            <linearGradient id={`${id}f`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
              {fillStops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />)}
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id}f)`} />
          {zones &&
            zoneStarts(zones).map((b) =>
              b > lo && b < hi ? (
                <path key={b} d={`M0 ${y(b).toFixed(1)} H600`} stroke="var(--rule-strong)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
              ) : null,
            )}
          <path d={line} fill="none" stroke={`url(#${id}l)`} strokeWidth={2.2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        {/* The cool-down, after a dashed line where the workout stopped. */}
        <div className="absolute inset-y-0 right-0 border-l border-dashed border-zinc-500 bg-panel" style={{ left: `${endPct}%` }} />
        {marks &&
          [
            { p: heart.peak, up: true },
            { p: heart.low, up: false },
          ].map(({ p, up }) => {
            const left = (x(p.at) / 600) * 100;
            return (
              <span key={up ? 'peak' : 'low'} className="pointer-events-none absolute size-0" style={{ left: `${left}%`, top: `${(y(p.bpm) / H) * 100}%` }}>
                <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full ring-2 ring-zinc-950" style={{ background: dot(p) }} />
                <span
                  className="absolute whitespace-nowrap text-caption font-semibold text-zinc-50"
                  style={{ top: up ? -21 : 8, transform: `translateX(${left < 6 ? '-2px' : left > 94 ? '-100%' : '-50%'})` }}
                >
                  {formatInteger(p.bpm)}
                </span>
              </span>
            );
          })}
        {hover && (
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-y-0 w-px bg-zinc-400" style={{ left: `${(x(hover.at) / 600) * 100}%` }} />
            <span
              className="absolute -ml-[5px] -mt-[5px] size-2.5 rounded-full ring-2 ring-zinc-950"
              style={{ left: `${(x(hover.at) / 600) * 100}%`, top: `${(y(hover.bpm) / H) * 100}%`, background: dot(hover) }}
            />
          </div>
        )}
      </div>
      {ticks && (() => {
        // A tick every few minutes on the clock, about 10 to 24 of them, with the start, the middle and the end labelled.
        const step = [1, 2, 5, 10, 15, 30, 60].find((s) => span / s <= 24) ?? 60;
        const first = (step - (startMin % step)) % step;
        const marks: number[] = [];
        for (let m = first; m <= span; m += step) marks.push((m / span) * 100);
        const mid = Math.round((startMin + heart.end / 2) / step) * step - startMin;
        const at = (m: number) => (m / span) * 100;
        const clock = (m: number) => formatClock(Math.round(startMin + m) % 1440);
        return (
          <Ruler
            marks={marks}
            labels={[
              { at: 0, text: clock(0), align: 'start' as const },
              ...(mid > step && mid < heart.end - step ? [{ at: at(mid), text: clock(mid) }] : []),
              { at: at(heart.end), text: clock(heart.end) },
            ]}
          />
        );
      })()}
    </div>
  );
}

/**
 * A ruler under a chart, the way the app's day ruler marks days: a short tick at every mark, and a
 * longer one under each label. `strong` is now, bright and bold. Positions are percentages across.
 */
export function Ruler({ marks, labels }: {
  marks: number[];
  labels: { at: number; text: string; align?: 'start' | 'centre' | 'end'; strong?: boolean }[];
}) {
  return (
    <div aria-hidden="true" className="relative mt-1 h-[26px]">
      {marks.map((x, i) => <div key={`m${i}`} className="absolute top-0 h-[3px] w-px bg-zinc-700" style={{ left: `${x}%` }} />)}
      {labels.map((l, i) => (
        <React.Fragment key={`l${i}`}>
          <div className={`absolute top-0 h-1.5 w-px ${l.strong ? 'bg-zinc-200' : 'bg-zinc-500'}`} style={{ left: `${l.at}%` }} />
          <span
            className={`absolute top-[9px] whitespace-nowrap text-note ${l.strong ? 'font-bold text-zinc-200' : 'text-zinc-500'}`}
            style={{ left: `${l.at}%`, transform: l.align === 'start' ? undefined : l.align === 'end' ? 'translateX(-100%)' : 'translateX(-50%)' }}
          >
            {l.text}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** What the pointer is on: the time, the bpm and its zone. */
export function ScrubReadout({ scrub, startMin, zones }: { scrub: HeartScrub | null; startMin: number; zones: HeartRateZones | null }) {
  if (!scrub) return null;
  const k = zones ? zoneOf(scrub.bpm, zones) : null;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-detail text-zinc-400">
      {k !== null && <i className="size-[7px] rounded-full" style={{ background: ZONE_COLOURS[k] }} />}
      {rich(k === null ? 'workouts.heart.readout' : 'workouts.heart.readoutZone', {
        time: formatClock(Math.round(startMin + scrub.at) % 1440),
        bpm: formatInteger(scrub.bpm),
        zone: k === null ? '' : t(ZONE_NAMES[k]),
        strong: (w) => <span className="font-semibold text-zinc-50">{w}</span>,
      })}
    </span>
  );
}

/** The chart's words for a screen reader. */
export const heartLabel = (heart: WorkoutHeart) =>
  t('workouts.heart.label', { low: heart.low.bpm, peak: heart.peak.bpm, recovery: heart.recovery ?? 'none' });

// ─────────────────────────────────────────────────────────────── the level

/** The level's line: how it has moved in the last 4 weeks, or what this step means. */
function levelLine(level: WorkoutLevel): string {
  const id = LEVELS[level.index];
  if (level.before !== null && level.before < level.index) return t(`workouts.level.up.${id as Exclude<LevelId, 'embers'>}`);
  if (level.before !== null && level.before > level.index) return t(`workouts.level.down.${id as Exclude<LevelId, 'wildfire'>}`);
  return t(`workouts.level.lines.${id}`);
}

/** Five bars rising beside the level's name, lit to where it is. */
function LevelMeter({ index, tall }: { index: number; tall: boolean }) {
  return (
    <div className="flex shrink-0 items-end gap-1.5" aria-hidden="true">
      {LEVELS.map((id, i) => (
        <span
          key={id}
          className="rounded-[5px]"
          style={{
            width: tall ? 18 : 14,
            height: (tall ? 30 : 20) + i * (tall ? 16 : 11),
            background: LEVEL_COLOUR[id],
            opacity: i === index ? 1 : i < index ? 0.85 : 0.3,
          }}
        />
      ))}
    </div>
  );
}

/** The five steps as a rail, with a marker where the level is and each step's name and start under it. */
function LevelRail({ level }: { level: WorkoutLevel }) {
  const starts = levelStarts();
  return (
    <div className="relative">
      <div className="absolute -top-[9px] h-6 w-0.5 -translate-x-px rounded-[1px] bg-zinc-50" style={{ left: `${level.position * 100}%` }} />
      <div className="flex gap-[3px]">
        {LEVELS.map((id, i) => (
          <span key={id} className="h-2 flex-1 rounded" style={{ background: LEVEL_COLOUR[id], opacity: i === level.index ? 1 : 0.45 }} />
        ))}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {LEVELS.map((id, i) => (
          <div key={id} className="min-w-0 flex-1">
            <div className={`truncate text-detail ${i === level.index ? 'font-semibold text-zinc-50' : 'text-zinc-500'}`}>{levelName(id)}</div>
            <div className="text-caption text-zinc-500">{i === LEVELS.length - 1 ? t('workouts.level.from', { minutes: starts[id] }) : formatInteger(starts[id])}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The workout level: the step the last 4 weeks of workouts reach, its line, the rail of all five
 * steps, and the zone minutes a week with how many more reach the next. `hero` is the Workouts
 * tab's wide card; otherwise it's the narrower card the Overview and phones show.
 */
export function LevelCard({ level, hero = false, className = '' }: { level: WorkoutLevel; hero?: boolean; className?: string }) {
  const id = LEVELS[level.index];
  const next = LEVELS[level.index + 1];
  const figures = (
    <div className="flex flex-wrap gap-x-9 gap-y-3 border-t border-rule pt-3.5">
      <div>
        <div className="text-eyebrow uppercase text-zinc-400">{t('workouts.level.perWeek')}</div>
        <div className="font-display text-number-sm text-zinc-50 tabular-nums">{formatInteger(level.perWeek)}</div>
      </div>
      {next && level.toNext !== null && (
        <div>
          <div className="text-eyebrow uppercase text-zinc-400">{t('workouts.level.toNext', { level: levelName(next) })}</div>
          <div className="font-display text-number-sm text-zinc-50 tabular-nums">
            {rich('workouts.level.more', { minutes: formatInteger(level.toNext), muted: (w) => <span className="font-sans text-detail font-normal text-zinc-400">{w}</span> })}
          </div>
        </div>
      )}
    </div>
  );
  return (
    <Card glow={WORKOUT} className={`flex flex-col px-[18px] pt-4 pb-[18px] md:px-6 ${hero ? 'md:pt-5 md:pb-[22px]' : ''} ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="card-title-detail text-zinc-50">{t('workouts.level.title')}</h2>
        <span className="text-detail text-zinc-500">{t('workouts.level.span')}</span>
      </div>
      {hero ? (
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0 flex-[1_1_380px]">
            <div className="font-display text-number-2xl text-zinc-50">{levelName(id)}</div>
            <p className="mt-3 max-w-[460px] font-display text-insight-body text-zinc-400">{levelLine(level)}</p>
          </div>
          <LevelMeter index={level.index} tall />
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex items-end justify-between gap-4">
            <div className="font-display text-number-xl text-zinc-50">{levelName(id)}</div>
            <LevelMeter index={level.index} tall={false} />
          </div>
          {/* The line takes the space the card has, centred between the name and the rail, which sits just above the figures. */}
          <div className="flex flex-1 items-center py-4">
            <p className="font-display text-insight-body text-zinc-400">{levelLine(level)}</p>
          </div>
        </>
      )}
      <div className={hero ? 'mt-6' : ''}>
        <LevelRail level={level} />
      </div>
      <div className={hero ? 'mt-[18px]' : 'mt-5'}>{figures}</div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────── the load

const STRETCHES = [
  { from: 0, to: 0.8, colour: 'var(--slate-400)' },
  { from: 0.8, to: 1.5, colour: WORKOUT },
  { from: 1.5, to: 2, colour: EFFORT.vigorous },
] as const;

/** The load on a dial of 270°, from nothing to twice the usual week, in its three stretches. */
function LoadDial({ ratio, size }: { ratio: number | null; size: number }) {
  const C = 120;
  const R = 96;
  const pt = (r: number, deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [C + r * Math.cos(a), C + r * Math.sin(a)];
  };
  const arc = (d0: number, d1: number) => {
    const [x0, y0] = pt(R, d0);
    const [x1, y1] = pt(R, d1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  const angle = (v: number) => -135 + (Math.min(v, 2) / 2) * 270;
  const knob = ratio === null ? null : pt(R, angle(ratio));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 240 240" className="absolute inset-0 h-full w-full" aria-hidden="true">
        {STRETCHES.map((s) => (
          <path key={s.from} d={arc(angle(s.from) + 1.2, angle(s.to) - 1.2)} stroke={s.colour} strokeOpacity={0.22} strokeWidth={16} fill="none" />
        ))}
        {ratio !== null &&
          STRETCHES.filter((s) => ratio > s.from).map((s) => (
            <path key={s.from} d={arc(angle(s.from) + 1.2, Math.min(angle(s.to) - 1.2, angle(ratio)))} stroke={s.colour} strokeWidth={16} fill="none" />
          ))}
        {knob && <circle cx={knob[0]} cy={knob[1]} r={11} fill="var(--color-zinc-50)" stroke="var(--color-zinc-950)" strokeWidth={4} />}
      </svg>
      {[0.8, 1.5].map((v) => {
        const [x, y] = pt(R + 21, angle(v));
        return (
          <span key={v} className="absolute -translate-x-1/2 -translate-y-1/2 text-note text-zinc-500" style={{ left: `${(x / 240) * 100}%`, top: `${(y / 240) * 100}%` }}>
            {t('workouts.load.times', { ratio: fmtNum(v, 1) })}
          </span>
        );
      })}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="font-display text-number-lg leading-none text-zinc-50">{ratio === null ? '—' : t('workouts.load.times', { ratio: fmtNum(ratio, 1) })}</div>
        <div className="mt-1 text-caption text-zinc-500">{t('workouts.load.usual')}</div>
      </div>
    </div>
  );
}

/**
 * The workout load: the last 7 days of zone minutes from workouts against the usual week before,
 * on a dial, with what to do about it, read together with today's body battery.
 */
export function LoadCard({ load, battery, wide, className = '' }: { load: WorkoutLoad; battery: number | null; wide: boolean; className?: string }) {
  const tier = battery === null ? null : batteryTier(battery);
  const low = tier !== null && (tier.tag === 'LOW' || tier.tag === 'DRAINED');
  const advice = load.ratio === null ? null : loadAdvice(load.ratio, low);
  const words = (
    <div className="min-w-0 flex-1">
      <div className="font-display text-number-sm text-zinc-50">{t(advice ? `workouts.load.headline.${advice}` : 'workouts.load.headline.none')}</div>
      <p className="mt-2 font-display text-insight-body text-zinc-400">
        {advice === null
          ? t('workouts.load.advice.none')
          : advice === 'easy'
            ? t('workouts.load.advice.easy', { battery: battery!, tier: tier!.tag === 'DRAINED' ? 'drained' : 'low' })
            : t(`workouts.load.advice.${advice}`, { battery: battery === null ? 'none' : battery })}
      </p>
    </div>
  );
  const unit = (w: React.ReactNode[]) => <span className="font-sans text-caption font-normal text-zinc-400">{w}</span>;
  return (
    <Card glow={WORKOUT} className={`flex flex-col px-[18px] pt-4 pb-[18px] md:px-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="card-title-detail text-zinc-50">{t('workouts.load.title')}</h2>
        <span className="text-detail text-zinc-500">{t('workouts.load.span')}</span>
      </div>
      {wide ? (
        <div className="mt-1.5 flex flex-1 items-center gap-5">
          <LoadDial ratio={load.ratio} size={196} />
          {words}
        </div>
      ) : (
        <div className="mt-2 flex flex-col items-center gap-3">
          <LoadDial ratio={load.ratio} size={180} />
          <div className="self-stretch">{words}</div>
        </div>
      )}
      <div className="mt-[18px] grid grid-cols-3 gap-3">
        <PlainFigure label={t('workouts.load.week')} value={rich('workouts.load.zoneMinutes', { minutes: formatInteger(load.week), muted: unit })} />
        <PlainFigure label={t('workouts.load.usualWeek')} value={load.usual === null ? '—' : rich('workouts.load.zoneMinutes', { minutes: formatInteger(load.usual), muted: unit })} />
        <PlainFigure
          label={t('workouts.load.battery')}
          value={battery === null ? '—' : rich('workouts.load.batteryValue', { score: battery, tier: t(`today.battery.tiers.${tier!.tag.toLowerCase() as Lowercase<ReturnType<typeof batteryTier>['tag']>}.name`), muted: unit })}
        />
      </div>
    </Card>
  );
}

/** A label and a figure, without a box: a row of figures about the week rather than a workout. */
function PlainFigure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-eyebrow-sm uppercase text-zinc-400">{label}</div>
      <div className="mt-0.5 whitespace-nowrap font-display text-number-xs leading-tight text-zinc-50 tabular-nums">{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── the latest workout

/**
 * The latest workout: its name and big figure, its heart rate (which a pointer or a finger can
 * move across), four figures for its kind, and the zones it reached. The corner opens it.
 */
export function LatestWorkoutCard({ dw, heart, zones, restingPerMinute, today, onOpen, wide, className = '' }: {
  dw: DatedWorkout;
  heart: WorkoutHeart | null;
  zones: HeartRateZones | null;
  restingPerMinute: number | null;
  today: CivilDate | null;
  onOpen: () => void;
  wide: boolean;
  className?: string;
}) {
  const w = dw.workout;
  const [scrub, setScrub] = useState<HeartScrub | null>(null);
  const big = bigFigure(w);
  return (
    <Card glow={WORKOUT} className={`flex flex-col px-[18px] pt-4 pb-[18px] md:px-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="card-title-detail text-zinc-50">{t('workouts.latest.title')}</h2>
        <button type="button" onClick={onOpen} className="flex items-center gap-0.5 text-detail font-medium hover:underline" style={{ color: WORKOUT }}>
          {startedLabel(dw, today)}
          <ChevronRight size={13} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <WorkoutIcon kind={kindOf(w)} size={28} />
          <span className="truncate text-body-sm font-medium text-zinc-100">{workoutName(w)}</span>
        </div>
        <div className="whitespace-nowrap font-display text-number-md text-zinc-50 tabular-nums">
          {big.value}
          {big.unit && <span className="font-sans text-body-sm font-normal text-zinc-400"> {big.unit}</span>}
        </div>
      </div>
      {heart && (
        <>
          <div className="mt-3 flex h-[18px] items-center justify-between gap-3">
            <span className="text-eyebrow-sm uppercase text-zinc-400">{t('workouts.heart.title')}</span>
            <ScrubReadout scrub={scrub} startMin={w.startMin} zones={zones} />
          </div>
          <div className="mt-1.5">
            <HeartChart heart={heart} zones={zones} height={wide ? 132 : 104} startMin={w.startMin} onScrub={setScrub} label={heartLabel(heart)} />
          </div>
        </>
      )}
      <div className={`mt-3.5 grid gap-2 ${wide ? 'grid-cols-4' : 'grid-cols-2'}`}>
        {latestFigures(w, heart, restingPerMinute).map((f) => <FigureBox key={f.label} {...f} />)}
      </div>
      <div className="mt-4">
        <ZoneBar w={w} />
      </div>
    </Card>
  );
}

/** For the zone list in a workout's detail: each zone's bpm on the day. */
export function zoneRange(k: number, zones: HeartRateZones | null): string | null {
  if (!zones) return null;
  const starts = zoneStarts(zones);
  if (k === 0) return t('workouts.zones.below', { bpm: starts[0] });
  if (k === 3) return t('workouts.zones.above', { bpm: starts[2] });
  return t('workouts.zones.between', { from: starts[k - 1], to: starts[k] - 1 });
}

export { ZONE_COLOURS, ZONE_KEYS };
