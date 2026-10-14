import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, civilFromGH, civilFromInstant, dateRange, formatCivilDay, formatCivilRange, isoWeekdayIndex, parseUtcOffsetSeconds, todayCivil } from '../../lib/date';
import { int, num, nullIf, round } from '../coerce';
import { splitWindow, MAX_ROLLUP_WINDOW_DAYS } from '../transport';
import { syncHealthData } from '../sync';
import { FIXTURE_CLOCK, buildFixturePayloads, createFixtureFetch } from '../fixtures';
import {
  HISTORY_QUERIES, evaluate, insightFeeds, monthSummary, needLabel, observations, recoveryTax, settle, todaySummary, weekSummary,
  type Finding,
} from '../insights';
import { freshEntry } from '../insights/helpers';
import { scoreSleep } from '../sleep';
import {
  compareToBaseline, coverage, findGaps, periodShift, rollingMean, series, stats, values,
  bedtimeConsistency, currentStreak, readiness, windowShift, firstObserved, sleepRegularity, circularMeanMinutes, typicalSleepWindow,
  sleepNeedFor, goalStreak, weightTrend, batteryTier, latestBody,
} from '../derive';
import { DEFAULT_GOALS, GOAL_LIMITS, parseGoals, readGoals, type Goals } from '../goals';
import { STREAMS } from '../registry';
import { answerQueries, parseQueries, queryRange, type HistoryQueries } from '../history';
import { answerFromRows } from '../incremental';
import { emptyRecord } from '../normalize';
import type { SyncResult } from '../sync';

/** Every test runs against a fixed "today" so the 62-day window is deterministic. */
const NOW = new Date('2026-08-19T01:39:00+02:00');

let cached: SyncResult | null = null;
async function dataset(): Promise<SyncResult> {
  if (cached) return cached;
  cached = await syncHealthData({
    token: 'test',
    fetchImpl: createFixtureFetch(buildFixturePayloads()),
    windowDays: 62,
    now: NOW,
    includeIntraday: true,
  });
  return cached;
}

/** A 180-day window, so the sparse hand-logged body readings fall inside it. */
let cachedWide: SyncResult | null = null;
async function wideDataset(): Promise<SyncResult> {
  if (cachedWide) return cachedWide;
  cachedWide = await syncHealthData({
    token: 'test',
    fetchImpl: createFixtureFetch(buildFixturePayloads()),
    windowDays: 180,
    now: NOW,
  });
  return cachedWide;
}

const day = (ds: SyncResult, date: string) => {
  const d = ds.days.find((x) => x.date === date);
  assert.ok(d, `no row for ${date}`);
  return d!;
};

// ───────────────────────────────────────────────────────────── primitives

describe('coerce', () => {
  it('parses the API’s string-encoded numbers', () => {
    assert.equal(num('7229'), 7229);
    assert.equal(num(521.318), 521.318);
    assert.equal(int('63'), 63);
  });

  it('returns null — never 0 or NaN — for unusable values', () => {
    // The literal string "NaN" appears in baselineTemperatureCelsius.
    assert.equal(num('NaN'), null);
    assert.equal(num(null), null);
    assert.equal(num(undefined), null);
    assert.equal(num(''), null);
    assert.equal(num(Number.NaN), null);
    assert.equal(num(Infinity), null);
    assert.equal(num({}), null);
  });

  it('treats sentinel zeros as missing where documented', () => {
    assert.equal(nullIf(0, 0), null);
    assert.equal(nullIf(40.1, 0), 40.1);
  });

  it('preserves null through rounding', () => {
    assert.equal(round(null, 2), null);
    assert.equal(round(35.37899, 2), 35.38);
  });
});

describe('civil dates', () => {
  it('reads Google’s {year,month,day}', () => {
    assert.equal(civilFromGH({ year: 2026, month: 8, day: 4 }), '2026-08-04');
    assert.equal(civilFromGH({ year: 2026, month: 8 }), null);
    assert.equal(civilFromGH(undefined), null);
  });

  it('parses utcOffset in seconds-string form', () => {
    assert.equal(parseUtcOffsetSeconds('7200s'), 7200);
    assert.equal(parseUtcOffsetSeconds('3600s'), 3600);
    assert.equal(parseUtcOffsetSeconds('+02:00'), 7200);
    assert.equal(parseUtcOffsetSeconds(undefined), 0);
  });

  it('assigns a late-evening UTC instant to the correct local day', () => {
    // 23:39 UTC on the 18th is 01:39 local on the 19th at +02:00.
    const c = civilFromInstant('2026-08-18T23:39:05Z', '7200s');
    assert.equal(c!.date, '2026-08-19');
    assert.equal(c!.minutesOfDay, 99); // 01:39
  });

  it('does calendar arithmetic without timezone drift', () => {
    assert.equal(addDays('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(addDays('2026-08-18', -61), '2026-06-18');
  });

  it('derives today from local getters, once, at the edge', () => {
    assert.equal(todayCivil(new Date(2026, 7, 19, 1, 39)), '2026-08-19');
  });

  it('writes the day under the tabs as weekday, month, day and year', () => {
    assert.equal(formatCivilDay('2026-10-12'), 'Mon Oct 12 2026');
    assert.equal(formatCivilDay('2026-08-05'), 'Wed Aug 5 2026');
  });

  it('writes a span of days compactly, naming the month once when it can', () => {
    assert.equal(formatCivilRange('2026-08-11', '2026-08-17'), '11–17 Aug');
    assert.equal(formatCivilRange('2026-07-29', '2026-08-04'), '29 Jul – 4 Aug');
    assert.equal(formatCivilRange('2025-12-29', '2026-01-04'), '29 Dec – 4 Jan');
  });
});

describe('transport windowing', () => {
  it('splits a 62-day window into ≤14-day chunks with no gaps or overlap', () => {
    const chunks = splitWindow('2026-06-18', '2026-08-18', MAX_ROLLUP_WINDOW_DAYS);
    assert.equal(chunks[0].start, '2026-06-18');
    assert.equal(chunks.at(-1)!.end, '2026-08-18');
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].start, addDays(chunks[i - 1].end, 1), 'chunks must be contiguous');
    }
  });

  it('handles a window shorter than one chunk', () => {
    assert.deepEqual(splitWindow('2026-08-18', '2026-08-18', 14), [
      { start: '2026-08-18', end: '2026-08-18' },
    ]);
  });
});

// ─────────────────────────────────────────── the bugs, one test each

describe('regressions from the previous implementation', () => {
  it('resting heart rate reads beatsPerMinute, not the non-existent heartRateBpm', async () => {
    const ds = await dataset();
    // Old build: latest = last array element = oldest record = 73.
    assert.equal(day(ds, '2026-08-18').restingHr, 63);
    assert.equal(day(ds, '2026-06-18').restingHr, 73);
  });

  it('HRV reads averageHeartRateVariabilityMilliseconds, not rmssdMillis', async () => {
    const ds = await dataset();
    assert.equal(day(ds, '2026-08-18').hrv, 44.1);
    // Deep-sleep RMSSD is a separate field and must not be conflated with it.
    assert.notEqual(day(ds, '2026-08-18').hrvDeepSleep, day(ds, '2026-08-18').hrv);
  });

  it('SpO2 reads averagePercentage and keeps the min/max envelope', async () => {
    const ds = await dataset();
    const s = day(ds, '2026-08-18').spo2!;
    assert.equal(s.avg, 95.7);
    assert.equal(s.ciLower, 93.2);
    assert.equal(s.ciUpper, 98.5);
  });

  it('prefers the source with a real envelope when two devices report one day', async () => {
    const ds = await dataset();
    // Fitbit says 93.8 (90.4–96.5); Samsung says 95 with lo == hi == 95.
    const s = day(ds, '2026-07-21').spo2!;
    assert.equal(s.avg, 93.8);
    assert.notEqual(s.ciLower, s.ciUpper);
  });

  it('skin temperature is stored as deviation from baseline, not absolute °C', async () => {
    const ds = await dataset();
    const d = day(ds, '2026-08-18');
    assert.equal(d.skinTempDeviationC, 0.34);
    // The absolute value is kept but is not what the UI leads with.
    assert.ok(d.skinTempNightlyC! > 30);
  });

  it('leaves temperature deviation null while the baseline is still "NaN"', async () => {
    const ds = await dataset();
    const earliest = ds.days.find((d) => d.skinTempNightlyC !== null)!;
    assert.equal(earliest.skinTempDeviationC, null);
  });

  it('treats vo2Max: 0 as uncalibrated rather than a fitness collapse', async () => {
    const ds = await dataset();
    for (const d of ds.days) {
      assert.notEqual(d.vo2Max, 0, `${d.date} recorded a literal zero VO2max`);
    }
    assert.equal(day(ds, '2026-08-18').vo2Max, 40.1);
    assert.equal(day(ds, '2026-07-26').vo2Max, 35.4);
    assert.equal(day(ds, '2026-08-18').cardioFitnessLevel, 'AVERAGE');
  });

  it('picks the newest weight reading, not the oldest', async () => {
    const ds = await dataset();
    const withWeight = ds.days.filter((d) => d.weightKg !== null);
    assert.equal(withWeight.at(-1)!.weightKg, 108); // 7 Jul, not 110 from February
    assert.equal(withWeight.at(-1)!.date, '2026-07-07');
  });

  it('reads the latest weigh-in, the one before it, and the newest split of fat and lean', async () => {
    const body = latestBody((await wideDataset()).days);
    assert.deepEqual(body.weighIns.map((p) => p.date), ['2026-02-26', '2026-05-21', '2026-06-03', '2026-06-16', '2026-07-07']);
    assert.deepEqual(body.latest, { date: '2026-07-07', value: 108 });
    assert.deepEqual(body.previous, { date: '2026-06-16', value: 109.7 });
    const now = body.composition!;
    const before = body.previousComposition!;
    assert.equal(now.date, '2026-07-07');
    assert.equal(now.fatPct, 39.1);
    assert.equal(Math.round(now.fatKg * 10) / 10, 42.2);
    assert.equal(Math.round(now.leanKg * 10) / 10, 65.8);
    assert.equal(before.date, '2026-06-16');
    // From the reading before: 1.4 kg less fat, 0.3 kg less lean.
    assert.equal(Math.round((now.fatKg - before.fatKg) * 10) / 10, -1.4);
    assert.equal(Math.round((now.leanKg - before.leanKg) * 10) / 10, -0.3);
  });

  it('reads the age from the Google Health profile, and only with its scope', async () => {
    assert.equal((await dataset()).profile.age, 41);
    const without = await syncHealthData({
      token: 'test', fetchImpl: createFixtureFetch(), windowDays: 62, now: NOW,
      grantedScopes: ['activity', 'sleep', 'metrics', 'nutrition', 'ecg', 'irn'],
    });
    assert.equal(without.profile.age, null);
    assert.equal(without.profile.heightCm, 175);
  });

  it('keys sleep to the morning of waking, from endTime + endUtcOffset', async () => {
    const ds = await dataset();
    // Bed at 01:57 local on the 18th, awake 07:36 — one night, filed under the 18th.
    const d = day(ds, '2026-08-18');
    assert.ok(d.sleep, 'sleep session missing — the old build looked for civilEndTime');
    assert.equal(d.sleep!.minutesAsleep, 332);
    assert.equal(d.sleep!.bedtimeMin, 117); // 01:57
    assert.equal(d.sleep!.wakeMin, 456); // 07:36
  });

  it('separates the 25-minute nap from the night’s sleep', async () => {
    const ds = await dataset();
    const d = day(ds, '2026-08-09');
    assert.equal(d.sleep!.minutesAsleep, 310, 'main sleep must win over the nap');
    assert.equal(d.naps.length, 1);
    assert.equal(d.naps[0].minutesAsleep, 25);
    assert.equal(d.naps[0].isNap, true);
  });

  it('uses the reported distance stream instead of estimating from step count', async () => {
    const ds = await dataset();
    const d = day(ds, '2026-08-18');
    assert.equal(d.distanceKm, 5.15);
    // steps × 0.74 / 1000 — the old estimate — would have produced 5.35.
    assert.notEqual(d.distanceKm, round((d.steps! * 0.74) / 1000, 2));
  });

  it('rolls intraday heart rate up into one-minute averages and reports the true span', async () => {
    const ds = await dataset();
    // 900 raw samples at 3 s are 45 minutes: one averaged sample per minute.
    assert.equal(ds.heartRateSamples.length, 45);
    const spanMin =
      (Date.parse(ds.heartRateSamples.at(-1)!.iso) - Date.parse(ds.heartRateSamples[0].iso)) / 60000;
    // The point of the test: this is emphatically not "today".
    assert.equal(spanMin, 44);
    assert.ok(Date.parse(ds.heartRateSamples[0].iso) < Date.parse(ds.heartRateSamples.at(-1)!.iso), 'must be ascending');
    assert.ok(ds.heartRateSamples.every((s) => Number.isInteger(s.value) && s.value > 40 && s.value < 130));
  });

  it('never fabricates heart-rate zones from active minutes', async () => {
    const ds = await dataset();
    const d = day(ds, '2026-08-18');
    // Zone minutes come from the AZM stream or they don't exist.
    assert.ok(d.zoneMinutes);
    const sum = d.zoneMinutes!.fatBurn + d.zoneMinutes!.cardio + d.zoneMinutes!.peak;
    const active = d.activeMinutes!.light + d.activeMinutes!.moderate + d.activeMinutes!.vigorous;
    assert.notEqual(sum, active, 'zones must not be a fixed ratio of active minutes');
  });

  it('reports streams with no data as empty, not as errors', async () => {
    const ds = await dataset();
    for (const dt of ['hydration-log', 'blood-glucose']) {
      const st = ds.meta.streams.find((s) => s.dataType === dt)!;
      assert.ok(st, `${dt} must appear in the stream report`);
      assert.equal(st.status, 'empty', `${dt} returned nothing and should say so`);
    }
  });

  it('reports a rejected dataType as an error with its reason, not as empty', async () => {
    // The registry no longer carries a permanently-broken stream, so the error
    // path is exercised by injecting a 400 into an otherwise healthy one.
    const payloads = buildFixturePayloads() as any;
    payloads['daily-vo2-max'] = {
      __httpError: {
        status: 400,
        body: JSON.stringify({ error: { code: 400, message: 'boom', status: 'INVALID_ARGUMENT' } }),
      },
    };
    const ds = await syncHealthData({
      token: 'test', fetchImpl: createFixtureFetch(payloads), windowDays: 62, now: NOW,
    });
    const vo2 = ds.meta.streams.find((s) => s.dataType === 'daily-vo2-max')!;
    assert.equal(vo2.status, 'error');
    assert.equal(vo2.httpStatus, 400);
    assert.match(vo2.error!, /INVALID_ARGUMENT/);
    // And per-stream failure must stay per-stream: everything else still landed.
    const rhr = ds.meta.streams.find((s) => s.dataType === 'daily-resting-heart-rate')!;
    assert.equal(rhr.status, 'ok');
  });
});

// ────────────────────────────────────────────────── missing data handling

describe('missing data', () => {
  it('materialises every day in the window, gaps included', async () => {
    const ds = await dataset();
    assert.equal(ds.days.length, 62);
    assert.equal(ds.days[0].date, '2026-06-18');
    assert.equal(ds.days.at(-1)!.date, '2026-08-18');
    for (let i = 1; i < ds.days.length; i++) {
      assert.equal(ds.days[i].date, addDays(ds.days[i - 1].date, 1));
    }
  });

  it('records null — not zero — for days a stream did not cover', async () => {
    const ds = await dataset();
    // Movement data begins 23 Jul; June must be null, or every average is wrong.
    assert.equal(day(ds, '2026-06-20').steps, null);
    assert.equal(day(ds, '2026-07-22').steps, null);
    assert.equal(day(ds, '2026-07-23').steps, 11251);
  });

  it('keeps missing days out of averages', async () => {
    const ds = await dataset();
    const s = series(ds.days, (d) => d.steps);
    const st = stats(values(s))!;
    assert.equal(st.n, 27, 'only the 27 recorded days should count');
    assert.ok(st.mean > 7000 && st.mean < 8200, `mean was ${st.mean}`);
    // Had nulls become zeros, the mean would fall to ~3,340.
    const withZeros = s.map((p) => p.value ?? 0);
    assert.ok(stats(withZeros)!.mean < 3500);
  });

  it('finds the mid-July outage as a contiguous gap', async () => {
    const ds = await dataset();
    const gaps = findGaps(ds.days, 'daily-resting-heart-rate', 2);
    const july = gaps.find((g) => g.from === '2026-07-14');
    assert.ok(july, 'the 14–17 Jul outage should be detected');
    assert.equal(july!.to, '2026-07-17');
    assert.equal(july!.days, 4);
  });

  it('builds a coverage matrix with staleness per stream', async () => {
    const ds = await dataset();
    const rows = coverage(ds.days, STREAMS.map((s) => ({ dataType: s.dataType, label: s.label })));
    const weight = rows.find((r) => r.dataType === 'weight')!;
    assert.equal(weight.latest, '2026-07-07');
    assert.equal(weight.staleDays, 42);
    const rhr = rows.find((r) => r.dataType === 'daily-resting-heart-rate')!;
    assert.equal(rhr.observed, 58);
    assert.equal(rhr.total, 62);
  });
});

// ─────────────────────────────────────────────────────────── derivations

