import { addDays, isoWeekdayIndex, type CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import { circularMeanMinutes, type Point } from './derive';

/**
 * Grouping for long chart spans.
 *
 * Up to 90 days every day gets its own point. Beyond that a chart would carry
 * hundreds of points it can't show, so days are grouped into weeks (and months
 * past two years). Values become averages per *recorded* day, not totals, so the
 * unit matches the daily view and a partial week, or a day without the watch,
 * doesn't read as a drop.
 *
 * Only descriptive charts are grouped. Baselines, readiness and insights keep
 * their fixed recent windows whatever span is on screen.
 */

export type Bucket = 'day' | 'week' | 'month';

/** More points than this and a chart is grouped. Sparse series under it stay raw. */
export const MAX_POINTS = 120;

/** Daily up to MAX_POINTS days, weekly up to two years, monthly beyond. */
export function bucketFor(spanDays: number): Bucket {
  if (spanDays <= MAX_POINTS) return 'day';
  if (spanDays <= 730) return 'week';
  return 'month';
}

/** The bucket for a series: its span's bucket, unless it has few enough readings to plot raw. */
export function bucketForSeries(points: Point[], spanDays: number): Bucket {
  const recorded = points.filter((p) => p.value !== null).length;
  return recorded <= MAX_POINTS ? 'day' : bucketFor(spanDays);
}

/** First day of the bucket a date falls in: the day itself, its Monday, or the 1st. */
export function bucketStart(date: CivilDate, bucket: Bucket): CivilDate {
  if (bucket === 'week') return addDays(date, -isoWeekdayIndex(date));
  if (bucket === 'month') return `${date.slice(0, 7)}-01`;
  return date;
}

function nextBucket(start: CivilDate, bucket: Bucket): CivilDate {
  if (bucket === 'week') return addDays(start, 7);
  if (bucket === 'month') {
    const [y, m] = start.split('-').map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return addDays(start, 1);
}

/**
 * Split days into consecutive buckets, oldest first. Every bucket between the
 * first and last day is present, empty ones included, so gaps stay visible.
 */
export function groupDays<T extends { date: CivilDate }>(days: T[], bucket: Bucket): { date: CivilDate; days: T[] }[] {
  if (!days.length) return [];
  const byStart = new Map<CivilDate, T[]>();
  for (const d of days) {
    const key = bucketStart(d.date, bucket);
    let list = byStart.get(key);
    if (!list) byStart.set(key, (list = []));
    list.push(d);
  }
  const out: { date: CivilDate; days: T[] }[] = [];
  const last = bucketStart(days[days.length - 1].date, bucket);
  for (let start = bucketStart(days[0].date, bucket); start <= last; start = nextBucket(start, bucket)) {
    out.push({ date: start, days: byStart.get(start) ?? [] });
  }
  return out;
}

/** Monday-to-Sunday weeks lying wholly inside the days given, oldest first; a week cut by either end is left out. */
export function wholeWeeks<T extends { date: CivilDate }>(days: T[]): { date: CivilDate; days: T[] }[] {
  return groupDays(days, 'week').filter((w) => w.days.length === 7);
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const recorded = (xs: (number | null | undefined)[]) => xs.filter((v): v is number => typeof v === 'number');

/** Average of the recorded values in each bucket; null where a bucket has none. */
export function groupSeries(points: Point[], bucket: Bucket): Point[] {
  if (bucket === 'day') return points;
  return groupDays(points, bucket).map((g) => ({ date: g.date, value: mean(recorded(g.days.map((p) => p.value))) }));
}

/** Per-bucket average of a value read off each day. */
export function groupMean(days: DailyRecord[], bucket: Bucket, get: (d: DailyRecord) => number | null | undefined) {
  return groupDays(days, bucket).map((g) => ({ date: g.date, value: mean(recorded(g.days.map(get))) }));
}

/**
 * Per-bucket range: the average of the averages, but the lowest low and highest
 * high, so one bad night stays visible instead of being averaged away.
 */
export function groupRange(
  days: DailyRecord[],
  bucket: Bucket,
  get: (d: DailyRecord) => { avg: number; low: number | null; high: number | null } | null,
) {
  return groupDays(days, bucket).map((g) => {
    const xs = g.days.map(get).filter((x): x is NonNullable<typeof x> => x !== null);
    const lows = recorded(xs.map((x) => x.low));
    const highs = recorded(xs.map((x) => x.high));
    return {
      date: g.date,
      value: xs.length
        ? { avg: mean(xs.map((x) => x.avg))!, low: lows.length ? Math.min(...lows) : null, high: highs.length ? Math.max(...highs) : null }
        : null,
    };
  });
}

/**
 * Median of clock times on a 24-hour circle. Each time is first moved to within
 * 12 hours of the circular mean, so 23:30 and 00:30 give midnight, not noon,
 * and a day sleeper's 11:30 and 12:30 give 12:00 rather than straddling a
 * fixed fold.
 */
export function circularMedianMinutes(mins: number[]): number | null {
  if (!mins.length) return null;
  const centre = circularMeanMinutes(mins)?.mean ?? mins[0];
  const unwrapped = mins.map((m) => {
    let x = m;
    while (x - centre > 720) x -= 1440;
    while (centre - x > 720) x += 1440;
    return x;
  });
  return ((Math.round(median(unwrapped)!) % 1440) + 1440) % 1440;
}

/** One typical night per bucket: circular median bedtime and median time in bed. */
export function groupNights(days: DailyRecord[], bucket: Bucket) {
  return groupDays(days, bucket).map((g) => {
    const nights = g.days.map((d) => d.sleep).filter((s): s is NonNullable<typeof s> => !!s);
    if (!nights.length) return { date: g.date, night: null, nights: 0 };
    const bed = circularMedianMinutes(nights.map((s) => s.bedtimeMin))!;
    const inBed = median(nights.map((s) => s.minutesInBed))!;
    const staged = nights.map((s) => s.stages).filter((st): st is NonNullable<typeof st> => !!st);
    const avgStage = (k: 'deep' | 'light' | 'rem' | 'awake') => Math.round(mean(staged.map((st) => st[k]))!);
    return {
      date: g.date,
      nights: nights.length,
      night: {
        bedtimeMin: bed,
        minutesInBed: Math.round(inBed),
        wakeMin: Math.round(bed + inBed) % (24 * 60),
        minutesAsleep: Math.round(median(nights.map((s) => s.minutesAsleep))!),
        /** Average minutes per stage over the bucket's staged nights; null if none were staged. */
        stages: staged.length ? { deep: avgStage('deep'), light: avgStage('light'), rem: avgStage('rem'), awake: avgStage('awake') } : null,
      },
    };
  });
}

/** Rolling-mean length that suits the bucket: 7 days, 4 weeks, none for months. */
export const meanWindowFor = (bucket: Bucket): number | null => (bucket === 'day' ? 7 : bucket === 'week' ? 4 : null);
