import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, civilFromGH, civilFromInstant, parseUtcOffsetSeconds, todayCivil } from '../../lib/date';
import { int, num, nullIf, round } from '../coerce';
import { splitWindow, MAX_ROLLUP_WINDOW_DAYS } from '../transport';
import { syncHealthData } from '../sync';
import { buildFixturePayloads, createFixtureFetch } from '../fixtures';
import { observations, recoveryTax, todaySummary } from '../insights';
import { scoreSleep } from '../sleep';
import {
  compareToBaseline, coverage, findGaps, periodShift, rollingMean, series, stats, values,
  bedtimeConsistency, currentStreak, readiness, windowShift, firstObserved, sleepRegularity, circularMeanMinutes, typicalSleepWindow,
  personalSleepNeed,
} from '../derive';
import { STREAMS } from '../registry';
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
    const hard = readiness(syntheticDays(28, { steps: 24000 }));
    const p = part(hard, 'Recent strain')!;
    assert.ok(p.contribution < 0 && p.contribution >= -7.01);
  });

  it('raises the illness flag only when several signals deviate together', () => {
    const oneOff = readiness(syntheticDays(28, { restingHr: 70 }));
    assert.equal(oneOff.flags.length, 0, 'one deviating signal is noise, not a pattern');
    const pattern = readiness(syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 }));
    assert.equal(pattern.flags.length, 1);
    assert.match(pattern.flags[0], /illness/i);
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

/** observations() only reads ds.days; a minimal dataset shell is enough. */
const dsOf = (days: ReturnType<typeof emptyRecord>[]): any => ({ days });
// Synthetic grids start 2026-07-01; 28 days end on 2026-07-28. Container TZ is
// UTC, so these Dates land in the intended daypart on the grid's last day.
const MORNING = new Date('2026-07-28T08:00:00');
const MIDDAY = new Date('2026-07-28T14:00:00');
const EVENING = new Date('2026-07-28T18:00:00');
const titles = (days: ReturnType<typeof emptyRecord>[], now: Date = MORNING) =>
  observations(dsOf(days), now).map((o) => o.title);
const byTitle = (days: ReturnType<typeof emptyRecord>[], t: string, now: Date = MORNING) =>
  observations(dsOf(days), now).find((o) => o.title === t);

