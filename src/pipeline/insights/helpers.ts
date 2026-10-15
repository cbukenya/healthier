import { civilClock, daysBetween, isoWeekdayIndex, type CivilDate } from '../../lib/date';
import { t } from '../../i18n';
import { formatMonth } from '../../i18n/format';
import type { DailyRecord } from '../../types/health';
import { BATTERY_TIERS } from '../derive';
import type { Daypart } from './types';

/** Show news for up to this many days after it starts. */
export const ENTRY_WINDOW = 2;
/** "Fully charged" on the battery's own scale: the green-light card fires from here. */
export const CHARGED = BATTERY_TIERS[0].min;
/** The low-battery card fires below this: the lower half of "Low", and "Drained". */
export const COAST_BELOW = 50;

// ───────────────────────────────────────────────────────────── the clock

export const daypartOf = (minutesOfDay: number): Daypart => {
  const h = minutesOfDay / 60;
  return h < 11 ? 'morning' : h < 16 ? 'midday' : 'evening';
};

/** Minutes past midnight on the user's wall clock: in `timeZone` when given, else this runtime's zone. */
export const wallClock = (now: Date, timeZone?: string) =>
  timeZone ? civilClock(timeZone)(now.getTime()).minutesOfDay : now.getHours() * 60 + now.getMinutes();

/** Mon–Fri, hardcoded by decision. */
export const isWorkday = (d: CivilDate) => isoWeekdayIndex(d) <= 4;

// ──────────────────────────────────────────────────────── plain-language figures

/** "since March 2025, as far back as your history goes": all time, said honestly. */
export const sinceHistory = (month: string, today: CivilDate) =>
  t('insights.common.sinceHistory', { month: formatMonth(month, today) });

/**
 * Whether a record's readings reach back a year, so it's a record "in the past year": once they go
 * back that far, with a month's grace for a late start. A rule picks its words from this, never
 * from the phrase pastYear() returns, which is in the person's language.
 */
export const reachesYear = (first: CivilDate | null, today: CivilDate) => !first || daysBetween(first, today) >= 335;

/**
 * How far back a record reaches, said: "in the past year" once readings go back that far, else
 * since the readings began.
 */
export const pastYear = (first: CivilDate | null, today: CivilDate) =>
  first === null || reachesYear(first, today) ? t('insights.common.pastYear') : sinceHistory(first, today);

// ──────────────────────────────────────────────────────────── day arithmetic

export const circDelta = (a: number, b: number) => ((a - b + 720 + 1440) % 1440) - 720;

export const sleepMins = (slice: DailyRecord[], get: (s: NonNullable<DailyRecord['sleep']>) => number) =>
  slice.map((d) => (d.sleep ? get(d.sleep) : null)).filter((m): m is number => m !== null);

/**
 * A day's minutes in the WHO's currency, where vigorous counts double. Active Zone Minutes
 * already weight it that way (1/min in fat burn, 2/min in cardio and peak); the fallback,
 * moderate + 2 × vigorous, keeps the same currency.
 */
export const zoneMins = (d: DailyRecord) =>
  d.zoneMinutes ? d.zoneMinutes.fatBurn + 2 * (d.zoneMinutes.cardio + d.zoneMinutes.peak) : 0;
export const briskMins = (d: DailyRecord) =>
  d.activeMinutes ? d.activeMinutes.moderate + 2 * d.activeMinutes.vigorous : 0;

// ─────────────────────────────────────────────── stateless guards

/** Truncate the grid by n days: the heart of the yesterday test. */
export const cut = (days: DailyRecord[], n: number) => days.slice(0, Math.max(0, days.length - n));

/**
 * Entry guard: the predicate holds now but did not hold ENTRY_WINDOW+1 days
 * ago, so the state was entered recently and the insight is news. Also serves
 * hysteresis when the caller passes a *reset* predicate for the past check.
 */
export function entered(
  days: DailyRecord[],
  firesNow: (w: DailyRecord[]) => boolean,
  heldBefore: (w: DailyRecord[]) => boolean = firesNow,
): boolean {
  return firesNow(days) && !heldBefore(cut(days, ENTRY_WINDOW + 1));
}

/** A trend that lapsed for less than this many days and came back is the same story resuming, not news. */
export const QUIET_DAYS = 7;

/**
 * Entry guard for states that wobble around their threshold: news when the state
 * began within the entry window (it has held for at most ENTRY_WINDOW + 1 days
 * running) and held on none of the QUIET_DAYS days before it began. A trend that
 * lapsed for a day or two and came back stays on its page, saying how long it has
 * held, instead of arriving on Today as if it were new. `heldAgo(n)` re-runs the
 * state on the grid cut back n days; `heldAgo(0)` is now.
 */
export function freshEntry(heldAgo: (n: number) => boolean): boolean {
  let run = 0;
  while (run <= ENTRY_WINDOW + 1 && heldAgo(run)) run++;
  if (run === 0 || run > ENTRY_WINDOW + 1) return false;
  for (let n = run; n < run + QUIET_DAYS; n++) if (heldAgo(n)) return false;
  return true;
}

/**
 * How many days a state has held, by re-running it on the window cut back a
 * day at a time: the yesterday test, repeated. Standing cards use it to say
 * how long something has been true.
 */
export const HELD_MAX = 28;

export function heldFor(days: DailyRecord[], holds: (w: DailyRecord[]) => boolean, max = HELD_MAX): number {
  let n = 0;
  while (n < max && n < days.length && holds(cut(days, n))) n++;
  return n;
}

/**
 * Consecutive days meeting a per-day test, counted back from the latest observation. Days after it
 * (today, not synced yet) are skipped; a missing day inside the run ends it, so "third night running"
 * never reaches across a gap.
 */
export function trailingDays(days: DailyRecord[], test: (d: DailyRecord) => boolean | null): number {
  let n = 0;
  let started = false;
  for (let i = days.length - 1; i >= 0; i--) {
    const r = test(days[i]);
    if (r === null) {
      if (started) break;
      continue;
    }
    started = true;
    if (!r) break;
    n++;
  }
  return n;
}

/**
 * The grid as it stood before its latest morning with overnight readings (sleep, HRV or resting HR).
 * Day-over-day rules compare against this, so they always compare two different nights, even before
 * today's has synced.
 */
export function beforeLatestMorning(days: DailyRecord[]): DailyRecord[] {
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.sleep || d.hrv !== null || d.restingHr !== null) return days.slice(0, i);
  }
  return [];
}

/**
 * A standing card's note on how long it has held, once that's long enough to be worth saying:
 * a sentence with its leading space, for the end of a card's text.
 */
export const sinceNote = (held: number, unit: 'day' | 'night' = 'day') =>
  held >= HELD_MAX ? t('insights.common.sinceNote.longTime')
    : held >= 3 ? t('insights.common.sinceNote.count', { unit, count: held }) : '';