describe('derivations', () => {
  it('computes a robust baseline and flags an unusual day', async () => {
    const ds = await dataset();
    const hrv = compareToBaseline(series(ds.days, (d) => d.hrv));
    assert.equal(hrv.value, 44.1);
    assert.ok(hrv.baseline! > 25 && hrv.baseline! < 42);
    assert.ok(hrv.z! > 0, 'the final night is above baseline');
    assert.ok(hrv.n >= 20);
  });

  it('withholds a band until enough history exists', () => {
    const short = [
      { date: '2026-08-16', value: 40 },
      { date: '2026-08-17', value: 41 },
      { date: '2026-08-18', value: 90 },
    ];
    const c = compareToBaseline(short, 28, 8);
    assert.equal(c.value, 90);
    assert.equal(c.band, null, 'no verdict from two prior points');
  });

  it('separates "this fortnight vs last" from "across the whole window"', async () => {
    const ds = await dataset();
    const rhrSeries = series(ds.days, (d) => d.restingHr);
    const hrvSeries = series(ds.days, (d) => d.hrv);

    // Adjacent fortnights: the current move.
    const rhrRecent = periodShift(rhrSeries, 14);
    assert.ok(rhrRecent.delta! < -3, `resting HR fortnight-on-fortnight, got ${rhrRecent.delta}`);

    // First 14 observations vs last 14: the two-month trend.
    const rhrWhole = windowShift(rhrSeries, 14);
    assert.ok(rhrWhole.delta! < -8, `resting HR across the window, got ${rhrWhole.delta}`);
    const hrvWhole = windowShift(hrvSeries, 14);
    assert.ok(hrvWhole.delta! > 10, `HRV across the window, got ${hrvWhole.delta}`);

    // The two answers genuinely differ, which is why both are exposed.
    const hrvRecent = periodShift(hrvSeries, 14);
    assert.ok(hrvWhole.delta! > hrvRecent.delta! + 5);
  });

  it('leaves rolling means null until the window has enough observations', async () => {
    const ds = await dataset();
    const rm = rollingMean(series(ds.days, (d) => d.steps), 7, 4);
    assert.equal(rm[0].value, null);
    assert.ok(rm.at(-1)!.value! > 0);
  });

  it('folds post-midnight bedtimes so consistency is measured correctly', () => {
    const nights = [
      { date: '2026-08-16', sleep: { bedtimeMin: 23 * 60 + 50 } },
      { date: '2026-08-17', sleep: { bedtimeMin: 10 } },
      { date: '2026-08-18', sleep: { bedtimeMin: 0 } },
    ] as any;
    const c = bedtimeConsistency(nights)!;
    // 23:50, 00:10, 00:00 are 20 minutes apart, not 16 hours.
    assert.ok(c.sdMin < 15, `sd was ${c.sdMin}`);
  });

  it('counts a streak only over consecutive recorded days', () => {
    const s = [
      { date: '2026-08-15', value: 11167 },
      { date: '2026-08-16', value: 8995 },
      { date: '2026-08-17', value: 12000 },
      { date: '2026-08-18', value: 10500 },
    ];
    assert.equal(currentStreak(s, (v) => v >= 10000), 2);
    assert.equal(currentStreak([...s, { date: '2026-08-19', value: null }], (v) => v >= 10000), 0);
  });

  it('scores sleep transparently and the parts sum to the total', async () => {
    const ds = await dataset();
    const sc = scoreSleep(day(ds, '2026-08-18').sleep!);
    assert.equal(sc.duration + sc.restoration + sc.efficiency, sc.total);
    assert.ok(sc.total > 0 && sc.total <= 100);
    assert.equal(sc.restorativePct, 45); // (84 deep + 66 REM) / 332
  });

  it('returns no readiness score rather than a fake one when signals are absent', () => {
    const empty = readiness([]);
    assert.equal(empty.score, null);
    assert.equal(empty.confidence, 'low');
    const bare = readiness(['2026-08-10', '2026-08-11', '2026-08-12'].map(emptyRecord));
    assert.equal(bare.score, null);
  });

  it('builds readiness from labelled parts that sum onto the neutral baseline', async () => {
    const ds = await dataset();
    const r = readiness(ds.days);
    assert.ok(r.score! >= 1 && r.score! <= 100);
    assert.ok(r.parts.length >= 3, `expected at least the three core parts, got ${r.parts.length}`);
    const raw = 70 + r.parts.reduce((a, p) => a + p.contribution, 0);
    const expected = Math.round(Math.min(100, Math.max(1, raw)));
    assert.equal(r.score, expected, 'the breakdown must explain the score exactly');
    assert.equal(r.confidence, 'high');
  });
});

// ───────────────────────────────────────────────────────── observability

describe('sync reporting', () => {
  it('reports one row per stream with requests, timing and observations', async () => {
    const ds = await dataset();
    assert.ok(ds.meta.streams.length >= STREAMS.length);
    for (const s of ds.meta.streams) {
      assert.ok(['ok', 'empty', 'error', 'unauthorized', 'skipped'].includes(s.status));
      assert.ok(s.requests >= 0);
    }
    assert.ok(ds.meta.totalRequests > 0);
    assert.equal(ds.meta.hasData, true);
  });

  it('distinguishes "returned 200 with nothing" from "failed"', async () => {
    const ds = await dataset();
    const floors = ds.meta.streams.find((s) => s.dataType === 'floors')!;
    assert.equal(floors.status, 'empty');
    assert.equal(floors.error, undefined);
  });

  it('identifies all three devices from dataSource blocks', async () => {
    const ds = await dataset();
    const labels = ds.meta.sources.map((s) => s.label).sort();
    // Four distinct dataSource signatures: the watch, hand-typed Fitbit entries,
    // Samsung Health via Health Connect, and the archived Oura readings.
    assert.deepEqual(labels, ['Fitbit', 'Google Fitbit Air', 'Oura Ring', 'Samsung Health']);
    const manual = ds.meta.sources.find((s) => s.label === 'Fitbit')!;
    assert.equal(manual.method, 'MANUAL');
  });

  it('hoists height out of the daily rows into profile facts', async () => {
    const ds = await dataset();
    assert.equal(ds.profile.heightCm, 175);
    assert.equal(ds.profile.heightRecordedOn, '2026-05-21');
  });

  it('skips streams whose scope was not granted instead of retrying 403s', async () => {
    const ds = await syncHealthData({
      token: 'test',
      fetchImpl: createFixtureFetch(),
      windowDays: 14,
      now: NOW,
      grantedScopes: ['activity'],
    });
    const sleep = ds.meta.streams.find((s) => s.dataType === 'sleep')!;
    assert.equal(sleep.status, 'skipped');
    assert.equal(sleep.requests, 0);
    const steps = ds.meta.streams.find((s) => s.dataType === 'steps')!;
    assert.equal(steps.status, 'ok');
  });

  it('survives a stream that throws without losing the others', async () => {
    const good = createFixtureFetch();
    const flaky: typeof good = async (url, init) => {
      if (url.includes('/steps/')) throw new Error('socket hang up');
      return good(url, init);
    };
    const ds = await syncHealthData({
      token: 'test', fetchImpl: flaky, windowDays: 14, now: NOW, maxRetriesOverride: 0,
    } as any);
    const steps = ds.meta.streams.find((s) => s.dataType === 'steps')!;
    assert.equal(steps.status, 'error');
    const rhr = ds.meta.streams.find((s) => s.dataType === 'daily-resting-heart-rate')!;
    assert.equal(rhr.status, 'ok');
  });
});

// ─────────────────────────────────── fixes found by looking at the rendering

describe('second-pass corrections', () => {
  it('does not report the period before a stream started as a gap', async () => {
    const ds = await dataset();
    // Sleep records begin 8 Aug; the 62-day window opens on 18 Jun. That 51-day
    // stretch is "before sleep data existed", not a gap in it.
    const gaps = findGaps(ds.days, 'sleep', 2);
    const firstNight = ds.days.find((d) => d.sleep)!.date;
    for (const g of gaps) {
      assert.ok(g.from >= firstNight, `gap at ${g.from} precedes the first record ${firstNight}`);
    }
    assert.equal(firstObserved(ds.days, 'sleep'), firstNight);
  });

  it('still reports genuine interior gaps', async () => {
    const ds = await dataset();
    const gaps = findGaps(ds.days, 'daily-resting-heart-rate', 2);
    assert.ok(gaps.some((g) => g.from === '2026-07-14' && g.days === 4));
  });

  it('scores a short night as short even when its quality is excellent', async () => {
    const ds = await dataset();
    const sc = scoreSleep(day(ds, '2026-08-18').sleep!);
    // 5h32m, 45% deep+REM, 98% efficient. Quality is near-perfect but it is still
    // an hour and a half short, and the total has to say so.
    assert.ok(sc.total < 80, `a 5h32m night should not score ${sc.total}`);
    assert.ok(sc.duration < 30, `duration component was ${sc.duration}/50`);
    assert.equal(sc.duration + sc.restoration + sc.efficiency, sc.total);
  });

  it('gives full duration marks in the 7–9 hour band', () => {
    const base = { minutesAwake: 10, minutesInBed: 490, efficiency: 96, stages: null, segments: [], shortAwakeningsMin: [] };
    const eight = scoreSleep({ ...base, minutesAsleep: 480 } as any);
    assert.equal(eight.duration, 50);
    const four = scoreSleep({ ...base, minutesAsleep: 240 } as any);
    assert.equal(four.duration, 0, 'the taper bottoms out at four hours');
  });

  it('makes efficiency discriminating rather than a free 25 points', () => {
    const mk = (efficiency: number) =>
      scoreSleep({
        minutesAsleep: 480, minutesAwake: 10, minutesInBed: 490, efficiency,
        stages: null, segments: [], shortAwakeningsMin: [],
      } as any).efficiency;
    assert.equal(mk(100), 25);
    assert.ok(mk(90) < 15, `90% efficiency scored ${mk(90)}`);
    assert.equal(mk(85), 0);
    assert.equal(mk(70), 0, 'never negative');
  });

  it('attributes each measurement to the source that supplied it', async () => {
    const ds = await wideDataset();
    const jul7 = day(ds, '2026-07-07');
    // Hand-typed into Fitbit, not measured by the watch that also synced that day.
    assert.equal(jul7.sourceByType['weight'], 'FITBIT:Fitbit');
    assert.equal(jul7.sourceByType['daily-resting-heart-rate'], 'FITBIT:Google Fitbit Air');
    // Same metric, different app, three weeks earlier.
    assert.equal(day(ds, '2026-06-16').sourceByType['weight'], 'HEALTH_CONNECT:Samsung Health');
    // The archived Oura reading keeps its own attribution too.
    assert.equal(day(ds, '2026-02-26').sourceByType['weight'], 'HEALTH_CONNECT:Oura Ring');
  });

  it('counts observations inside the window and flags those outside it', async () => {
    const ds = await dataset();
    const weight = ds.meta.streams.find((s) => s.dataType === 'weight')!;
    // Five readings parse. Over a 62-day window only 7 Jul is in scope; the other
    // four are older. The report must not present four missing rows as a failure.
    assert.equal(weight.observations, 1);
    assert.equal(weight.parsedOutsideWindow, 4);
    // The stream table and the coverage grid must agree by construction.
    const cov = coverage(ds.days, [{ dataType: 'weight', label: 'Weight' }])[0];
    assert.equal(weight.observations, cov.observed);

    // Widen the window to 180 days and all five come into scope, February included.
    const wide = await wideDataset();
    const wideWeight = wide.meta.streams.find((s) => s.dataType === 'weight')!;
    assert.equal(wideWeight.observations, 5);
    assert.equal(wideWeight.parsedOutsideWindow, 0);
  });

  it('keeps a stream "ok" when its only observations sit outside the window', async () => {
    const ds = await syncHealthData({
      token: 'test',
      fetchImpl: createFixtureFetch(),
      windowDays: 3,
      now: NOW,
    });
    const weight = ds.meta.streams.find((s) => s.dataType === 'weight')!;
    assert.equal(weight.observations, 0);
    // It parsed fine — calling this an error would send you hunting a real bug.
    assert.equal(weight.status, 'ok');
    assert.ok(weight.parsedOutsideWindow! > 0);
  });
});

// ──────────────────────────────────────── readiness v2 (research-grounded)

/**
 * Synthetic-day helper: a run of stable baseline days ending in one day we
 * manipulate, so each mechanism can be tested in isolation. Baseline values
 * carry small alternating jitter — a perfectly constant series has zero spread
 * and no z-score is defined against it.
 */
function syntheticDays(
  n: number,
  overridesForLast: Partial<{
    hrv: number; restingHr: number; sleepMin: number; resp: number;
    tempDev: number; steps: number;
  }> = {},
  base: Partial<{ hrv: number; restingHr: number; sleepMin: number; resp: number; steps: number }> = {},
) {
  const b = { hrv: 34, restingHr: 62, sleepMin: 450, resp: 14, steps: 8000, ...base };
  const days: ReturnType<typeof emptyRecord>[] = [];
  // Five-point jitter cycle. Two properties matter: the median sits at zero with
  // MAD > 0 (a two-valued alternation puts the median ON one pole, making the
  // other pole read as a −2σ event), and index 27 % 5 = 2 lands on the zero, so
  // the default 28-day run ends exactly at baseline. The scale gives HRV a
  // realistic ~10% night-to-night spread rather than an implausibly tight one.
  const CYC = [1, -0.5, 0, 0.5, -1];
  const jit = (i: number) => CYC[i % 5];
  // Steps get their own permutation of the same values. With one shared cycle,
  // high-step days deterministically precede low-HRV nights and the synthetic
  // "quiet month" carries a built-in recovery-tax correlation — an artefact of
  // the fixture, not a property of a quiet month. Same multiset, same zero at
  // index 27 % 5 = 2, but the day-to-day pairing with the vitals is broken.
  const SCYC = [-0.5, 1, 0, -1, 0.5];
  const sjit = (i: number) => SCYC[i % 5];
  for (let i = 0; i < n; i++) {
    const d = emptyRecord(addDays('2026-07-01', i));
    const isLast = i === n - 1;
    const o = isLast ? overridesForLast : {};
    d.hrv = o.hrv ?? b.hrv + jit(i) * 5;
    d.restingHr = o.restingHr ?? b.restingHr + jit(i) * 2;
    d.respiratoryRate = o.resp ?? b.resp + jit(i) * 0.5;
    d.steps = o.steps ?? b.steps + sjit(i) * 1200;
    d.skinTempDeviationC = o.tempDev ?? jit(i) * 0.05;
    const mins = o.sleepMin ?? b.sleepMin + jit(i) * 20;
    d.sleep = {
      date: d.date, isMainSleep: true, isNap: false,
      bedtimeMin: 1380, wakeMin: 420, bedtimeIso: '', wakeIso: '',
      minutesAsleep: mins, onsetLatencyMin: null, minutesAwake: 10, minutesInBed: mins + 10,
      efficiency: 97, stages: null, segments: [], shortAwakeningsMin: [],
    };
    days.push(d);
  }
  return days;
}

const part = (r: ReturnType<typeof readiness>, label: string) =>
  r.parts.find((p) => p.label === label);

