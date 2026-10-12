/**
 * Civil-date utilities.
 *
 * The Google Health API speaks two different languages about time:
 *
 *   1. `civilStartTime.date { year, month, day }` — a wall-clock calendar day with
 *      no timezone. This is what "your Tuesday" means.
 *   2. `physicalTime` (UTC instant) + `utcOffset` ("7200s") — an absolute moment
 *      plus the offset that was in force where the user was standing.
 *
 * The old pipeline built day keys with `new Date()` and `getFullYear()`, which
 * silently resolves to *the server's* timezone. Running in UTC while the user is
 * in UTC+2 shifts every "today" lookup by a day between 00:00 and 02:00 local.
 *
 * Rule for this codebase: a day is a `CivilDate` string, "YYYY-MM-DD", and it is
 * never produced by a Date object's local getters. All conversions are explicit.
 */

/** A calendar day with no timezone attached, e.g. "2026-08-18". */
export type CivilDate = string;

export interface GHDate {
  year?: number;
  month?: number;
  day?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Google Health `{year, month, day}` → "YYYY-MM-DD". */
export function civilFromGH(d: GHDate | undefined | null): CivilDate | null {
  if (!d || !d.year || !d.month || !d.day) return null;
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** "7200s" → 7200. Tolerates numbers, missing values and the "+02:00" form. */
export function parseUtcOffsetSeconds(offset: unknown): number {
  if (typeof offset === 'number') return offset;
  if (typeof offset !== 'string' || !offset) return 0;
  const s = offset.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (s) return Math.round(parseFloat(s[1]));
  const hm = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (hm) {
    const sign = hm[1] === '-' ? -1 : 1;
    return sign * (parseInt(hm[2], 10) * 3600 + parseInt(hm[3], 10) * 60);
  }
  return 0;
}

/**
 * A UTC instant plus its offset → the civil date/time the user actually saw.
 * This is the only correct way to answer "which of my days does this belong to".
 */
export function civilFromInstant(
  isoUtc: string | undefined | null,
  utcOffset: unknown,
): { date: CivilDate; minutesOfDay: number; iso: string } | null {
  if (!isoUtc) return null;
  const t = Date.parse(isoUtc);
  if (Number.isNaN(t)) return null;
  const shifted = new Date(t + parseUtcOffsetSeconds(utcOffset) * 1000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    iso: isoUtc,
  };
}

/** Today as the *user's device* sees it. Called once, at the edge, never deep in parsing. */
export function todayCivil(now: Date = new Date()): CivilDate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Today in a named IANA zone, for code running away from the user's device: the
 * server syncs in UTC while the user lives in, say, Europe/Stockholm.
 */
export function todayCivilIn(timeZone: string, now: Date = new Date()): CivilDate {
  return civilClock(timeZone)(now.getTime()).date;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's UTC offset at an instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(ms: number, timeZone: string): number {
  let fmt = zoneFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormats.set(timeZone, fmt);
  }
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant → the civil date and minute-of-day it falls on in a zone. Returns a
 * converter that caches the offset per UTC hour, since converting tens of
 * thousands of minute buckets one Intl call at a time is needlessly slow.
 */
export function civilClock(timeZone: string): (ms: number) => { date: CivilDate; minutesOfDay: number } {
  const offsets = new Map<number, number>();
  return (ms) => {
    const hour = Math.floor(ms / 3_600_000);
    let offset = offsets.get(hour);
    if (offset === undefined) {
      offset = zoneOffsetMs(hour * 3_600_000, timeZone);
      offsets.set(hour, offset);
    }
    const shifted = new Date(ms + offset);
    return {
      date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
      minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  };
}

/** The UTC instant (ms) at which a civil date begins in a zone, DST included. */
export function startOfCivilDay(date: CivilDate, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the naive guess, then at the corrected instant,
  // which differ only when a DST change falls between them.
  const first = wall - zoneOffsetMs(wall, timeZone);
  return wall - zoneOffsetMs(first, timeZone);
}

/** Shift a civil date by whole days. Timezone-free: pure calendar arithmetic. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** Inclusive list of civil dates from `start` to `end`. */
export function dateRange(start: CivilDate, end: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard++ < 4000) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export function daysBetween(a: CivilDate, b: CivilDate): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, computed from the calendar day itself. */
export function weekdayIndex(date: CivilDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 0 = Monday … 6 = Sunday: the ISO week, for anything that counts working weeks. */
export function isoWeekdayIndex(date: CivilDate): number {
  return (weekdayIndex(date) + 6) % 7;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const weekdayShort = (date: CivilDate) => WD[weekdayIndex(date)];
export const weekdayLetter = (date: CivilDate) => WD[weekdayIndex(date)][0];

/** "2026-08-18" → "18 Aug". */
export function formatCivil(date: CivilDate): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MON[m - 1]}`;
}

/** "2026-08-18" → "Tue 18 Aug". */
export function formatCivilLong(date: CivilDate): string {
  return `${weekdayShort(date)} ${formatCivil(date)}`;
}

/** Minutes past midnight → "01:57". Wraps past 24h so late bedtimes read correctly. */
export function formatClock(minutesOfDay: number): string {
  const m = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Google Health's own `{year, month, day}` payload shape, for request bodies. */
export function ghDateFromCivil(date: CivilDate): Required<GHDate> {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}
