import { addDays, type CivilDate } from '../lib/date';
import type { DailyRecord, SleepSession } from '../types/health';
import { reportError, type StreamDay, type StreamState, type StreamWrite } from './incremental';
import { fetchIntradayHeartRate, type IntradayDay } from './intraday';
import { SLEEP_HR_FLOOR } from './registry';
import type { HealthTransport } from './transport';

/**
 * The night's heart rate floor: the tenth percentile of the one-minute heart rate during the main
 * sleep, in bpm. The cycle finder reads it as the sleeping heart rate (cycle.ts, nightsFrom).
 * Progesterone lifts the body's floor through the luteal phase, and the floor shows that lift more
 * clearly than the night's average does: on mcPHASES it moved by 0.8 of a night's noise between the
 * halves of a cycle, against 0.7 for the average over light and deep sleep (Google's non-REM
 * heart rate), and the finder finds 33% of period starts within 3 days with it against 24%.
 *
 * Healthier computes it on the server from the minute heart rate the window sync fetches, for every
 * night with a main sleep and at least half its minutes recorded, while cycle tracking is on. It is
 * stored like a stream (SLEEP_HR_FLOOR) so it outlives the minute data, which is kept for the window
 * only; older nights are filled in by the history backfill, a fortnight of minutes at a time, and
 * those minutes are not kept. Turning tracking off removes it.
 */
export const FLOOR_QUANTILE = 0.1;
/** A night needs this many minutes with a reading, and half of its sleep's, to be judged. */
export const FLOOR_MIN_MINUTES = 120;
export const FLOOR_MIN_SHARE = 0.5;
/** A backfill step fetches this many days of minutes at once (the API's limit per request). */
export const FLOOR_BACKFILL_DAYS = 14;

/** The floor of one night, or null when the minutes don't cover enough of the sleep. */
export function sleepHrFloor(session: Pick<SleepSession, 'bedtimeIso' | 'wakeIso'>, minutes: readonly IntradayDay[]): number | null {
  const bed = Date.parse(session.bedtimeIso) / 1000;
  const wake = Date.parse(session.wakeIso) / 1000;
  if (!Number.isFinite(bed) || !Number.isFinite(wake) || wake <= bed) return null;
  const values: number[] = [];
  for (const day of minutes) {
    for (let i = 0; i < day.t.length; i++) if (day.t[i] >= bed && day.t[i] < wake) values.push(day.v[i]);
  }
  if (values.length < Math.max(FLOOR_MIN_MINUTES, ((wake - bed) / 60) * FLOOR_MIN_SHARE)) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * FLOOR_QUANTILE)];
}

/** The nights among `days` with a floor, as stored days of the derived stream. */
export function sleepHrFloorDays(days: readonly Pick<DailyRecord, 'date' | 'sleep'>[], intraday: readonly IntradayDay[]): Record<CivilDate, StreamDay> {
  const byDate = new Map(intraday.map((d) => [d.date, d]));
  const out: Record<CivilDate, StreamDay> = {};
  for (const d of days) {
    if (!d.sleep) continue;
    // A night is filed under the morning it ends on, and begins the day before.
    const minutes = [byDate.get(addDays(d.date, -1)), byDate.get(d.date)].filter((x): x is IntradayDay => !!x);
    const v = sleepHrFloor(d.sleep, minutes);
    if (v !== null) out[d.date] = { fields: { sleepHrFloor: v }, present: [SLEEP_HR_FLOOR.dataType], sources: [], sourceByType: {} };
  }
  return out;
}

/** A night's main sleep, as the person's choice of sleep device reads it (pipeline/sources.ts). */
export type FloorNight = Pick<DailyRecord, 'date' | 'sleep'>;

