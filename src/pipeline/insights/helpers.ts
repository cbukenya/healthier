import { civilClock, isoWeekdayIndex, type CivilDate } from '../../lib/date';
import type { DailyRecord } from '../../types/health';
import { BATTERY_TIERS } from '../derive';
import type { Daypart } from './types';

/** Show news for up to this many days after it starts. */
export const ENTRY_WINDOW = 2;
/** Google's Health API offers no step goal to read, so everyone starts at 10,000 until the app has a setting. */
export const STEP_GOAL = 10000;
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

/** "7h 05m", rounded to the minute first so 479.6 reads 8h 00m, not 7h 00m. */
export const hm = (mins: number) => {
  const m = Math.round(mins);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** A sleep need as "7h" or "7h 18m"; the median behind it can land on a half minute. */
export const needLabel = (need: number) => {
  const m = Math.round(need);
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}`;
};

export const clk = (m: number) => {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');

/** "18 August". */
export const dayMonth = (d: CivilDate) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/** "3.6 hours", or "1 hour". */
export const hoursText = (mins: number) => {
  const h = (mins / 60).toFixed(1);
  return h === '1.0' ? '1 hour' : `${h} hours`;
};

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "a, b and c". */
export const listOf = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** A standing card's note on how long it has held, once that's long enough to be worth saying. */
export const sinceNote = (held: number, unit = 'day') =>
  held >= HELD_MAX ? " It's been like this for four weeks or more."
    : held >= 3 ? ` It's been like this for ${plural(held, unit)}.` : '';