describe('readiness v2', () => {
  it('scores a fully typical day near the 70-point neutral', () => {
    const r = readiness(syntheticDays(28));
    assert.ok(Math.abs(r.score! - 70) <= 6, `typical day scored ${r.score}`);
    assert.equal(r.confidence, 'high');
    assert.equal(r.flags.length, 0);
  });

  it('judges HRV in the log domain: equal ratios move the score equally', () => {
    // ×1.3 up vs ÷1.3 down are symmetric ratios; in raw ms they are not
    // symmetric differences. ln-domain scoring must treat them alike in
    // magnitude (before the deliberate cap on the upside).
    const up = readiness(syntheticDays(28, { hrv: 34 * 1.15 }));
    const down = readiness(syntheticDays(28, { hrv: 34 / 1.15 }));
    const cUp = part(up, 'HRV vs baseline')!.contribution;
    const cDown = part(down, 'HRV vs baseline')!.contribution;
    assert.ok(cUp > 0 && cDown < 0);
    // The downside is allowed to be *larger* (suppression matters more), never smaller.
    assert.ok(Math.abs(cDown) >= Math.abs(cUp) - 0.01, `${cDown} vs ${cUp}`);
  });

  it('caps the HRV upside and applies the saturation guard far above baseline', () => {
    const moderate = readiness(syntheticDays(28, { hrv: 38 }));
    const extreme = readiness(syntheticDays(28, { hrv: 80 }));
    const cMod = part(moderate, 'HRV vs baseline')!.contribution;
    const pExt = part(extreme, 'HRV vs baseline')!;
    // A wildly elevated night must not earn more than a solidly good one.
    assert.ok(pExt.contribution <= 14.01, `extreme HRV earned ${pExt.contribution}`);
    assert.ok(pExt.contribution <= Math.max(cMod, 8) + 0.01);
    assert.ok(pExt.note, 'the saturation caution must be attached');
    assert.match(pExt.note!, /overload/i);
  });

  it('penalises suppressed HRV more than the same-sized elevation is rewarded', () => {
    const low = readiness(syntheticDays(28, { hrv: 20 }));
    const c = part(low, 'HRV vs baseline')!.contribution;
    assert.ok(c <= -12, `deep suppression only cost ${c}`);
    assert.ok(c >= -20.01, 'floor respected');
  });

  it('treats resting HR asymmetrically: elevation costs more than suppression earns', () => {
    const up = readiness(syntheticDays(28, { restingHr: 70 }));   // well above 62
    const down = readiness(syntheticDays(28, { restingHr: 54 })); // equally below
    const cUp = part(up, 'Resting HR vs baseline')!.contribution;
    const cDown = part(down, 'Resting HR vs baseline')!.contribution;
    assert.ok(cUp < 0 && cDown > 0);
    assert.ok(Math.abs(cUp) > Math.abs(cDown), `${cUp} vs +${cDown}`);
    assert.ok(cDown <= 6.01, 'suppression bonus is capped small');
  });

  it('uses a personal sleep-need estimate that cannot fall below 7 hours', () => {
    // A chronic 5.5h sleeper: the need clamps to 420, so another 5.5h night
    // still reads as short — restriction must not redefine "enough".
    const short = readiness(syntheticDays(28, {}, { sleepMin: 330 }));
    const p = part(short, 'Last night’s sleep')!;
    assert.ok(p.contribution < -5, `chronic short sleep scored ${p.contribution}`);
    assert.match(p.detail, /7h 00m need/);
  });

  it('counts prior-week sleep debt separately from last night (the v1 bug)', () => {
    // Same good last night in both; only the preceding week differs. In v1 the
    // debt input was accepted and silently ignored — these must now diverge.
    const rested = readiness(syntheticDays(28, { sleepMin: 460 }));
    const debtDays = syntheticDays(28, { sleepMin: 460 });
    for (let i = 20; i < 27; i++) debtDays[i].sleep!.minutesAsleep = 330; // short prior week
    const indebted = readiness(debtDays);
    assert.ok(indebted.score! < rested.score!, 'a short prior week must lower the score');
    const p = part(indebted, 'Recent sleep debt')!;
    assert.ok(p.contribution <= -4, `debt contribution was ${p.contribution}`);
    assert.match(p.detail, /short of need/);
  });

  it('penalises elevated breathing but pays nothing for low breathing', () => {
    const high = readiness(syntheticDays(28, { resp: 17.5 }));
    assert.ok(part(high, 'Breathing rate')!.contribution < 0);
    const low = readiness(syntheticDays(28, { resp: 11 }));
    assert.equal(part(low, 'Breathing rate'), undefined, 'no bonus for a low rate');
  });

  it('penalises elevated skin temperature but ignores cool nights', () => {
    const warm = readiness(syntheticDays(28, { tempDev: 0.9 }));
    const p = part(warm, 'Skin temperature')!;
    assert.ok(p.contribution < -3);
    assert.match(p.detail, /\+0\.90/);
    const cool = readiness(syntheticDays(28, { tempDev: -0.6 }));
    assert.equal(part(cool, 'Skin temperature'), undefined);
  });

  it('drags the score slightly for unusually hard recent activity', () => {
    const days = syntheticDays(28);
    days[25].steps = 24000; // two hard finished days
    days[26].steps = 24000;
    const p = part(readiness(days), 'Recent strain')!;
    assert.ok(p.contribution < 0 && p.contribution >= -7.01);
  });

  it('raises the illness flag only when several signals deviate together', () => {
    const oneOff = readiness(syntheticDays(28, { restingHr: 70 }));
    assert.equal(oneOff.flags.length, 0, 'one deviating signal is noise, not a pattern');
    const pattern = readiness(syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 }));
    assert.equal(pattern.flags.length, 1);
    // A deviation pattern with everyday explanations, never a prediction of illness.
    assert.match(pattern.flags[0], /several overnight signals/i);
    assert.doesNotMatch(pattern.flags[0], /precedes illness|diagnos/i);
    assert.ok(pattern.score! < 50, `illness-like morning scored ${pattern.score}`);
  });

  it('prefers deep-sleep RMSSD when its coverage exists', () => {
    const days = syntheticDays(28);
    // Deep-sleep series flat at baseline; overnight average wildly high on the
    // last night. If deep-sleep is preferred, the HRV part stays near zero.
    days.forEach((d, i) => { d.hrvDeepSleep = 33 + [1, -0.5, 0, 0.5, -1][i % 5] * 4; });
    days[days.length - 1].hrv = 90;
    const r = readiness(days);
    const p = part(r, 'HRV vs baseline')!;
    assert.ok(Math.abs(p.contribution) < 6, `deep-sleep series should dominate, got ${p.contribution}`);
    assert.match(p.detail, /deep-sleep RMSSD/);
  });

  it('blends the 7-day trend so one aberrant night cannot swing the whole score', () => {
    // Identical single bad night; one dataset also has a bad *week*. The week
    // must read worse — the trend term is doing real work.
    const oneBadNight = readiness(syntheticDays(28, { hrv: 24 }));
    const badWeek = syntheticDays(28, { hrv: 24 });
    for (let i = 21; i < 27; i++) badWeek[i].hrv = 25 + (i % 2);
    const sustained = readiness(badWeek);
    const cNight = part(oneBadNight, 'HRV vs baseline')!.contribution;
    const cWeek = part(sustained, 'HRV vs baseline')!.contribution;
    assert.ok(cWeek < cNight, `sustained suppression (${cWeek}) must outweigh one night (${cNight})`);
  });

  it('produces a sane, fully-explained score on the real fixture', async () => {
    const ds = await dataset();
    const r = readiness(ds.days);
    assert.ok(r.score! >= 1 && r.score! <= 100);
    assert.equal(r.confidence, 'high');
    for (const p of r.parts) {
      assert.ok(p.detail.length > 0, `${p.label} must explain itself`);
      assert.ok(Number.isFinite(p.contribution));
    }
    // The fixture's final morning: HRV high vs baseline, RHR at baseline,
    // 5h32m sleep against a 7h-clamped need → sleep drags, HRV lifts.
    assert.ok(part(r, 'Last night’s sleep')!.contribution < 0);
    assert.ok(part(r, 'HRV vs baseline')!.contribution > 0);
  });
});

describe('battery arithmetic', () => {
  const hrvPart = (r: ReturnType<typeof readiness>) => part(r, 'HRV vs baseline')?.contribution ?? null;

  it("doesn't fall as today's steps climb", () => {
    const morning = syntheticDays(28, { steps: 500 });
    const evening = syntheticDays(28, { steps: 30000 });
    assert.equal(readiness(morning).score, readiness(evening).score);
  });

  it('gives a new account no strain verdict instead of a baseline of zero', () => {
    const days = syntheticDays(8);
    days[6].steps = 20000; // a big yesterday, but too little history to judge it by
    assert.equal(part(readiness(days), 'Recent strain'), undefined);
  });

  it('never mixes zone minutes and steps in one series', () => {
    // Zone minutes for three weeks, then a week without: steps must not be judged against minutes.
    const days = syntheticDays(28);
    days.forEach((d, i) => { d.zoneMinutes = i < 20 ? { fatBurn: 20, cardio: 5, peak: 0 } : null; });
    assert.equal(part(readiness(days), 'Recent strain'), undefined);
  });

  it('pays no more for an HRV spike than its own blend, so there is no cliff at the guard', () => {
    // A very low week, then last night swept up through the 2.5-spread guard. The
    // blend sits near zero where the guard engages; a flat +8 jumped there.
    const night = (hrv: number) => {
      const days = syntheticDays(28, { hrv });
      for (let i = 21; i < 27; i++) days[i].hrv = 20;
      return part(readiness(days), 'HRV vs baseline')!;
    };
    let prev: number | null = null;
    let guarded = false;
    for (let hrv = 40; hrv <= 60; hrv++) {
      const p = night(hrv);
      if (prev !== null) assert.ok(Math.abs(p.contribution - prev) < 1.5, `${hrv - 1} → ${hrv} ms moved ${prev} → ${p.contribution}`);
      if (p.note) {
        guarded = true;
        assert.ok(p.contribution <= 8, `a spike earned ${p.contribution}`);
      }
      prev = p.contribution;
    }
    assert.ok(guarded, 'the guard engages within the sweep, caution attached');
  });

  it("doesn't let an HRV spike make the battery fully charged", () => {
    const r = readiness(syntheticDays(28, { hrv: 80, restingHr: 58, sleepMin: 500 }));
    assert.ok(r.score! < 80, `scored ${r.score}`);
    assert.notEqual(r.label, "You're fully charged");
  });

  it("doesn't let one outlier night mute a real resting-HR rise", () => {
    const clean = syntheticDays(28, { restingHr: 66 });
    const withOutlier = syntheticDays(28, { restingHr: 66 });
    withOutlier[10].restingHr = 85;
    const a = part(readiness(clean), 'Resting HR vs baseline')!.contribution;
    const b = part(readiness(withOutlier), 'Resting HR vs baseline')!.contribution;
    assert.ok(Math.abs(a - b) < 2, `${a} without the outlier, ${b} with it`);
  });

  it('gives breathing rate a noise floor', () => {
    // A near-flat baseline must not turn a tenth of a breath into a big penalty.
    const days = syntheticDays(28, { resp: 14.35 });
    days.forEach((d, i) => { if (i < 27) d.respiratoryRate = 14 + (i % 2) * 0.05; });
    const p = part(readiness(days), 'Breathing rate');
    assert.ok(!p || p.contribution > -1.5, `penalty ${p?.contribution}`);
  });

  it('never turns the sleep-quality penalty into a bonus', () => {
    // Shallow (20% deep + REM) but unbroken (99% efficiency): no reward for it.
    const staged = syntheticDays(28);
    const plain = syntheticDays(28);
    const night = staged[27].sleep!;
    night.efficiency = 99;
    plain[27].sleep!.efficiency = 99;
    night.stages = { deep: 40, rem: 50, light: night.minutesAsleep - 90, awake: 10 };
    const withStages = part(readiness(staged), 'Last night’s sleep')!.contribution;
    const without = part(readiness(plain), 'Last night’s sleep')!.contribution;
    assert.ok(withStages <= without, `${withStages} > ${without}`);
  });

  it('falls back to the overnight HRV when deep-sleep RMSSD is too new for a baseline', () => {
    const days = syntheticDays(28);
    for (let i = 13; i < 28; i++) days[i].hrvDeepSleep = 30;
    const p = part(readiness(days), 'HRV vs baseline');
    assert.ok(p, 'HRV must not drop out');
    assert.match(p!.detail, /overnight RMSSD/);
  });

  it('restarts the baselines when the watch changes, instead of reading it as a change in you', () => {
    const days = syntheticDays(28);
    days.forEach((d, i) => {
      const watch = i < 23 ? 'FITBIT:Old watch' : 'FITBIT:New watch';
      d.sourceByType['daily-heart-rate-variability'] = watch;
      d.sourceByType['daily-resting-heart-rate'] = watch;
      if (i >= 23) {
        d.hrv = 52; // the new watch reads HRV higher and resting HR lower
        d.restingHr = 55;
      }
    });
    const r = readiness(days);
    assert.equal(part(r, 'HRV vs baseline'), undefined);
    assert.equal(part(r, 'Resting HR vs baseline'), undefined);
    assert.deepEqual(r.calibrating, ['HRV', 'resting heart rate']);
    assert.equal(r.confidence, 'low');
  });

  it('uses one scale for the tag, the label and the legend', () => {
    assert.equal(batteryTier(80).tag, 'CHARGED');
    assert.equal(batteryTier(79).tag, 'BALANCED');
    assert.equal(batteryTier(55).tag, 'BALANCED');
    assert.equal(batteryTier(54).tag, 'LOW');
    assert.equal(batteryTier(30).tag, 'LOW');
    assert.equal(batteryTier(29).tag, 'DRAINED');
    assert.equal(readiness(syntheticDays(28)).label, batteryTier(readiness(syntheticDays(28)).score!).label);
  });
});

// ─────────────────────────────────────────────── sleep regularity index

/** n days with a main session per night; times overridable per index. */
function sleepDays(
  n: number,
  timing: (i: number) => { bed: string; wake: string } | null,
  naps: (i: number) => { bed: string; wake: string }[] = () => [],
) {
  const tm = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const mk = (date: string, bed: string, wake: string, isNap: boolean) => {
    const bm = tm(bed), wm = tm(wake);
    const mins = ((wm - bm + 1440) % 1440) || 1;
    return {
      date, isMainSleep: !isNap, isNap,
      bedtimeMin: bm, wakeMin: wm, bedtimeIso: '', wakeIso: '',
      minutesAsleep: mins, onsetLatencyMin: null, minutesAwake: 0, minutesInBed: mins,
      efficiency: 100, stages: null, segments: [], shortAwakeningsMin: [],
    };
  };
  return Array.from({ length: n }, (_, i) => {
    const date = addDays('2026-07-01', i);
    const d = emptyRecord(date);
    const t = timing(i);
    if (t) d.sleep = mk(date, t.bed, t.wake, false);
    d.naps = naps(i).map((x) => mk(date, x.bed, x.wake, true));
    return d;
  });
}

describe('sleep regularity index', () => {
  it('scores an identical schedule as ~100, excellent', () => {
    const r = sleepRegularity(sleepDays(20, () => ({ bed: '23:00', wake: '07:00' })))!;
    assert.ok(r.score >= 99, `got ${r.score}`);
    assert.equal(r.band, 'excellent');
    assert.equal(r.pairs, 19);
    assert.equal(r.nights, 20);
  });

  it('scores a chaotic alternating schedule as critical', () => {
    // 22:00–06:00 one day, 03:00–11:00 the next: state agrees only 03–06 asleep
    // and 11–22 awake → 14/24 agreement → SRI ≈ 17.
    const r = sleepRegularity(
      sleepDays(20, (i) => (i % 2 === 0 ? { bed: '22:00', wake: '06:00' } : { bed: '03:00', wake: '11:00' })),
    )!;
    assert.ok(r.score < 25, `got ${r.score}`);
    assert.equal(r.band, 'critical');
  });

  it('skips pairs touching an unrecorded night instead of scoring them as awake', () => {
    const days = sleepDays(12, (i) => (i === 5 ? null : { bed: '23:00', wake: '07:00' }));
    const r = sleepRegularity(days)!;
    // Pairs (4,5) and (5,6) drop; the schedule itself is perfect.
    assert.equal(r.pairs, 9);
    assert.equal(r.nights, 11);
    assert.ok(r.score >= 99, `a sync gap must not dent a perfect schedule, got ${r.score}`);
  });

  it('returns null below five valid pairs rather than shouting at a data gap', () => {
    assert.equal(sleepRegularity(sleepDays(5, () => ({ bed: '23:00', wake: '07:00' }))), null);
    // Ten days but only sparse recordings → too few adjacent pairs.
    const sparse = sleepDays(10, (i) => (i % 2 === 0 ? { bed: '23:00', wake: '07:00' } : null));
    assert.equal(sleepRegularity(sparse), null);
  });

  it('counts naps as sleep, including across midnight', () => {
    // Identical nightly naps leave a perfect pattern perfect…
    const withNaps = sleepRegularity(
      sleepDays(10, () => ({ bed: '01:00', wake: '08:00' }), () => [{ bed: '23:40', wake: '00:20' }]),
    )!;
    assert.ok(withNaps.score >= 99, `got ${withNaps.score}`);
    // …while alternating-day naps genuinely reduce day-over-day agreement.
    const alternating = sleepRegularity(
      sleepDays(10, () => ({ bed: '01:00', wake: '08:00' }), (i) => (i % 2 === 0 ? [{ bed: '22:00', wake: '23:30' }] : [])),
    )!;
    assert.ok(alternating.score < withNaps.score, `${alternating.score} !< ${withNaps.score}`);
  });

  it('produces a stable value on the real fixture nights', async () => {
    const ds = await dataset();
    const r = sleepRegularity(ds.days)!;
    assert.ok(r, 'fixture has 11 consecutive nights — enough pairs');
    assert.equal(r.pairs, 10);
    assert.ok(r.score > 0 && r.score <= 100);
    // These nights drift across a ~5-hour bedtime span; they must not read as regular.
    assert.ok(r.band === 'bad' || r.band === 'critical', `got ${r.band} (${r.score})`);
  });
});

// ─────────────────────────────────────────── circular clock-time averaging

describe('typical sleep window (circular mean)', () => {
  const M = (h: number, m = 0) => h * 60 + m;

  it('averages across midnight correctly — the arithmetic-mean trap', () => {
    // Arithmetic mean of 23:30 and 00:30 is 12:00 noon. Circular mean is 00:00.
    const r = circularMeanMinutes([M(23, 30), M(0, 30)])!;
    assert.ok(Math.min(r.mean, 1440 - r.mean) < 1, `expected ~00:00, got ${r.mean}`);
  });

  it('matches the plain mean when times do not straddle midnight', () => {
    const r = circularMeanMinutes([M(22), M(23)])!;
    assert.ok(Math.abs(r.mean - M(22, 30)) < 1, `got ${r.mean}`);
    const w = circularMeanMinutes([M(7), M(9)])!;
    assert.ok(Math.abs(w.mean - M(8)) < 1, `got ${w.mean}`);
  });

  it('reports zero spread for identical times and growing spread otherwise', () => {
    const tight = circularMeanMinutes([M(23), M(23), M(23)])!;
    assert.ok(tight.sdMin < 1);
    const loose = circularMeanMinutes([M(22), M(0, 30), M(2), M(23)])!;
    assert.ok(loose.sdMin > 45, `got ${loose.sdMin}`);
  });

  it('refuses a centre when times are spread around the whole clock', () => {
    assert.equal(circularMeanMinutes([M(0), M(6), M(12), M(18)]), null);
  });

  it('computes the typical window from a day slice, needing at least 3 nights', () => {
    const days = sleepDays(10, () => ({ bed: '23:50', wake: '07:40' }));
    const w = typicalSleepWindow(days)!;
    assert.ok(Math.abs(w.bedMean - M(23, 50)) < 1);
    assert.ok(Math.abs(w.wakeMean - M(7, 40)) < 1);
    assert.equal(w.nights, 10);
    assert.equal(typicalSleepWindow(sleepDays(2, () => ({ bed: '23:00', wake: '07:00' }))), null);
  });

  it('lands on a sensible centre for the real fixture nights', async () => {
    const ds = await dataset();
    const w = typicalSleepWindow(ds.days)!;
    // Bedtimes run 23:32 → 04:57; the circular mean must sit in the small hours,
    // never at some noon-adjacent arithmetic artefact.
    const bedFolded = w.bedMean >= 18 * 60 ? w.bedMean - 1440 : w.bedMean;
    assert.ok(bedFolded > -60 && bedFolded < M(4), `avg bed ${w.bedMean} min`);
    assert.ok(w.wakeMean > M(6) && w.wakeMean < M(10, 30), `avg wake ${w.wakeMean} min`);
    assert.equal(w.nights, 11);
    assert.ok(w.bedSdMin > 30, 'a 5-hour bedtime span cannot have a tiny spread');
  });
});

// ─────────────────────────────────────────────── insight engine

/** The engine only reads ds.days; a minimal dataset shell is enough. */
const dsOf = (days: ReturnType<typeof emptyRecord>[]): any => ({ days });
// Synthetic grids start 2026-07-01; 28 days end on 2026-07-28. Container TZ is
// UTC, so these Dates land in the intended daypart on the grid's last day.
const MORNING = new Date('2026-07-28T08:00:00');
const MIDDAY = new Date('2026-07-28T14:00:00');
const EVENING = new Date('2026-07-28T18:00:00');
type Days = ReturnType<typeof emptyRecord>[];
const feedsAt = (days: Days, now: Date = MORNING) => insightFeeds(dsOf(days), now);
const everyCard = (days: Days, now: Date = MORNING) => {
  const f = feedsAt(days, now);
  return [...f.today, ...Object.values(f.pages).flat()];
};
/** Where a card shows: 'today', its page, or null when it shows nowhere. */
const whereIs = (days: Days, id: string, now: Date = MORNING) => {
  const f = feedsAt(days, now);
  if (f.today.some((o) => o.id === id)) return 'today';
  return Object.entries(f.pages).find(([, os]) => os.some((o) => o.id === id))?.[0] ?? null;
};
const cardOf = (days: Days, id: string, now: Date = MORNING) => everyCard(days, now).find((o) => o.id === id);
const listing = (days: Days, now: Date = MORNING) => {
  const f = feedsAt(days, now);
  return [...f.today.map((o) => `today:${o.id}`), ...Object.entries(f.pages).flatMap(([p, os]) => os.map((o) => `${p}:${o.id}`))].join(' | ');
};

