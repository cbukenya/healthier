import type { CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import { scoreSleep } from './sleep';

/**
 * The history digest: a few kilobytes that stand in for every stored day
 * before the dashboard's window, so the insights can say "your best month" and
 * "your biggest day" without the browser holding two years of days.
 *
 * It's plain arithmetic over stored days, rebuilt from scratch whenever a
 * dataset is assembled, and never a memory of what was shown. It covers only
 * the days before the window, so the yesterday test still works: cutting the
 * window back never reaches into the digest, and a record set inside the window
 * can't already be counted in it. Monthly figures are kept as sums and counts so
 * a month split across the window's edge merges exactly.
 */

export interface Tally {
  sum: number;
  n: number;
}

export interface MonthTotals {
  /** 'YYYY-MM'. */
  month: string;
  steps: Tally;
  sleepMin: Tally;
  sleepScore: Tally;
  restingHr: Tally;
  hrv: Tally;
}

/** A 7-day mean over at least 5 readings, and the day it ends on. */
export interface WeekRecord {
  end: CivilDate;
  mean: number;
}

export interface HistoryDigest {
  /** The first and last day it covers: the stored days before the window. */
  from: CivilDate;
  to: CivilDate;
  months: MonthTotals[];
  /** The biggest step day. */
  stepDay: { date: CivilDate; steps: number } | null;
  /** The lowest resting-heart-rate week and the highest HRV week. */
  restingHrWeek: WeekRecord | null;
  hrvWeek: WeekRecord | null;
  /** The first weigh-in on record. */
  firstWeight: { date: CivilDate; kg: number } | null;
}

const tally = (): Tally => ({ sum: 0, n: 0 });
const add = (t: Tally, v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  t.sum += v;
  t.n++;
};

/** Sums and counts per calendar month, oldest first. */
export function monthTotals(days: DailyRecord[]): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    let m = byMonth.get(month);
    if (!m) byMonth.set(month, (m = { month, steps: tally(), sleepMin: tally(), sleepScore: tally(), restingHr: tally(), hrv: tally() }));
    add(m.steps, d.steps);
    add(m.restingHr, d.restingHr);
    add(m.hrv, d.hrv);
    if (d.sleep) {
      add(m.sleepMin, d.sleep.minutesAsleep);
      add(m.sleepScore, scoreSleep(d.sleep).total);
    }
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Two sets of month totals as one: a month split across the window's edge adds up exactly. */
export function mergeMonths(a: MonthTotals[], b: MonthTotals[]): MonthTotals[] {
  const byMonth = new Map<string, MonthTotals>();
  const plus = (x: Tally, y: Tally): Tally => ({ sum: x.sum + y.sum, n: x.n + y.n });
  for (const m of [...a, ...b]) {
    const held = byMonth.get(m.month);
    byMonth.set(m.month, held
      ? {
          month: m.month,
          steps: plus(held.steps, m.steps),
          sleepMin: plus(held.sleepMin, m.sleepMin),
          sleepScore: plus(held.sleepScore, m.sleepScore),
          restingHr: plus(held.restingHr, m.restingHr),
          hrv: plus(held.hrv, m.hrv),
        }
      : m);
  }
  return [...byMonth.values()].sort((x, y) => (x.month < y.month ? -1 : 1));
}

/** The best 7-day mean (5+ readings) in a run of days: lowest or highest. */
export function bestWeek(days: DailyRecord[], get: (d: DailyRecord) => number | null, better: 'min' | 'max'): WeekRecord | null {
  let best: WeekRecord | null = null;
  for (let end = 7; end <= days.length; end++) {
    const v = days.slice(end - 7, end).map(get).filter((x): x is number => x !== null);
    if (v.length < 5) continue;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    if (!best || (better === 'min' ? mean < best.mean : mean > best.mean)) best = { end: days[end - 1].date, mean };
  }
  return best;
}

export function buildDigest(days: DailyRecord[]): HistoryDigest | null {
  if (!days.length) return null;
  let stepDay: HistoryDigest['stepDay'] = null;
  for (const d of days) if (d.steps !== null && (!stepDay || d.steps > stepDay.steps)) stepDay = { date: d.date, steps: d.steps };
  const weighIn = days.find((d) => d.weightKg !== null);
  return {
    from: days[0].date,
    to: days[days.length - 1].date,
    months: monthTotals(days),
    stepDay,
    restingHrWeek: bestWeek(days, (d) => d.restingHr, 'min'),
    hrvWeek: bestWeek(days, (d) => d.hrv, 'max'),
    firstWeight: weighIn ? { date: weighIn.date, kg: weighIn.weightKg! } : null,
  };
}
