import { addDays, civilClock, startOfCivilDay, type CivilDate } from '../lib/date';
import type { IntradaySample } from '../types/health';
import { num } from './coerce';
import { INTRADAY_HEART_RATE } from './registry';
import { pool, splitWindow, type FetchError, type HealthTransport } from './transport';

/**
 * Intraday heart rate.
 *
 * Raw samples arrive every few seconds — tens of thousands a day — so listing
 * them page by page covered under two days per sync. Google's `rollUp` returns
 * one-minute averages directly: a 62-day window is a handful of requests, which
 * is what lets the labs (nocturnal dipping, tachycardia) see the whole window.
 *
 * `rollUp` works in UTC, so the user's IANA zone turns each minute back into
 * the civil date and clock minute the rest of the app speaks.
 */

/** One civil day of minute buckets, stored and sent column-wise to stay compact. */
export interface IntradayDay {
  date: CivilDate;
  /** Bucket start, epoch seconds. */
  t: number[];
  /** Minutes past local midnight. */
  m: number[];
  /** Average bpm over the minute. */
  v: number[];
}

/** rollUp rejects heart-rate ranges over 14 days; a day of headroom absorbs DST-length days. */
const MAX_RANGE_DAYS = 13;
const WINDOW = '60s';

export interface IntradayFetch {
  days: Map<CivilDate, IntradayDay>;
  /** Civil ranges fetched completely; only these may replace stored days. */
  okRanges: { from: CivilDate; to: CivilDate }[];
  requests: number;
  pages: number;
  ms: number;
  status: number;
  /** Why the first failed chunk failed: the transport's error, or `truncated` when Google had more minutes than the pages fetched. */
  error?: FetchError | { code: 'truncated' };
}

export async function fetchIntradayHeartRate(
  transport: HealthTransport,
  opts: { from: CivilDate; to: CivilDate; timeZone: string; now: Date },
): Promise<IntradayFetch> {
  const t0 = Date.now();
  const clock = civilClock(opts.timeZone);
  // Whole minutes only: the bucket in progress would read low.
  const nowMs = Math.floor(opts.now.getTime() / 60_000) * 60_000;
  const chunks = splitWindow(opts.from, opts.to, MAX_RANGE_DAYS);

  const results = await pool(chunks, transport.concurrency, async (chunk) => {
    const start = startOfCivilDay(chunk.start, opts.timeZone);
    const end = Math.min(startOfCivilDay(addDays(chunk.end, 1), opts.timeZone), nowMs);
    if (end <= start) return { chunk, res: null };
    const res = await transport.rollUpWindows(
      INTRADAY_HEART_RATE.dataType,
      { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() },
      WINDOW,
    );
    return { chunk, res };
  });

  const out: IntradayFetch = { days: new Map(), okRanges: [], requests: 0, pages: 0, ms: 0, status: 200 };
  const buckets = new Map<CivilDate, [number, number, number][]>();
  for (const { chunk, res } of results) {
    if (res) {
      out.requests += res.requests;
      out.pages += res.pages;
      // A truncated chunk is missing its oldest minutes: don't let it replace stored days.
      if (res.error || res.truncated) {
        out.error ??= res.error ?? { code: 'truncated' };
        out.status = res.error ? res.status : out.status;
        continue;
      }
      for (const dp of res.body?.rollupDataPoints ?? []) {
        const bpm = num(dp?.heartRate?.beatsPerMinuteAvg);
        const ms = Date.parse(dp?.startTime);
        if (bpm === null || Number.isNaN(ms)) continue; // unset when the watch was off-wrist
        const { date, minutesOfDay } = clock(ms);
        let list = buckets.get(date);
        if (!list) buckets.set(date, (list = []));
        list.push([Math.round(ms / 1000), minutesOfDay, Math.round(bpm)]);
      }
    }
    out.okRanges.push({ from: chunk.start, to: chunk.end });
  }

  for (const [date, list] of buckets) {
    list.sort((a, b) => a[0] - b[0]);
    out.days.set(date, { date, t: list.map((x) => x[0]), m: list.map((x) => x[1]), v: list.map((x) => x[2]) });
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Expand stored days into the sample objects the views and labs consume, ascending. */
export function unpackIntraday(days: IntradayDay[]): IntradaySample[] {
  const out: IntradaySample[] = [];
  for (const day of [...days].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (let i = 0; i < day.t.length; i++) {
      out.push({ iso: new Date(day.t[i] * 1000).toISOString(), date: day.date, minutesOfDay: day.m[i], value: day.v[i] });
    }
  }
  return out;
}

export const sampleCount = (days: IntradayDay[]) => days.reduce((n, d) => n + d.t.length, 0);
