import { addDays, dateRange, type CivilDate } from '../../lib/date';
import type { DailyRecord } from '../../types/health';
import { scoreSleep } from '../sleep';
import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR, compareToBaseline, isRecent, readiness, series, sleepDebt, sleepNeedFor,
} from '../derive';
import { DEFAULT_GOALS, type Goals } from '../goals';
import type { InsightDataset, InsightOptions } from './context';
import { briskMins, sleepMins, zoneMins } from './helpers';
import { insightFeeds } from './engine';

/** Convenience: everything the Today view needs, computed once. */
export function todaySummary(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions) {
  const days = ds.days;
  const goals = extras?.goals ?? DEFAULT_GOALS;
  const need = sleepNeedFor(days, goals.sleepNeed);
  const last = days[days.length - 1] ?? null;
  // Cards about now show readings from today or yesterday; anything older is history, not last night.
  const recent = (d: DailyRecord | undefined) => (d && isRecent(d.date, last?.date) ? d : null);
  const movementDay = recent([...days].reverse().find((d) => d.steps !== null));
  const sleepDay = recent([...days].reverse().find((d) => d.sleep !== null));

  const hrv = compareToBaseline(series(days, (d) => d.hrv), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
  const rhr = compareToBaseline(series(days, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);

  return {
    today: last,
    movementDay,
    sleepDay,
    sleepScore: sleepDay?.sleep ? scoreSleep(sleepDay.sleep) : null,
    hrv,
    rhr,
    readiness: readiness(days, goals.sleepNeed),
    sleepTargetMin: need,
    debt: sleepDebt(days, need),
    week: weekSummary(days, goals),
    observations: insightFeeds(ds, now, extras).today,
  };
}

// ─────────────────────────────────────────────────────────── this week

/** The days ending today, as Today's week card reads them: the last 7, or with Month the last 30. */
export interface PeriodSummary {
  /** How many days it covers, today included. */
  length: number;
  /** Each morning's battery, scored on the data up to that day; oldest first, null where there was no score. */
  battery: { date: CivilDate; score: number | null }[];
  /** Mean time asleep across the period's recorded nights. */
  sleep: { avgMin: number; nights: number } | null;
  /** Minutes in the WHO's currency, today's so far included: Active Zone Minutes when the period has them. */
  activeMinutes: { total: number; unit: 'azm' | 'brisk' } | null;
  /** Finished days only: today's count is still climbing. `atGoal` counts the days that reached the step goal. */
  steps: { avg: number; days: number; atGoal: number } | null;
}

/** The seven days ending today. */
export type WeekSummary = PeriodSummary;

export const weekSummary = (days: DailyRecord[], goals: Goals = DEFAULT_GOALS): PeriodSummary | null =>
  periodSummary(days, 7, goals);

/** The 30 days ending today, for the card's month view. */
export const monthSummary = (days: DailyRecord[], goals: Goals = DEFAULT_GOALS): PeriodSummary | null =>
  periodSummary(days, 30, goals);

function periodSummary(days: DailyRecord[], length: number, goals: Goals): PeriodSummary | null {
  const today = days.at(-1)?.date;
  if (!today) return null;
  const from = addDays(today, -(length - 1));
  const period = days.filter((d) => d.date >= from);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const battery = dateRange(from, today).map((date) => {
    const i = days.findIndex((d) => d.date === date);
    return { date, score: i < 0 ? null : readiness(days.slice(0, i + 1), goals.sleepNeed).score };
  });
  const nights = sleepMins(period, (s) => s.minutesAsleep);
  const azm = period.some((d) => d.zoneMinutes !== null);
  const brisk = period.some((d) => d.activeMinutes !== null);
  const steps = period
    .filter((d) => d.date !== today)
    .map((d) => d.steps)
    .filter((s): s is number => s !== null);

  return {
    length,
    battery,
    sleep: nights.length ? { avgMin: mean(nights), nights: nights.length } : null,
    activeMinutes: azm || brisk
      ? { total: period.reduce((a, d) => a + (azm ? zoneMins(d) : briskMins(d)), 0), unit: azm ? 'azm' : 'brisk' }
      : null,
    steps: steps.length
      ? { avg: mean(steps), days: steps.length, atGoal: steps.filter((s) => s >= goals.steps).length }
      : null,
  };
}
