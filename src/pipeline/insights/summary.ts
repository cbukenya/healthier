import { addDays, dateRange, type CivilDate } from '../../lib/date';
import type { DailyRecord } from '../../types/health';
import { scoreSleep } from '../sleep';
import {
  NOISE_FLOOR, compareToBaseline, estimatedSleepTarget, isRecent, readiness, series, sleepDebt,
} from '../derive';
import type { InsightDataset, InsightOptions } from './context';
import { STEP_GOAL, briskMins, sleepMins, zoneMins } from './helpers';
import { insightFeeds } from './engine';

/** Convenience: everything the Today view needs, computed once. */
export function todaySummary(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions) {
  const days = ds.days;
  const last = days[days.length - 1] ?? null;
  // Cards about now show readings from today or yesterday; anything older is history, not last night.
  const recent = (d: DailyRecord | undefined) => (d && isRecent(d.date, last?.date) ? d : null);
  const movementDay = recent([...days].reverse().find((d) => d.steps !== null));
  const sleepDay = recent([...days].reverse().find((d) => d.sleep !== null));

  const hrv = compareToBaseline(series(days, (d) => d.hrv), 28, 8, NOISE_FLOOR.hrv);
  const rhr = compareToBaseline(series(days, (d) => d.restingHr), 28, 8, NOISE_FLOOR.restingHr);

  return {
    today: last,
    movementDay,
    sleepDay,
    sleepScore: sleepDay?.sleep ? scoreSleep(sleepDay.sleep) : null,
    hrv,
    rhr,
    readiness: readiness(days),
    sleepTargetMin: estimatedSleepTarget(days),
    debt: sleepDebt(days, estimatedSleepTarget(days)),
    week: weekSummary(days),
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
  /** Finished days only: today's count is still climbing. */
  steps: { avg: number; days: number; atGoal: number } | null;
}

/** The seven days ending today. */
export type WeekSummary = PeriodSummary;

export const weekSummary = (days: DailyRecord[]): PeriodSummary | null => periodSummary(days, 7);

/** The 30 days ending today, for the card's month view. */
export const monthSummary = (days: DailyRecord[]): PeriodSummary | null => periodSummary(days, 30);

function periodSummary(days: DailyRecord[], length: number): PeriodSummary | null {
  const today = days.at(-1)?.date;
  if (!today) return null;
  const from = addDays(today, -(length - 1));
  const period = days.filter((d) => d.date >= from);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const battery = dateRange(from, today).map((date) => {
    const i = days.findIndex((d) => d.date === date);
    return { date, score: i < 0 ? null : readiness(days.slice(0, i + 1)).score };
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
      ? { avg: mean(steps), days: steps.length, atGoal: steps.filter((s) => s >= STEP_GOAL).length }
      : null,
  };
}
