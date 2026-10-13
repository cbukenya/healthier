import { addDays, isoWeekdayIndex } from '../../lib/date';
import type { DailyRecord, SleepSession } from '../../types/health';
import { circularMeanMinutes, stats, type Point } from '../derive';
import { illnessDates, type IntradayDays } from '../labs';
import { scoreSleep } from '../sleep';
import { welch } from './association';
import { isWorkday } from './helpers';

/**
 * The building blocks behind the deeper page insights: weekday profiles, when
 * in the day you move, mid-sleep on work and free days, and bedtime against
 * sleep score. Each is plain arithmetic over the day grid, with the minimum
 * data it needs written into it.
 */

/** ISO order, as `isoWeekdayIndex` counts. */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// ───────────────────────────────────────────────────────── weekday profiles

export interface WeekdayMedian {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  median: number | null;
  n: number;
}

/** The median of a series on each weekday, with how many values each rests on. */
export function weekdayMedians(s: Point[]): WeekdayMedian[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  for (const p of s) if (p.value !== null) buckets[isoWeekdayIndex(p.date)].push(p.value);
  return buckets.map((b, weekday) => ({ weekday, median: stats(b)?.median ?? null, n: b.length }));
}

/** The lowest and highest weekday medians, once every weekday has at least `minEach` values. */
export function weekdayExtremes(s: Point[], minEach: number): { low: WeekdayMedian; high: WeekdayMedian } | null {
  const meds = weekdayMedians(s);
  if (meds.some((m) => m.median === null || m.n < minEach)) return null;
  const sorted = [...meds].sort((a, b) => a.median! - b.median!);
  return { low: sorted[0], high: sorted[6] };
}

// ─────────────────────────────────────────────────── when in the day you move

/** Minute heart rate from 06:00 to 22:00, where waking activity happens. */
const DAY_FROM = 6 * 60;
const DAY_TO = 22 * 60;
/** A day counts once the watch saw at least ten of those sixteen hours. */
const WORN_MINUTES = 600;

export interface PeakWindow {
  /** The two-hour window's first hour, 6–20. */
  fromHour: number;
  /** Active minutes a day in the window, on average. */
  minutes: number;
  days: number;
}

export interface ActiveHours {
  /** Beats per minute from which a minute counts as active. */
  threshold: number;
  days: number;
  weekdays: PeakWindow | null;
  weekends: PeakWindow | null;
}

/**
 * When in the day you're most active, from minute heart rate over the last 28
 * finished days. A minute counts as active at 40% of heart-rate reserve or
 * above (Karvonen), the lower edge of moderate intensity, with a maximum of
 * 208 − 0.7 × age (Tanaka). Weekdays and weekends are read separately; each
 * reports the two-hour window holding the most active minutes, but only when
 * that window averages at least 10 minutes a day and holds at least a fifth
 * of the day's active minutes. Silent below 14 well-worn days.
 */
export function activeHours(days: DailyRecord[], intraday: IntradayDays, age: number, restingHr: number): ActiveHours | null {
  const maxHr = 208 - 0.7 * age;
  if (maxHr <= restingHr) return null;
  const threshold = Math.round(restingHr + 0.4 * (maxHr - restingHr));

  const groups = { weekdays: [] as number[][], weekends: [] as number[][] };
  for (const d of days.slice(-29, -1)) {
    const samples = (intraday[d.date] ?? []).filter((x) => x.minutesOfDay >= DAY_FROM && x.minutesOfDay < DAY_TO);
    if (samples.length < WORN_MINUTES) continue;
    const perHour = new Array(24).fill(0);
    for (const x of samples) if (x.value >= threshold) perHour[Math.floor(x.minutesOfDay / 60)]++;
    (isWorkday(d.date) ? groups.weekdays : groups.weekends).push(perHour);
  }
  const total = groups.weekdays.length + groups.weekends.length;
  if (total < 14) return null;

  const peak = (rows: number[][], minDays: number): PeakWindow | null => {
    if (rows.length < minDays) return null;
    const avg = (h: number) => rows.reduce((a, r) => a + r[h], 0) / rows.length;
    let best = DAY_FROM / 60;
    for (let h = DAY_FROM / 60; h < DAY_TO / 60 - 1; h++) if (avg(h) + avg(h + 1) > avg(best) + avg(best + 1)) best = h;
    const minutes = avg(best) + avg(best + 1);
    let day = 0;
    for (let h = DAY_FROM / 60; h < DAY_TO / 60; h++) day += avg(h);
    return minutes >= 10 && minutes >= day / 5 ? { fromHour: best, minutes, days: rows.length } : null;
  };
  return { threshold, days: total, weekdays: peak(groups.weekdays, 8), weekends: peak(groups.weekends, 4) };
}

// ─────────────────────────────────────────────────── work and free nights

/** Minutes from going to sleep to waking, across midnight. */
const spanOf = (s: SleepSession) => (s.wakeMin - s.bedtimeMin + 1440) % 1440;
/** The middle of the night on the clock. */
export const midSleep = (s: SleepSession) => (s.bedtimeMin + spanOf(s) / 2) % 1440;