describe('insight engine — stateless guards', () => {
  it('shows exactly the daypart floor card on a fully typical, unchanged month', () => {
    // Steadiness that has held all along is not news: the yesterday test
    // keeps every entry rule off Today, and the floor card carries the quiet.
    const days = syntheticDays(28);
    const f = feedsAt(days);
    assert.deepEqual(f.today.map((o) => o.id), ['floor-morning'], listing(days));
    assert.match(f.today[0].text, /Nothing new needs your attention/);
    assert.equal(f.pages.vitals[0].id, 'vitals-all-quiet');
    assert.equal(cardOf(days, 'bed-settling')?.title, 'Your bedtime has been steady', 'standing, not news');
  });

  it('calls a bedtime settling only when it tightened recently, and steady when it always was', () => {
    const days = syntheticDays(28);
    days.forEach((d, i) => { if (d.sleep) d.sleep.bedtimeMin = i < 14 ? 1380 + (i % 2 ? 90 : -90) : 1380; });
    assert.equal(cardOf(days, 'bed-settling')?.title, 'Your bedtime is settling down', listing(days));
    assert.equal(whereIs(days, 'bed-settling'), 'sleep', 'a page insight, never Today');
  });

  it('puts an HRV slide on Today as it starts, then on Vitals while it lasts', () => {
    const enteredNow = syntheticDays(28);
    // Crossed the 8% threshold only in the last couple of days: a fresh entry.
    for (let i = 24; i < 28; i++) enteredNow[i].hrv = 25 + (i % 2);
    assert.equal(whereIs(enteredNow, 'hrv-trend-down'), 'today', listing(enteredNow));
    assert.equal(cardOf(enteredNow, 'hrv-acute-low'), undefined, 'the trend speaks for the single night');
    assert.doesNotMatch(cardOf(enteredNow, 'hrv-trend-down')!.text, /been like this/);

    const lasting = syntheticDays(28);
    for (let i = 21; i < 28; i++) lasting[i].hrv = 25 + (i % 2);
    assert.equal(whereIs(lasting, 'hrv-trend-down'), 'vitals', listing(lasting));
    assert.match(cardOf(lasting, 'hrv-trend-down')!.text, /It's been like this for 5 days\./);

    const over = syntheticDays(28);
    for (let i = 10; i < 28; i++) over[i].hrv = 25 + (i % 2);
    assert.equal(whereIs(over, 'hrv-trend-down'), null, 'two low weeks in a row are no longer a slide');
  });

  it('flags one clearly elevated morning as an alert, escalating by trailing days', () => {
    const one = syntheticDays(28, { restingHr: 75 });
    const card1 = cardOf(one, 'rhr-acute-high')!;
    assert.ok(card1, listing(one));
    assert.equal(whereIs(one, 'rhr-acute-high'), 'today');
    assert.match(card1.text, /75 bpm this morning\. It's usually around 62/);
    assert.ok(card1.action, 'first day carries the easy-day suggestion');

    const three = syntheticDays(28);
    for (let i = 25; i < 28; i++) three[i].restingHr = 75;
    const card3 = cardOf(three, 'rhr-acute-high')!;
    assert.ok(card3, listing(three));
    assert.match(card3.text, /third morning/);
  });

  it('the illness pattern speaks for every recovery card', () => {
    const rough = syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 });
    const f = feedsAt(rough);
    assert.ok(f.today.some((o) => o.id === 'illness-pattern'), listing(rough));
    for (const id of ['rhr-acute-high', 'hrv-acute-low', 'battery-low', 'battery-drain']) {
      assert.equal(cardOf(rough, id), undefined, `${id} steps aside`);
    }
    assert.equal(f.pages.vitals[0].id, 'vitals-on-today', 'Vitals points to Today instead of calling itself steady');
    assert.match(f.pages.vitals[0].text, /“Several of your signals are off” is on Today/);
  });

  it('shows all qualifying watch cards past the daypart gate without arbitrary quotas', () => {
    const awful = syntheticDays(28, { restingHr: 75, hrv: 22, sleepMin: 290, tempDev: 0.7, resp: 17.5 });
    for (let i = 21; i < 28; i++) { awful[i].hrv = 23; awful[i].sleep!.minutesAsleep = 300; }
    const obs = observations(dsOf(awful), MORNING);
    assert.ok(obs.filter((o) => o.tone === 'watch').length >= 1, obs.map((o) => `${o.tone}:${o.title}`).join(' | '));
  });

  it('says a short night plainly, escalating on the second, and moves it to Sleep after the morning', () => {
    const one = syntheticDays(28, { sleepMin: 300 });
    const card = cardOf(one, 'night-short')!;
    assert.ok(card, listing(one));
    assert.equal(card.title, "Last night wasn't your best sleep");
    assert.match(card.text, /^Your sleep score is \d+ out of 100 from last night\. You slept 5h 00m compared to your 7h 30m need\.$/);
    assert.match(card.action!, /30 minutes earlier/);
    assert.equal(whereIs(one, 'night-short'), 'today');
    assert.equal(whereIs(one, 'night-short', MIDDAY), 'sleep', 'one place at a time: the page once the morning is over');

    const two = syntheticDays(28, { sleepMin: 300 });
    two[26].sleep!.minutesAsleep = 305;
    const card2 = cardOf(two, 'night-short')!;
    assert.match(card2.text, /That makes two short nights in a row\./);
    assert.match(card2.action!, /adds up/);
  });

  it('gives wins no homework', () => {
    const days = syntheticDays(28, { sleepMin: 500 });
    days[27].sleep!.stages = { deep: 95, rem: 105, light: 290, awake: 10 };
    const card = cardOf(days, 'night-good')!;
    assert.ok(card, listing(days));
    assert.equal(card.action, undefined, 'good news never arrives with a task attached');
  });

  it('measures sleep debt against the personal need, not a hardcoded 8 hours', () => {
    const natural = syntheticDays(28, {}, { sleepMin: 405 });
    assert.equal(sleepNeedFor(natural), 420, 'short nights never lower the need below 7 hours');
    assert.equal(cardOf(natural, 'sleep-debt'), undefined, listing(natural));
    const short = syntheticDays(28, {}, { sleepMin: 330 });
    assert.equal(cardOf(short, 'sleep-debt')?.title, "You're very short on sleep this week", listing(short));
  });

  it('notices bedtime creeping later, with both clock times cited', () => {
    const days = syntheticDays(28);
    // Three fresh late nights (+90 min): the recent-7 circular mean lands
    // ~23:38 against the prior fortnight's 23:00, past the 30-minute trigger,
    // and absent from the entry-window cut, so it still reads as news.
    for (let i = 25; i < 28; i++) days[i].sleep!.bedtimeMin = 1470;
    const card = cardOf(days, 'bed-creep-later')!;
    assert.ok(card, listing(days));
    assert.equal(whereIs(days, 'bed-creep-later'), 'today');
    assert.equal(card.text, 'This week your average bedtime was 23:38. In the two weeks before, it was 23:00.');
    assert.equal(cardOf(days, 'bed-settling'), undefined);
  });

  it('celebrates a streak on Activity, and on Today only when a week or more lands', () => {
    const streak = (n: number) => {
      const days = syntheticDays(28);
      for (let i = 28 - n; i < 28; i++) days[i].steps = 11000;
      return days;
    };
    // Today's count joins the streak once it clears the goal, so n days end today.
    assert.equal(whereIs(streak(3), 'streak'), 'activity', 'three days is a page milestone');
    assert.equal(whereIs(streak(4), 'streak'), 'activity', 'still standing between milestones');
    assert.equal(whereIs(streak(7), 'streak'), 'today', listing(streak(7)));
    assert.equal(whereIs(streak(8), 'streak'), 'activity', 'the day after, back on its page');
    assert.match(cardOf(streak(7), 'streak')!.text, /every day for 7 days in a row/);
  });

  it('declares records only on completed days above a floor', () => {
    const days = syntheticDays(28);
    days[26].steps = 24000;
    const card = cardOf(days, 'step-record')!;
    assert.ok(card, listing(days));
    assert.equal(whereIs(days, 'step-record'), 'today');
    assert.match(card.text, /You walked 24,000 steps on 27 July\./);

    const tiny = syntheticDays(28, {}, { steps: 3000 });
    tiny[26].steps = 7000;
    assert.equal(cardOf(tiny, 'step-record'), undefined);
  });

  it('keeps nudges to Today, in their part of the day', () => {
    // Within reach: only in the evening, only when close.
    const close = syntheticDays(28, { steps: 8700 });
    assert.equal(whereIs(close, 'within-reach', EVENING), 'today');
    assert.equal(whereIs(close, 'within-reach', MORNING), null, 'a nudge never waits on a page');

    // Slow day: only past 13:00, and never two low days running.
    const slow = syntheticDays(28, { steps: 1500 });
    assert.equal(whereIs(slow, 'slow-day', MIDDAY), 'today', listing(slow, MIDDAY));
    assert.equal(whereIs(slow, 'slow-day', new Date('2026-07-28T09:00:00')), null);
    const slowTwice = syntheticDays(28, { steps: 1500 });
    slowTwice[26].steps = 1200;
    assert.equal(whereIs(slowTwice, 'slow-day', MIDDAY), null, 'never nags twice running');
  });

  it("offers the wind-down after a short night, carrying the week's debt", () => {
    const indebted = syntheticDays(28, {}, { sleepMin: 330 });
    const card = cardOf(indebted, 'wind-down', EVENING)!;
    assert.ok(card, listing(indebted, EVENING));
    assert.match(card.text, /hours short on sleep this week/);
    assert.ok(card.action);

    const fine = syntheticDays(28);
    assert.equal(cardOf(fine, 'wind-down', EVENING), undefined);

    // A long debt alone doesn't earn it every evening: last night was fine.
    const recovering = syntheticDays(28, { sleepMin: 450 }, { sleepMin: 330 });
    assert.equal(whereIs(recovering, 'wind-down', EVENING), null, listing(recovering, EVENING));
    assert.equal(whereIs(recovering, 'sleep-debt', EVENING), 'sleep', 'the debt still stands on its page');
  });

  it('reports weight direction without judgement: news on a fresh reading, then on Body', () => {
    const down = syntheticDays(28);
    down[0].weightKg = 90; down[10].weightKg = 89; down[26].weightKg = 87.8;
    const card = cardOf(down, 'weight-down')!;
    assert.ok(card, listing(down));
    assert.equal(card.tone, 'neutral');
    assert.equal(whereIs(down, 'weight-down'), 'today');
    assert.match(card.text, /^You're losing about 0\.\d\d kg a week\. Your latest weigh-in was 87\.8 kg on 27 July\./);

    const older = syntheticDays(28);
    older[0].weightKg = 90; older[5].weightKg = 89; older[22].weightKg = 87.8;
    assert.equal(whereIs(older, 'weight-down'), 'body', 'no new reading: not news, still true');
  });

  it('crosses the WHO weekly bar on the crossing day', () => {
    // 2026-07-28 is a Tuesday: the week holds Mon 27 + Tue 28.
    const days = syntheticDays(28);
    days[26].activeMinutes = { light: 20, moderate: 70, vigorous: 10 }; // Mon: 80
    days[27].activeMinutes = { light: 20, moderate: 60, vigorous: 15 }; // Tue: +75 → 155 crosses
    const card = cardOf(days, 'who-week')!;
    assert.ok(card, listing(days));
    assert.equal(whereIs(days, 'who-week'), 'today');
    assert.match(card.text, /minutes of brisk activity this week/);
    assert.match(card.text, /with 5 days to spare/);

    const next = [...days, emptyRecord('2026-07-29')];
    next[28].activeMinutes = { light: 20, moderate: 10, vigorous: 0 };
    assert.equal(whereIs(next, 'who-week', new Date('2026-07-29T08:00:00')), 'activity', 'the day after, on its page');
  });

  it('finds a real recovery tax and stays silent on a null one', () => {
    // 60 days: alternating big and ordinary days; HRV drops after big ones.
    const days = syntheticDays(60);
    days.forEach((d, i) => {
      d.steps = i % 2 === 0 ? 14000 : 4000;
      const afterBig = i > 0 && (i - 1) % 2 === 0;
      d.hrv = (afterBig ? 28 : 36) + (i % 3);
    });
    const tax = recoveryTax(days);
    assert.ok(tax, 'a clean lagged effect must be found');
    assert.ok(tax!.pct >= 10 && tax!.pct <= 35, `got ${tax!.pct}%`);

    const flat = syntheticDays(60);
    flat.forEach((d, i) => { d.steps = i % 2 === 0 ? 14000 : 4000; });
    assert.equal(recoveryTax(flat), null, 'no relationship, no story');
  });

  it('keeps every card checkable on real data: figures, ids, plain words', async () => {
    const ds = await dataset();
    for (const at of ['2026-08-19T08:00:00', '2026-08-19T14:00:00', '2026-08-19T19:00:00']) {
      const f = insightFeeds(ds as any, new Date(at), { timeZone: 'UTC' });
      assert.ok(f.today.length >= 1, `got ${f.today.length}`);
      for (const page of ['activity', 'sleep', 'vitals', 'body'] as const) assert.ok(f.pages[page].length >= 1, `${page} is never empty`);
      for (const o of [...f.today, ...Object.values(f.pages).flat()]) {
        assert.ok(o.id.length > 0 && o.title.length > 0);
        const floor = o.kind === 'review' && /floor|on-today/.test(o.id);
        if (!floor) assert.ok(/\d/.test(o.text), `"${o.title}" must cite at least one figure: ${o.text}`);
        assert.doesNotMatch(`${o.title} ${o.text} ${o.action ?? ''}`, /\d\/100|→|×| vs |·|~/, `"${o.title}" reads as shorthand`);
      }
    }
    const s = todaySummary(ds as any, new Date('2026-08-19T08:00:00'));
    assert.ok(Array.isArray(s.observations));
  });
});

describe('insight engine — one place at a time', () => {
  const scenarios: [string, Days, Date][] = [
    ['typical', syntheticDays(28), MORNING],
    ['short night, midday', syntheticDays(28, { sleepMin: 300 }), MIDDAY],
    ['illness', syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 }), MORNING],
    ['indebted evening', syntheticDays(28, {}, { sleepMin: 330 }), EVENING],
    ['quiet day', syntheticDays(28, { steps: 1500 }), MIDDAY],
  ];

  it('shows each card in exactly one place', () => {
    for (const [name, days, now] of scenarios) {
      const f = feedsAt(days, now);
      const ids = [...f.today, ...Object.values(f.pages).flat()].map((o) => o.id);
      assert.equal(new Set(ids).size, ids.length, `${name}: ${ids.join(', ')}`);
    }
  });

  it('replays each news rule a day at a time: Today as it starts, then its page while it lasts', () => {
    // The yesterday test, run forward: the same grid cut to each length in turn.
    const trace = (days: Days, id: string, from: number) => {
      const out: string[] = [];
      for (let n = from; n <= days.length; n++) out.push(whereIs(days.slice(0, n), id) ?? '-');
      return out.join(' ');
    };
    const grid = (n: number, from: number, change: (d: Days[number], i: number) => void) => {
      const days = syntheticDays(n);
      for (let i = from; i < n; i++) change(days[i], i);
      return days;
    };

    assert.equal(trace(grid(44, 30, (d, i) => { d.hrv = 25 + (i % 2); }), 'hrv-trend-down', 29),
      '- - - - today today today vitals vitals vitals vitals vitals vitals - - -');
    // Hysteresis: two days in, the shift was already halfway there, so it's news for two days, not three.
    assert.equal(trace(grid(44, 30, (d) => { d.sleep!.bedtimeMin = 1470; }), 'bed-creep-later', 29),
      '- - - - today today sleep sleep sleep sleep sleep sleep sleep sleep sleep sleep');
    assert.equal(trace(grid(60, 40, (d, i) => { d.restingHr = 64.5 + (i % 2); }), 'rhr-shift-up', 39),
      '- - - - - - - - - - today today today vitals vitals vitals vitals vitals vitals vitals vitals vitals');
    // A record is news the mornings after it lands, then stands on the page for the rest of its week.
    assert.equal(trace(grid(44, 30, (d, i) => { if (i === 30) d.steps = 24000; }), 'step-record', 29),
      '- - - today today today activity activity activity activity - - - - - -');
    // The weekly target is news on the day it's crossed, and stands until the week ends.
    assert.equal(trace(grid(44, 30, (d) => { d.activeMinutes = { light: 10, moderate: 40, vigorous: 0 }; }), 'who-week', 29),
      '- - - - - - - - today activity activity activity - - - today');
    // Streaks stand on the page from 3 days, and reach Today on 7, 10 and 14.
    assert.equal(trace(grid(44, 30, (d) => { d.steps = 11000; }), 'streak', 29),
      '- - - - activity activity activity activity today activity activity today activity activity activity today');
  });

  it('keeps page-only insights off Today and nudges off the pages', () => {
    for (const [name, days, now] of scenarios) {
      const r = evaluate(dsOf(days), now)!;
      const never = new Set(r.found.filter((x) => x.today === 'never').map((x) => x.id));
      assert.ok(r.feeds.today.every((o) => !never.has(o.id)), name);
      for (const [page, os] of Object.entries(r.feeds.pages)) {
        assert.ok(os.every((o) => o.kind !== 'nudge'), `${name}: a nudge on ${page}`);
        assert.ok(os.every((o) => o.page === page), `${name}: a stray card on ${page}`);
      }
    }
  });

  it('settles every feed so no family mixes tones and no metric is claimed both ways', () => {
    for (const [name, days, now] of scenarios) {
      const r = evaluate(dsOf(days), now)!;
      const shown = new Set([...r.feeds.today, ...Object.values(r.feeds.pages).flat()].map((o) => o.id));
      const cards = r.settled.filter((x) => shown.has(x.id));
      for (const fam of new Set(cards.map((x) => x.family))) {
        const tones = new Set(cards.filter((x) => x.family === fam).map((x) => x.tone));
        assert.ok(!(tones.has('watch') && tones.has('good')), `${name}: ${fam} mixes tones`);
      }
      const claims = new Map<string, string>();
      for (const x of cards) {
        if (!x.claims) continue;
        assert.ok(!claims.has(x.claims.metric) || claims.get(x.claims.metric) === x.claims.direction, `${name}: ${x.claims.metric} both ways`);
        claims.set(x.claims.metric, x.claims.direction);
      }
    }
  });
});

