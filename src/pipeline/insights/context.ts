import type { CivilDate } from '../../lib/date';
import { formatDuration } from '../../i18n/format';
import type { DailyRecord, HealthDataset, SleepSession } from '../../types/health';
import type { HistoryAnswers } from '../history';
import type { IntradayDays } from '../labs';
import type { ProfileFacts } from '../registry';
import {
  BASELINE_DAYS, isRecent, loadRatio, readiness, series, sleepDebt, sleepNeedFor, stats, values,
  type Point, type Readiness,
} from '../derive';
import { DEFAULT_GOALS, type Goals } from '../goals';
import type { CycleLog, CycleSummary, Night } from '../cycle';
import { beforeLatestMorning, daypartOf, wallClock } from './helpers';
import type { Daypart } from './types';

export interface InsightOptions {
  intraday?: IntradayDays;
  /** The zone `now` is read in. Defaults to this runtime's, which in the browser is the user's. */
  timeZone?: string;
  /** The person's goals; the defaults when they haven't set any. */
  goals?: Goals;
  /** Cycle tracking, only while it's on. */
  cycle?: CycleInsight;
}

/** What the cycle-aware cards read: the cycles found and logged, and the window judged with them in mind. */
export interface CycleInsight {
  summary: CycleSummary;
  nights: Night[];
  log: CycleLog;
  /**
   * The window's days with each second-half night moved back by the person's own shift
   * (cycleAdjusted), for judging what's unusual; null until three cycles show the shift.
   */
  judged: DailyRecord[] | null;
}

type ReadinessPart = Readiness['parts'][number];

/** The day grid, and the profile when the dataset carries one. */
export type InsightDataset = HealthDataset & {
  profile?: Pick<ProfileFacts, 'age' | 'heightCm'>;
  /** Answers to the history queries, from the stored days before the window. */
  answers?: HistoryAnswers;
};

/**
 * Everything the cards share, worked out once. "Today" is always the grid's
 * last day (the server ends the window on the user's today); the clock only
 * says whether it's morning, midday or evening.
 */
export interface InsightContext {
  days: DailyRecord[];
  today: CivilDate;
  todayRow: DailyRecord;
  minutesNow: number;
  part: Daypart;
  /** Day of the month, for the calendar cards. */
  dom: number;
  intraday?: IntradayDays;
  /** Years and centimetres, from the Google Health profile, when they're known. */
  age: number | null;
  heightCm: number | null;
  /** What the history queries found before the window: empty without older history, or before it has loaded. */
  answers: HistoryAnswers;
  /** The person's goals, the defaults where they haven't set one. */
  goals: Goals;
  /**
   * Personal sleep need in minutes, and as "7h 20m" (or "7h 00m", to read alongside a night's "5h 40m"):
   * the person's own figure when they've set one, else the estimate from their nights.
   */
  need: number;
  needH: string;
  stepsSeries: Point[];
  /** Today's steps are still counting, so whole-day comparisons read finished days only. */
  doneSteps: Point[];
  stepMedian: number | null;
  lastNightDay: DailyRecord | null;
  lastNight: SleepSession | null;
  lastNightIsRecent: boolean;
  /** The battery now, and as of the morning before the latest one. */
  rNow: Readiness;
  rPrev: Readiness;
  prevDays: DailyRecord[];
  topPos: ReadinessPart | null;
  topNeg: ReadinessPart | null;
  /**
   * Several overnight signals off at once: single-signal cards step aside. With cycle tracking on,
   * judged against the person's own cycle, so the second half of a cycle isn't mistaken for it.
   */
  illness: boolean;
  /** The same, as of the morning before the latest one. */
  illnessBefore: boolean;
  /** Cycle tracking, while it's on; null otherwise. */
  cycle: CycleInsight | null;
  /** The days judged against the person's own cycle, while tracking is on and a shift is known; null otherwise. */
  judged: DailyRecord[] | null;
  debt: ReturnType<typeof sleepDebt>;
  /** The battery's own debt figure, only from a fully recorded week. */
  debtMin: number | null;
  load: ReturnType<typeof loadRatio>;
}

export function buildContext(ds: InsightDataset, now: Date, extras?: InsightOptions): InsightContext | null {
  const days = ds.days;
  if (!days.length) return null;
  const todayRow = days[days.length - 1];
  const today = todayRow.date;
  const minutesNow = wallClock(now, extras?.timeZone);

  const goals = extras?.goals ?? DEFAULT_GOALS;
  const need = sleepNeedFor(days, goals.sleepNeed);
  const stepsSeries = series(days, (d) => d.steps);
  const doneSteps = stepsSeries.slice(0, -1);
  const lastNightDay = [...days].reverse().find((d) => d.sleep) ?? null;

  const rNow = readiness(days, goals.sleepNeed);
  const prevDays = beforeLatestMorning(days);
  const cycle = extras?.cycle ?? null;
  const judged = cycle?.judged ?? null;
  const rPrev = readiness(prevDays, goals.sleepNeed);
  // The battery's score stays the person's own. Whether several signals are off is judged with the
  // cycle in mind too, while tracking is on: the cycle can explain them away, never add them.
  const illness = rNow.flags.length > 0 && (!judged || readiness(judged, goals.sleepNeed).flags.length > 0);
  const illnessBefore = rPrev.flags.length > 0 && (!judged || readiness(beforeLatestMorning(judged), goals.sleepNeed).flags.length > 0);
  const byContribution = [...rNow.parts].sort((a, b) => b.contribution - a.contribution);
  const debt = sleepDebt(days, need);

  return {
    days,
    today,
    todayRow,
    minutesNow,
    part: daypartOf(minutesNow),
    dom: Number(today.slice(8, 10)),
    intraday: extras?.intraday,
    age: ds.profile?.age ?? null,
    heightCm: ds.profile?.heightCm ?? null,
    answers: ds.answers ?? {},
    goals,
    need,
    needH: formatDuration(need),
    stepsSeries,
    doneSteps,
    stepMedian: stats(values(doneSteps.slice(-BASELINE_DAYS)))?.median ?? null,
    lastNightDay,
    lastNight: lastNightDay?.sleep ?? null,
    lastNightIsRecent: isRecent(lastNightDay?.date, today),
    rNow,
    rPrev,
    prevDays,
    topPos: byContribution[0] ?? null,
    topNeg: byContribution[byContribution.length - 1] ?? null,
    illness,
    illnessBefore,
    cycle,
    judged,
    debt,
    debtMin: debt && debt.coverage === 'full' ? debt.netMin : null,
    load: loadRatio(doneSteps),
  };
}
