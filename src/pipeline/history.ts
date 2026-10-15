import { addDays, isoWeekdayIndex, type CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import { scoreSleep } from './sleep';

/**
 * History queries: how anything that needs your older days asks for them.
 *
 * The dashboard carries 62 days. An insight that needs more ("your most active
 * month", "your biggest day yet") declares a query: a measure, how to
 * aggregate it, an optional grouping or rolling mean, and how far back to look.
 * The app sends its queries with the dataset request and the server answers
 * them from the stored days. Nothing is stored or remembered: the same days and
 * the same queries always give the same answers.
 *
 * Every answer ends before the dashboard's window. The window is what the
 * engine cuts back a day at a time for the yesterday test; if an answer also
 * covered it, a record set today would already be inside "your biggest day this
 * year" and could never be news. So the server answers the older part, and the
 * engine adds the window's own days, which it can still cut back.
 *
 * The vocabulary is small and fixed, so a query can only ever read one
 * person's own daily records. Anything it doesn't recognise is answered with
 * null, and the card that asked stays silent.
 */

/** The daily values a query can read. One definition, shared by the server, the app and demo mode. */
export const MEASURES = {
  steps: (d: DailyRecord) => d.steps,
  distanceKm: (d: DailyRecord) => d.distanceKm,
  floors: (d: DailyRecord) => d.floors,
  activeKcal: (d: DailyRecord) => d.activeKcal,
  /** Active Zone Minutes, cardio and peak counting double. */
  activeZoneMinutes: (d: DailyRecord) => (d.zoneMinutes ? d.zoneMinutes.fatBurn + 2 * (d.zoneMinutes.cardio + d.zoneMinutes.peak) : null),
  /** Moderate minutes plus vigorous counting double. */
  briskMinutes: (d: DailyRecord) => (d.activeMinutes ? d.activeMinutes.moderate + 2 * d.activeMinutes.vigorous : null),
  sleepMinutes: (d: DailyRecord) => d.sleep?.minutesAsleep ?? null,
  sleepScore: (d: DailyRecord) => (d.sleep ? scoreSleep(d.sleep).total : null),
  sleepEfficiency: (d: DailyRecord) => d.sleep?.efficiency ?? null,
  restingHr: (d: DailyRecord) => d.restingHr,
  hrv: (d: DailyRecord) => d.hrv,
  /** Heart rate in non-REM sleep. */
  nonRemHr: (d: DailyRecord) => d.nonRemHr,
  respiratoryRate: (d: DailyRecord) => d.respiratoryRate,
  spo2: (d: DailyRecord) => d.spo2?.avg ?? null,
  skinTempDeviationC: (d: DailyRecord) => d.skinTempDeviationC,
  vo2Max: (d: DailyRecord) => d.vo2Max,
  weightKg: (d: DailyRecord) => d.weightKg,
  bodyFatPct: (d: DailyRecord) => d.bodyFatPct,
} satisfies Record<string, (d: DailyRecord) => number | null>;

export type Measure = keyof typeof MEASURES;
export type Aggregate = 'sum' | 'count' | 'mean' | 'min' | 'max' | 'first' | 'last';
/** Single days, calendar months, ISO weeks (keyed by their Monday), weekdays (0 = Monday) or years. */
export type Grouping = 'day' | 'month' | 'week' | 'weekday' | 'year';

export interface HistoryQuery {
  measure: Measure;
  aggregate: Aggregate | Aggregate[];
  group?: Grouping;
  /** Read rolling means first: each run of `days` days with at least `minReadings` readings, dated by its last day. */
  rolling?: { days: number; minReadings: number };
  /** How far back from today, in days, or everything stored. */
  back: number | 'all';
  /** End this many days back instead of the day before the window. Never inside the window. */
  until?: number;
}

export interface Reading {
  date: CivilDate;
  value: number;
}

export interface AnswerRow {
  /** The group: the day, 'YYYY-MM', a week's Monday, '0'–'6' from Monday, or 'YYYY'. Null when ungrouped. */
  key: string | null;
  sum?: number;
  count?: number;
  mean?: number | null;
  min?: Reading | null;
  max?: Reading | null;
  first?: Reading | null;
  last?: Reading | null;
}

export interface Answer {
  /** The days the answer covers: empty when from is after to. */
  from: CivilDate;
  to: CivilDate;
  rows: AnswerRow[];
}

export type HistoryQueries = Record<string, HistoryQuery>;
export type HistoryAnswers = Record<string, Answer | null>;

const AGGREGATES: Aggregate[] = ['sum', 'count', 'mean', 'min', 'max', 'first', 'last'];
const GROUPINGS: Grouping[] = ['day', 'month', 'week', 'weekday', 'year'];
const MAX_QUERIES = 40;
const MAX_DAYS_BACK = 3650;

/**
 * Validate queries from a request. Anything malformed is dropped, so the
 * server never runs a query it doesn't understand; the app gets null for it.
 */
export function parseQueries(input: unknown): HistoryQueries {
  const out: HistoryQueries = {};
  if (!input || typeof input !== 'object') return out;
  for (const [name, q] of Object.entries(input as Record<string, any>).slice(0, MAX_QUERIES)) {
    if (!/^[A-Za-z][\w-]{0,47}$/.test(name) || !q || typeof q !== 'object') continue;
    const aggregates = Array.isArray(q.aggregate) ? q.aggregate : [q.aggregate];
    const whole = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
    if (typeof q.measure !== 'string' || !Object.hasOwn(MEASURES, q.measure)) continue;
    if (!aggregates.length || !aggregates.every((a: unknown) => AGGREGATES.includes(a as Aggregate))) continue;
    if (q.group !== undefined && !GROUPINGS.includes(q.group)) continue;
    if (q.rolling !== undefined && !(whole(q.rolling?.days, 2, 31) && whole(q.rolling?.minReadings, 1, q.rolling?.days))) continue;
    if (q.back !== 'all' && !whole(q.back, 1, MAX_DAYS_BACK)) continue;
    if (q.until !== undefined && !whole(q.until, 1, MAX_DAYS_BACK)) continue;
    out[name] = {
      measure: q.measure,
      aggregate: aggregates,
      ...(q.group ? { group: q.group } : {}),
      ...(q.rolling ? { rolling: { days: q.rolling.days, minReadings: q.rolling.minReadings } } : {}),
      back: q.back,
      ...(q.until !== undefined ? { until: q.until } : {}),
    };
  }
  return out;
}

/**
 * The days a query covers: from `back` days before today (or the oldest
 * stored day) to the day before the window, or to `until` days back. Null when
 * it would reach into the window.
 */
export function queryRange(q: HistoryQuery, today: CivilDate, windowFrom: CivilDate, oldest: CivilDate | null): { from: CivilDate; to: CivilDate } | null {
  const to = q.until === undefined ? addDays(windowFrom, -1) : addDays(today, -q.until);
  if (to >= windowFrom) return null;
  const back = q.back === 'all' ? oldest ?? addDays(to, 1) : addDays(today, -q.back);
  const from = oldest && oldest > back ? oldest : back;
  return { from, to };
}

/** The span every query together needs, for one read of the stored days. */
export function queriesSpan(
  queries: HistoryQueries,
  today: CivilDate,
  windowFrom: CivilDate,
  oldest: CivilDate | null,
): { from: CivilDate; to: CivilDate } | null {
  const ranges = Object.values(queries)
    .map((q) => queryRange(q, today, windowFrom, oldest))
    .filter((r): r is { from: CivilDate; to: CivilDate } => r !== null && r.from <= r.to);
  if (!ranges.length) return null;
  return {
    from: ranges.reduce((a, r) => (r.from < a ? r.from : a), ranges[0].from),
    to: ranges.reduce((a, r) => (r.to > a ? r.to : a), ranges[0].to),
  };
}

const groupKey = (date: CivilDate, group: Grouping | undefined): string | null => {
  if (!group) return null;
  if (group === 'day') return date;
  if (group === 'month') return date.slice(0, 7);
  if (group === 'year') return date.slice(0, 4);
  if (group === 'weekday') return String(isoWeekdayIndex(date));
  return addDays(date, -isoWeekdayIndex(date));
};

/** One query over days already read (oldest first), restricted to its own range. */
export function answerQuery(q: HistoryQuery, days: DailyRecord[], range: { from: CivilDate; to: CivilDate }): Answer {
  const get = MEASURES[q.measure];
  const inRange = days.filter((d) => d.date >= range.from && d.date <= range.to);
  let readings: Reading[] = [];
  if (q.rolling) {
    const { days: n, minReadings } = q.rolling;
    for (let end = n; end <= inRange.length; end++) {
      const span = inRange.slice(end - n, end);
      // A rolling run spans consecutive calendar days, never a gap in the grid.
      if (addDays(span[0].date, n - 1) !== span[n - 1].date) continue;
      const v = span.map(get).filter((x): x is number => x !== null);
      if (v.length >= minReadings) readings.push({ date: span[n - 1].date, value: v.reduce((a, b) => a + b, 0) / v.length });
    }
  } else {
    readings = inRange.flatMap((d) => {
      const v = get(d);
      return v === null || !Number.isFinite(v) ? [] : [{ date: d.date, value: v }];
    });
  }

  const groups = new Map<string | null, Reading[]>();
  for (const r of readings) {
    const key = groupKey(r.date, q.group);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(r);
  }
  if (!q.group && !groups.size) groups.set(null, []);

  const aggregates = Array.isArray(q.aggregate) ? q.aggregate : [q.aggregate];
  const rows = [...groups.entries()]
    .sort(([a], [b]) => ((a ?? '') < (b ?? '') ? -1 : 1))
    .map(([key, list]) => {
      const row: AnswerRow = { key };
      const sum = list.reduce((a, r) => a + r.value, 0);
      for (const a of aggregates) {
        if (a === 'sum') row.sum = sum;
        else if (a === 'count') row.count = list.length;
        else if (a === 'mean') row.mean = list.length ? sum / list.length : null;
        else if (a === 'first') row.first = list[0] ?? null;
        else if (a === 'last') row.last = list[list.length - 1] ?? null;
        else {
          // Ties go to the earliest reading: a later equal day hasn't beaten it.
          let best: Reading | null = null;
          for (const r of list) if (!best || (a === 'max' ? r.value > best.value : r.value < best.value)) best = r;
          row[a] = best;
        }
      }
      return row;
    });
  return { from: range.from, to: range.to, rows };
}

/**
 * Every query, answered from one read of the stored days. `days` must hold the
 * span `queriesSpan` asked for; `oldest` is the first stored day of all.
 */
export function answerQueries(
  queries: HistoryQueries,
  days: DailyRecord[],
  today: CivilDate,
  windowFrom: CivilDate,
  oldest: CivilDate | null,
): HistoryAnswers {
  const out: HistoryAnswers = {};
  for (const [name, q] of Object.entries(queries)) {
    const range = queryRange(q, today, windowFrom, oldest);
    out[name] = range ? answerQuery(q, days, range) : null;
  }
  return out;
}
