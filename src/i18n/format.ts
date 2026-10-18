import { weekdayIndex, type CivilDate } from '../lib/date';
import type { Bucket } from '../pipeline/aggregate';
import { formatParts, locale, names, numberFormat, t } from '.';

/**
 * Numbers, dates, times, durations and lists, the way the active language writes them. Patterns
 * and names come from the `format` section of the language file, so English keeps its own look
 * ("14 Oct", "23:47", "7h 05m") and another language can say "14. okt.", "23.47" or "7 t 05 min".
 * Numbers use Intl with the language's tag, for its decimal mark and digit grouping.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const parts = (date: CivilDate) => date.split('-').map(Number) as [number, number, number];

// ───────────────────────────────────────────────────────────────── numbers

/**
 * A number with exactly `digits` decimals and the language's digit grouping: "1,234.5". Rounds the
 * way toLocaleString does, from the shortest decimal that names the number: 7.05 → "7.1".
 */
export const formatNumber = (v: number, digits = 0) =>
  numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);

/**
 * The same, rounded the way toFixed rounds, from the number's exact binary value: 7.05 is stored as
 * 7.0499…, so "7.0". Intl formats the decimal string toFixed gives without rounding it again.
 */
export const formatFixed = (v: number, digits = 0) =>
  numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v.toFixed(digits) as unknown as number);

/** Rounded to `digits` decimals, with trailing zeros dropped: 52.04 → "52", 52.06 → "52.1". */
export const formatRounded = (v: number, digits = 1) =>
  numberFormat({ maximumFractionDigits: 3 }).format(Math.round(v * 10 ** digits) / 10 ** digits);

/** A whole number with digit grouping: "10,234". */
export const formatInteger = (v: number) => formatNumber(Math.round(v));

/** Thousands the short way, for chart gutters and labels: "10k", "7.5k". */
export const formatThousands = (v: number) =>
  t('format.thousands', { value: v % 1000 === 0 ? formatInteger(v / 1000) : formatFixed(v / 1000, 1) });

// ─────────────────────────────────────────────────────────────────── dates

export const weekdayName = (date: CivilDate) => names('format.weekdays')[weekdayIndex(date)];
export const weekdayShort = (date: CivilDate) => names('format.weekdaysShort')[weekdayIndex(date)];
export const weekdayLetter = (date: CivilDate) => names('format.weekdaysNarrow')[weekdayIndex(date)];
/** A weekday's name by ISO index, 0 = Monday … 6 = Sunday. */
export const isoWeekdayName = (index: number) => names('format.weekdays')[(index + 1) % 7];

/** Month names as a date with a day in it uses them ("18 August"); some languages inflect them there. */
const monthWithDay = (m: number) => names('format.monthsWithDay')[m - 1];
const monthShortWithDay = (m: number) => names('format.monthsShortWithDay')[m - 1];

/** "2026-08-18" → "18 Aug". */
export function formatCivil(date: CivilDate): string {
  const [, m, d] = parts(date);
  return t('format.date.dayMonth', { day: d, month: monthShortWithDay(m) });
}

/** "2025-03-02" → "2 Mar 2025". */
export function formatCivilYear(date: CivilDate): string {
  const [y, m, d] = parts(date);
  return t('format.date.dayMonthYear', { day: d, month: monthShortWithDay(m), year: y });
}

/** "2026-06-02", the date as numbers, where every day of a long grid needs a compact name. */
export function formatCivilNumeric(date: CivilDate): string {
  const [y, m, d] = parts(date);
  return t('format.date.numeric', { year: y, month: pad(m), day: pad(d) });
}

/** "2026-06-02" → "2026". */
export const formatYear = (date: CivilDate) => t('format.date.year', { year: parts(date)[0] });

/** "2026-08-18" → "18 August". */
export function formatDayMonthLong(date: CivilDate): string {
  const [, m, d] = parts(date);
  return t('format.date.dayMonth', { day: d, month: monthWithDay(m) });
}

/** "2026-08-18" → "Tue 18 Aug". */
export function formatCivilLong(date: CivilDate): string {
  const [, m, d] = parts(date);
  return t('format.date.weekdayDayMonth', { weekday: weekdayShort(date), day: d, month: monthShortWithDay(m) });
}

/** "2026-10-12" → "Mon Oct 12 2026". */
export function formatCivilDay(date: CivilDate): string {
  const [y, m, d] = parts(date);
  return t('format.date.full', { weekday: weekdayShort(date), day: d, month: monthShortWithDay(m), year: y });
}

/** "12–18 Aug", or "29 Jul – 4 Aug" across a month. */
export function formatCivilRange(from: CivilDate, to: CivilDate): string {
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const [, m, d] = parts(to);
    return t('format.date.rangeInMonth', { fromDay: parts(from)[2], toDay: d, month: monthShortWithDay(m) });
  }
  return t('format.date.range', { from: formatCivil(from), to: formatCivil(to) });
}

/** "2026-10" or "2026-10-14" → "October 2026". */
export function formatMonthYear(monthOrDate: string): string {
  const [y, m] = parts(monthOrDate);
  return t('format.date.monthYear', { month: names('format.months')[m - 1], year: y });
}

/** "Sep 2025", from a 'YYYY-MM' month or a date. */
export function formatMonthYearShort(monthOrDate: string): string {
  const [y, m] = parts(monthOrDate);
  return t('format.date.monthYear', { month: names('format.monthsShort')[m - 1], year: y });
}

