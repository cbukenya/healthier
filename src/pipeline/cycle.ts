import { addDays, daysBetween, type CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import type { HistoryAnswers, HistoryQueries } from './history';

/**
 * Cycles: found in the nightly signals, and made certain by the person's own log.
 *
 * Google Health doesn't share periods with other apps: its menstrual-period data can be added
 * but not read back. What can be read are the night-time signals the watch records, and they
 * have a rhythm: after ovulation, progesterone raises body temperature by about 0.3 to 0.5 °C,
 * resting heart rate rises and HRV dips, and all three fall back around the next period (Goodale
 * et al., JMIR 2019, who found it in wrist sensors). So cycles are found in the nights, whether or
 * not anything is logged. Logging adds to that: a period the person logs, or a start they confirm,
 * is certain, so it counts twice as much as one found in the data, and teaches Healthier how their
 * own nights line up with their periods.
 *
 * Everything is arithmetic over the nights and the log, worked out on every read. Nothing found
 * is stored. It describes cycles after the fact and gives ranges from the person's own; it never
 * marks fertile days and is not a form of contraception.
 */

// ─────────────────────────────────────────────────────────────── the log

/** How heavy a day's bleeding was. `unspecified`: the period started, and how heavy wasn't said. */
export const FLOWS = ['spotting', 'light', 'medium', 'heavy', 'unspecified'] as const;
export type Flow = (typeof FLOWS)[number];

/** Spotting is noted, but it doesn't start or extend a period. */
const BLEEDING: ReadonlySet<Flow> = new Set(['light', 'medium', 'heavy', 'unspecified']);

export const SYMPTOMS = [
  'cramps', 'headache', 'bloating', 'breasts', 'back', 'acne', 'tired', 'low-mood', 'irritable', 'cravings', 'sleep',
] as const;
export type Symptom = (typeof SYMPTOMS)[number];

/** One logged day. A day with nothing on it isn't kept. */
export interface CycleDay {
  date: CivilDate;
  flow?: Flow;
  symptoms?: Symptom[];
  note?: string;
}

export interface CycleSettings {
  /** The Cycle page and its cards. Off until the person turns it on; nothing about cycles runs without it. */
  tracking: boolean;
  /** Cycle cards may show on Today. Off keeps them on the Cycle page. */
  todayCards: boolean;
  /**
   * The other pages allow for the cycle when they judge a night (see cycleAdjusted). Off, they read
   * the nights as for someone who doesn't track cycles; the Cycle page and its cards stay.
   */
  otherPages: boolean;
}

/** What the person keeps: settings, logged days, and the found starts they said weren't a period. */
export interface CycleLog {
  settings: CycleSettings;
  days: CycleDay[];
  rejected: CivilDate[];
}

export const DEFAULT_CYCLE_SETTINGS: CycleSettings = { tracking: false, todayCards: true, otherPages: true };
export const EMPTY_CYCLE_LOG: CycleLog = { settings: DEFAULT_CYCLE_SETTINGS, days: [], rejected: [] };

export const MAX_NOTE = 500;
/** About ten years of daily logs: more than anyone keeps, small enough to read whole. */
const MAX_DAYS = 4000;
const MAX_REJECTED = 1000;

const isCivilDate = (v: unknown): v is CivilDate => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** A day as sent: null when anything in it is malformed. Empty fields are dropped. */
export function parseCycleDay(date: unknown, raw: unknown): CycleDay | null {
  if (!isCivilDate(date) || !raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const day: CycleDay = { date };
  if (o.flow !== undefined && o.flow !== null) {
    if (!FLOWS.includes(o.flow as Flow)) return null;
    day.flow = o.flow as Flow;
  }
  if (o.symptoms !== undefined && o.symptoms !== null) {
    if (!Array.isArray(o.symptoms) || !o.symptoms.every((s) => SYMPTOMS.includes(s as Symptom))) return null;
    const unique = SYMPTOMS.filter((s) => (o.symptoms as unknown[]).includes(s));
    if (unique.length) day.symptoms = unique;
  }
  if (o.note !== undefined && o.note !== null) {
    if (typeof o.note !== 'string' || o.note.length > MAX_NOTE) return null;
    const note = o.note.trim();
    if (note) day.note = note;
  }
  return day;
}

/**
 * Settings as sent: null unless each is a boolean. `otherPages` came later, so a page loaded before
 * it may leave it out, and it stays on.
 */
export function parseCycleSettings(raw: unknown): CycleSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.tracking !== 'boolean' || typeof o.todayCards !== 'boolean') return null;
  if (o.otherPages !== undefined && typeof o.otherPages !== 'boolean') return null;
  return {
    tracking: o.tracking,
    todayCards: o.todayCards,
    otherPages: typeof o.otherPages === 'boolean' ? o.otherPages : DEFAULT_CYCLE_SETTINGS.otherPages,
  };
}

/** A day with something on it. */
export const hasEntry = (d: CycleDay) => !!(d.flow || d.symptoms?.length || d.note);

