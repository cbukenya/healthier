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

/** The seven days ending today, as Today's week card reads them. */
export interface WeekSummary {
  /** Each morning's battery, scored on the data up to that day; oldest first, null where there was no score. */
  battery: { date: CivilDate; score: number | null }[];
  /** Mean time asleep across the week's recorded nights. */
  sleep: { avgMin: number; nights: number } | null;
  /** Minutes in the WHO's currency, today's so far included: Active Zone Minutes when the week has them. */
  activeMinutes: { total: number; unit: 'azm' | 'brisk' } | null;
  /** Finished days only: today's count is still climbing. */
  steps: { avg: number; days: number; atGoal: number } | null;
}

export function weekSummary(days: DailyRecord[]): WeekSummary | null {
  const today = days.at(-1)?.date;
  if (!today) return null;
  const from = addDays(today, -6);
  const week = days.filter((d) => d.date >= from);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const battery = dateRange(from, today).map((date) => {
    const i = days.findIndex((d) => d.date === date);
    return { date, score: i < 0 ? null : readiness(days.slice(0, i + 1)).score };
  });
  const nights = sleepMins(week, (s) => s.minutesAsleep);
  const azm = week.some((d) => d.zoneMinutes !== null);
  const brisk = week.some((d) => d.activeMinutes !== null);
  const steps = week
    .filter((d) => d.date !== today)
    .map((d) => d.steps)
    .filter((s): s is number => s !== null);

  return {
    battery,
    sleep: nights.length ? { avgMin: mean(nights), nights: nights.length } : null,
    activeMinutes: azm || brisk
      ? { total: week.reduce((a, d) => a + (azm ? zoneMins(d) : briskMins(d)), 0), unit: azm ? 'azm' : 'brisk' }
      : null,
    steps: steps.length
      ? { avg: mean(steps), days: steps.length, atGoal: steps.filter((s) => s >= STEP_GOAL).length }
      : null,
  };
}