export interface NightGroup {
  n: number;
  bed: number;
  wake: number;
  mid: number;
  /** Mean minutes from going to sleep to waking. */
  span: number;
}

export interface WorkFreeNights {
  /** Nights ending on a workday morning. */
  work: NightGroup;
  /** Nights ending on a free morning: you didn't have to be up. */
  free: NightGroup;
  /**
   * Mid-sleep on free nights corrected for catch-up sleep (Roenneberg): when
   * free nights run longer than the week's average, half the extra is taken
   * off. The best estimate of your natural timing.
   */
  midCorrected: number;
}

/** Work and free nights over the last 28 days: at least 4 free and 8 work nights. */
export function workFreeNights(days: DailyRecord[]): WorkFreeNights | null {
  const recent = days.slice(-28).filter((d) => d.sleep);
  const group = (rows: DailyRecord[]): NightGroup | null => {
    const s = rows.map((d) => d.sleep!);
    const bed = circularMeanMinutes(s.map((x) => x.bedtimeMin));
    const wake = circularMeanMinutes(s.map((x) => x.wakeMin));
    const mid = circularMeanMinutes(s.map(midSleep));
    if (!bed || !wake || !mid) return null;
    return { n: s.length, bed: bed.mean, wake: wake.mean, mid: mid.mean, span: s.reduce((a, x) => a + spanOf(x), 0) / s.length };
  };
  const workRows = recent.filter((d) => isWorkday(d.date));
  const freeRows = recent.filter((d) => !isWorkday(d.date));
  if (workRows.length < 8 || freeRows.length < 4) return null;
  const work = group(workRows);
  const free = group(freeRows);
  if (!work || !free) return null;
  const week = (5 * work.span + 2 * free.span) / 7;
  const midCorrected = free.span > work.span ? (free.mid - (free.span - week) / 2 + 1440) % 1440 : free.mid;
  return { work, free, midCorrected };
}

// ─────────────────────────────────────────────────── bedtime and sleep score

export interface BestBedtime {
  /** Minutes past midnight, on the half hour. */
  cut: number;
  early: { mean: number; n: number };
  late: { mean: number; n: number };
  earlierBetter: boolean;
}

/** Bedtimes before noon belong to the night before: 00:30 is later than 23:00. */
const fold = (m: number) => (m < 12 * 60 ? m + 1440 : m);

/**
 * Sleep score on nights you went to sleep by your usual bedtime against the
 * nights after it. The cut is your median bedtime on the half hour, chosen
 * before looking at the scores so it can't be fished for. Silent unless both
 * sides have 10 nights, the gap is 5 points and Welch's test clears p < 0.05.
 */
export function bestBedtime(days: DailyRecord[]): BestBedtime | null {
  const nights = days.filter((d) => d.sleep).map((d) => ({ bed: fold(d.sleep!.bedtimeMin), score: scoreSleep(d.sleep!).total }));
  if (nights.length < 20) return null;
  const cut = Math.round(stats(nights.map((x) => x.bed))!.median / 30) * 30;
  const early = nights.filter((x) => x.bed <= cut).map((x) => x.score);
  const late = nights.filter((x) => x.bed > cut).map((x) => x.score);
  if (early.length < 10 || late.length < 10) return null;
  const w = welch(early, late);
  if (!w || Math.abs(w.diff) < 5 || w.p >= 0.05) return null;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    cut: cut % 1440,
    early: { mean: mean(early), n: early.length },
    late: { mean: mean(late), n: late.length },
    earlierBetter: w.diff > 0,
  };
}

// ─────────────────────────────────────────────────── sleep length and HRV

export interface SleepHrvAssociation {
  /** How much higher (positive) or lower overnight HRV runs on long nights, in percent. */
  pct: number;
  nLong: number;
  nShort: number;
  p: number;
}

/**
 * Overnight HRV on nights of 7 hours or more against shorter nights, in the
 * log domain, with nights around illness-like readings left out. Silent unless
 * each side has 8 nights, the difference is 5% or more and Welch's test clears
 * p < 0.05. An association in one person's data, never a cause.
 */
export function sleepHrvAssociation(days: DailyRecord[]): SleepHrvAssociation | null {
  const sick = illnessDates(days);
  const long: number[] = [];
  const short: number[] = [];
  for (const d of days) {
    if (!d.sleep || d.hrv === null || d.hrv <= 0 || sick.has(d.date) || sick.has(addDays(d.date, -1))) continue;
    (d.sleep.minutesAsleep >= 420 ? long : short).push(Math.log(d.hrv));
  }
  if (long.length < 8 || short.length < 8) return null;
  const w = welch(long, short);
  if (!w || w.p >= 0.05) return null;
  const pct = Math.round((Math.exp(w.diff) - 1) * 100);
  return Math.abs(pct) >= 5 ? { pct, nLong: long.length, nShort: short.length, p: w.p } : null;
}