/** "September" in `today`'s year, "March 2025" in another, from a 'YYYY-MM' month or a date. */
export function formatMonth(monthOrDate: string, today: CivilDate): string {
  const [y, m] = parts(monthOrDate);
  return y === parts(today)[0] ? names('format.months')[m - 1] : formatMonthYear(monthOrDate);
}

/** Axis and tooltip labels for a chart bucket's first day: "5 Oct", "Week of 5 Oct 2026", "Oct 26", "Oct 2026". */
export function bucketLabel(date: CivilDate, bucket: Bucket, style: 'tick' | 'full' = 'tick'): string {
  const [y, m] = parts(date);
  if (bucket === 'month') {
    if (style === 'full') return formatMonthYearShort(date);
    return t('format.date.monthYearShort', { month: names('format.monthsShort')[m - 1], year: String(y).slice(2) });
  }
  if (bucket === 'week' && style === 'full') return t('format.date.weekOf', { date: formatCivilYear(date) });
  return formatCivil(date);
}

/** "7-day mean", "4-week mean". */
export const meanLabel = (bucket: Bucket, count: number) =>
  t('format.mean', { unit: bucket === 'week' ? 'week' : 'day', count });

// ─────────────────────────────────────────────────────────────────── times

/** Minutes past midnight → "01:57". Wraps past 24h so late bedtimes read correctly. */
export function formatClock(minutesOfDay: number): string {
  const m = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return t('format.time.clock', {
    hours: pad(h),
    hours12: String(h % 12 || 12),
    minutes: pad(m % 60),
    period: h < 12 ? 'am' : 'pm',
  });
}

/** An hour of the day as a column heading: 7 → "07". */
export function formatHour(hour: number): string {
  return t('format.time.hour', { hours: pad(hour), hours12: String(hour % 12 || 12), period: hour < 12 ? 'am' : 'pm' });
}

// ─────────────────────────────────────────────────────────────── durations

type Sign = 'minus' | 'plus' | 'none';
const signOf = (mins: number, signed: boolean): Sign => (mins < 0 ? 'minus' : signed ? 'plus' : 'none');

/** A duration's words, with its units marked, so a big figure can set them small. */
export type DurationPiece = { unit: boolean; text: string };

function pieces(out: string | { unit: string } | (string | { unit: string })[]): DurationPiece[] {
  return (Array.isArray(out) ? out : [out]).map((p) => (typeof p === 'string' ? { unit: false, text: p } : { unit: true, text: p.unit }));
}

/** Durations formatDuration has written, with their units marked, for durationPieces to find again. */
const written = new Map<string, DurationPiece[]>();

/**
 * Minutes → "7h 05m", rounded to the minute first so 479.6 reads 8h 00m. Negative with a "−";
 * `signed` adds a "+" to the rest, for an offset.
 */
export function formatDuration(mins: number, { signed = false } = {}): string {
  const m = Math.abs(Math.round(mins));
  const ps = pieces(formatParts<{ unit: string }>('format.duration.hoursMinutes', {
    sign: signOf(mins, signed),
    hours: Math.floor(m / 60),
    minutes: m % 60,
    unit: (chunks) => ({ unit: chunks.join('') }),
  }));
  const text = ps.map((p) => p.text).join('');
  if (written.size >= 500) written.clear();
  written.set(text, ps);
  return text;
}

/**
 * The numbers and units of a duration formatDuration wrote, so a big figure can set the units
 * small. Null for anything else.
 */
export const durationPieces = (shown: string): DurationPiece[] | null => written.get(shown) ?? null;

/** Minutes under an hour: "25m"; `signed` adds a "+" when it isn't negative. */
export const formatMinutes = (mins: number, { signed = false } = {}) =>
  t('format.duration.minutes', { sign: signOf(mins, signed), minutes: Math.abs(Math.round(mins)) });

/** A length of time in whole hours when it is one: "7h", else "7h 18m". */
export function formatHours(mins: number): string {
  const m = Math.round(mins);
  if (m % 60) return formatDuration(m);
  return t('format.duration.hours', { sign: signOf(m, false), hours: Math.abs(m) / 60 });
}

/** "3.6 hours", "3.0 hours", or "1 hour". */
export function formatHoursDecimal(mins: number): string {
  return t('format.duration.hoursDecimal', { count: Number((mins / 60).toFixed(1)), hours: formatFixed(mins / 60, 1) });
}

// ─────────────────────────────────────────────────────────────────── lists

/**
 * A phrase that opens a sentence, such as a list of names: its first letter in capitals, by the
 * language's own casing rules. Languages without capitals are left as they are.
 */
export const capitalize = (s: string) => s.replace(/\p{L}/u, (c) => c.toLocaleUpperCase(locale()));

const LISTS = {
  and: { pair: 'format.list.and.pair', start: 'format.list.and.start', end: 'format.list.and.end' },
  or: { pair: 'format.list.or.pair', start: 'format.list.or.start', end: 'format.list.or.end' },
} as const;

/** "a, b and c", or with `or`, "a, b or c": joined the way the language joins a list. */
export function formatList(items: readonly string[], join: keyof typeof LISTS = 'and'): string {
  const keys = LISTS[join];
  if (items.length < 2) return items.join('');
  if (items.length === 2) return t(keys.pair, { first: items[0], second: items[1] });
  let out = t(keys.end, { first: items[items.length - 2], last: items[items.length - 1] });
  for (let i = items.length - 3; i >= 0; i--) out = t(keys.start, { first: items[i], rest: out });
  return out;
}
