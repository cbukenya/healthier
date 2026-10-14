import type { CivilDate } from '../lib/date';
import type { HeartRateZones, IntradaySample } from '../types/health';

/**
 * The arithmetic behind the heart rate chart, apart from its drawing so it can be tested.
 *
 * Time on this chart is wall-clock time: a reading's civil date and minute, read as if they were
 * UTC milliseconds. The axis then shows the clock the person lives by, midnight falls on whole
 * days, and no time zone is needed to label it.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const wallTime = (s: Pick<IntradaySample, 'date' | 'minutesOfDay'>) =>
  Date.parse(`${s.date}T00:00:00Z`) + s.minutesOfDay * MINUTE;
export const wallDate = (t: number): CivilDate => new Date(t).toISOString().slice(0, 10);
export const wallClock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** The zones, rest first, by what they're called. */
export const ZONE_NAMES = ['Rest', 'Light', 'Moderate', 'Vigorous', 'Peak'] as const;

/** Where each zone above rest starts, in bpm, lowest first. */
export const zoneStarts = (z: HeartRateZones) => [z.light, z.moderate, z.vigorous, z.peak];

/** The zone a reading falls in: 0 for rest up to 4 for peak. */
export function zoneOf(bpm: number, z: HeartRateZones): number {
  const starts = zoneStarts(z);
  let k = 0;
  while (k < starts.length && bpm >= starts[k]) k++;
  return k;
}

/**
 * The stops of a vertical gradient that colours a line by zone, from `hi` bpm at the top to `lo`
 * at the bottom. Each boundary blends over `blend` of the height either side of it, so the colour
 * eases into the next zone rather than snapping. Without zones the line is one colour.
 */
export function zoneStops(
  z: HeartRateZones | null,
  lo: number,
  hi: number,
  colors: readonly string[],
  plain: string,
  blend = 0.016,
): { offset: number; color: string }[] {
  if (!z) return [{ offset: 0, color: plain }, { offset: 1, color: plain }];
  const at = (bpm: number) => (hi - bpm) / (hi - lo);
  const stops = [{ offset: 0, color: colors[zoneOf(hi, z)] }];
  const starts = zoneStarts(z);
  for (let k = starts.length - 1; k >= 0; k--) {
    const o = at(starts[k]);
    if (o <= 0 || o >= 1) continue;
    const prev = stops[stops.length - 1].offset;
    stops.push({ offset: Math.max(prev, o - blend), color: colors[k + 1] });
    stops.push({ offset: Math.min(1, Math.max(prev, o + blend)), color: colors[k] });
  }
  stops.push({ offset: 1, color: colors[zoneOf(lo, z)] });
  return stops;
}

/** The first index whose time is at or after `t`, in times sorted ascending. */
export function lowerBound(ts: readonly number[], t: number): number {
  let a = 0;
  let b = ts.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (ts[m] < t) a = m + 1;
    else b = m;
  }
  return a;
}

/** Tick spacing for a view: the shortest step that keeps labels at least `minPx` apart. */
export function tickStep(span: number, widthPx: number, minPx = 64): number {
  const steps = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
  return steps.find((s) => (s / span) * widthPx >= minPx) ?? 7 * DAY;
}

export type Pt = { t: number; v: number };

/**
 * The readings to draw for a view, split wherever the watch was off for more than `gap`. When
 * there are more readings than pixels, each pixel column keeps its lowest and highest, in time
 * order, so peaks survive at every zoom.
 */
export function visibleRuns(
  ts: readonly number[],
  vs: readonly number[],
  from: number,
  to: number,
  widthPx: number,
  gap = 5 * MINUTE,
): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  const a = Math.max(0, lowerBound(ts, from) - 1);
  const b = Math.min(ts.length, lowerBound(ts, to) + 1);
  const thin = b - a > widthPx * 2;
  const span = to - from;
  let col = Number.NaN;
  let lo = -1;
  let hi = -1;
  const flushColumn = () => {
    if (lo < 0) return;
    if (lo === hi) run.push({ t: ts[lo], v: vs[lo] });
    else {
      const [p, q] = lo < hi ? [lo, hi] : [hi, lo];
      run.push({ t: ts[p], v: vs[p] }, { t: ts[q], v: vs[q] });
    }
    lo = hi = -1;
  };
  for (let i = a; i < b; i++) {
    if (i > a && ts[i] - ts[i - 1] > gap) {
      flushColumn();
      if (run.length > 1) runs.push(run);
      run = [];
      col = Number.NaN;
    }
    if (!thin) {
      run.push({ t: ts[i], v: vs[i] });
      continue;
    }
    const c = Math.floor(((ts[i] - from) / span) * widthPx);
    if (c !== col) {
      flushColumn();
      col = c;
    }
    if (lo < 0 || vs[i] < vs[lo]) lo = i;
    if (hi < 0 || vs[i] > vs[hi]) hi = i;
  }
  flushColumn();
  if (run.length > 1) runs.push(run);
  return runs;
}

/**
 * Runs cut at midnight, so each day's stretch can take that day's zones. The reading after
 * midnight also ends the day before, so the line never breaks where the date changes.
 */
export function byDay(runs: Pt[][]): { date: CivilDate; points: Pt[] }[] {
  const out: { date: CivilDate; points: Pt[] }[] = [];
  for (const run of runs) {
    let cur: { date: CivilDate; points: Pt[] } | null = null;
    for (const p of run) {
      const date = wallDate(p.t);
      if (!cur || cur.date !== date) {
        if (cur) cur.points.push(p);
        cur = { date, points: [p] };
        out.push(cur);
      } else {
        cur.points.push(p);
      }
    }
  }
  return out.filter((c) => c.points.length > 1);
}

/** Each wall-clock hour's average, for the strip that shows every day at once. */
export function hourly(ts: readonly number[], vs: readonly number[]): Pt[] {
  const out: Pt[] = [];
  let hour = Number.NaN;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < ts.length; i++) {
    const h = Math.floor(ts[i] / HOUR);
    if (h !== hour) {
      if (n) out.push({ t: hour * HOUR + HOUR / 2, v: sum / n });
      hour = h;
      sum = 0;
      n = 0;
    }
    sum += vs[i];
    n++;
  }
  if (n) out.push({ t: hour * HOUR + HOUR / 2, v: sum / n });
  return out;
}
