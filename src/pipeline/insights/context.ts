import type { CivilDate } from '../../lib/date';
import type { DailyRecord, HealthDataset, SleepSession } from '../../types/health';
import type { IntradayDays } from '../labs';
import type { ProfileFacts } from '../registry';
import {
  estimatedSleepTarget, isRecent, loadRatio, readiness, series, sleepDebt, stats, values,
  type Point, type Readiness,
} from '../derive';
import { beforeLatestMorning, daypartOf, hm, wallClock } from './helpers';
import type { Daypart } from './types';

export interface InsightOptions {
  intraday?: IntradayDays;
  /** The zone `now` is read in. Defaults to this runtime's, which in the browser is the user's. */
  timeZone?: string;
}

type ReadinessPart = Readiness['parts'][number];

/** The day grid, and the profile when the dataset carries one. */
export type InsightDataset = HealthDataset & { profile?: Pick<ProfileFacts, 'age' | 'heightCm'> };

/**
 * Everything the rules share, worked out once. "Today" is always the grid's
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
  /** Personal sleep need in minutes, and as "7h 20m" (or "7h 00m", to read alongside a night's "5h 40m"). */
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
  /** Several overnight signals off at once: single-signal cards step aside. */
  illness: boolean;
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

  const need = estimatedSleepTarget(days);
  const stepsSeries = series(days, (d) => d.steps);
  const doneSteps = stepsSeries.slice(0, -1);
  const lastNightDay = [...days].reverse().find((d) => d.sleep) ?? null;

  const rNow = readiness(days);
  const prevDays = beforeLatestMorning(days);
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
    need,
    needH: hm(need),
    stepsSeries,
    doneSteps,
    stepMedian: stats(values(doneSteps.slice(-28)))?.median ?? null,
    lastNightDay,
    lastNight: lastNightDay?.sleep ?? null,
    lastNightIsRecent: isRecent(lastNightDay?.date, today),
    rNow,
    rPrev: readiness(prevDays),
    prevDays,
    topPos: byContribution[0] ?? null,
    topNeg: byContribution[byContribution.length - 1] ?? null,
    illness: rNow.flags.length > 0,
    debt,
    debtMin: debt && debt.coverage === 'full' ? debt.netMin : null,
    load: loadRatio(doneSteps),
  };
}