/**
 * The log as stored: whatever can't be read is left out, one entry per date, oldest first, so a
 * change to what a day may hold never leaves anyone with a log the app can't open.
 */
export function readCycleLog(raw: unknown): CycleLog {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (o.settings && typeof o.settings === 'object' ? o.settings : {}) as Record<string, unknown>;
  const settings: CycleSettings = {
    tracking: typeof s.tracking === 'boolean' ? s.tracking : DEFAULT_CYCLE_SETTINGS.tracking,
    todayCards: typeof s.todayCards === 'boolean' ? s.todayCards : DEFAULT_CYCLE_SETTINGS.todayCards,
    otherPages: typeof s.otherPages === 'boolean' ? s.otherPages : DEFAULT_CYCLE_SETTINGS.otherPages,
  };
  const byDate = new Map<CivilDate, CycleDay>();
  for (const d of Array.isArray(o.days) ? o.days.slice(0, MAX_DAYS) : []) {
    const day = d && typeof d === 'object' ? parseCycleDay((d as CycleDay).date, d) : null;
    if (day && hasEntry(day)) byDate.set(day.date, day);
  }
  const rejected = new Set<CivilDate>((Array.isArray(o.rejected) ? o.rejected : []).filter(isCivilDate).slice(0, MAX_REJECTED));
  return {
    settings,
    days: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    rejected: [...rejected].sort(),
  };
}