describe('insight engine — data cards', () => {
  it('tells a new sleep record from a thin one', () => {
    /** The pipeline marks each stream a day recorded; synthetic days start unmarked. */
    const marked = (days: Days) => { for (const d of days) if (d.sleep) d.present.push('sleep'); return days; };
    const fresh = syntheticDays(40);
    for (let i = 0; i < 25; i++) fresh[i].sleep = null;
    marked(fresh);
    assert.match(cardOf(fresh, 'sleep-coverage')!.text, /^Your sleep records start on 26 July, so there are 15 nights so far\./);

    const thin = syntheticDays(40);
    thin.forEach((d, i) => { if (i % 3) d.sleep = null; });
    marked(thin);
    const card = cardOf(thin, 'sleep-coverage')!;
    assert.equal(card.title, 'Some nights have no record');
    assert.match(card.text, /^Your watch recorded sleep on 14 of the last 40 nights\./);
    assert.equal(cardOf(thin, 'sleep-gap'), undefined, 'one card about the record at a time');
  });

  it('never calls the body page empty when weigh-ins are just older than the window', () => {
    const days = syntheticDays(28);
    const card = feedsAt(days).pages.body[0];
    assert.equal(card.id, 'body-floor');
    assert.equal(card.title, 'No recent weigh-ins');
    assert.match(card.text, /in the last 28 days/);
  });
});

