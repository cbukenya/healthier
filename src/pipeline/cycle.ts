import { addDays, daysBetween, type CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import { SHAPES, SHAPE_FROM, type ShapeMeasure } from './cycleShapes';
import type { HistoryAnswers, HistoryQueries } from './history';

/**
 * Cycles: found in the nightly signals, and made certain by the person's own log.
 *
 * Google Health doesn't share periods with other apps: its menstrual-period data can be added
 * but not read back. What can be read are the night-time signals the watch records, and they have
 * a rhythm. After ovulation, progesterone raises sleeping and resting heart rate, lowers HRV, and
 * warms the skin and quickens breathing a little; all of it falls back as the next period starts
 * (Goodale et al., JMIR 2019, who found it in wrist sensors).
 * - **Found in the nights:** cycles are found there whether or not anything is logged, by the
 *   shape those measures make around a period start (cycleShapes.ts).
 * - **Logging adds to that:** a period the person logs, or a start they confirm, is certain. It
 *   counts twice as much as one found in the data, and teaches Healthier how their own nights
 *   line up with their periods.
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
  /** Heart rate in non-REM sleep, bpm. */
  sleepHr?: number | null;
  /** Breaths a minute asleep. */
  breath?: number | null;
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
  cycleSleepHr: { measure: 'nonRemHr', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
  cycleBreath: { measure: 'respiratoryRate', aggregate: 'mean', group: 'day', back: CYCLE_HISTORY_DAYS },
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
  const older: [keyof typeof cycleQueries, 'temp' | 'restingHr' | 'hrv' | 'sleepHr' | 'breath' | 'asleep'][] = [
    ['cycleTemp', 'temp'], ['cycleRestingHr', 'restingHr'], ['cycleHrv', 'hrv'], ['cycleSleepHr', 'sleepHr'],
    ['cycleBreath', 'breath'], ['cycleAsleep', 'asleep'],
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
    n.sleepHr = d.nonRemHr;
    n.breath = d.respiratoryRate;
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

/** Nights from a period's first day before its start can be found: the shape needs a few after it. */
export const FIRST_SEEN_NIGHTS = 3;
/**
 * A start in the last week of nights shows only once the drop after it has: its first DROP_NIGHTS
 * nights lower than the six before it by DROP_MIN spreads. Without that, the second half of a cycle
 * still under way looks like the run-up to a period that hasn't come.
 */
const DROP_NIGHTS = 4;
const DROP_MIN = 0.4;
/**
 * Found starts are drawn through the person's own rhythm: one per cycle, 21 to 45 nights apart,
 * gaps near their usual length preferred by this much. Tuned on mcPHASES.
 */
const CHAIN_MIN = 21;
const CHAIN_MAX = 45;
const CHAIN_PULL = 0.1;
/**
 * How much the found starts have to stand out before they're shown, when nothing is logged: the
 * mean of their scores, at least EVIDENCE_FLOOR, and higher for fewer starts (a few can look strong
 * by chance). Set on people simulated without cycles, with the noise mcPHASES shows once its cycles
 * are taken out: at most 1 in 20 of them pass, at any history length. 73% of mcPHASES's three-month
 * stretches pass; the rest show "Finding your rhythm" until a period is logged.
 */
const EVIDENCE_FLOOR = 1.62;
const EVIDENCE_BASE = 0.98;
const EVIDENCE_FEW = 1.76;
export const evidenceBar = (starts: number) => Math.max(EVIDENCE_FLOOR, EVIDENCE_BASE + EVIDENCE_FEW / Math.sqrt(Math.max(2, starts)));

/**
 * The second half of a cycle, from the end of the fertile days to the next period, runs about the
 * same length from one cycle to the next: in mcPHASES, a median of 11 days to the next start, and
 * within a day of that for the same person. So it's counted back from the next start rather than
 * looked for in the nights. With the next start known, that put it within three days of the
 * hormone-marked day in 81% of cycles (88% for the people held out), where the best night-shape
 * search managed 77% (69%).
 */
export const SECOND_HALF_DAYS = 11;
/**
 * From where the nights' shape puts a start to the first day of bleeding. In mcPHASES the shapes
 * line up with the hormone-marked start, which people's own bleeding followed by a day. The
 * person's confirmed starts replace this with their own (calibrateOffset).
 */
export const DEFAULT_OFFSET = 1;
/** A found start this close to a logged one is the same start. */
const SAME_START_DAYS = 5;
/** Cycles outside this are left out of the typical cycle: most are a missed start, not a real cycle. */
export const MIN_CYCLE = 18;
export const MAX_CYCLE = 45;
/** How much each start counts: one the person logged or confirmed is certain. */
export const WEIGHT_LOGGED = 1;
export const WEIGHT_FOUND = 0.5;
/** The typical cycle reads the last six; it needs three to say anything. */
export const CYCLES_FOR_RANGE = 6;
export const MIN_CYCLES = 3;
/**
 * With two cycles, an early guess at the next period: their lengths, EARLY_PAD days wider either
 * side, since either start may have been found a few days off. It gives way to the typical cycle
 * at three.
 */
export const EARLY_CYCLES = 2;
const EARLY_PAD = 2;
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

/** Each night is read against the 61 nights around it, so a slow drift over the seasons isn't a cycle. */
const AROUND = 30;
/** A night further out than this, in spreads, counts as this far: a fever can't swamp the rest. */
const CLAMP_SD = 3;

/**
 * One measure's nights, each in spreads from its own average over the 61 nights around it, clamped
 * at CLAMP_SD. The mean and spread move smoothly as a cycle's halves come and go from the nights
 * around, where a median would jump from one half to the other.
 */
function standardized(x: (number | null | undefined)[]): (number | null)[] {
  return x.map((v, i) => {
    if (!isNum(v)) return null;
    const around = x.slice(Math.max(0, i - AROUND), i + AROUND + 1).filter(isNum);
    if (around.length < 20) return null;
    const mid = mean(around);
    const spread = Math.sqrt(mean(around.map((w) => (w - mid) ** 2)));
    if (!(spread > 0)) return null;
    return Math.max(-CLAMP_SD, Math.min(CLAMP_SD, (v - mid) / spread));
  });
}

/**
 * For every night, how much the nights around it look like the nights around a period start
 * (cycleShapes.ts). Each measure's nights are set against its own shape, using the nights that are
 * there, and the results are added up, the measures that move most counting most. A night needs
 * FIRST_SEEN_NIGHTS nights from it, and half of a shape's weight in nights, to be scored at all.
 */
export function startScores(nights: Night[]): (number | null)[] {
  const n = nights.length;
  const total = new Array<number>(n).fill(0);
  const weight = new Array<number>(n).fill(0);
  let allWeight = 0;
  for (const m of Object.keys(SHAPES) as ShapeMeasure[]) {
    const { size, shape } = SHAPES[m];
    allWeight += size;
    const z = standardized(nights.map((x) => x[m]));
    for (let i = 0; i < n; i++) {
      let s = 0;
      let e = 0;
      let after = 0;
      for (let k = 0; k < shape.length; k++) {
        const v = z[i + SHAPE_FROM + k];
        if (!isNum(v)) continue;
        s += shape[k] * v;
        e += shape[k] ** 2;
        if (SHAPE_FROM + k >= 0) after++;
      }
      if (e >= 0.5 && after >= FIRST_SEEN_NIGHTS) {
        total[i] += size * (s / Math.sqrt(e));
        weight[i] += size;
      }
    }
  }
  return total.map((t, i) => (weight[i] >= 0.3 * allWeight ? t / weight[i] : null));
}

/**
 * One start per cycle, drawn through the person's own rhythm. In each stretch of scored nights
 * (a stretch ends where 20 nights go unscored), it's the chain of nights CHAIN_MIN to CHAIN_MAX
 * apart with the most score between them, gaps near the person's usual length preferred. The
 * usual length comes from the strongest peaks first, then from the chain itself.
 */
function chainStarts(score: (number | null)[]): number[] {
  const stretches: [number, number][] = [];
  let first = -1;
  let last = -1;
  score.forEach((v, i) => {
    if (!isNum(v)) return;
    if (first < 0) first = i;
    else if (i - last > 20) {
      stretches.push([first, last]);
      first = i;
    }
    last = i;
  });
  if (first >= 0) stretches.push([first, last]);

  const out: number[] = [];
  for (const [from, to] of stretches) {
    if (to - from < CHAIN_MIN + 10) continue;
    // In this stretch's own spreads, so the pull toward the usual length means the same for everyone.
    const vals = score.slice(from, to + 1).filter(isNum);
    const mid = mean(vals);
    const spread = Math.sqrt(mean(vals.map((v) => (v - mid) ** 2))) || 1;
    const at = (i: number) => {
      const v = score[i];
      return isNum(v) ? (v - mid) / spread : -0.5;
    };
    // The usual length: the middle gap between the strongest peaks, at least 20 nights apart.
    const strong: number[] = [];
    const order: number[] = [];
    for (let i = from; i <= to; i++) if (isNum(score[i]) && at(i) > 1) order.push(i);
    order.sort((a, b) => at(b) - at(a));
    for (const i of order) if (strong.every((k) => Math.abs(k - i) >= 20)) strong.push(i);
    strong.sort((a, b) => a - b);
    const gaps = strong.slice(1).map((x, i) => x - strong[i]).filter((g) => g >= CHAIN_MIN && g <= 40);
    const run = (usual: number) => {
      const n = to - from + 1;
      const best = new Array<number>(n).fill(-Infinity);
      const prev = new Array<number>(n).fill(-1);
      for (let k = 0; k < n; k++) {
        // The chain may begin anywhere in the stretch's first cycle's worth of nights.
        if (k <= CHAIN_MAX) best[k] = at(from + k);
        for (let g = CHAIN_MIN; g <= CHAIN_MAX && k - g >= 0; g++) {
          const v = best[k - g] - CHAIN_PULL * ((g - usual) / 4) ** 2 + at(from + k);
          if (v > best[k]) {
            best[k] = v;
            prev[k] = k - g;
          }
        }
      }
      // And it ends in the last cycle's worth.
      let end = -1;
      for (let k = Math.max(0, n - CHAIN_MAX); k < n; k++) if (end < 0 || best[k] > best[end]) end = k;
      const chain: number[] = [];
      for (let k = end; k >= 0; k = prev[k]) chain.push(from + k);
      return chain.reverse();
    };
    let chain = run(gaps.length >= 2 ? median(gaps) : 28);
    const own = chain.slice(1).map((x, i) => x - chain[i]);
    if (own.length >= 2) chain = run(median(own));
    out.push(...chain);
  }
  return out;
}

/**
 * One number a night for how far into the second half the body looks, from all five measures:
 * each in its own spreads, turned so up means second half, weighted as their shapes are.
 */
function secondHalfLevel(nights: Night[]): (number | null)[] {
  const parts = (Object.keys(SHAPES) as ShapeMeasure[]).map((m) => {
    const { size, shape } = SHAPES[m];
    // The way the measure moves in the second half: its shape's sign four nights before a start.
    const sign = Math.sign(shape[-4 - SHAPE_FROM]);
    return { size, sign, z: standardized(nights.map((x) => x[m])) };
  });
  return nights.map((_, i) => {
    let s = 0;
    let w = 0;
    for (const { size, sign, z } of parts) {
      const v = z[i];
      if (isNum(v)) {
        s += size * sign * v;
        w += size;
      }
    }
    return w > 0 ? s / w : null;
  });
}

/** The starts the nights show, before any log, and how much they stand out: the mean of their scores. */
export function findStarts(nights: Night[]): { starts: CivilDate[]; evidence: number; chained: number } {
  const score = startScores(nights);
  const level = secondHalfLevel(nights);
  const avg = (a: number, b: number) => {
    const xs = level.slice(Math.max(0, a), Math.min(level.length, b + 1)).filter(isNum);
    return xs.length >= 3 ? mean(xs) : null;
  };
  const chain = chainStarts(score);
  // How much they stand out is judged on the whole chain, as the bar was set (evidenceBar).
  const scores = chain.map((i) => score[i]).filter(isNum);
  const shown = chain.filter((i) => {
    if (nights.length - 1 - i >= 7) return true;
    const before = avg(i - 6, i - 1);
    const after = avg(i, i + DROP_NIGHTS - 1);
    return before !== null && after !== null && before - after >= DROP_MIN;
  });
  return { starts: shown.map((i) => nights[i].date), evidence: scores.length >= 2 ? mean(scores) : -Infinity, chained: chain.length };
}

/**
 * Days from where the nights put a start to the first day of bleeding, from the person's own
 * confirmed starts: the median of each against the found start nearest it, once there are two.
 * Until then, DEFAULT_OFFSET.
 */
export function calibrateOffset(found: CivilDate[], logged: CivilDate[]): number {
  const gaps = offsetGaps(found, logged);
  return gaps.length < 2 ? DEFAULT_OFFSET : Math.min(3, Math.max(-2, Math.round(median(gaps))));
}

/** Each confirmed start against the found start nearest it, in days, where one is within four days of the usual. */
function offsetGaps(found: CivilDate[], logged: CivilDate[]): number[] {
  const gaps: number[] = [];
  for (const start of logged) {
    let best: number | null = null;
    for (const f of found) {
      const gap = daysBetween(f, start);
      if (Math.abs(gap - DEFAULT_OFFSET) <= 4 && (best === null || Math.abs(gap - DEFAULT_OFFSET) < Math.abs(best - DEFAULT_OFFSET))) best = gap;
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
  /**
   * The first night of the second half, counted back SECOND_HALF_DAYS from the next start: for the
   * cycle under way, from the likely one, once that night has come. Null for a cycle too short to have one.
   */
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
   * `ready`: a cycle is under way. `collecting`: not enough nights or logs yet. `no-rhythm`: most of
   * four months of nights with no cycle standing out in them, and nothing logged.
   */
  status: 'ready' | 'collecting' | 'no-rhythm';
  /** Oldest first; the last is the one under way, when there is one. */
  cycles: Cycle[];
  /** The cycle under way, and where today sits in it. */
  current: (Cycle & { day: number; riseDay: number | null; phase: 'before-rise' | 'after-rise' }) | null;
  /** The last six complete cycles inside MIN_CYCLE to MAX_CYCLE, once there are three; how many began with a logged period and how many were found. */
  length: (Range & { logged: number; found: number }) | null;
  /** Logged periods with an end. */
  period: Range | null;
  /** When the next period is likely, from the person's cycle lengths: an `early` guess from two cycles is wider. */
  next: { from: CivilDate; to: CivilDate; likely: CivilDate; basis: 'cycles' | 'early' } | null;
  /** The two cycles an early guess rests on, before there are three for `length`. */
  early: Range | null;
  /** Days from where the nights put a start to the first day of bleeding, for this person. */
  offset: number;
  /** The offset comes from the person's own confirmed starts, not the default. */
  offsetLearned: boolean;
  /** The cycle day the second half began on, in complete cycles that have one. */
  riseDay: Range | null;
  /** Found starts, before any confirmation: for the page to offer to confirm. Empty when they don't stand out enough to show. */
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
  const kept: CycleStart[] = [];
  for (const s of all) {
    if (s.source === 'found') {
      const crowded = all.some((o) => o.source === 'logged' && near(o.date, s.date, MIN_CYCLE - 1))
        || (kept.length > 0 && daysBetween(kept[kept.length - 1].date, s.date) < MIN_CYCLE);
      if (crowded) continue;
    }
    kept.push(s);
  }
  return kept;
}

/** Everything the Cycle page and the cycle-aware cards read, from the nights and the log. */
export function summarizeCycles(nights: Night[], log: CycleLog, today: CivilDate): CycleSummary {
  const upToToday = nights.filter((n) => n.date <= today);
  const periods = loggedPeriods(log.days);
  const logged = periods.map((p) => p.start);
  // A period logged within these nights shows there are cycles in them. Without one, the found
  // starts have to stand out enough that someone without cycles wouldn't see any.
  const seen = findStarts(upToToday);
  const confirmed = upToToday.length > 0 && logged.some((d) => d >= upToToday[0].date && d <= today);
  const shown = confirmed || seen.evidence >= evidenceBar(seen.chained) ? seen.starts : [];
  const offset = calibrateOffset(shown, logged);
  const offsetLearned = offsetGaps(shown, logged).length >= 2;
  const found = shown
    .map((d) => addDays(d, offset))
    .filter((d) => d <= today && !log.rejected.some((r) => Math.abs(daysBetween(r, d)) <= 2));
  const starts = cycleStarts(found, log, today);
  const cycles: Cycle[] = starts.map((s, i) => {
    const next = starts[i + 1]?.date ?? null;
    // Its second half, counted back from the next start.
    const rise = next && daysBetween(s.date, next) >= MIN_CYCLE ? addDays(next, -SECOND_HALF_DAYS) : null;
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
  const period = rangeOf(
    periods.filter((p) => p.length !== null).slice(-CYCLES_FOR_RANGE).map((p) => ({ value: p.length!, weight: WEIGHT_LOGGED })),
  );
  const riseDay = rangeOf(
    complete
      .filter((c) => c.rise !== null)
      .slice(-CYCLES_FOR_RANGE)
      .map((c) => ({ value: daysBetween(c.start, c.rise!) + 1, weight: c.weight })),
  );

  const early = !lengthRange && recent.length >= EARLY_CYCLES
    ? { min: Math.min(...recent.map((c) => c.length)), max: Math.max(...recent.map((c) => c.length)), typical: Math.round(mean(recent.map((c) => c.length))), count: recent.length }
    : null;

  // A cycle that began more than two longest cycles ago isn't under way any more: something was missed.
  const last = cycles[cycles.length - 1];
  const underWay = last && last.next === null && daysBetween(last.start, today) < 2 * MAX_CYCLE ? last : null;
  // Its second half, counted back from the day its period is likely, once that night has come.
  const typical = lengthRange?.typical ?? early?.typical ?? null;
  if (underWay && typical !== null && addDays(underWay.start, typical - SECOND_HALF_DAYS) <= today) {
    underWay.rise = addDays(underWay.start, typical - SECOND_HALF_DAYS);
  }
  const current = underWay
    ? (() => {
      const day = daysBetween(underWay.start, today) + 1;
      const riseDay = underWay.rise ? daysBetween(underWay.start, underWay.rise) + 1 : null;
      return { ...underWay, day, riseDay, phase: riseDay ? ('after-rise' as const) : ('before-rise' as const) };
    })()
    : null;

  let next: CycleSummary['next'] = null;
  if (current && early) {
    next = {
      from: addDays(current.start, early.min - EARLY_PAD),
      to: addDays(current.start, early.max + EARLY_PAD),
      likely: addDays(current.start, early.typical),
      basis: 'early',
    };
  }
  if (current && lengthRange) {
    next = {
      from: addDays(current.start, lengthRange.min),
      to: addDays(current.start, lengthRange.max),
      likely: addDays(current.start, lengthRange.typical),
      basis: 'cycles',
    };
  }

  // No rhythm: most of the last four months recorded, and no cycle shown in them.
  const since = addDays(today, -(NO_RHYTHM_SPAN - 1));
  const recorded = nights.filter((n) => n.date >= since && n.date <= today && (isNum(n.temp) || isNum(n.sleepHr) || isNum(n.restingHr))).length;
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
    period,
    next,
    early,
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

/**
 * The days of a cycle its second half likely runs, by cycle day: from the day this cycle's began,
 * or is likely to begin, to the last day of the typical cycle, or of the early guess from two
 * cycles. Null until there are two cycles.
 */
export function secondHalfDays(summary: CycleSummary): { from: number; to: number } | null {
  const typical = summary.length?.typical ?? summary.early?.typical ?? null;
  if (typical === null) return null;
  return { from: summary.current?.riseDay ?? typical - SECOND_HALF_DAYS + 1, to: typical };
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

