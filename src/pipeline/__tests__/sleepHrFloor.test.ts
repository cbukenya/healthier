import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { nightsFrom } from '../cycle';
import { assembleDays, MemoryStore, type StreamDay, type StreamState } from '../incremental';
import type { IntradayDay } from '../intraday';
import { emptyRecord } from '../normalize';
import { SLEEP_HR_FLOOR } from '../registry';
import { backfillSleepHrFloor, FLOOR_BACKFILL_DAYS, sleepHrFloor, sleepHrFloorDays, sleepHrFloorWindow } from '../sleepHrFloor';
import { HealthTransport } from '../transport';

/**
 * The night's heart rate floor: the tenth percentile of the minutes inside the main sleep, only
 * when they cover enough of it; stored like a stream for the window and filled in backwards.
 */

const secs = (iso: string) => Date.parse(iso) / 1000;
/** One civil day of minute heart rate (in UTC), `bpm` for each minute from `fromIso` for `count` minutes. */
function minutes(date: CivilDate, fromIso: string, count: number, bpm: (i: number) => number): IntradayDay {
  const t0 = secs(fromIso);
  const t = Array.from({ length: count }, (_, i) => t0 + 60 * i);
  return { date, t, m: t.map((s) => Math.floor((s % 86400) / 60)), v: t.map((_, i) => bpm(i)) };
}
const session = (bedtimeIso: string, wakeIso: string) => ({ bedtimeIso, wakeIso });
const sleepOf = (bedtimeIso: string, wakeIso: string) => ({
  ...emptyRecord('2026-08-11').sleep, bedtimeIso, wakeIso, date: '2026-08-11', isMainSleep: true, isNap: false, bedtimeMin: 0, wakeMin: 0,
  minutesAsleep: 400, onsetLatencyMin: 0, minutesAwake: 20, minutesInBed: 420, efficiency: 95, stages: null, segments: [], shortAwakeningsMin: [], source: null,
}) as any;

describe('the night\'s heart rate floor', () => {
  // Bed at 23:30, up at 06:30: 420 minutes, across two civil days.
  const night = [minutes('2026-08-10', '2026-08-10T23:00:00Z', 60, () => 70), minutes('2026-08-11', '2026-08-11T00:00:00Z', 420, (i) => 50 + (i % 20))];

  it('is the tenth percentile of the minutes between bedtime and waking', () => {
    const v = sleepHrFloor(session('2026-08-10T23:30:00Z', '2026-08-11T06:30:00Z'), night);
    // 30 minutes at 70 before midnight, then 390 minutes cycling 50 to 69: the 42nd lowest of 420 is 52.
    assert.equal(v, 52);
  });

  it('needs two hours of minutes, and half the sleep', () => {
    assert.equal(sleepHrFloor(session('2026-08-10T23:30:00Z', '2026-08-11T06:30:00Z'), [night[0]]), null, 'only the evening');
    const short = [minutes('2026-08-11', '2026-08-11T00:00:00Z', 100, () => 55)];
    assert.equal(sleepHrFloor(session('2026-08-11T00:00:00Z', '2026-08-11T02:00:00Z'), short), null, 'under two hours');
    assert.equal(sleepHrFloor(session('', ''), night), null, 'no times');
  });

  it('files each night under the morning it ends on, and skips nights without enough minutes', () => {
    const days = [
      { date: '2026-08-11', sleep: sleepOf('2026-08-10T23:30:00Z', '2026-08-11T06:30:00Z') },
      { date: '2026-08-12', sleep: sleepOf('2026-08-11T23:30:00Z', '2026-08-12T06:30:00Z') },
      { date: '2026-08-13', sleep: null },
    ];
    const out = sleepHrFloorDays(days, night);
    assert.deepEqual(Object.keys(out), ['2026-08-11']);
    assert.equal(out['2026-08-11'].fields.sleepHrFloor, 52);
    assert.deepEqual(out['2026-08-11'].present, [SLEEP_HR_FLOOR.dataType]);
  });

  it('recomputes the window from its second day and keeps older coverage', () => {
    const sleepDays = [{ date: '2026-08-11', sleep: sleepOf('2026-08-10T23:30:00Z', '2026-08-11T06:30:00Z') }];
    const prev = { ...state('2026-05-01', '2026-08-01'), latestDate: '2026-08-01' as CivilDate };
    const w = sleepHrFloorWindow(prev, sleepDays, night, { windowStart: '2026-07-01', today: '2026-08-31', keepFrom: '2025-09-01' });
    assert.deepEqual(w.replace, [{ from: '2026-07-02', to: '2026-08-31' }]);
    assert.equal(w.days['2026-08-11'].fields.sleepHrFloor, 52);
    assert.equal(w.state.coveredFrom, '2026-05-01');
    assert.equal(w.state.latestDate, '2026-08-11');
    assert.equal(w.state.report.mode, 'derived');
    assert.equal(w.state.report.status, 'ok');
    const first = sleepHrFloorWindow(undefined, sleepDays, [], { windowStart: '2026-07-01', today: '2026-08-31', keepFrom: '2025-09-01' });
    assert.equal(first.state.coveredFrom, '2026-07-02', 'a first write covers the window it computed');
    assert.equal(first.state.report.status, 'empty');
  });

  it('reads as the sleeping heart rate once it covers half the nights the non-REM figure does', () => {
    const days = Array.from({ length: 10 }, (_, i) => ({ ...emptyRecord(addDays('2026-08-01', i)), nonRemHr: 60 + i }));
    assert.equal(nightsFrom(days)[3].sleepHr, 63, 'non-REM alone');
    days.forEach((d, i) => { if (i < 4) d.sleepHrFloor = 50 + i; });
    assert.equal(nightsFrom(days)[3].sleepHr, 63, 'the floor on fewer than half the nights');
    days.forEach((d, i) => { if (i < 5) d.sleepHrFloor = 50 + i; });
    const nights = nightsFrom(days);
    assert.equal(nights[3].sleepHr, 53, 'the floor once it covers half');
    assert.equal(nights[7].sleepHr ?? null, null, 'and nothing where it has no night');
    const older = { cycleSleepHrFloor: { rows: [{ key: '2026-07-20', mean: 48 }] }, cycleSleepHr: { rows: [{ key: '2026-07-20', mean: 58 }] } } as any;
    assert.equal(nightsFrom(days, older)[0].sleepHr, 48, 'history rows too');
  });

  it('shows up in the assembled days', () => {
    const store = new MemoryStore();
    store.applyWrites([{ dataType: SLEEP_HR_FLOOR.dataType, replace: [], days: { '2026-08-11': { fields: { sleepHrFloor: 52 }, present: [SLEEP_HR_FLOOR.dataType], sources: [], sourceByType: {} } }, state: state('2026-08-11', '2026-08-11') }]);
    const days = assembleDays(store.rows, '2026-08-10', '2026-08-11');
    assert.equal(days[0].sleepHrFloor, null);
    assert.equal(days[1].sleepHrFloor, 52);
    assert.deepEqual(days[1].present, [SLEEP_HR_FLOOR.dataType]);
  });
});