describe('insight engine — Activity in depth', () => {
  /** The same grid cut to each length in turn: the yesterday test, run forward. */
  const trace = (days: Days, id: string, from: number) => {
    const out: string[] = [];
    for (let n = from; n <= days.length; n++) out.push(whereIs(days.slice(0, n), id) ?? '-');
    return out.join(' ');
  };
  // Grids of 56 days end on Tue 25 Aug.
  const AUG25 = new Date('2026-08-25T08:00:00');

  it('names your most and least active weekdays once six weeks back them', () => {
    const days = syntheticDays(56);
    days.forEach((d) => { const w = isoWeekdayIndex(d.date); d.steps = w === 5 ? 12000 : w === 0 ? 6000 : 8000; });
    assert.equal(cardOf(days, 'activity-week-shape', AUG25)?.text,
      'Saturday is usually your most active day, at about 12,000 steps. Monday is usually your quietest, at about 6,000.');
    days.forEach((d) => { d.steps = isoWeekdayIndex(d.date) === 5 ? 9000 : 8000; });
    assert.equal(cardOf(days, 'activity-week-shape', AUG25), undefined, 'under 20% apart is no pattern');
  });

  it('says plainly when several days were very quiet', () => {
    const days = syntheticDays(28);
    for (const i of [21, 23, 25]) days[i].steps = 2000;
    assert.equal(cardOf(days, 'activity-quiet-days')?.text,
      "You had 3 days in the last week with fewer than 4,000 steps. That's under half of your usual day, which is about 8,000 steps.");
    days[25].steps = 8000;
    assert.equal(cardOf(days, 'activity-quiet-days'), undefined);
  });

  it('counts active days in a row, in zone minutes or brisk minutes', () => {
    const zone = syntheticDays(28);
    for (let i = 21; i < 28; i++) zone[i].zoneMinutes = { fatBurn: 20, cardio: 5, peak: 0 };
    assert.match(cardOf(zone, 'activity-azm-streak')!.text, /^You've earned at least 22 active zone minutes every day for 7 days\./);

    const brisk = syntheticDays(28);
    for (let i = 24; i < 28; i++) brisk[i].activeMinutes = { light: 10, moderate: 20, vigorous: 2 };
    assert.match(cardOf(brisk, 'activity-azm-streak')!.text, /^You've done at least 22 minutes of brisk activity every day for 4 days/);

    const grid = syntheticDays(44);
    for (let i = 30; i < 44; i++) grid[i].zoneMinutes = { fatBurn: 20, cardio: 5, peak: 0 };
    assert.equal(trace(grid, 'activity-azm-streak', 29),
      '- - - - activity activity activity activity today activity activity activity activity activity activity today');
  });

  it('marks the first goal day after a week or more without one, with no homework', () => {
    const days = syntheticDays(28, {}, { steps: 6000 });
    days[15].steps = 11000;
    days[27].steps = 10400;
    const card = cardOf(days, 'activity-back-at-it')!;
    assert.equal(card.text, 'You passed 10,000 steps today for the first time in 12 days.');
    assert.equal(card.action, undefined);

    const grid = syntheticDays(44, {}, { steps: 6000 });
    grid[20].steps = 11000;
    grid[33].steps = 10500;
    assert.equal(trace(grid, 'activity-back-at-it', 31), '- - - today today activity activity - - - - - - -');

    const close = syntheticDays(28, {}, { steps: 6000 });
    close[22].steps = 11000;
    close[27].steps = 10400;
    assert.equal(cardOf(close, 'activity-back-at-it'), undefined, 'five days is no break');
  });

  it("celebrates a marathon's distance in a week on the day it's passed", () => {
    const days = syntheticDays(44);
    for (const d of days) d.distanceKm = 8;
    // Weeks start on Monday; 8 km a day passes 42.2 km on Saturday.
    assert.equal(trace(days, 'activity-distance', 29), '- - - today activity - - - - - today activity - - - -');
    assert.match(cardOf(days.slice(0, 32), 'activity-distance')!.text, /^You've covered 48\.0 km this week\. That's more than the length of a marathon\.$/);
  });

  it('notes 100, 200 and 300 km months', () => {
    const days = syntheticDays(28);
    for (const d of days) d.distanceKm = 4;
    days[27].distanceKm = 10;
    const card = cardOf(days, 'activity-distance-month')!;
    assert.equal(card.title, "You've passed 100 km this month");
    assert.equal(whereIs(days, 'activity-distance-month'), 'activity', 'passed days ago: on the page');
  });

  it('finds your most floors in any week', () => {
    const days = syntheticDays(56);
    days.forEach((d, i) => { d.floors = i >= 48 ? 14 : 5; });
    assert.equal(cardOf(days, 'activity-floors', AUG25)?.text,
      'You climbed 98 floors in the last 7 days, the most in any week of the last two months.');
  });

  it('describes how hard you work and when the weekend does most of it', () => {
    const days = syntheticDays(28);
    days.forEach((d, i) => { d.zoneMinutes = { fatBurn: 30, cardio: i % 4 === 0 ? 8 : 0, peak: 0 }; });
    assert.match(cardOf(days, 'activity-intensity-mix')!.text, /^Most of your active minutes in the last four weeks were at a moderate effort, in the fat-burn zone\. You spent at least 5 minutes in the cardio or peak zone on 7 days\.$/);

    // 2026-07-28 is a Tuesday, so last week ran Mon 20 to Sun 26 July.
    const load = syntheticDays(28);
    for (const d of load) d.zoneMinutes = { fatBurn: 5, cardio: 0, peak: 0 };
    load[24].zoneMinutes = { fatBurn: 40, cardio: 10, peak: 0 };
    load[25].zoneMinutes = { fatBurn: 40, cardio: 10, peak: 0 };
    const card = cardOf(load, 'activity-weekend-load')!;
    assert.equal(card.title, 'Your weekends do most of the work');
    assert.equal(card.tone, 'neutral');
    assert.match(card.text, /^Last week, 83% of your active zone minutes came on Saturday and Sunday\./);
  });

  it('tracks how often you reach your goal, and says when it sits far from your usual day', () => {
    const days = syntheticDays(60);
    days.forEach((d, i) => { d.steps = i >= 31 ? (i % 7 < 5 ? 11000 : 7000) : i % 7 < 2 ? 11000 : 7000; });
    const AUG29 = new Date('2026-08-29T08:00:00');
    assert.equal(cardOf(days, 'activity-consistency', AUG29)?.text,
      'You reached 10,000 steps on 20 of the last 28 days. In the four weeks before, it was 8 of 28 days.');
    assert.equal(cardOf(days, 'activity-goal-fit', AUG29), undefined, 'one card about goal days at a time');

    const high = syntheticDays(28, {}, { steps: 13500 });
    assert.equal(cardOf(high, 'activity-goal-fit')?.text,
      'On a typical day you take about 13,500 steps, well past the 10,000 goal. You reached 10,000 on every one of 27 recorded days in the last four weeks.');
  });

  it('finds when in the day you move from minute heart rate, your resting heart rate and age', () => {
    const days = syntheticDays(30);
    const intraday: Record<string, { iso: string; date: string; minutesOfDay: number; value: number }[]> = {};
    for (const d of days) {
      const weekend = isoWeekdayIndex(d.date) >= 5;
      intraday[d.date] = [];
      for (let m = 360; m < 1320; m++) {
        const h = Math.floor(m / 60);
        const active = weekend ? h >= 10 && h < 12 : h >= 17 && h < 19;
        intraday[d.date].push({ iso: '', date: d.date, minutesOfDay: m, value: active ? 120 : 70 });
      }
    }
    const at = new Date('2026-07-30T08:00:00');
    const card = (age: number | null) => insightFeeds({ days, profile: { age } } as any, at, { intraday }).pages.activity.find((o) => o.id === 'activity-peak-hours');
    // Resting 62 and age 40: 62 + 0.4 × (208 − 0.7 × 40 − 62) = 109 bpm.
    assert.equal(card(40)?.text,
      "On weekdays you're most active between 17:00 and 19:00. At weekends it's between 10:00 and 12:00. That's when your heart rate most often reaches a brisk-walking level, 109 bpm or more. It's based on 28 days of heart-rate readings from the last four weeks.");
    assert.equal(card(null), undefined, 'no age, no threshold, no card');
  });
});

describe('insight engine — Sleep in depth', () => {
  const trace = (days: Days, id: string, from: number) => {
    const out: string[] = [];
    for (let n = from; n <= days.length; n++) out.push(whereIs(days.slice(0, n), id) ?? '-');
    return out.join(' ');
  };
  // Grids of 40 days end on Sun 9 Aug; 56 days on Tue 25 Aug.
  const AUG9 = new Date('2026-08-09T08:00:00');
  const AUG25 = new Date('2026-08-25T08:00:00');

  it('explains the need every sleep card measures against', () => {
    assert.equal(cardOf(syntheticDays(28), 'sleep-need')?.text,
      "Your sleep cards measure each night against about 7h 30m. That's the middle of your last 28 recorded nights.");
    assert.equal(cardOf(syntheticDays(28, {}, { sleepMin: 330 }), 'sleep-need')?.text,
      'Your sleep cards measure each night against 7 hours. Your nights are usually shorter, about 5h 30m, but most adults need at least 7 hours.');
  });

  it('says when a week of debt is behind you: news the morning it clears, then on Sleep', () => {
    const days = syntheticDays(44);
    for (let i = 26; i < 33; i++) days[i].sleep!.minutesAsleep = 330;
    for (let i = 33; i < 44; i++) days[i].sleep!.minutesAsleep = 520;
    assert.equal(trace(days, 'sleep-debt-cleared', 33), '- - - - - - today sleep sleep sleep sleep sleep');
    assert.match(cardOf(days.slice(0, 39), 'sleep-debt-cleared', AUG9)!.text,
      /^Last week you were [\d.]+ hours short on sleep\. Over the 7 nights before last night, your sleep added up to what you need\.$/);
  });

  it('counts good nights in a row: on Sleep from 3, on Today at 7 and 14', () => {
    const days = syntheticDays(44);
    days[29].sleep!.minutesAsleep = 300;
    for (let i = 30; i < 44; i++) days[i].sleep!.minutesAsleep = 480;
    assert.equal(trace(days, 'sleep-rested-streak', 29), '- - - - sleep sleep sleep sleep today sleep sleep sleep sleep sleep sleep today');
  });

  it('finds the bedtime you sleep best by, and the wind-down nudge uses it', () => {
    const days = syntheticDays(40);
    days.forEach((d, i) => {
      const early = i % 9 < 5;
      d.sleep!.bedtimeMin = early ? 1350 : 30;
      d.sleep!.minutesAsleep = (early ? 480 : 370) + (i % 3) * 10;
      d.sleep!.minutesInBed = d.sleep!.minutesAsleep + 10;
    });
    // A short last night, so the evening nudge has earned its place.
    days[39].sleep!.minutesAsleep = 300;
    days[39].sleep!.minutesInBed = 310;
    const card = cardOf(days, 'sleep-best-bedtime', AUG9)!;
    assert.equal(card.title, 'You sleep best before 22:30');
    assert.match(card.text, /^On nights you went to sleep by 22:30, your sleep score averaged \d+\. On later nights it averaged \d+\. That's based on 24 earlier nights and 16 later ones, so it's a pattern rather than a rule\.$/);
    assert.match(cardOf(days, 'wind-down', new Date('2026-08-09T19:00:00'))!.text, /^You tend to sleep best when you're asleep by 22:30\./);
  });

  it('reads your natural rhythm and weekend shift from free and work nights', () => {
    const days = syntheticDays(28);
    for (const d of days) {
      const free = isoWeekdayIndex(d.date) >= 5;
      d.sleep!.bedtimeMin = free ? 60 : 1380;
      d.sleep!.wakeMin = free ? 570 : 420;
    }
    assert.equal(cardOf(days, 'sleep-weekend-shift')?.text,
      "At weekends you sleep about 2h 15m later than on weekdays. For your body, that's a bit like flying across a time zone and back every week.");
    assert.equal(cardOf(days, 'sleep-natural-rhythm')?.text,
      "When you don't have to be up early, you usually sleep from about 01:00 to 09:30. The middle of your sleep falls around 05:15.");
  });

  it('names your shortest and longest nights by the evening they start', () => {
    const days = syntheticDays(56);
    days.forEach((d) => { const w = isoWeekdayIndex(d.date); d.sleep!.minutesAsleep = w === 0 ? 360 : w === 5 ? 510 : 450; });
    assert.equal(cardOf(days, 'sleep-week-shape', AUG25)?.text,
      'Sunday night is usually your shortest, at about 6h 00m. Friday night is usually your longest, at about 8h 30m.');
  });

  it('notices more time awake and less REM, and keeps the efficiency card quiet beside them', () => {
    const restless = syntheticDays(40);
    restless.forEach((d, i) => { d.sleep!.minutesAwake = i >= 33 ? 40 : 10 + (i % 3); });
    assert.match(cardOf(restless, 'sleep-restless', AUG9)!.text, /^You spent about 40 minutes awake each night this week, compared with your usual 11\./);
    assert.equal(cardOf(restless, 'sleep-efficiency', AUG9), undefined, 'a cautious card beats good news in its family');
    assert.equal(cardOf(syntheticDays(40), 'sleep-efficiency', AUG9)?.title, 'You use your time in bed well');

    const rem = syntheticDays(40);
    rem.forEach((d, i) => { d.sleep!.stages = { deep: 70, rem: i >= 33 ? 60 : 90 + (i % 5) * 2, light: 280, awake: 10 }; });
    assert.match(cardOf(rem, 'sleep-rem-short', AUG9)!.text, /^On each of the last 7 nights you got less REM sleep than usual, about 60 minutes instead of 94\./);
  });

  it('notes naps, and the short nights before them', () => {
    const days = syntheticDays(28);
    for (const i of [24, 26]) {
      days[i].sleep!.minutesAsleep = 330;
      days[i].naps = [{ ...days[i].sleep!, isNap: true, isMainSleep: false, minutesAsleep: 35 }];
    }
    assert.equal(cardOf(days, 'sleep-naps')?.text,
      'You took 2 naps in the last week, about 35 minutes each. Each one came after a night shorter than your 7h 30m need.');
  });

  it('finds long nights in your HRV, worded as a pattern', () => {
    const days = syntheticDays(40);
    days.forEach((d, i) => { const long = i % 2 === 0; d.sleep!.minutesAsleep = long ? 470 : 380; d.hrv = (long ? 40 : 33) + (i % 3); });
    assert.match(cardOf(days, 'sleep-hrv-link', AUG9)!.text,
      /^On nights of 7 hours or more, your overnight HRV is usually about 21% higher than on shorter nights\. That's based on 20 longer nights and 20 shorter ones\. It's a pattern in your data, not proof that one causes the other\.$/);
    const flat = syntheticDays(40);
    flat.forEach((d, i) => { d.sleep!.minutesAsleep = i % 2 === 0 ? 470 : 380; });
    assert.equal(cardOf(flat, 'sleep-hrv-link', AUG9), undefined, 'no relationship, no story');
  });
});

describe('insight engine — Vitals in depth', () => {
  // Grid ends: 40 days on Sun 9 Aug, 58 on Thu 27 Aug, 62 on Mon 31 Aug.
  const AUG9 = new Date('2026-08-09T08:00:00');
  const AUG27 = new Date('2026-08-27T08:00:00');
  const AUG31 = new Date('2026-08-31T08:00:00');

  it('flags two nights of faster breathing or running warm, and steps aside for the several-signals card', () => {
    const breathing = syntheticDays(28);
    breathing[26].respiratoryRate = 16.2;
    breathing[27].respiratoryRate = 16.0;
    assert.equal(whereIs(breathing, 'vitals-breathing-up'), 'today', listing(breathing));
    assert.match(cardOf(breathing, 'vitals-breathing-up')!.text, /^Your breathing rate has been about 16\.1 breaths a minute for the last 2 nights\. It's usually around 14\.0\./);
    breathing[26].respiratoryRate = 14;
    assert.equal(cardOf(breathing, 'vitals-breathing-up'), undefined, 'one night is not a run');

    const warm = syntheticDays(28);
    warm[26].skinTempDeviationC = 0.7;
    warm[27].skinTempDeviationC = 0.6;
    assert.match(cardOf(warm, 'vitals-warm')!.text, /^Your skin temperature has been about 0\.6 °C above your normal for the last 2 nights\./);

    const rough = syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 });
    rough[26].respiratoryRate = 17.5;
    rough[26].skinTempDeviationC = 0.8;
    assert.equal(cardOf(rough, 'vitals-breathing-up'), undefined);
    assert.equal(cardOf(rough, 'vitals-warm'), undefined);
  });

  it('puts lower overnight oxygen on Vitals, and on Today the morning it makes three nights', () => {
    const days = syntheticDays(40);
    days.forEach((d, i) => { d.spo2 = { avg: i >= 37 ? 93.5 : 96 + (i % 3) * 0.2, ciLower: null, ciUpper: null, rollingAvgSd: null }; });
    const trace: string[] = [];
    for (let n = 37; n <= 40; n++) trace.push(whereIs(days.slice(0, n), 'vitals-oxygen-lower', AUG9) ?? '-');
    assert.equal(trace.join(' '), '- vitals vitals today');
    assert.equal(cardOf(days, 'vitals-oxygen-lower', AUG9)?.text,
      "Your overnight oxygen averaged 93.5% over the last 3 nights. It's usually around 96.2%. You can see these nights in Labs.");
  });

  it('calls everything steady only after a week with nothing far from usual, and never beside a cautious card', () => {
    assert.equal(cardOf(syntheticDays(28), 'vitals-all-quiet')?.text,
      "Your resting heart rate, HRV, breathing and temperature haven't strayed far from their usual range for 20 nights.");
    const off = syntheticDays(28);
    off[24].restingHr = 75; // far above, four nights ago
    assert.equal(cardOf(off, 'vitals-all-quiet'), undefined, 'the run restarts after a far night');
    const warm = syntheticDays(28);
    warm[26].skinTempDeviationC = 0.7;
    warm[27].skinTempDeviationC = 0.6;
    assert.equal(cardOf(warm, 'vitals-all-quiet'), undefined);
  });

  it('notices HRV steadier than usual, worded as its typical swing', () => {
    const days = syntheticDays(58);
    for (let i = 51; i < 58; i++) days[i].hrv = 34 + (i % 2 ? 0.4 : -0.4);
    days[57].hrv = 34;
    assert.match(cardOf(days, 'vitals-hrv-stability', AUG27)!.text,
      /^This week your HRV varied by about \d+% around its average\. Usually it varies by about \d+%\. Steadier HRV often goes with good recovery\.$/);
    assert.equal(cardOf(syntheticDays(58), 'vitals-hrv-stability', AUG27), undefined, 'an ordinary week is no news');
  });

  it('reads how quickly HRV is back in range after your hardest days', () => {
    const quick = syntheticDays(62);
    quick.forEach((d, i) => { const hard = i % 7 < 2; d.zoneMinutes = { fatBurn: hard ? 50 : 10, cardio: hard ? 10 : 0, peak: 0 }; });
    assert.equal(cardOf(quick, 'vitals-bounce-back', AUG31)?.title, 'You bounce back quickly');

    const slower = syntheticDays(62);
    slower.forEach((d, i) => {
      const hard = i % 4 === 0;
      d.zoneMinutes = { fatBurn: hard ? 50 : 10, cardio: hard ? 10 : 0, peak: 0 };
      if (i % 4 === 1) d.hrv = 24;
    });
    assert.match(cardOf(slower, 'vitals-bounce-back', AUG31)!.text,
      /^After your hardest days, your HRV usually takes about 2 nights to get back to its normal range\. That's based on \d+ days with 25 active zone minutes or more in the last 8 weeks\.$/);
  });

  it('finds a weekly HRV pattern only when it beats night-to-night noise', () => {
    const days = syntheticDays(56);
    days.forEach((d) => { const w = isoWeekdayIndex(d.date); d.hrv = w === 0 ? 29 : w === 3 ? 38 : 34; });
    assert.match(cardOf(days, 'vitals-week-shape', new Date('2026-08-25T08:00:00'))!.text,
      /^Your HRV is usually lowest on Monday mornings and highest on Thursday mornings\. On Monday mornings it's about \d+% below your weekly average\.$/);
    assert.equal(cardOf(syntheticDays(56), 'vitals-week-shape', new Date('2026-08-25T08:00:00')), undefined);
  });

  it("gives Google's fitness band for your age, and steps aside while a revision is news", () => {
    const days = syntheticDays(40);
    days.forEach((d, i) => { d.vo2Max = i < 5 ? 42.0 : 43.2; d.cardioFitnessLevel = 'GOOD'; });
    assert.equal(cardOf(days, 'vitals-fitness-level', AUG9)?.text,
      "Your VO₂ max is 43.2, which Google rates as Good for your age. It's 1.2 points higher than on 1 July.");
    const fresh = syntheticDays(40);
    fresh.forEach((d, i) => { d.vo2Max = i < 30 ? 42.0 : 43.2; d.cardioFitnessLevel = 'GOOD'; });
    assert.equal(cardOf(fresh, 'vitals-fitness-level', AUG9), undefined, 'one card about VO₂ max at a time');
    assert.ok(cardOf(fresh, 'vo2-up', AUG9));
  });
});

describe('insight engine — Body in depth', () => {
  const AUG9 = new Date('2026-08-09T08:00:00');

  it('alerts to a fast change either way, and it speaks for the weight trend', () => {
    const days = syntheticDays(40);
    for (let k = 0; k < 6; k++) days[4 + k * 6].weightKg = Math.round((90 - k * 6 * ((90 * 0.012) / 7)) * 10) / 10;
    assert.equal(whereIs(days, 'body-fast-change', AUG9), 'today');
    assert.equal(cardOf(days, 'body-fast-change', AUG9)?.text,
      "You've been losing about 1.3% of your body weight a week for 4 weeks. Most guidance suggests 0.5 to 1% a week for changes that last.");
    assert.equal(cardOf(days, 'weight-down', AUG9), undefined, 'one card about weight at a time');
  });

  it('says when weight holds steady, and how much it swings day to day', () => {
    const steady = syntheticDays(40);
    [3, 10, 17, 24, 31, 38].forEach((i, k) => { steady[i].weightKg = 80 + [0.2, -0.1, 0.3, -0.2, 0.1, 0][k]; });
    assert.equal(cardOf(steady, 'body-holding-steady', AUG9)?.text,
      'Your weight has stayed within 0.3 kg either way of 80.0 kg for 5 weeks, across 6 weigh-ins.');

    const swings = syntheticDays(40);
    for (let i = 28; i < 40; i++) swings[i].weightKg = 80 + (i % 2 ? 0.8 : 0) - (i - 28) * 0.03;
    assert.match(cardOf(swings, 'body-swings', AUG9)!.text, /^Your weight can swing by about 0\.8 kg from one day to the next\./);
  });

  it('reads fat and lean mass from paired readings, news when the newest pair shows it', () => {
    const days = syntheticDays(40);
    [4, 16, 28, 39].forEach((i, k) => { days[i].weightKg = 80 - k * 0.15; days[i].bodyFatPct = 22 - k * 0.35; });
    assert.equal(whereIs(days, 'body-composition', AUG9), 'today');
    assert.equal(cardOf(days, 'body-composition', AUG9)?.text,
      'Over the last 5 weeks you gained 0.5 kg of lean mass and lost 0.9 kg of fat. That\'s from 4 readings that measured both.');
    assert.equal(cardOf(days, 'body-fat-trend', AUG9), undefined, 'one card about composition at a time');
  });

  it('counts weeks with a weigh-in, and notes BMI on the first days of the month', () => {
    const rhythm = syntheticDays(44);
    [2, 9, 16, 23, 30, 37, 43].forEach((i) => { rhythm[i].weightKg = 80; });
    assert.equal(cardOf(rhythm, 'body-weigh-in-rhythm', new Date('2026-08-13T08:00:00'))?.text,
      "You've weighed in every week for 7 weeks. That's enough for a trend you can trust.");

    const bmi = syntheticDays(63);
    for (let i = 3; i < 63; i += 5) bmi[i].weightKg = Math.round((85 - (i / 7) * 0.5) * 10) / 10;
    const sep1 = new Date('2026-09-01T08:00:00');
    const card = insightFeeds({ days: bmi, profile: { heightCm: 180 } } as any, sep1).pages.body.find((o) => o.id === 'body-bmi');
    assert.equal(card?.text, 'Going by your weight trend and your height of 1.80 m, your BMI went from 25.6 to 25.0 over the last month.');
    assert.equal(insightFeeds({ days: bmi } as any, sep1).pages.body.find((o) => o.id === 'body-bmi'), undefined, 'no height, no BMI');
  });
});

describe('history queries', () => {
  /** Days from one date to another, each filled in by `fill`. */
  const span = (from: string, to: string, fill: (d: ReturnType<typeof emptyRecord>, i: number) => void = () => {}) =>
    dateRange(from, to).map((date, i) => {
      const d = emptyRecord(date);
      fill(d, i);
      return d;
    });
  const TODAY = '2026-09-01';
  const WINDOW_FROM = addDays(TODAY, -61); // 2 July

  it('answers each aggregate, with dates for the readings it picks', () => {
    const days = span('2026-03-01', '2026-03-05', (d, i) => { d.steps = [9000, 12000, 7000, 12000, 8000][i]; });
    const answer = answerQueries(
      { steps: { measure: 'steps', aggregate: ['sum', 'count', 'mean', 'min', 'max', 'first', 'last'], back: 'all' } },
      days, TODAY, WINDOW_FROM, '2026-03-01',
    ).steps!;
    assert.deepEqual(answer.rows, [{
      key: null, sum: 48000, count: 5, mean: 9600,
      min: { date: '2026-03-03', value: 7000 },
      max: { date: '2026-03-02', value: 12000 }, // the first of two equal days: a later one hasn't beaten it
      first: { date: '2026-03-01', value: 9000 },
      last: { date: '2026-03-05', value: 8000 },
    }]);
  });

  it('groups by month, ISO week, weekday and year', () => {
    const days = span('2026-03-28', '2026-04-03', (d) => { d.steps = 1000; });
    const run = (group: 'month' | 'week' | 'weekday' | 'year') =>
      answerQueries({ q: { measure: 'steps', aggregate: 'count', group, back: 'all' } }, days, TODAY, WINDOW_FROM, '2026-03-28').q!.rows
        .map((r) => `${r.key}:${r.count}`).join(' ');
    assert.equal(run('month'), '2026-03:4 2026-04:3');
    assert.equal(run('week'), '2026-03-23:2 2026-03-30:5'); // Sat 28 and Sun 29 March, then Monday 30 March on
    assert.equal(run('weekday'), '0:1 1:1 2:1 3:1 4:1 5:1 6:1');
    assert.equal(run('year'), '2026:7');
  });

  it('reads rolling means only where enough days have readings, and never across a gap', () => {
    const days = span('2026-03-01', '2026-03-10', (d, i) => { d.restingHr = i === 2 ? null : 60 + i; });
    const answer = answerQueries(
      { week: { measure: 'restingHr', rolling: { days: 7, minReadings: 6 }, aggregate: ['min', 'count'], back: 'all' } },
      days, TODAY, WINDOW_FROM, '2026-03-01',
    ).week!;
    assert.equal(answer.rows[0].count, 4); // runs ending 7 to 10 March
    assert.deepEqual(answer.rows[0].min, { date: '2026-03-07', value: (60 + 61 + 63 + 64 + 65 + 66) / 6 });
    const gappy = days.filter((d) => d.date !== '2026-03-05');
    const none = answerQueries({ week: { measure: 'restingHr', rolling: { days: 7, minReadings: 1 }, aggregate: 'count', back: 'all' } },
      gappy, TODAY, WINDOW_FROM, '2026-03-01').week!;
    assert.equal(none.rows[0].count, 0, 'only runs of seven real calendar days');
  });

  it('says how far back with back and until, and never reaches into the window', () => {
    const q = (back: number | 'all', until?: number) => ({ measure: 'steps' as const, aggregate: 'count' as const, back, until });
    assert.deepEqual(queryRange(q('all'), TODAY, WINDOW_FROM, '2025-01-01'), { from: '2025-01-01', to: '2026-07-01' });
    assert.deepEqual(queryRange(q(365), TODAY, WINDOW_FROM, '2025-01-01'), { from: '2025-09-01', to: '2026-07-01' });
    assert.deepEqual(queryRange(q(395, 365), TODAY, WINDOW_FROM, '2025-01-01'), { from: '2025-08-02', to: '2025-09-01' });
    assert.deepEqual(queryRange(q(400), TODAY, WINDOW_FROM, '2026-05-01'), { from: '2026-05-01', to: '2026-07-01' }, 'no further back than what is stored');
    assert.equal(queryRange(q('all', 30), TODAY, WINDOW_FROM, '2025-01-01'), null, 'until inside the window');
    const empty = answerQueries({ q: q(30) }, [], TODAY, WINDOW_FROM, '2025-01-01').q!;
    assert.deepEqual(empty.rows, [{ key: null, count: 0 }], 'a range that ends before it starts finds nothing');
  });

  it('drops anything it does not understand', () => {
    const parsed = parseQueries({
      ok: { measure: 'steps', aggregate: ['sum', 'count'], group: 'month', back: 'all' },
      badMeasure: { measure: 'password', aggregate: 'count', back: 'all' },
      badAggregate: { measure: 'steps', aggregate: 'median', back: 'all' },
      badBack: { measure: 'steps', aggregate: 'count', back: -3 },
      badRolling: { measure: 'hrv', aggregate: 'max', rolling: { days: 7, minReadings: 9 }, back: 'all' },
      'bad name!': { measure: 'steps', aggregate: 'count', back: 'all' },
    });
    assert.deepEqual(Object.keys(parsed), ['ok']);
    assert.deepEqual(parseQueries('nonsense'), {});
  });

  it('answers from stored rows before the window only, as demo mode and the server do', () => {
    const day = (steps: number) => ({ fields: { steps }, present: ['steps'], sources: [], sourceByType: {} });
    const rows = new Map([['steps', new Map([
      ['2026-05-01', day(9000)], ['2026-05-02', day(11000)], ['2026-07-10', day(30000)],
    ])]]);
    const queries: HistoryQueries = { biggest: { measure: 'steps', aggregate: 'max', back: 'all' } };
    const answers = answerFromRows(rows as any, queries, WINDOW_FROM, TODAY);
    assert.deepEqual(answers.biggest!.rows[0].max, { date: '2026-05-02', value: 11000 }, "the window's own record isn't in it");
    assert.equal(answers.biggest!.from, '2026-05-01');
    assert.equal(answers.biggest!.to, '2026-07-01');
  });

  it('finds nothing before the window in demo mode, where the fixture is just the window', async () => {
    const ds = await syncHealthData({
      token: 'demo',
      fetchImpl: createFixtureFetch(buildFixturePayloads()),
      windowDays: 62,
      now: FIXTURE_CLOCK.now,
      timeZone: FIXTURE_CLOCK.timeZone,
      queries: HISTORY_QUERIES,
    });
    assert.deepEqual(Object.keys(ds.answers!).sort(), Object.keys(HISTORY_QUERIES).sort());
    assert.equal(ds.answers!.stepsByMonth!.rows.length, 0);
    assert.equal(ds.answers!.biggestStepDay!.rows[0].max, null);
  });
});

describe('insight engine — all time and the week in review', () => {
  /** Older days from 1 March to 30 June, before a window of syntheticDays (1 July on). */
  const older = (fill: (d: ReturnType<typeof emptyRecord>, i: number) => void) =>
    dateRange('2026-03-01', '2026-06-30').map((date, i) => {
      const d = emptyRecord(date);
      fill(d, i);
      return d;
    });
  /** The app's real history queries, answered from older days as the server would answer them. */
  const feedsWith = (window: Days, before: Days, now: Date) =>
    insightFeeds({ days: window, answers: answerQueries(HISTORY_QUERIES, before, window.at(-1)!.date, window[0].date, before[0]?.date ?? null) } as any, now);
  const find = (f: ReturnType<typeof feedsWith>, id: string) => {
    if (f.today.some((o) => o.id === id)) return { where: 'today', card: f.today.find((o) => o.id === id)! };
    for (const [page, os] of Object.entries(f.pages)) {
      const card = os.find((o) => o.id === id);
      if (card) return { where: page, card };
    }
    return null;
  };
  const SEP1 = new Date('2026-09-01T08:00:00');
  // 63 days of syntheticDays run from 1 July to Tue 1 September; 67 to Sat 5 September.
  const window = (n = 63) => {
    const days = syntheticDays(n);
    for (const d of days) if (d.date.startsWith('2026-08')) d.steps = 10000;
    return days;
  };

  it('names last month your most active on record: news on the 1st, on Activity after', () => {
    const before = older((d) => { d.steps = 7000; });
    const sep1 = find(feedsWith(window(), before, SEP1), 'activity-best-month')!;
    assert.equal(sep1.where, 'today');
    assert.equal(sep1.card.text, "You averaged 10,000 steps a day in August. That's your most active month since March, as far back as your history goes.");
    assert.equal(find(feedsWith(window(67), before, new Date('2026-09-05T08:00:00')), 'activity-best-month')?.where, 'activity');
    assert.equal(find(feedsWith(window(), [], SEP1), 'activity-best-month'), null, 'two months are no record');
    const may = older((d) => { d.steps = d.date.startsWith('2026-05') ? 12000 : 7000; });
    assert.equal(find(feedsWith(window(), may, SEP1), 'activity-best-month'), null);
  });

  it('finds your best month of sleep and your calmest month the same way', () => {
    const days = syntheticDays(63);
    for (const d of days) {
      if (!d.date.startsWith('2026-07')) continue;
      d.restingHr = 64;
      d.sleep!.minutesAsleep = 400;
    }
    const before = older((d) => {
      d.restingHr = 66;
      d.sleep = { ...syntheticDays(1)[0].sleep!, date: d.date, minutesAsleep: 380, minutesInBed: 390 };
    });
    const f = feedsWith(days, before, SEP1);
    assert.match(find(f, 'sleep-best-month')!.card.text,
      /^In August you slept 7h 30m a night on average, and your average sleep score was \d+\. That's your best month of sleep since March, as far back as your history goes\.$/);
    assert.match(find(f, 'vitals-calmest-month')!.card.text,
      /^Your resting heart rate averaged 62\.\d bpm in August\. That's your lowest month since March, as far back as your history goes\.$/);
  });

  it('calls a step record all time only when it beats every stored day', () => {
    const days = syntheticDays(28);
    days[26].steps = 24000;
    const at = new Date('2026-07-28T08:00:00');
    const beaten = find(feedsWith(days, older((d, i) => { d.steps = i === 40 ? 20000 : 8000; }), at), 'step-record')!;
    assert.equal(beaten.card.title, 'Your biggest day yet');
    assert.equal(beaten.card.text, "You walked 24,000 steps on 27 July. That's your biggest day since March, as far back as your history goes. Your previous best was 20,000.");
    const unbeaten = find(feedsWith(days, older((d, i) => { d.steps = i === 40 ? 30000 : 8000; }), at), 'step-record')!;
    assert.equal(unbeaten.card.title, 'Your biggest day in two months');
    assert.match(unbeaten.card.text, /That's your biggest day in the last two months\./);
  });

  it('calls a record week all time only when it beats every stored week', () => {
    // 63 days end on a jitter-free morning, so the battery doesn't move and nothing cautious shares the family.
    const days = syntheticDays(63);
    for (let i = 56; i < 63; i++) days[i].restingHr = 55;
    const at = SEP1;
    const calmer = find(feedsWith(days, older((d, i) => { d.restingHr = i >= 30 && i < 37 ? 58 : 62; }), at), 'record-rhr')!;
    assert.equal(calmer.card.title, 'Your calmest week yet');
    assert.equal(calmer.card.text, "Your resting heart rate averaged 55.0 bpm this week. That's your lowest week since March, as far back as your history goes.");
    const notYet = find(feedsWith(days, older((d, i) => { d.restingHr = i >= 30 && i < 37 ? 54 : 62; }), at), 'record-rhr')!;
    assert.equal(notYet.card.title, 'Your calmest week in two months');
  });

  it('measures weight since your first weigh-in on record', () => {
    const days = syntheticDays(63);
    [10, 25, 40, 55, 60].forEach((i, k) => { days[i].weightKg = 88 - k * 0.4; });
    const since = find(feedsWith(days, older((d, i) => { if (i === 1) d.weightKg = 90; }), SEP1), 'body-since-start')!;
    assert.equal(since.where, 'today');
    assert.equal(since.card.text, "You've lost 3.6 kg since March, going from 90.0 kg to 86.4 kg.");
  });

  it('reviews last week on Monday mornings only, from measures with 5 days or more', () => {
    const days = syntheticDays(27); // ends on Monday 27 July
    for (const d of days) d.zoneMinutes = { fatBurn: 20, cardio: 5, peak: 0 };
    const card = cardOf(days, 'weekly-review', new Date('2026-07-27T08:00:00'))!;
    assert.equal(card.title, 'Your week in review');
    assert.equal(card.text,
      'Last week you averaged 8,000 steps a day, about the same as the week before. You earned 210 active zone minutes and slept 7h 30m a night on average. Your HRV was about usual.');
    assert.equal(whereIs(days, 'weekly-review', new Date('2026-07-27T08:00:00')), 'today');
    assert.equal(cardOf(days, 'weekly-review', new Date('2026-07-27T14:00:00')), undefined, 'a morning card');
    assert.equal(cardOf(syntheticDays(28), 'weekly-review'), undefined, 'Tuesday');
  });
});

describe('insight engine — records in the past year', () => {
  /** Older days up to 30 June, before a window of syntheticDays (1 July on). */
  const older = (from: string, fill: (d: ReturnType<typeof emptyRecord>, i: number) => void) =>
    dateRange(from, '2026-06-30').map((date, i) => {
      const d = emptyRecord(date);
      fill(d, i);
      return d;
    });
  const feedsWith = (window: Days, before: Days, now: Date) =>
    insightFeeds({ days: window, answers: answerQueries(HISTORY_QUERIES, before, window.at(-1)!.date, window[0].date, before[0]?.date ?? null) } as any, now);
  const cardIn = (f: ReturnType<typeof feedsWith>, id: string) => [...f.today, ...Object.values(f.pages).flat()].find((o) => o.id === id);
  const whereIn = (f: ReturnType<typeof feedsWith>, id: string) =>
    f.today.some((o) => o.id === id) ? 'today' : Object.entries(f.pages).find(([, os]) => os.some((o) => o.id === id))?.[0] ?? '-';
  // 63 days of syntheticDays end on Tue 1 September; a year back reaches 1 September 2025.
  const SEP1 = new Date('2026-09-01T08:00:00');
  const YEAR_AGO = '2025-09-01';

  it('celebrates your most active week in a year, and lets a ramp alert speak when the week is a sudden jump', () => {
    const window = syntheticDays(63);
    for (let i = 55; i < 62; i++) window[i].steps = 11500;
    const card = cardIn(feedsWith(window, older(YEAR_AGO, (d, i) => { d.steps = i >= 100 && i < 107 ? 10000 : 8000; }), SEP1), 'activity-week-record')!;
    assert.equal(card.title, 'Your most active week in a year');
    assert.equal(card.text, "You took 80,500 steps over the last 7 days. That's your most active week in the past year.");
    assert.equal(cardIn(feedsWith(window, older('2026-03-01', (d) => { d.steps = 8000; }), SEP1), 'activity-week-record')?.title,
      'Your most active week yet', 'shorter history: since it began');
    assert.equal(cardIn(feedsWith(window, older(YEAR_AGO, (d, i) => { d.steps = i >= 100 && i < 107 ? 12000 : 8000; }), SEP1), 'activity-week-record'), undefined);

    const jump = syntheticDays(63);
    for (let i = 55; i < 62; i++) jump[i].steps = 14000;
    const f = feedsWith(jump, older(YEAR_AGO, (d) => { d.steps = 8000; }), SEP1);
    assert.equal(cardIn(f, 'activity-week-record'), undefined, 'a cautious card beats good news in its family');
    assert.ok(cardIn(f, 'ramp'));
  });

  it('celebrates your longest walk, most floors and hardest day', () => {
    const window = syntheticDays(63);
    for (const d of window) { d.distanceKm = 5; d.floors = 8; d.zoneMinutes = { fatBurn: 20, cardio: 5, peak: 0 }; }
    window[61].distanceKm = 21.4;
    window[61].floors = 48;
    window[61].zoneMinutes = { fatBurn: 60, cardio: 30, peak: 10 };
    const before = older(YEAR_AGO, (d, i) => {
      d.distanceKm = i === 50 ? 18 : 6;
      d.floors = i === 50 ? 40 : 9;
      d.zoneMinutes = { fatBurn: i === 50 ? 70 : 20, cardio: 5, peak: 0 };
    });
    const f = feedsWith(window, before, SEP1);
    assert.equal(cardIn(f, 'activity-longest-walk')?.text, 'You covered 21.4 km on 31 August, your furthest day in the past year. Your previous best was 18.0 km.');
    assert.equal(cardIn(f, 'activity-most-floors')?.text, 'You climbed 48 floors on 31 August, your most in a day in the past year. Your previous best was 40.');
    assert.equal(cardIn(f, 'activity-hardest-day')?.text, 'You earned 140 active zone minutes on 31 August, your most in a day in the past year. Your previous best was 80.');
    assert.equal(whereIn(f, 'activity-longest-walk'), 'today');

    const beaten = older(YEAR_AGO, (d, i) => { d.distanceKm = i === 50 ? 25 : 6; });
    assert.equal(cardIn(feedsWith(window, beaten, SEP1), 'activity-longest-walk'), undefined, 'a longer day in the past year');
  });

  it('puts a day record on Today the mornings after, then on its page for the rest of the week', () => {
    const window = syntheticDays(70);
    for (const d of window) d.distanceKm = 5;
    window[60].distanceKm = 21.4; // 30 August
    const before = older(YEAR_AGO, (d) => { d.distanceKm = 6; });
    const trace: string[] = [];
    for (let n = 61; n <= 69; n++) {
      const cut = window.slice(0, n);
      trace.push(whereIn(feedsWith(cut, before, new Date(`${cut.at(-1)!.date}T08:00:00`)), 'activity-longest-walk'));
    }
    assert.equal(trace.join(' '), '- today today today activity activity activity activity -');
  });

  it('needs two months of readings behind a record before it calls one', () => {
    const window = syntheticDays(63);
    for (const d of window) d.distanceKm = 5;
    window[61].distanceKm = 21.4;
    assert.ok(cardIn(feedsWith(window, [], SEP1), 'activity-longest-walk'), '61 days in the window are enough');
    const short = window.slice(20);
    assert.equal(cardIn(feedsWith(short, [], SEP1), 'activity-longest-walk'), undefined, 'six weeks are not');
  });

  it("celebrates your best night's sleep in a year, in place of the good-night card", () => {
    const window = syntheticDays(63);
    window[62].sleep!.minutesAsleep = 500;
    window[62].sleep!.stages = { deep: 95, rem: 105, light: 290, awake: 10 };
    const before = older(YEAR_AGO, (d) => { d.sleep = { ...syntheticDays(1)[0].sleep!, date: d.date, minutesAsleep: 430, minutesInBed: 445, efficiency: 95 }; });
    const f = feedsWith(window, before, SEP1);
    assert.equal(cardIn(f, 'sleep-best-night')?.text, "Last night's sleep score was 92, your best in the past year. Your previous best was 83.");
    assert.equal(whereIn(f, 'sleep-best-night'), 'today');
    assert.equal(cardIn(f, 'night-good'), undefined, 'one card about last night');
  });

  it('celebrates your lowest resting heart rate in a year, but never a single HRV night', () => {
    const window = syntheticDays(63);
    window[62].restingHr = 51;
    window[62].hrv = 60;
    const before = older(YEAR_AGO, (d) => { d.restingHr = 58; d.hrv = 34; });
    const f = feedsWith(window, before, SEP1);
    assert.equal(cardIn(f, 'vitals-lowest-rhr')?.text, 'Your resting heart rate was 51 bpm this morning, your lowest in the past year. Your previous low was 58 bpm.');
    assert.equal(cardIn(f, 'rhr-acute-low'), undefined, 'one card about this morning');
    assert.ok([...f.today, ...Object.values(f.pages).flat()].every((o) => !/highest HRV|HRV yet/i.test(o.title)), 'no single-night HRV record');
  });

  it('looks back one year: a better month before that no longer counts', () => {
    const window = syntheticDays(63);
    for (const d of window) if (d.date.startsWith('2026-08')) d.steps = 10000;
    // July 2025 was busier, but it's more than a year before 1 September 2026.
    const before = older('2025-07-01', (d) => { d.steps = d.date.startsWith('2025-07') ? 15000 : 7000; });
    const card = cardIn(feedsWith(window, before, SEP1), 'activity-best-month');
    assert.equal(card?.text, "You averaged 10,000 steps a day in August. That's your most active month in the past year.");
  });
});

describe('insight engine — conflict rules', () => {
  const finding = (f: Partial<Finding> & Pick<Finding, 'id'>): Finding => ({
    domain: 'cardio', page: 'vitals', kind: 'trend', tone: 'neutral', title: f.id, text: '',
    importance: 50, topic: f.id, family: f.id, today: 'as-news', news: true, ...f,
  });
  const ids = (fs: Finding[]) => settle(fs).map((f) => f.id).sort();

  it('lets the cautious claim win: a low HRV night over an improving week', () => {
    assert.deepEqual(ids([
      finding({ id: 'hrv-trend-up', tone: 'good', family: 'recovery', topic: 'hrv', importance: 80, claims: { metric: 'hrv', direction: 'up' }, evidence: 14 }),
      finding({ id: 'hrv-acute-low', tone: 'watch', family: 'recovery', topic: 'hrv-night', importance: 85, claims: { metric: 'hrv', direction: 'down' }, evidence: 1 }),
    ]), ['hrv-acute-low']);
  });

  it('never suggests a hard workout beside a recovery alert', () => {
    assert.deepEqual(ids([
      finding({ id: 'battery-green', tone: 'good', page: 'today', family: 'battery', topic: 'battery', advice: 'push' }),
      finding({ id: 'rhr-acute-high', tone: 'watch', family: 'heart', topic: 'rhr', advice: 'rest' }),
    ]), ['rhr-acute-high']);
  });

  it('lets several signals off speak for the whole recovery family', () => {
    assert.deepEqual(ids([
      finding({ id: 'illness-pattern', tone: 'watch', page: 'today', family: 'recovery' }),
      finding({ id: 'running-warm', tone: 'watch', family: 'recovery' }),
      finding({ id: 'breathing-faster', tone: 'watch', family: 'recovery' }),
      finding({ id: 'who-week', tone: 'good', page: 'activity', family: 'movement-milestone' }),
    ]), ['illness-pattern', 'who-week']);
  });

  it('folds a good night into the debt card instead of showing both', () => {
    assert.deepEqual(ids([
      finding({ id: 'night-good', tone: 'good', page: 'sleep', family: 'sleep-amount', topic: 'sleep-night' }),
      finding({ id: 'sleep-debt', tone: 'watch', page: 'sleep', family: 'sleep-amount', topic: 'sleep-debt' }),
    ]), ['sleep-debt']);

    const days = syntheticDays(28);
    for (let i = 20; i < 27; i++) days[i].sleep!.minutesAsleep = 330;
    days[27].sleep!.minutesAsleep = 520;
    assert.equal(cardOf(days, 'night-good'), undefined, listing(days));
    assert.match(cardOf(days, 'sleep-debt')!.text, /^Last night's 8h 40m helped\. Over the 7 nights before it, you slept [\d.]+ hours less than you need\./);
  });

  it('keeps a later bedtime over a settling one', () => {
    assert.deepEqual(ids([
      finding({ id: 'bed-creep-later', tone: 'watch', page: 'sleep', family: 'sleep-timing', topic: 'bedtime-shift', claims: { metric: 'bedtime', direction: 'up' }, evidence: 21 }),
      finding({ id: 'bed-settling', tone: 'good', page: 'sleep', family: 'sleep-timing', topic: 'bedtime-spread', claims: { metric: 'bedtime', direction: 'steady' }, evidence: 14 }),
    ]), ['bed-creep-later']);
  });

  it('lets unrelated news stand beside an alert', () => {
    assert.deepEqual(ids([
      finding({ id: 'who-week', tone: 'good', page: 'activity', family: 'movement-milestone' }),
      finding({ id: 'battery-low', tone: 'watch', page: 'today', family: 'recovery', topic: 'battery', advice: 'rest' }),
    ]), ['battery-low', 'who-week']);
  });

  it('breaks equal caution by evidence, and keeps one card per topic', () => {
    assert.deepEqual(ids([
      finding({ id: 'a', tone: 'good', claims: { metric: 'm', direction: 'up' }, evidence: 21 }),
      finding({ id: 'b', tone: 'good', claims: { metric: 'm', direction: 'steady' }, evidence: 14 }),
    ]), ['a']);
    assert.deepEqual(ids([
      finding({ id: 'low', topic: 't', importance: 57 }),
      finding({ id: 'high', topic: 't', importance: 74 }),
    ]), ['high']);
  });
});

describe('insight engine — calibrated against stored history', () => {
  const trace = (days: Days, id: string, from: number, now: Date = MORNING) => {
    const out: string[] = [];
    for (let n = from; n <= days.length; n++) out.push(whereIs(days.slice(0, n), id, now) ?? '-');
    return out.join(' ');
  };

  it('calls a wobbling state news only when it began lately, after a quiet week', () => {
    // heldAgo(n): did the state hold with the grid cut back n days?
    const held = (...ns: number[]) => (n: number) => ns.includes(n);
    assert.equal(freshEntry(held(0)), true, 'began today');
    assert.equal(freshEntry(held(0, 1, 2)), true, 'third day running');
    assert.equal(freshEntry(held(0, 1, 2, 3)), false, 'a fourth day is no longer news');
    assert.equal(freshEntry(held()), false, 'not holding at all');
    assert.equal(freshEntry(held(0, 4)), false, 'lapsed for three days and came back');
    // It began yesterday (n = 1), so the quiet week is n = 2 to 8.
    assert.equal(freshEntry(held(0, 1, 8)), false, 'back within a week of the last run');
    assert.equal(freshEntry(held(0, 1, 9)), true, 'a full quiet week before it began');
  });

  it('puts sleep debt on Today as it starts and as it deepens, and on Sleep in between', () => {
    const days = syntheticDays(60);
    for (let i = 30; i < 60; i++) {
      days[i].sleep!.minutesAsleep = i < 44 ? 390 : 330;
      days[i].sleep!.minutesInBed = days[i].sleep!.minutesAsleep + 10;
    }
    assert.equal(trace(days, 'sleep-debt', 31),
      '- - - today today today sleep sleep sleep sleep sleep sleep sleep sleep sleep today today today sleep sleep sleep sleep sleep sleep sleep sleep sleep sleep sleep sleep');
    assert.match(cardOf(days.slice(0, 37), 'sleep-debt')!.text, / It's been like this for 4 nights\.$/);
    assert.equal(cardOf(days.slice(0, 47), 'sleep-debt')!.title, "You're very short on sleep this week");
  });

  it('lets the wind-down carry the debt in the evening, and keeps the debt card on Sleep', () => {
    const days = syntheticDays(34);
    for (let i = 30; i < 34; i++) {
      days[i].sleep!.minutesAsleep = 330;
      days[i].sleep!.minutesInBed = 340;
    }
    assert.equal(whereIs(days, 'sleep-debt'), 'today', listing(days));
    assert.equal(whereIs(days, 'sleep-debt', EVENING), 'sleep', listing(days, EVENING));
    assert.equal(whereIs(days, 'wind-down', EVENING), 'today');
    assert.match(cardOf(days, 'wind-down', EVENING)!.text, /hours short on sleep this week/);
  });

  it('warns about a jump in steps as it starts, then keeps it on Activity', () => {
    const days = syntheticDays(56);
    for (let i = 35; i < 56; i++) days[i].steps = 16000;
    assert.equal(trace(days, 'ramp', 34),
      '- - - - - - today today today activity activity activity activity activity activity activity - - - - - - -');
    assert.match(cardOf(days.slice(0, 44), 'ramp')!.text, / It's been like this for 5 days\.$/);
  });

  it('keeps a trend that lapses and comes back within a week on its page', () => {
    const climb = (a: number, dip: number, b: number) => {
      const days = syntheticDays(64);
      for (let i = 30; i < 64; i++) days[i].steps = i < 37 ? a : i < 39 ? dip : b;
      return days;
    };
    // Back after six days: the same story resuming, so it waits on Activity.
    assert.equal(trace(climb(11000, 9500, 14000), 'steps-up', 30),
      '- - - - - - today today today activity - - - - - - activity - activity activity - - - - - - - - - - - - - - -');
    // Back after a full quiet week: news again.
    assert.equal(trace(climb(10000, 9000, 12500), 'steps-up', 30),
      '- - - - - - - today today - - - - - - - today today today - - - - - - - - - - - - - - - -');
  });

  it('counts one minute of brisk activity as one minute', () => {
    const days = syntheticDays(28);
    days.forEach((d, i) => { d.activeMinutes = { light: 200, moderate: i < 20 ? 10 : 1, vigorous: 0 }; });
    assert.equal(cardOf(days, 'mvpa-down')?.text,
      "You're averaging 1 minute of brisk activity a day this week, down from 10 last week.");
  });
});

describe('one today: freshness, partial days, the demo clock', () => {
  /** A low battery without the several-signals pattern: short sleep and a low HRV, heart rate as usual. */
  const lowMorning = (d: ReturnType<typeof emptyRecord>) => {
    d.hrv = 20;
    d.sleep!.minutesAsleep = 300;
  };

  it('takes "today" from the data, not the device clock', () => {
    const short = syntheticDays(28, { sleepMin: 300 });
    const obs = observations(dsOf(short), new Date('2026-09-15T08:00:00'));
    assert.ok(obs.some((o) => o.id === 'night-short'), 'last night is the grid’s last night, whatever the device date');
  });

  it('reads morning, midday and evening on the given zone’s clock', () => {
    // Goal already met, so the evening has nothing to suggest and shows its floor card.
    const quiet = dsOf(syntheticDays(28, { steps: 12000 }));
    const at = new Date('2026-07-28T06:00:00Z');
    assert.equal(observations(quiet, at)[0].id, 'floor-morning'); // 06:00 in this runtime's UTC
    assert.equal(observations(quiet, at, { timeZone: 'Asia/Tokyo' })[0].id, 'floor-midday'); // 15:00
    assert.equal(observations(quiet, at, { timeZone: 'America/Los_Angeles' })[0].id, 'floor-evening'); // 23:00
  });

  it('runs demo mode on the fixture’s clock and zone, wherever it’s opened', async () => {
    const ds = await syncHealthData({
      token: 'demo',
      fetchImpl: createFixtureFetch(buildFixturePayloads()),
      windowDays: 62,
      now: FIXTURE_CLOCK.now,
      timeZone: FIXTURE_CLOCK.timeZone,
    });
    // 01:39 on the 19th in Stockholm, though this runtime is in UTC, where it's still the 18th.
    assert.equal(ds.days.at(-1)!.date, '2026-08-19');
  });

  it('scores no battery from readings older than yesterday', () => {
    const charging = syntheticDays(28);
    for (const date of ['2026-07-29', '2026-07-30', '2026-07-31']) charging.push(emptyRecord(date));
    const r = readiness(charging);
    assert.equal(r.score, null, 'three days on the charger is no score, not the last night seen');
    assert.equal(r.label, 'No readings since 28 Jul');

    // Yesterday's night still counts while this morning's hasn't synced.
    const notYet = syntheticDays(28);
    notYet.push(emptyRecord('2026-07-29'));
    assert.notEqual(readiness(notYet).score, null);
    assert.equal(readiness(notYet).confidence, 'high');
  });

  it('leaves out a night older than yesterday instead of scoring it as last night', () => {
    const days = syntheticDays(28);
    for (let i = 25; i < 28; i++) days[i].sleep = null;
    const r = readiness(days);
    assert.equal(part(r, 'Last night’s sleep'), undefined);
    assert.equal(part(r, 'Recent sleep debt'), undefined);
    assert.equal(r.confidence, 'medium');
  });

  it('compares day over day against the previous night, never the same one twice', () => {
    // An illness-like morning, then today with nothing synced yet: still the pattern's first morning.
    const rough = syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 });
    rough.push(emptyRecord('2026-07-29'));
    const card = observations(dsOf(rough), new Date('2026-07-29T08:00:00')).find((o) => o.id === 'illness-pattern');
    assert.ok(card);
    assert.doesNotMatch(card!.text, /second morning/);

    // Two low mornings and an empty today make two, not three.
    const low = syntheticDays(28);
    lowMorning(low[26]);
    lowMorning(low[27]);
    low.push(emptyRecord('2026-07-29'));
    const battery = observations(dsOf(low), new Date('2026-07-29T08:00:00')).find((o) => o.id === 'battery-low');
    assert.ok(battery);
    assert.doesNotMatch(battery!.text, /third low morning/);
    lowMorning(low[25]);
    const third = observations(dsOf(low), new Date('2026-07-29T08:00:00')).find((o) => o.id === 'battery-low');
    assert.match(third!.text, /This is your third low morning in a row\./);
  });

  it('never counts a run across a missing night', () => {
    const days = syntheticDays(28, { sleepMin: 300 });
    days[25].sleep!.minutesAsleep = 305;
    days[26].sleep = null;
    const card = cardOf(days, 'night-short')!;
    assert.ok(card, listing(days));
    assert.doesNotMatch(card.text, /two short nights/);
  });

  it("doesn't read this morning's steps as a quieter stretch", () => {
    // Six days at 9,000 after weeks at 11,000 is under the 20% bar; a few hundred steps so far today must not tip it.
    const days = syntheticDays(28, {}, { steps: 11000 });
    for (let i = 21; i < 27; i++) days[i].steps = 9000;
    days[27].steps = 300;
    assert.equal(cardOf(days, 'steps-down'), undefined, listing(days));
  });

  it('keeps a streak alive while today is still counting', () => {
    const s = [
      { date: '2026-08-16', value: 11000 },
      { date: '2026-08-17', value: 12000 },
      { date: '2026-08-18', value: 10500 },
    ];
    const meets = (v: number) => v >= 10000;
    assert.equal(goalStreak([...s, { date: '2026-08-19', value: 900 }], meets), 3, 'a morning in progress breaks nothing');
    assert.equal(goalStreak([...s, { date: '2026-08-19', value: null }], meets), 3);
    assert.equal(goalStreak([...s, { date: '2026-08-19', value: 10200 }], meets), 4, 'and joins once it clears the goal');
  });

  it('counts weeks from Monday and workdays as Monday to Friday', () => {
    assert.equal(isoWeekdayIndex('2026-07-27'), 0); // Monday
    assert.equal(isoWeekdayIndex('2026-08-02'), 6); // Sunday

    // Sunday's minutes belong to last week: the bar is crossed on Tuesday, not Monday.
    const days = syntheticDays(28);
    days[25].activeMinutes = { light: 0, moderate: 100, vigorous: 0 }; // Sun 26 Jul
    days[26].activeMinutes = { light: 0, moderate: 80, vigorous: 0 }; // Mon 27 Jul
    days[27].activeMinutes = { light: 0, moderate: 75, vigorous: 0 }; // Tue 28 Jul
    assert.equal(whereIs(days, 'who-week'), 'today', listing(days));

    // Weekend lie-ins are free days; Friday and Sunday mornings aren't swapped.
    const month = syntheticDays(32); // ends Sat 1 Aug, when the monthly cards run
    for (const d of month) d.sleep!.minutesAsleep = isoWeekdayIndex(d.date) >= 5 ? 540 : 420;
    const card = cardOf(month, 'weekday-deficit', new Date('2026-08-01T08:00:00'));
    assert.ok(card);
    assert.equal(whereIs(month, 'weekday-deficit', new Date('2026-08-01T08:00:00')), 'sleep');
    assert.match(card!.text, /On free days you usually sleep about 9h 00m, but on workdays only 7h 00m\./);
  });

  it('needs a fortnight of readings before calling a resting-HR shift', () => {
    const days = syntheticDays(28);
    for (let i = 14; i < 27; i++) days[i].restingHr = null;
    days[27].restingHr = 64; // one reading, a little above
    assert.equal(cardOf(days, 'rhr-shift-up'), undefined, listing(days));
  });

  it('draws no weight trend from two readings or under three weeks', () => {
    const pts = (rows: [string, number][]) => rows.map(([date, value]) => ({ date, value }));
    assert.equal(weightTrend(pts([['2026-07-01', 80], ['2026-07-29', 79]])), null);
    assert.equal(weightTrend(pts([['2026-07-01', 80], ['2026-07-08', 79.5], ['2026-07-15', 79]])), null);
    const t = weightTrend(pts([['2026-07-01', 80], ['2026-07-11', 79.5], ['2026-07-22', 79]]))!;
    assert.equal(t.readings, 3);
    assert.equal(t.spanDays, 21);
    assert.ok(Math.abs(t.kgPerWeek + 1 / 3) < 0.01, `got ${t.kgPerWeek}`);
  });
});

describe('this week', () => {
  // Synthetic grids run 2026-07-01 to 2026-07-28, so the week is 22–28 Jul.
  it('scores each of the last seven mornings on the data up to that day', () => {
    const days = syntheticDays(28);
    const w = weekSummary(days)!;
    assert.deepEqual(w.battery.map((b) => b.date), dateRange('2026-07-22', '2026-07-28'));
    assert.equal(w.battery[6].score, readiness(days).score);
    assert.equal(w.battery[0].score, readiness(days.slice(0, 22)).score);
  });

  it('leaves a day with no row as a gap, never a zero', () => {
    const w = weekSummary(syntheticDays(28).filter((d) => d.date !== '2026-07-25'))!;
    assert.equal(w.battery.length, 7);
    assert.equal(w.battery.find((b) => b.date === '2026-07-25')!.score, null);
  });

  it('averages steps over finished days, leaving out today’s count in progress', () => {
    const days = syntheticDays(28, { steps: 15000 });
    days[26].steps = 12000;
    const w = weekSummary(days)!;
    const done = days.slice(21, 27).map((d) => d.steps!);
    assert.equal(w.steps!.days, 6);
    assert.equal(w.steps!.avg, done.reduce((a, b) => a + b, 0) / 6);
    assert.equal(w.steps!.atGoal, 1, 'today’s 15,000 waits until the day is done');
  });

  it('counts minutes the WHO’s way: Active Zone Minutes when the week has them, else moderate + 2 × vigorous', () => {
    const days = syntheticDays(28);
    for (const d of days.slice(-7)) d.activeMinutes = { light: 100, moderate: 10, vigorous: 5 };
    assert.deepEqual(weekSummary(days)!.activeMinutes, { total: 140, unit: 'brisk' });
    days[26].zoneMinutes = { fatBurn: 30, cardio: 10, peak: 5 };
    assert.deepEqual(weekSummary(days)!.activeMinutes, { total: 60, unit: 'azm' });
  });

  it('averages sleep over the nights on record', () => {
    const days = syntheticDays(28);
    days[25].sleep = null;
    const w = weekSummary(days)!;
    const nights = days.slice(21).filter((d) => d.sleep).map((d) => d.sleep!.minutesAsleep);
    assert.equal(w.sleep!.nights, 6);
    assert.equal(w.sleep!.avgMin, nights.reduce((a, b) => a + b, 0) / 6);
  });

  it('labels a sleep need in whole minutes', () => {
    assert.equal(needLabel(420), '7h');
    assert.equal(needLabel(437.5), '7h 18m');
  });

  it('reads the month the same way: the 30 days ending today', () => {
    const days = syntheticDays(40, { steps: 15000 });
    for (const d of days) d.activeMinutes = { light: 100, moderate: 10, vigorous: 5 };
    days[20].sleep = null;
    const m = monthSummary(days)!;
    assert.equal(m.length, 30);
    assert.deepEqual(m.battery.map((b) => b.date), dateRange('2026-07-11', '2026-08-09'));
    assert.equal(m.battery[29].score, readiness(days).score);
    assert.equal(m.sleep!.nights, 29, 'the missing night is left out, not counted as zero');
    assert.deepEqual(m.activeMinutes, { total: 30 * 20, unit: 'brisk' });
    assert.equal(m.steps!.days, 29, 'finished days only');
    assert.equal(weekSummary(days)!.length, 7);
  });
});

describe('goals', () => {
  const withGoals = (patch: Partial<Goals>): Goals => ({ ...DEFAULT_GOALS, ...patch });
  const cardWith = (days: Days, id: string, goals: Goals, now: Date = MORNING) => {
    const f = insightFeeds(dsOf(days), now, { goals });
    return [...f.today, ...Object.values(f.pages).flat()].find((o) => o.id === id);
  };

  it('reads stored goals inside their bounds, with defaults where one is missing', () => {
    assert.deepEqual(readGoals(null), DEFAULT_GOALS);
    assert.deepEqual(readGoals({ steps: 'lots', sleepNeed: 'auto' }), DEFAULT_GOALS);
    assert.deepEqual(readGoals({ steps: 10, briskMinutes: 1000, sleepNeed: 60 }), { steps: 2000, briskMinutes: 120, sleepNeed: 420 },
      'ten steps and an hour of sleep are pulled up to the floors');
    assert.deepEqual(readGoals({ steps: 7720, briskMinutes: 33, sleepNeed: 488 }), { steps: 7500, briskMinutes: 35, sleepNeed: 495 },
      'and onto their steps');
  });

  it('saves only goals on their steps and inside their bounds', () => {
    assert.deepEqual(parseGoals({ steps: 8000, briskMinutes: 25, sleepNeed: null }), { steps: 8000, briskMinutes: 25, sleepNeed: null });
    assert.deepEqual(parseGoals({ steps: 25000, briskMinutes: 120, sleepNeed: 540 }), { steps: 25000, briskMinutes: 120, sleepNeed: 540 });
    assert.equal(parseGoals({ steps: 10, briskMinutes: 30, sleepNeed: null }), null, 'ten steps is no goal');
    assert.equal(parseGoals({ steps: 10000, briskMinutes: 30, sleepNeed: 60 }), null, 'an hour is no sleep need');
    assert.equal(parseGoals({ steps: 10000, briskMinutes: 5, sleepNeed: null }), null);
    assert.equal(parseGoals({ steps: 30000, briskMinutes: 30, sleepNeed: null }), null);
    assert.equal(parseGoals({ steps: 10250, briskMinutes: 30, sleepNeed: null }), null, 'off its steps');
    assert.equal(parseGoals({ steps: 10000, briskMinutes: 30 }), null, 'sleep need is sent, as null for automatic');
    assert.equal(parseGoals('10000'), null);
    for (const limit of Object.values(GOAL_LIMITS)) {
      assert.equal((limit.max - limit.min) % limit.step, 0, 'every bound sits on its steps');
    }
  });

  it('measures streaks, nudges and records against the step goal that is set', () => {
    const days = syntheticDays(28);
    for (let i = 21; i < 28; i++) days[i].steps = 9000;
    assert.equal(cardOf(days, 'streak'), undefined, 'under the default 10,000');
    assert.match(cardWith(days, 'streak', withGoals({ steps: 8500 }))!.text, /more than 8,500 steps every day for 7 days in a row/);

    const close = syntheticDays(28, { steps: 8700 });
    assert.equal(cardWith(close, 'within-reach', withGoals({ steps: 9500 }), EVENING)?.text, "You're 800 steps short of 9,500.");
    assert.equal(cardWith(close, 'within-reach', withGoals({ steps: 12000 }), EVENING), undefined, 'too far for an evening walk');

    // A record needs most of a goal day: 7,000 is tiny against 10,000, a record against 5,000.
    const quiet = syntheticDays(28, {}, { steps: 3000 });
    quiet[26].steps = 7000;
    assert.equal(cardOf(quiet, 'step-record'), undefined);
    assert.match(cardWith(quiet, 'step-record', withGoals({ steps: 5000 }))!.text, /You walked 7,000 steps on 27 July\./);
  });

  it('counts goal days in the week against the step goal', () => {
    const days = syntheticDays(28);
    assert.equal(weekSummary(days)!.steps!.atGoal, 0);
    assert.equal(weekSummary(days, withGoals({ steps: 7000 }))!.steps!.atGoal, weekSummary(days)!.steps!.days - 1,
      'every finished day but the one at 6,800');
  });

  it('judges nights against a sleep need that is set, and leaves the estimate alone otherwise', () => {
    const days = syntheticDays(28);
    assert.deepEqual(readiness(days, null), readiness(days), 'automatic is the estimate');
    const nine = readiness(days, 540);
    assert.ok(nine.score! < readiness(days).score!, 'a 9-hour need makes a 7.5-hour night short');
    assert.match(part(nine, 'Last night’s sleep')!.detail, /vs 9h 00m need/, 'a need that is set is exact, not "~"');
    assert.match(part(readiness(days), 'Last night’s sleep')!.detail, /vs ~7h 30m need/);
    assert.equal(cardWith(days, 'sleep-need', withGoals({ sleepNeed: 480 }))?.text,
      'Your sleep cards measure each night against the 8h you set on the Data tab. Your nights are usually about 7h 30m.');
    assert.equal(todaySummary(dsOf(days), MORNING, { goals: withGoals({ sleepNeed: 480 }) }).sleepTargetMin, 480);
  });
});

describe('rollup chunking against the fixture server', () => {
  it('reassembles a 62-day rollup from five chunked requests', async () => {
    const ds = await dataset();
    const steps = ds.meta.streams.find((s) => s.dataType === 'steps')!;
    assert.equal(steps.pagesFetched, 5); // ceil(62 / 14)
    assert.equal(steps.observations, 27);
    // No duplicates across chunk boundaries.
    const dates = ds.days.filter((d) => d.steps !== null).map((d) => d.date);
    assert.equal(new Set(dates).size, dates.length);
  });
});