function stateOf(prev: StreamState | undefined, days: Record<CivilDate, StreamDay>, coveredFrom: CivilDate, finalThrough: CivilDate, ms: number): StreamState {
  const dates = Object.keys(days).sort();
  const latest = dates[dates.length - 1];
  return {
    dataType: SLEEP_HR_FLOOR.dataType,
    coveredFrom,
    finalThrough,
    latestDate: !prev?.latestDate || (latest && latest > prev.latestDate) ? latest ?? null : prev.latestDate,
    parsed: dates.length,
    sources: [],
    report: {
      dataType: SLEEP_HR_FLOOR.dataType,
      label: SLEEP_HR_FLOOR.label,
      domain: SLEEP_HR_FLOOR.domain,
      mode: 'derived',
      status: dates.length || prev?.latestDate ? 'ok' : 'empty',
      observations: 0,
      requests: 0,
      pagesFetched: 0,
      truncated: false,
      ms,
    },
  };
}

/**
 * The window's nights, recomputed from the stored minutes after each sync, and when the choice of
 * sleep device changes: every night after the window's first, whose evening minutes are gone (the
 * minutes are kept from the window's first day). Coverage reaches back as far as the backfill
 * has taken it. Older nights keep the floor their sleep's times gave when it was computed: on
 * mcPHASES, moving a sleep's ends by half an hour moved the floor by a beat or less on 94% of
 * nights or more.
 */
export function sleepHrFloorWindow(
  prev: StreamState | undefined,
  nights: readonly FloorNight[],
  intraday: readonly IntradayDay[],
  plan: { windowStart: CivilDate; today: CivilDate; keepFrom: CivilDate },
): StreamWrite {
  const t0 = Date.now();
  const from = addDays(plan.windowStart, 1);
  const days = sleepHrFloorDays(nights.filter((n) => n.date >= from && n.date <= plan.today), intraday);
  const older = prev?.coveredFrom && prev.coveredFrom < from ? prev.coveredFrom : from;
  const coveredFrom = older < plan.keepFrom ? plan.keepFrom : older;
  return { dataType: SLEEP_HR_FLOOR.dataType, replace: [{ from, to: plan.today }], days, state: stateOf(prev, days, coveredFrom, plan.today, Date.now() - t0) };
}

/**
 * One step of history: the fortnight of nights before the stream's coverage, back to `start`, from
 * minutes fetched for it and the main sleeps already stored. Null once coverage reaches `start`.
 * A failed fetch moves nothing and is noted on the state, the way a stream's backfill notes it.
 */
export async function backfillSleepHrFloor(
  transport: HealthTransport,
  prev: StreamState,
  loadNights: (from: CivilDate, to: CivilDate) => Promise<readonly FloorNight[]>,
  start: CivilDate,
  opts: { timeZone: string; now: Date; dataSourceFamily?: string | null },
): Promise<StreamWrite | null> {
  if (!prev.coveredFrom || prev.coveredFrom <= start) return null;
  const to = addDays(prev.coveredFrom, -1);
  const earliest = addDays(to, -(FLOOR_BACKFILL_DAYS - 1));
  const from = earliest < start ? start : earliest;
  // The first night's evening is on the day before `from`.
  const res = await fetchIntradayHeartRate(transport, { from: addDays(from, -1), to, timeZone: opts.timeZone, now: opts.now, dataSourceFamily: opts.dataSourceFamily });
  if (res.error) {
    const error = reportError(res.error);
    return { dataType: SLEEP_HR_FLOOR.dataType, replace: [], days: {}, state: { ...prev, backfillError: error.error, backfillErrorCode: error.errorCode } };
  }
  const days = sleepHrFloorDays((await loadNights(from, to)).filter((n) => n.date >= from && n.date <= to), [...res.days.values()]);
  const state = stateOf(prev, days, from, prev.finalThrough ?? to, res.ms);
  return {
    dataType: SLEEP_HR_FLOOR.dataType,
    replace: [{ from, to }],
    days,
    state: { ...state, parsed: prev.parsed + state.parsed, report: { ...state.report, requests: res.requests, pagesFetched: res.pages }, backfillError: undefined, backfillErrorCode: undefined },
  };
}