function state(coveredFrom: CivilDate, finalThrough: CivilDate): StreamState {
  return {
    dataType: SLEEP_HR_FLOOR.dataType, coveredFrom, finalThrough, latestDate: null, parsed: 0, sources: [],
    report: { dataType: SLEEP_HR_FLOOR.dataType, label: SLEEP_HR_FLOOR.label, domain: 'cardio', mode: 'derived', status: 'ok', observations: 0, requests: 0, pagesFetched: 0, truncated: false, ms: 0 },
  };
}

describe('its history, a fortnight at a time', () => {
  /** Google's minute rollup for any range: 55 to 64 bpm through the night, 80 by day. */
  const rollUp = (status = 200) => new HealthTransport({
    token: 'test', maxRetries: 0,
    fetchImpl: async (url, init) => {
      if (!url.includes('dataPoints:rollUp')) return new Response('{}', { status: 404 });
      if (status !== 200) return new Response(JSON.stringify({ error: { code: status, message: 'nope' } }), { status });
      const { range } = JSON.parse(String(init?.body));
      const points = [];
      for (let t = secs(range.startTime); t < secs(range.endTime); t += 60) {
        const hour = Math.floor((t % 86400) / 3600);
        points.push({ startTime: new Date(t * 1000).toISOString(), heartRate: { beatsPerMinuteAvg: hour < 7 || hour >= 23 ? 55 + ((t / 60) % 10) : 80 } });
      }
      return new Response(JSON.stringify({ rollupDataPoints: points }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  /** A main sleep every night, 23:00 to 07:00. */
  const loadSleep = async (from: CivilDate, to: CivilDate) => {
    const out: { date: CivilDate; sleep: any }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, sleep: sleepOf(`${addDays(d, -1)}T23:00:00Z`, `${d}T07:00:00Z`) });
    return out;
  };
  const opts = { timeZone: 'UTC', now: new Date('2026-09-01T12:00:00Z') };

  it('moves coverage back a fortnight per step, stops at the start, and keeps the figures only', async () => {
    const prev = state('2026-08-15', '2026-08-31');
    const one = (await backfillSleepHrFloor(rollUp(), prev, loadSleep, '2026-07-20', opts))!;
    assert.deepEqual(one.replace, [{ from: addDays('2026-08-14', -(FLOOR_BACKFILL_DAYS - 1)), to: '2026-08-14' }]);
    assert.equal(one.state.coveredFrom, '2026-08-01');
    assert.equal(Object.keys(one.days).length, FLOOR_BACKFILL_DAYS);
    // 480 night minutes cycling 55 to 64, 48 of each: the 49th lowest is 56.
    assert.equal(one.days['2026-08-10'].fields.sleepHrFloor, 56);
    assert.equal(one.state.report.requests, 2, 'fifteen days of minutes: the fortnight and the evening before it');
    const two = (await backfillSleepHrFloor(rollUp(), one.state, loadSleep, '2026-07-20', opts))!;
    assert.deepEqual(two.replace, [{ from: '2026-07-20', to: '2026-07-31' }], 'the last step is cut at the start');
    assert.equal(two.state.coveredFrom, '2026-07-20');
    assert.equal(await backfillSleepHrFloor(rollUp(), two.state, loadSleep, '2026-07-20', opts), null, 'done');
  });

  it('notes a failed fetch on the state and moves nothing', async () => {
    const prev = state('2026-08-15', '2026-08-31');
    const w = (await backfillSleepHrFloor(rollUp(500), prev, loadSleep, '2026-07-20', opts))!;
    assert.deepEqual(w.replace, []);
    assert.equal(w.state.coveredFrom, '2026-08-15');
    assert.ok(w.state.backfillError || w.state.backfillErrorCode, 'Google\'s words, or a code');
    const again = (await backfillSleepHrFloor(rollUp(), w.state, loadSleep, '2026-07-20', opts))!;
    assert.equal(again.state.backfillError, undefined, 'cleared once a step succeeds');
  });
});
