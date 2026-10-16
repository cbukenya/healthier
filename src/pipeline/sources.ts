import type { CivilDate } from '../lib/date';
import type { DailyRecord, SourceRef } from '../types/health';
import { emptyRecord } from './normalize';

/**
 * Devices and sources: which of the person's devices and apps each reading comes from.
 *
 * Google Health sends every source's readings (sleep, HRV, resting heart rate and the rest) and
 * names where each came from, so Healthier picks one source per reading per day. The sync keeps
 * every source's reading for a day more than one reported (StreamDay.variants), and the pick is
 * made when the day is read, so a change of choice takes effect at once, with nothing fetched.
 * Daily totals and minute heart rate come already added up by Google; for those the person can
 * only choose which kinds of source Google counts (DATA_SOURCE_FAMILY).
 *
 * A day whose reading came from a source other than the first choice is a fill: it's shown, but
 * judged only against readings from that same source (see series in derive.ts), so a night from
 * another device neither gets a verdict nor moves the usual range.
 */

/** Which kinds of source Google counts in daily totals and minute heart rate. */
export type TotalsFamily = 'all' | 'google' | 'worn';

export interface SourcePrefs {
  /** Source ids, first choice first. Sources not listed come after, most recent first. */
  order: string[];
  /** Source ids switched off: their readings are left out entirely. */
  off: string[];
  /** A first choice for one reading, by its stream's dataType, ahead of `order`. */
  perReading: Record<string, string>;
  totals: TotalsFamily;
}

export const DEFAULT_SOURCE_PREFS: SourcePrefs = { order: [], off: [], perReading: {}, totals: 'all' };

/** The readings a first choice can be set for, by stream. */
export const READING_STREAMS = [
  'sleep',
  'daily-heart-rate-variability',
  'daily-resting-heart-rate',
  'daily-respiratory-rate',
  'daily-sleep-temperature-derivations',
  'daily-oxygen-saturation',
  'daily-vo2-max',
  'weight',
  'body-fat',
] as const;

/**
 * Google Health's data source families (dataSourceFamily on rollUp and dailyRollUp). Every
 * source is Google's default, so it's left out of the request.
 */
export const DATA_SOURCE_FAMILY: Record<TotalsFamily, string | null> = {
  all: null,
  google: 'users/me/dataSourceFamilies/google-sources',
  worn: 'users/me/dataSourceFamilies/google-wearables',
};

const MAX_SOURCES = 64;
const MAX_ID = 300;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID;
const TOTALS: readonly TotalsFamily[] = ['all', 'google', 'worn'];

/** Choices as the app sends them: null for anything malformed. */
export function parseSourcePrefs(raw: unknown): SourcePrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ids = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length <= MAX_SOURCES && v.every(isId) ? [...new Set(v as string[])] : null;
  const order = ids(o.order ?? []);
  const off = ids(o.off ?? []);
  if (!order || !off) return null;
  const per = o.perReading ?? {};
  if (!per || typeof per !== 'object' || Array.isArray(per)) return null;
  const perReading: Record<string, string> = {};
  for (const [k, v] of Object.entries(per)) {
    if (!(READING_STREAMS as readonly string[]).includes(k) || !isId(v)) return null;
    perReading[k] = v;
  }
  const totals = o.totals ?? 'all';
  if (!TOTALS.includes(totals as TotalsFamily)) return null;
  return { order, off, perReading, totals: totals as TotalsFamily };
}

/** Choices as stored: anything malformed reads as the defaults. */
export const readSourcePrefs = (raw: unknown): SourcePrefs => parseSourcePrefs(raw) ?? DEFAULT_SOURCE_PREFS;

/**
 * The fuller of two descriptions of one source. A source can come with several, since its id is
 * its platform and name: a ring's own readings and what was typed into its app share one. A form
 * factor counts most, then a way of recording other than typing it in.
 */