describe('insight engine — stateless guards', () => {
  it('shows exactly the daypart floor card on a fully typical, unchanged month', () => {
    // Steadiness that has held all along is not news: the yesterday test
    // silences every entry rule, and the floor card carries the quiet.
    const obs = observations(dsOf(syntheticDays(28)), MORNING);
    assert.equal(obs.length, 1, obs.map((o) => o.title).join(' | '));
    assert.equal(obs[0].id, 'floor-morning');
    assert.match(obs[0].text, /No news is the good kind/);
  });

  it('fires settling-in only when the schedule tightened recently, not when it was always tight', () => {
    const days = syntheticDays(28);
    days.forEach((d, i) => { if (d.sleep) d.sleep.bedtimeMin = i < 14 ? 1290 + (i % 5) * 90 : 1380; });
    const t = titles(days);
    assert.ok(t.includes('Your nights are settling in'), t.join(' | '));
    // …and the always-steady month (previous test) stayed silent. QED.
  });

  it('reports an HRV slide once at entry, then goes quiet while it persists', () => {
    const enteredNow = syntheticDays(28);
    // Crossed the 8% threshold only in the last couple of days — a fresh entry.
    for (let i = 24; i < 28; i++) enteredNow[i].hrv = 25 + (i % 2);
    assert.ok(titles(enteredNow).includes('Recovery has been slipping'));
    assert.ok(!titles(enteredNow).includes('Your body is asking for rest'), 'trend mutes the single-night card');

    const persisting = syntheticDays(28);
    for (let i = 10; i < 28; i++) persisting[i].hrv = 25 + (i % 2);
    assert.ok(!titles(persisting).includes('Recovery has been slipping'), 'an old slide is not news');
  });

  it('flags one clearly elevated morning as an alert, escalating by trailing days', () => {
    const one = syntheticDays(28, { restingHr: 75 });
    const card1 = byTitle(one, 'Something has your heart working harder')!;
    assert.ok(card1);
    assert.ok(card1.action, 'first day carries the easy-day suggestion');

    const three = syntheticDays(28);
    for (let i = 25; i < 28; i++) three[i].restingHr = 75;
    const card3 = byTitle(three, 'Something has your heart working harder')!;
    assert.ok(card3, titles(three).join(' | '));
    assert.match(card3.text, /Third morning/);
  });

  it('the illness pattern replaces the single-signal cards', () => {
    const rough = syntheticDays(28, { restingHr: 70, resp: 17.5, tempDev: 0.8, hrv: 24 });
    const obs = observations(dsOf(rough), MORNING);
    const t = obs.map((o) => o.title);
    assert.ok(t.includes('Several signals are off at once'), t.join(' | '));
    assert.ok(!t.includes('Something has your heart working harder'));
    assert.ok(!t.includes('Your body is asking for rest'));
  });

  it('shows all qualifying watch cards past the daypart gate without arbitrary quotas', () => {
    const awful = syntheticDays(28, { restingHr: 75, hrv: 22, sleepMin: 290, tempDev: 0.7, resp: 17.5 });
    for (let i = 21; i < 28; i++) { awful[i].hrv = 23; awful[i].sleep!.minutesAsleep = 300; }
    const obs = observations(dsOf(awful), MORNING);
    assert.ok(obs.filter((o) => o.tone === 'watch').length >= 1, obs.map((o) => `${o.tone}:${o.title}`).join(' | '));
    assert.ok(obs.length >= 1);
  });

  it('merges the short night into one card with the repair-window action, escalating on the second', () => {
    const one = syntheticDays(28, { sleepMin: 300 });
    const card = byTitle(one, "Last night didn't quite deliver")!;
    assert.ok(card, titles(one).join(' | '));
    assert.match(card.action!, /repair window/);
    assert.doesNotMatch(card.text, /Second short night/);

    const two = syntheticDays(28, { sleepMin: 300 });
    two[26].sleep!.minutesAsleep = 305;
    const card2 = byTitle(two, "Last night didn't quite deliver")!;
    assert.match(card2.text, /Second short night/);
    assert.match(card2.action!, /compounding/);
  });

  it('gives wins no homework', () => {
    const days = syntheticDays(28, { sleepMin: 500 });
    days[27].sleep!.stages = { deep: 95, rem: 105, light: 290, awake: 10 };
    const card = byTitle(days, 'That was a good night')!;
    assert.ok(card, titles(days).join(' | '));
    assert.equal(card.action, undefined, 'good news never arrives with a task attached');
  });

  it('measures sleep debt against the personal need, not a hardcoded 8 hours', () => {
    const natural = syntheticDays(28, {}, { sleepMin: 405 });
    assert.equal(personalSleepNeed(natural), 420);
    assert.ok(!titles(natural).includes('Significant sleep debt accumulated'));
    const short = syntheticDays(28, {}, { sleepMin: 330 });
    assert.ok(titles(short).includes('Significant sleep debt accumulated'));
  });

  it('notices bedtime creeping later, with both clock times cited', () => {
    const days = syntheticDays(28);
    // Three fresh late nights (+90 min): the recent-7 circular mean lands
    // ~23:38 against the prior fortnight's 23:00 — past the 30-minute trigger,
    // and absent from the entry-window cut, so it still reads as news.
    for (let i = 25; i < 28; i++) days[i].sleep!.bedtimeMin = 1470;
    const card = byTitle(days, 'Bedtime has been creeping later')!;
    assert.ok(card, titles(days).join(' | '));
    assert.match(card.text, /23:38/);
    assert.match(card.text, /23:00/);
    assert.match(card.text, /minutes later/);
    assert.ok(!titles(days).includes('Your nights are settling in'));
  });

  it('fires streak milestones at exactly the milestone, silence in between', () => {
    const at3 = syntheticDays(28);
    for (let i = 25; i < 28; i++) at3[i].steps = 11000;
    assert.ok(titles(at3).includes("You're on a rolling streak"));

    const at4 = syntheticDays(28);
    for (let i = 24; i < 28; i++) at4[i].steps = 11000;
    assert.ok(!titles(at4).includes("You're on a rolling streak"), '4 is not a milestone');
  });

  it('declares records only on completed days above a floor', () => {
    const days = syntheticDays(28);
    days[26].steps = 24000;
    const card = byTitle(days, 'Setting a new pace')!;
    assert.ok(card);
    assert.match(card.text, /24,000/);

    const tiny = syntheticDays(28, {}, { steps: 3000 });
    tiny[26].steps = 7000;
    assert.ok(!titles(tiny).includes('Setting a new pace'));
  });

  it('gates today-cards by daypart and expiry', () => {
    // Within reach: only in the evening, only when close.
    const close = syntheticDays(28, { steps: 8700 });
    assert.ok(titles(close, EVENING).includes('Within reach'));
    assert.ok(!titles(close, MORNING).includes('Within reach'));

    // Slow day: only past 13:00, and never two low days running.
    const slow = syntheticDays(28, { steps: 1500 });
    assert.ok(titles(slow, MIDDAY).includes('A quiet start to the day'), titles(slow, MIDDAY).join(' | '));
    assert.ok(!titles(slow, new Date('2026-07-28T09:00:00')).includes('A quiet start to the day'));
    const slowTwice = syntheticDays(28, { steps: 1500 });
    slowTwice[26].steps = 1200;
    assert.ok(!titles(slowTwice, MIDDAY).includes('A quiet start to the day'), 'never nags twice running');
  });

  it('offers the wind-down only when debt or drift earned it', () => {
    const indebted = syntheticDays(28, {}, { sleepMin: 330 });
    const card = byTitle(indebted, 'Wind-down window', EVENING)!;
    assert.ok(card, titles(indebted, EVENING).join(' | '));
    assert.match(card.text, /short of your/);
    assert.ok(card.action);

    const fine = syntheticDays(28);
    assert.ok(!titles(fine, EVENING).includes('Wind-down window'));
  });

  it('reports weight direction without judgement, and only on a fresh reading', () => {
    const down = syntheticDays(28);
    down[0].weightKg = 90; down[10].weightKg = 89; down[26].weightKg = 87.8;
    const card = byTitle(down, 'Your weight is trending down')!;
    assert.ok(card, titles(down).join(' | '));
    assert.equal(card.tone, 'neutral');

    const staleReadings = syntheticDays(28);
    staleReadings[0].weightKg = 90; staleReadings[5].weightKg = 89; staleReadings[22].weightKg = 87.8;
    assert.ok(!titles(staleReadings).includes('Your weight is trending down'), 'no new reading, no card');
  });

  it('crosses the WHO weekly bar on the crossing day', () => {
    // 2026-07-28 is a Tuesday: the week holds Mon 27 + Tue 28.
    const days = syntheticDays(28);
    days[26].activeMinutes = { light: 20, moderate: 70, vigorous: 10 }; // Mon: 80
    days[27].activeMinutes = { light: 20, moderate: 60, vigorous: 15 }; // Tue: +75 → 155 crosses
    const card = byTitle(days, 'A benchmark week')!;
    assert.ok(card, titles(days).join(' | '));
    assert.match(card.text, /brisk minutes/);
    assert.match(card.text, /days to spare/);
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

  it('keeps every card checkable on real data: figures, ids', async () => {
    const ds = await dataset();
    const obs = observations(ds as any, new Date('2026-08-19T08:00:00'));
    assert.ok(obs.length >= 1, `got ${obs.length}`);
    for (const o of obs) {
      assert.ok(o.id.length > 0 && o.title.length > 0);
      assert.ok(/\d/.test(o.text), `"${o.title}" must cite at least one figure: ${o.text}`);
    }
    const s = todaySummary(ds as any, new Date('2026-08-19T08:00:00'));
    assert.ok(Array.isArray(s.observations));
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