/** The log with one day replaced; a day with nothing on it is removed. */
export function withDay(log: CycleLog, day: CycleDay): CycleLog {
  const days = log.days.filter((d) => d.date !== day.date);
  if (hasEntry(day)) days.push(day);
  if (days.length > MAX_DAYS) return log;
  return { ...log, days: days.sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

/** The log with a found start marked as not a period, or that mark taken back. */
export function withRejected(log: CycleLog, date: CivilDate, rejected: boolean): CycleLog {
  const set = new Set(log.rejected);
  if (rejected) set.add(date);
  else set.delete(date);
  if (set.size > MAX_REJECTED) return log;
  return { ...log, rejected: [...set].sort() };
}

/** Periods as logged: runs of bleeding days, a one-day gap allowed inside a run. */
export function loggedPeriods(days: CycleDay[]): { start: CivilDate; end: CivilDate; length: number | null }[] {
  const dates = days.filter((d) => d.flow && BLEEDING.has(d.flow)).map((d) => d.date).sort();
  const out: { start: CivilDate; end: CivilDate; length: number | null }[] = [];
  for (const date of dates) {
    const last = out[out.length - 1];
    if (last && daysBetween(last.end, date) <= 2) last.end = date;
    else out.push({ start: date, end: date, length: null });
  }
  // A single logged day says when a period started, not how long it lasted.
  for (const p of out) p.length = p.start === p.end ? null : daysBetween(p.start, p.end) + 1;
  return out;
}

// ──────────────────────────────────────────────────────────── the nights

/** One night's signals, by the day the night ended. */
export interface Night {
  date: CivilDate;
  /** Skin temperature, °C from the watch's own baseline. */
  temp: number | null;
  restingHr: number | null;
  hrv: number | null;
  /** Minutes asleep, for the cards that read sleep through the cycle. */
  asleep?: number | null;
}

/** How far back the cycles reach: about eight cycles, so six full ones are there to go on. */
export const CYCLE_HISTORY_DAYS = 240;

/** The older nights the Cycle page needs, asked for with the dataset (see history.ts). */
export const cycleQueries = {
  cycleTemp: { measure: 'skinTempDeviationC', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
  cycleRestingHr: { measure: 'restingHr', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
  cycleHrv: { measure: 'hrv', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
  cycleAsleep: { measure: 'sleepMinutes', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
} satisfies HistoryQueries;

/** Every night from the oldest answered to the window's last day, gaps included as nulls. */
export function nightsFrom(days: DailyRecord[], answers: HistoryAnswers = {}): Night[] {
  if (!days.length) return [];
  const byDate = new Map<CivilDate, Night>();
  const night = (date: CivilDate) => {
    let n = byDate.get(date);
    if (!n) byDate.set(date, (n = { date, temp: null, restingHr: null, hrv: null }));
    return n;
  };
  const older: [keyof typeof cycleQueries, 'temp' | 'restingHr' | 'hrv' | 'asleep'][] = [
    ['cycleTemp', 'temp'], ['cycleRestingHr', 'restingHr'], ['cycleHrv', 'hrv'], ['cycleAsleep', 'asleep'],
  ];
  const windowFrom = days[0].date;
  for (const [query, field] of older) {
    for (const row of answers[query]?.rows ?? []) {
      if (row.key && row.key < windowFrom && typeof row.mean === 'number' && Number.isFinite(row.mean)) night(row.key)[field] = row.mean;
    }
  }
  for (const d of days) {
    const n = night(d.date);
    n.temp = d.skinTempDeviationC;
    n.restingHr = d.restingHr;
    n.hrv = d.hrv;
    n.asleep = d.sleep?.minutesAsleep ?? null;
  }
  const dates = [...byDate.keys()].sort();
  const out: Night[] = [];
  for (let date = dates[0]; date <= days[days.length - 1].date; date = addDays(date, 1)) {
    out.push(byDate.get(date) ?? { date, temp: null, restingHr: null, hrv: null });
  }
  return out;
}

// ───────────────────────────────────────────────────────── finding cycles

/**
 * How far a run of high nights has to stand above the nights on both sides of it, in spreads of
 * the nightly signal (nightlySignal). In the second half of a cycle temperature rises by 0.28 to
 * 0.56 °C, about one spread of a watch's nightly skin temperature, and resting heart rate by a few
 * beats (Goodale et al. 2019). On simulated nights as noisy as a real watch's, 0.9 found most cycles
 * in people who have them, and almost none in people who don't; the tests hold both.
 */
export const MIN_SHIFT_SD = 0.9;
/** The low nights compared on each side of a run of high ones: about a week either side. */
const SIDE = 6;
/**
 * A fall is sure once this many nights from it are in, so a found start has settled by day
 * FALL_NIGHTS − offset of its cycle. It can show a night or two sooner, a day or two early.
 */
export const FALL_NIGHTS = SIDE;
/** Nights in a row that, low inside a run of high ones, break it: a fever between two lows, say. */
const DIP_NIGHTS = 4;
/** An average needs this share of its nights. */
const COVERAGE = 0.6;
/** A change is the biggest within this many nights either side; which of two changes counts is settled later. */
const NEARBY = 3;
/**
 * How long the high nights last, from the rise to the fall. The second half of a cycle runs about
 * 7 to 17 days (the 95% range in 612,613 cycles; Bull et al., npj Digital Medicine 2019), so a fall
 * without a rise 7 to 18 nights before it is a fever or a warm room, not a cycle.
 */
const HIGH_MIN = 7;
const HIGH_MAX = 18;
/**
 * The day after the fall: the temperature drops as progesterone does, around the start of a
 * period. The person's confirmed starts replace this with their own (calibrateOffset).
 */
export const DEFAULT_OFFSET = 1;
/** A found start this close to a logged one is the same start. */
const SAME_START_DAYS = 5;
/**
 * A rhythm: two cycles in a row of 21 to 38 days. Most adults' cycles run 24 to 38 days (FIGO's
 * normal limits; Fraser et al. 2011), with a little room either side for a start found a day or
 * two off.
 */
const RHYTHM_MIN = 21;
const RHYTHM_MAX = 38;
const RHYTHM_RUN = 2;
/** Where the rhythm expects a start: this close, and this smaller a change, will do. */
const GUIDED_DAYS = 4;
const GUIDED_MIN_SD = 0.6;
/** Cycles outside this are left out of the typical cycle: most are a missed start, not a real cycle. */
export const MIN_CYCLE = 18;
export const MAX_CYCLE = 45;
/** How much each start counts: one the person logged or confirmed is certain. */
export const WEIGHT_LOGGED = 1;
export const WEIGHT_FOUND = 0.5;
/** The typical cycle reads the last six; it needs three to say anything. */
export const CYCLES_FOR_RANGE = 6;
export const MIN_CYCLES = 3;
/** Ninety nights recorded in the last 120 with no cycle in them: three cycles' worth, and no rhythm to show. */
const NO_RHYTHM_SPAN = 120;
const NO_RHYTHM_NIGHTS = 90;

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One shift: where the nights rose, where they fell back (null while still up), and its levels. */
export interface Shift {
  rise: CivilDate;
  fall: CivilDate | null;
  /** The nightly signal on either side of the run, and through it, in spreads. */
  low: number;
  high: number;
}

/** Where a score peaks: at least `min`, and the biggest within NEARBY nights either side. */
function peaks(score: (number | null)[], min: number): number[] {
  const out: number[] = [];
  score.forEach((v, i) => {
    if (!isNum(v) || v < min) return;
    for (let j = Math.max(0, i - NEARBY); j <= Math.min(score.length - 1, i + NEARBY); j++) {
      const w = score[j];
      // Ties go to the earlier night.
      if (j !== i && isNum(w) && (w > v || (w === v && j < i))) return;
    }
    out.push(i);
  });
  return out;
}

/** Every rise in the nights, each with the fall that ended it, oldest first; the last may still be up. */
export function findShifts(nights: Night[]): Shift[] {
  return shiftsIn(nights, nightlySignal(nights), MIN_SHIFT_SD);
}

/** The signals that move together through a cycle, each with the way it moves and how much it counts. */
const SIGNALS: { field: 'temp' | 'restingHr' | 'hrv'; sign: 1 | -1; weight: number }[] = [
  { field: 'temp', sign: 1, weight: 1 },
  { field: 'restingHr', sign: 1, weight: 1 },
  { field: 'hrv', sign: -1, weight: 0.5 },
];
/** Each night is read against the 61 nights around it, so a slow drift over the seasons isn't a cycle. */
const AROUND = 30;
/** A night further out than this, in spreads, counts as this far: a fever can't swamp the rest. */
const CLAMP_SD = 3;

/**
 * One number a night for how far into the second half of a cycle the body looks: skin temperature
 * and resting heart rate up, HRV down (Goodale et al. 2019 found all three in the second half).
 * Each is measured in its own spreads (standard deviations) from its own average over the nights
 * around, so a degree and a beat count alike, then averaged, HRV counting half. A night needs its
 * temperature or its resting heart rate.
 */
export function nightlySignal(nights: Night[]): (number | null)[] {
  const scored = SIGNALS.map(({ field, sign }) => {
    const x = nights.map((n) => n[field]);
    return x.map((v, i) => {
      if (!isNum(v)) return null;
      const around = x.slice(Math.max(0, i - AROUND), i + AROUND + 1).filter(isNum);
      if (around.length < 20) return null;
      // The mean and spread move smoothly as a cycle's halves come and go from the nights around,
      // where a median would jump from one half to the other.
      const mid = mean(around);
      const spread = Math.sqrt(mean(around.map((w) => (w - mid) ** 2)));
      if (!(spread > 0)) return null;
      return sign * Math.max(-CLAMP_SD, Math.min(CLAMP_SD, (v - mid) / spread));
    });
  });
  return nights.map((_, i) => {
    if (scored[0][i] === null && scored[1][i] === null) return null;
    let sum = 0;
    let weight = 0;
    SIGNALS.forEach(({ weight: w }, k) => {
      const z = scored[k][i];
      if (z !== null) {
        sum += w * z;
        weight += w;
      }
    });
    return sum / weight;
  });
}

/**
 * The shifts in one nightly series. A shift is a run of 7 to 18 high nights: the nights from the
 * rise to the fall, compared with the SIDE nights before the rise and the SIDE nights from the
 * fall. Both sides have to be lower by at least `min`. Comparing a whole run with both its sides
 * lets a cycle show through noise that would hide any single night's change, and a slow drift,
 * which leaves one side as high as the run, never passes.
 */
export function shiftsIn(nights: Night[], t: (number | null)[], min: number): Shift[] {
  const n = t.length;
  // Running sums and counts, for the average of any run of nights in one step.
  const sum = [0];
  const count = [0];
  for (const v of t) {
    sum.push(sum[sum.length - 1] + (isNum(v) ? v : 0));
    count.push(count[count.length - 1] + (isNum(v) ? 1 : 0));
  }
  const avg = (a: number, b: number): number | null => {
    if (a < 0 || b >= n || b < a) return null;
    const k = count[b + 1] - count[a];
    return k >= Math.ceil((b - a + 1) * COVERAGE) ? (sum[b + 1] - sum[a]) / k : null;
  };

  // A run is high throughout: never DIP_NIGHTS in a row nearer its sides than its own level.
  const steady = (r: number, f: number, high: number, low: number) => {
    const mid = (high + low) / 2;
    let below = 0;
    for (let k = r; k < f; k++) {
      const v = t[k];
      below = isNum(v) && v < mid ? below + 1 : 0;
      if (below >= DIP_NIGHTS) return false;
    }
    return true;
  };

  // For each night as the fall, the rise 7 to 18 nights before it that stands out most from both
  // sides. Each side has to be lower by `min`; the score is how far the run sits above them both.
  const best = t.map((_, f) => {
    let top: { r: number; score: number; low: number; high: number } | null = null;
    for (let r = f - HIGH_MAX; r <= f - HIGH_MIN; r++) {
      const high = avg(r, f - 1);
      const before = avg(r - SIDE, r - 1);
      const after = avg(f, f + SIDE - 1);
      if (high === null || before === null || after === null) continue;
      if (high - before < min || high - after < min) continue;
      const low = (before + after) / 2;
      const score = high - low;
      if ((!top || score > top.score) && steady(r, f, high, low)) top = { r, score, low, high };
    }
    return top;
  });

  const out: (Shift & { at: number; size: number })[] = [];
  for (const f of peaks(best.map((b) => b?.score ?? null), min)) {
    const b = best[f]!;
    const prev = out[out.length - 1];
    // Two falls closer than the shortest cycle: the one that stands out more.
    if (prev && f - prev.at < MIN_CYCLE) {
      if (b.score <= prev.size) continue;
      out.pop();
    }
    out.push({ rise: nights[b.r].date, fall: nights[f].date, low: b.low, high: b.high, at: f, size: b.score });
  }

  // The cycle under way: a rise since the last fall whose nights have stayed up to the latest one.
  const from = out.length ? out[out.length - 1].at + HIGH_MIN : SIDE;
  let current: { r: number; score: number; low: number; high: number } | null = null;
  // The run from the rise to the latest night is HIGH_MAX nights at most: the rise is looked for
  // that far back, however long ago the last fall was.
  for (let r = Math.max(from, SIDE, n - HIGH_MAX); r <= n - 4; r++) {
    const high = avg(r, n - 1);
    const before = avg(r - SIDE, r - 1);
    if (high === null || before === null) continue;
    const score = high - before;
    if (score >= min && (!current || score > current.score) && steady(r, n, high, before)) current = { r, score, low: before, high };
  }
  if (current) out.push({ rise: nights[current.r].date, fall: null, low: current.low, high: current.high, at: n, size: 0 });
  return out.map(({ rise, fall, low, high }) => ({ rise, fall, low, high }));
}

/**
 * Days from a fall to the start of the period, from the person's own confirmed starts: the median
 * of each start against the fall nearest it, once there are two. Until then, DEFAULT_OFFSET.
 */
export function calibrateOffset(shifts: Shift[], logged: CivilDate[]): number {
  const gaps = offsetGaps(shifts, logged);
  return gaps.length < 2 ? DEFAULT_OFFSET : Math.min(3, Math.max(0, Math.round(median(gaps))));
}

/** Each confirmed start against the fall nearest it, in days, where there is one. */
function offsetGaps(shifts: Shift[], logged: CivilDate[]): number[] {
  const falls = shifts.map((s) => s.fall).filter((f): f is CivilDate => f !== null);
  const gaps: number[] = [];
  for (const start of logged) {
    let best: number | null = null;
    for (const fall of falls) {
      const gap = daysBetween(fall, start);
      if (gap >= -2 && gap <= 4 && (best === null || Math.abs(gap - DEFAULT_OFFSET) < Math.abs(best - DEFAULT_OFFSET))) best = gap;
    }
    if (best !== null) gaps.push(best);
  }
  return gaps;
}

// ──────────────────────────────────────────────────────────────── cycles

export type StartSource = 'logged' | 'found';

export interface CycleStart {
  date: CivilDate;
  source: StartSource;
  weight: number;
}

export interface Cycle {
  start: CivilDate;
  source: StartSource;
  /** The next cycle's start; null for the cycle under way. */
  next: CivilDate | null;
  /** Days, start to next start; null for the cycle under way. */
  length: number | null;
  /** The night the temperature rose, when it did. */
  rise: CivilDate | null;
  /** Days of the period as logged; null when only its start was logged, or it was found. */
  periodDays: number | null;
  /** The lesser of its two starts' weights: a cycle is as certain as its least certain end. */
  weight: number;
}

export interface Range {
  min: number;
  max: number;
  /** The weighted middle. */
  typical: number;
  count: number;
}

export interface CycleSummary {
  /**
   * `ready`: a cycle is under way. `collecting`: not enough nights or logs yet. `no-rhythm`: eight
   * weeks of nights with no rise in them and nothing logged.
   */
  status: 'ready' | 'collecting' | 'no-rhythm';
  /** Oldest first; the last is the one under way, when there is one. */
  cycles: Cycle[];
  /** The cycle under way, and where today sits in it. */
  current: (Cycle & { day: number; riseDay: number | null; phase: 'before-rise' | 'after-rise' }) | null;
  /** The last six complete cycles inside MIN_CYCLE to MAX_CYCLE, once there are three; how many began with a logged period and how many were found. */
  length: (Range & { logged: number; found: number }) | null;
  /** Days from the rise to the next start, in cycles that have both. */
  afterRise: Range | null;
  /** Logged periods with an end. */
  period: Range | null;
  /** When the next period is likely, and what the range rests on. */
  next: { from: CivilDate; to: CivilDate; likely: CivilDate; basis: 'cycles' | 'rise' } | null;
  /** Days from a fall to a start, for this person. */
  offset: number;
  /** The offset comes from the person's own confirmed starts, not the default. */
  offsetLearned: boolean;
  /** The cycle day the temperature rose on, in complete cycles that have one. */
  riseDay: Range | null;
  /** Found starts, before any confirmation: for the page to offer to confirm. */
  found: CivilDate[];
}

/** The weighted middle: the first value at which half the total weight is reached. */
export function weightedMedian(items: { value: number; weight: number }[]): number {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((a, x) => a + x.weight, 0);
  let seen = 0;
  for (const x of sorted) {
    seen += x.weight;
    if (seen >= total / 2) return x.value;
  }
  return sorted[sorted.length - 1].value;
}

const rangeOf = (items: { value: number; weight: number }[]): Range | null =>
  items.length < MIN_CYCLES
    ? null
    : {
      min: Math.min(...items.map((x) => x.value)),
      max: Math.max(...items.map((x) => x.value)),
      typical: weightedMedian(items),
      count: items.length,
    };

/** Logged starts, and found ones no log or rejection covers, kept at least MIN_CYCLE apart. */
export function cycleStarts(found: CivilDate[], log: CycleLog, today: CivilDate): CycleStart[] {
  const logged = loggedPeriods(log.days).map((p) => p.start).filter((d) => d <= today);
  const near = (a: CivilDate, b: CivilDate, days: number) => Math.abs(daysBetween(a, b)) <= days;
  const all: CycleStart[] = [
    ...logged.map((date) => ({ date, source: 'logged' as const, weight: WEIGHT_LOGGED })),
    ...found
      .filter((date) => date <= today)
      .filter((date) => !logged.some((l) => near(l, date, SAME_START_DAYS)))
      .filter((date) => !log.rejected.some((r) => near(r, date, 2)))
      .map((date) => ({ date, source: 'found' as const, weight: WEIGHT_FOUND })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  let kept: CycleStart[] = [];
  for (const s of all) {
    if (s.source === 'found') {
      const crowded = all.some((o) => o.source === 'logged' && near(o.date, s.date, MIN_CYCLE - 1))
        || (kept.length > 0 && daysBetween(kept[kept.length - 1].date, s.date) < MIN_CYCLE);
      if (crowded) continue;
    }
    kept.push(s);
  }
  // Found starts count only as part of a rhythm. Leaving one out joins its neighbours' cycles,
  // which can make a rhythm of them, so this repeats until nothing changes.
  for (;;) {
    const next = inRhythm(kept);
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

/**
 * A found start counts when it's part of a rhythm: RHYTHM_RUN cycles in a row each RHYTHM_MIN to
 * RHYTHM_MAX days long, or a cycle like that next to a start the person logged. One change in
 * temperature that doesn't repeat is a warm spell, not a cycle; this is what keeps someone without
 * cycles from being shown any.
 */
function inRhythm(starts: CycleStart[]): CycleStart[] {
  // Two cycles' worth between starts is one start missed: the rhythm carries on across it.
  const regular = (a: CycleStart, b: CycleStart) => {
    const days = daysBetween(a.date, b.date);
    return (days >= RHYTHM_MIN && days <= RHYTHM_MAX) || (days >= 2 * RHYTHM_MIN && days <= 2 * RHYTHM_MAX);
  };
  const keep = new Set<CycleStart>(starts.filter((s) => s.source === 'logged'));
  let run: CycleStart[] = [];
  const close = () => {
    if (run.length - 1 >= RHYTHM_RUN || run.some((s) => s.source === 'logged')) run.forEach((s) => keep.add(s));
    run = [];
  };
  for (const s of starts) {
    if (run.length && !regular(run[run.length - 1], s)) close();
    run.push(s);
  }
  close();
  return starts.filter((s) => keep.has(s));
}

/**
 * Where a rhythm is established, a start the first look missed is looked for again where the
 * rhythm expects it, with a lower bar: a change that wouldn't count on its own counts when it
 * falls within GUIDED_DAYS of the day the person's own cycles point to. It's how anyone reads
 * their own chart.
 */
function fillGaps(starts: CycleStart[], weaker: CivilDate[], today: CivilDate): CycleStart[] {
  const lengths: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const days = daysBetween(starts[i - 1].date, starts[i].date);
    if (days >= RHYTHM_MIN && days <= RHYTHM_MAX) lengths.push(days);
  }
  if (lengths.length < RHYTHM_RUN) return starts;
  const typical = Math.round(median(lengths.slice(-CYCLES_FOR_RANGE)));
  const out = [...starts];
  for (let i = 0; i < out.length; i++) {
    const from = out[i].date;
    const to = out[i + 1]?.date ?? null;
    const gap = daysBetween(from, to ?? today);
    if (to ? gap <= RHYTHM_MAX : gap <= typical + GUIDED_DAYS) continue;
    const expected = addDays(from, typical);
    const fits = weaker
      .filter((d) => Math.abs(daysBetween(d, expected)) <= GUIDED_DAYS)
      .filter((d) => daysBetween(from, d) >= MIN_CYCLE && (!to || daysBetween(d, to) >= MIN_CYCLE))
      .sort((a, b) => Math.abs(daysBetween(a, expected)) - Math.abs(daysBetween(b, expected)));
    if (fits.length) out.splice(i + 1, 0, { date: fits[0], source: 'found', weight: WEIGHT_FOUND });
  }
  return out;
}

/** Everything the Cycle page and the cycle-aware cards read, from the nights and the log. */
export function summarizeCycles(nights: Night[], log: CycleLog, today: CivilDate): CycleSummary {
  const upToToday = nights.filter((n) => n.date <= today);
  const signal = nightlySignal(upToToday);
  const shifts = shiftsIn(upToToday, signal, MIN_SHIFT_SD);
  const periods = loggedPeriods(log.days);
  const offset = calibrateOffset(shifts, periods.map((p) => p.start));
  const offsetLearned = offsetGaps(shifts, periods.map((p) => p.start)).length >= 2;
  const startsOf = (list: Shift[]) => list
    .filter((s): s is Shift & { fall: CivilDate } => s.fall !== null)
    .map((s) => addDays(s.fall, offset))
    .filter((d) => d <= today && !log.rejected.some((r) => Math.abs(daysBetween(r, d)) <= 2));
  const found = startsOf(shifts);
  const starts = fillGaps(cycleStarts(found, log, today), startsOf(shiftsIn(upToToday, signal, GUIDED_MIN_SD)), today);

  const cycles: Cycle[] = starts.map((s, i) => {
    const next = starts[i + 1]?.date ?? null;
    const end = next ?? addDays(today, 1);
    // The rise inside this cycle: a few days after it starts, and before it ends.
    const rise = shifts.find((sh) => sh.rise >= addDays(s.date, 4) && sh.rise <= addDays(end, -3))?.rise ?? null;
    const period = periods.find((p) => p.start === s.date);
    return {
      start: s.date,
      source: s.source,
      next,
      length: next ? daysBetween(s.date, next) : null,
      rise,
      periodDays: period?.length ?? null,
      weight: next ? Math.min(s.weight, starts[i + 1].weight) : s.weight,
    };
  });

  const complete = cycles.filter((c): c is Cycle & { length: number } => c.length !== null && c.length >= MIN_CYCLE && c.length <= MAX_CYCLE);
  const recent = complete.slice(-CYCLES_FOR_RANGE);
  const lengthRange = rangeOf(recent.map((c) => ({ value: c.length, weight: c.weight })));
  const afterRise = rangeOf(
    complete
      .filter((c) => c.rise !== null)
      .map((c) => ({ value: daysBetween(c.rise!, c.next!), weight: c.weight }))
      .filter((x) => x.value >= 7 && x.value <= 17)
      .slice(-CYCLES_FOR_RANGE),
  );
  const period = rangeOf(
    periods.filter((p) => p.length !== null).slice(-CYCLES_FOR_RANGE).map((p) => ({ value: p.length!, weight: WEIGHT_LOGGED })),
  );
  const riseDay = rangeOf(
    complete
      .filter((c) => c.rise !== null)
      .slice(-CYCLES_FOR_RANGE)
      .map((c) => ({ value: daysBetween(c.start, c.rise!) + 1, weight: c.weight })),
  );

  const last = cycles[cycles.length - 1];
  // A cycle that began more than two longest cycles ago isn't under way any more: something was missed.
  const current = last && last.next === null && daysBetween(last.start, today) < 2 * MAX_CYCLE
    ? (() => {
      const day = daysBetween(last.start, today) + 1;
      const riseDay = last.rise ? daysBetween(last.start, last.rise) + 1 : null;
      return { ...last, day, riseDay, phase: riseDay ? ('after-rise' as const) : ('before-rise' as const) };
    })()
    : null;

  let next: CycleSummary['next'] = null;
  if (current && lengthRange) {
    next = {
      from: addDays(current.start, lengthRange.min),
      to: addDays(current.start, lengthRange.max),
      likely: addDays(current.start, lengthRange.typical),
      basis: 'cycles',
    };
    // Once the temperature has risen, the days left are steadier than the days before the rise.
    if (current.rise && afterRise && afterRise.max - afterRise.min < lengthRange.max - lengthRange.min) {
      next = {
        from: addDays(current.rise, afterRise.min),
        to: addDays(current.rise, afterRise.max),
        likely: addDays(current.rise, afterRise.typical),
        basis: 'rise',
      };
    }
  }

  // No rhythm: most of the last four months recorded, and no cycle started in them.
  const since = addDays(today, -(NO_RHYTHM_SPAN - 1));
  const recorded = nights.filter((n) => n.date >= since && n.date <= today && isNum(n.temp)).length;
  const status: CycleSummary['status'] = current
    ? 'ready'
    : recorded >= NO_RHYTHM_NIGHTS && !starts.some((s) => s.date >= since)
      ? 'no-rhythm'
      : 'collecting';

  return {
    status,
    cycles,
    current,
    length: lengthRange
      ? { ...lengthRange, logged: recent.filter((c) => c.source === 'logged').length, found: recent.filter((c) => c.source === 'found').length }
      : null,
    afterRise,
    period,
    next,
    offset,
    offsetLearned,
    riseDay,
    found,
  };
}

/**
 * How this cycle's nights since the rise differ from its nights before it: temperature in °C,
 * resting heart rate in bpm, HRV in ms. Null for a measure without three nights on each side.
 */
export function sinceRise(nights: Night[], summary: CycleSummary): Record<'temp' | 'restingHr' | 'hrv', number | null> | null {
  const c = summary.current;
  if (!c || !c.rise) return null;
  const inCycle = nights.filter((n) => n.date >= c.start);
  const shift = (field: 'temp' | 'restingHr' | 'hrv') => {
    const before = inCycle.filter((n) => n.date < c.rise!).map((n) => n[field]).filter(isNum);
    const after = inCycle.filter((n) => n.date >= c.rise!).map((n) => n[field]).filter(isNum);
    return before.length >= 3 && after.length >= 3 ? mean(after) - mean(before) : null;
  };
  return { temp: shift('temp'), restingHr: shift('restingHr'), hrv: shift('hrv') };
}

/**
 * One measure through the cycle, by cycle day: this cycle's nights so far, and the middle and the
 * spread (the middle half) of the last six complete cycles on the same day.
 */
export function byCycleDay(
  nights: Night[],
  summary: CycleSummary,
  field: 'temp' | 'restingHr' | 'hrv',
  days = 35,
): { day: number; mine: number | null; middle: number | null; low: number | null; high: number | null }[] {
  const index = new Map(nights.map((n) => [n.date, n]));
  const past = summary.cycles
    .filter((c) => c.length !== null && c.length >= MIN_CYCLE && c.length <= MAX_CYCLE)
    .slice(-CYCLES_FOR_RANGE);
  const out = [];
  for (let day = 1; day <= days; day++) {
    const values = past
      .filter((c) => day <= c.length!)
      .map((c) => index.get(addDays(c.start, day - 1))?.[field])
      .filter(isNum)
      .sort((a, b) => a - b);
    const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
    const date = summary.current ? addDays(summary.current.start, day - 1) : null;
    const mine = summary.current && day <= summary.current.day ? index.get(date!)?.[field] ?? null : null;
    out.push({
      day,
      mine: isNum(mine) ? mine : null,
      middle: values.length >= 3 ? median(values) : null,
      low: values.length >= 3 ? q(0.25) : null,
      high: values.length >= 3 ? q(0.75) : null,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────── aware elsewhere

export type Shifts = Record<'temp' | 'restingHr' | 'hrv', number | null>;

/**
 * How far this person's nights move in the second half of a cycle: for each measure, the middle
 * of each complete cycle's nights after the rise against its nights before it, over the last six
 * cycles that rose. Null for a measure until three cycles show it, and held to the way the second
 * half moves each measure (temperature and resting heart rate up, HRV down), so noise can't turn
 * a correction the wrong way.
 */
export function typicalShifts(nights: Night[], summary: CycleSummary): Shifts {
  const shift = (field: 'temp' | 'restingHr' | 'hrv', lo: number, hi: number) => {
    const each = cycleShifts(nights, summary, field);
    return each.length >= MIN_CYCLES ? Math.min(hi, Math.max(lo, median(each))) : null;
  };
  return { temp: shift('temp', 0, 0.8), restingHr: shift('restingHr', 0, 6), hrv: shift('hrv', -25, 0) };
}

/** Each of the last six complete cycles that rose: its nights after the rise against its nights before, with three a side or more. */
export function cycleShifts(nights: Night[], summary: CycleSummary, field: 'temp' | 'restingHr' | 'hrv'): number[] {
  const index = new Map(nights.map((n) => [n.date, n]));
  const cycles = summary.cycles.filter((c) => c.next !== null && c.rise !== null).slice(-CYCLES_FOR_RANGE);
  return cycles.flatMap((c) => {
    const before: number[] = [];
    const after: number[] = [];
    for (let d = c.start; d < c.next!; d = addDays(d, 1)) {
      const v = index.get(d)?.[field];
      if (isNum(v)) (d < c.rise! ? before : after).push(v);
    }
    return before.length >= 3 && after.length >= 3 ? [mean(after) - mean(before)] : [];
  });
}

/** The nights in the second half of a cycle: from each rise to the night before the next start, or to today. */
export function secondHalf(summary: CycleSummary, today: CivilDate): Set<CivilDate> {
  const out = new Set<CivilDate>();
  for (const c of summary.cycles) {
    if (!c.rise) continue;
    const end = c.next ? addDays(c.next, -1) : today;
    for (let d = c.rise; d <= end; d = addDays(d, 1)) out.add(d);
  }
  return out;
}

/** The days judged against the person's own cycle (see cycleAdjusted), once three cycles show a shift; null before. */
export function judgedDays(days: DailyRecord[], nights: Night[], summary: CycleSummary, today: CivilDate): DailyRecord[] | null {
  const shifts = typicalShifts(nights, summary);
  return Object.values(shifts).some((v) => v !== null) ? cycleAdjusted(days, summary, shifts, today) : null;
}

/**
 * The days with each second-half night's readings moved back by the person's own shift. Only for
 * judging what's unusual, never for showing: a resting heart rate that's up by just as much as
 * the second half of a cycle moves it isn't unusual for that night.
 */
export function cycleAdjusted(days: DailyRecord[], summary: CycleSummary, shifts: Shifts, today: CivilDate): DailyRecord[] {
  const half = secondHalf(summary, today);
  // Each shift in whole steps of the readings it moves (whole bpm, whole ms, hundredths of a
  // degree), so moved readings keep the same steps as the rest. Otherwise readings a fraction off
  // the whole numbers around them would shrink the usual range's spread and turn small changes
  // into large ones.
  const less = (v: number | null, by: number | null, step: number) =>
    v === null || by === null ? v : v - Math.round(by / step) * step;
  return days.map((d) => (half.has(d.date)
    ? {
      ...d,
      skinTempDeviationC: less(d.skinTempDeviationC, shifts.temp, 0.01),
      restingHr: less(d.restingHr, shifts.restingHr, 1),
      hrv: less(d.hrv, shifts.hrv, 1),
      hrvDeepSleep: less(d.hrvDeepSleep, shifts.hrv, 1),
    }
    : d));
}