export function fullerRef(a: SourceRef | undefined, b: SourceRef): SourceRef {
  const score = (r: SourceRef) => (r.formFactor ? 2 : 0) + (r.method !== 'MANUAL' ? 1 : 0);
  return !a || score(b) > score(a) ? b : a;
}

/** Where a source last reported a stream, and on how many days, across everything stored. */
export interface SourceSeen {
  latest: CivilDate;
  days: number;
}

/**
 * Every source, in the order tried: the person's order first, then any others, most recent first,
 * then by days reported, so a new device leads until it's placed and an old one's history comes
 * after. One order for every reading, so the card can show it as one list. Switched-off sources
 * keep their place in it.
 */
export function sourceRanking(seen: ReadonlyMap<string, ReadonlyMap<string, SourceSeen>>, prefs: SourcePrefs): string[] {
  const all = new Map<string, SourceSeen>();
  for (const sources of seen.values()) {
    for (const [id, s] of sources) {
      const x = all.get(id);
      if (!x) all.set(id, { ...s });
      else {
        x.days += s.days;
        if (s.latest > x.latest) x.latest = s.latest;
      }
    }
  }
  const placed = [...new Set(prefs.order)].filter((id) => all.has(id));
  const rest = [...all.entries()]
    .filter(([id]) => !placed.includes(id))
    .sort(([a, x], [b, y]) => (x.latest !== y.latest ? (x.latest < y.latest ? 1 : -1) : y.days - x.days || (a < b ? -1 : a > b ? 1 : 0)))
    .map(([id]) => id);
  return [...placed, ...rest];
}

/** What a day's reading is picked with: the choices, and each stream's sources in the order tried. */
export interface SourceChoice {
  prefs: SourcePrefs;
  orders: ReadonlyMap<string, readonly string[]>;
}

/**
 * Each stream's sources in the order tried: the reading's own first choice, then the ranking,
 * never one switched off. A stream whose sources are all switched off has an empty order, so
 * nothing of it is read.
 */
export function sourceOrders(seen: ReadonlyMap<string, ReadonlyMap<string, SourceSeen>>, prefs: SourcePrefs): Map<string, string[]> {
  const ranking = sourceRanking(seen, prefs);
  const off = new Set(prefs.off);
  const out = new Map<string, string[]>();
  for (const [dataType, sources] of seen) {
    if (!sources.size) continue;
    const order = ranking.filter((id) => sources.has(id) && !off.has(id));
    const own = prefs.perReading[dataType];
    if (own !== undefined && order.includes(own)) {
      order.splice(order.indexOf(own), 1);
      order.unshift(own);
    }
    out.set(dataType, order);
  }
  return out;
}

const EMPTY = emptyRecord('0000-00-00');

/** The day without these fields, as if their source hadn't reported. */
function without(d: DailyRecord, keys: string[]): DailyRecord {
  const out = { ...d } as Record<string, unknown>;
  for (const key of keys) out[key] = (EMPTY as unknown as Record<string, unknown>)[key];
  return out as unknown as DailyRecord;
}

/** A field's reading when it came from its stream's first choice; null when it was a fill. */
export const ownReading = <K extends keyof DailyRecord>(d: DailyRecord, key: K): DailyRecord[K] | null =>
  d.fills?.[key] === undefined ? d[key] : null;

/** A field's reading when it was a fill: from a source other than its stream's first choice. */
export const fillReading = <K extends keyof DailyRecord>(d: DailyRecord, key: K): DailyRecord[K] | null =>
  d.fills?.[key] !== undefined ? d[key] : null;

/**
 * The source a value read from the day came from, when it was a fill: the fill whose field the
 * value depends on (reading the day without it changes the value). Undefined for a first choice.
 */
export function fillSource(d: DailyRecord, get: (d: DailyRecord) => number | null, value: number | null): string | undefined {
  if (value === null || !d.fills) return undefined;
  for (const [key, source] of Object.entries(d.fills)) if (get(without(d, [key])) !== value) return source;
  return undefined;
}
