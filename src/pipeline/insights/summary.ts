import { addDays, dateRange, type CivilDate } from '../../lib/date';
import type { DailyRecord } from '../../types/health';
import { scoreSleep } from '../sleep';
import {
  compareVital, fullDays, isRecent, readiness, sleepDebt, sleepNorms,
} from '../derive';
import { DEFAULT_GOALS, type Goals } from '../goals';
import type { InsightDataset, InsightOptions } from './context';
import { sleepMins, whoWeek } from './helpers';
import { insightFeeds } from './engine';

/** Convenience: everything the Today view needs, computed once. */
export function todaySummary(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions) {
  const days = ds.days;
  const goals = extras?.goals ?? DEFAULT_GOALS;
  const norms = sleepNorms(days, goals.sleepNeed);
  const need = norms.need;
  // With cycle tracking on, the battery softens a penalty the cycle explains (see readiness).
  const judged = extras?.cycle?.judged ?? null;
  const last = days[days.length - 1] ?? null;
  // Cards about now show readings from today or yesterday; anything older is history, not last night.
  const recent = (d: DailyRecord | undefined) => (d && isRecent(d.date, last?.date) ? d : null);
  const movementDay = recent([...days].reverse().find((d) => d.steps !== null));
  const sleepDay = recent([...days].reverse().find((d) => d.sleep !== null));

  const hrv = compareVital(days, 'hrv');
  const rhr = compareVital(days, 'restingHr');

  return {
    today: last,
    movementDay,
    sleepDay,
    sleepScore: sleepDay?.sleep ? scoreSleep(sleepDay.sleep, norms) : null,
    hrv,
    rhr,
    readiness: readiness(days, goals.sleepNeed, judged),
    sleepTargetMin: need,
    debt: sleepDebt(days, need),
    week: weekSummary(days, goals, judged),
    observations: insightFeeds(ds, now, extras).today,
  };
}

// ─────────────────────────────────────────────────────────── this week

/**
 * The days ending today, as Today's week card reads them: the last 7, or with Month the last 30.
 * The battery and sleep include this morning and last night. Movement reads as many full days,
 * the last of them yesterday, since today's is still climbing: the same 7 days as Activity's
 * "Last 7 days" and the week in review.
 */
export interface PeriodSummary {
  /** How many days it covers, today included. */
  length: number;
  /** Each morning's battery, scored on the data up to that day; oldest first, null where there was no score. */
  battery: { date: CivilDate; score: number | null }[];
  /** Mean time asleep across the period's recorded nights. */
  sleep: { avgMin: number; nights: number } | null;
  /**
   * Minutes in the WHO's currency over the full days: Active Zone Minutes when they have them. The
   * total is what the days earned; `perWeek` is the average week, over the days that recorded any.
   */
  activeMinutes: { total: number; unit: 'azm' | 'brisk'; perWeek: number } | null;
  /** Over the full days. `atGoal` counts the days that reached the step goal. */
  steps: { avg: number; days: number; atGoal: number } | null;
}

/** The seven days ending today. */
export type WeekSummary = PeriodSummary;

export const weekSummary = (days: DailyRecord[], goals: Goals = DEFAULT_GOALS, judged: DailyRecord[] | null = null): PeriodSummary | null =>
  periodSummary(days, 7, goals, judged);

/** The 30 days ending today, for the card's month view. */
export const monthSummary = (days: DailyRecord[], goals: Goals = DEFAULT_GOALS, judged: DailyRecord[] | null = null): PeriodSummary | null =>
  periodSummary(days, 30, goals, judged);

function periodSummary(days: DailyRecord[], length: number, goals: Goals, judged: DailyRecord[] | null): PeriodSummary | null {
  const today = days.at(-1)?.date;
  if (!today) return null;
  const from = addDays(today, -(length - 1));
  const period = days.filter((d) => d.date >= from);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const battery = dateRange(from, today).map((date) => {
    const i = days.findIndex((d) => d.date === date);
    return { date, score: i < 0 ? null : readiness(days.slice(0, i + 1), goals.sleepNeed, judged).score };
  });
  const nights = sleepMins(period, (s) => s.minutesAsleep);
  // Movement: the same number of full days, ending yesterday.
  const done = fullDays(days, today, length);
  const who = whoWeek(done);
  const steps = done.map((d) => d.steps).filter((s): s is number => s !== null);

  return {
    length,
    battery,
    sleep: nights.length ? { avgMin: mean(nights), nights: nights.length } : null,
    activeMinutes: who ? { total: who.total, unit: who.unit, perWeek: who.perWeek } : null,
    steps: steps.length
      ? { avg: mean(steps), days: steps.length, atGoal: steps.filter((s) => s >= goals.steps).length }
      : null,
  };
}
