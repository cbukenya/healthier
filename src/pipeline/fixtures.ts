import { addDays, ghDateFromCivil, type CivilDate } from '../lib/date';
import type { FetchLike } from './transport';
import { HYPNOGRAM, SHORT_AWAKENINGS, parseFixtureSeries, type FixtureDay } from './series';

/**
 * Turns the packed series into payloads shaped exactly like Google Health v4
 * responses, then serves them through a fake `fetch`.
 *
 * This is the single most useful piece of infrastructure in the rebuild. It means:
 *
 *   - tests run the *real* pipeline — transport, registry, normaliser, derivations —
 *     with no network and no OAuth, so a renamed field fails a test rather than
 *     quietly rendering a flat line;
 *   - demo mode is not a separate mock UI with hardcoded props, it's the actual app
 *     with the actual pipeline in front of it;
 *   - the awkward cases are reproducible on purpose: string-encoded integers, a
 *     literal `"NaN"` baseline, `vo2Max: 0` before calibration, newest-first
 *     ordering, `nextPageToken` pagination, a nap mixed in with the nights, two
 *     devices reporting the same SpO₂ day, and a dataType that returns HTTP 400.
 */

const OFF = '7200s'; // Europe/Stockholm, CEST

/**
 * When and where the fixture was exported. Demo mode runs on this clock, in this zone, so it shows the
 * same window and the same insights wherever and whenever it's opened.
 */
export const FIXTURE_CLOCK: { readonly now: Date; readonly timeZone: string } = {
  now: new Date('2026-08-19T01:39:00+02:00'),
  timeZone: 'Europe/Stockholm',
};

const FITBIT = { recordingMethod: 'DERIVED', device: { displayName: 'Google Fitbit Air' }, platform: 'FITBIT' };
const FITBIT_PASSIVE = { recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Google Fitbit Air' }, platform: 'FITBIT' };
const FITBIT_MANUAL = { recordingMethod: 'MANUAL', platform: 'FITBIT' };
const SAMSUNG = { recordingMethod: 'UNKNOWN', device: {}, application: { packageName: 'com.sec.android.app.shealth' }, platform: 'HEALTH_CONNECT' };
const OURA = { recordingMethod: 'MANUAL', device: { formFactor: 'RING' }, application: { packageName: 'com.ouraring.oura' }, platform: 'HEALTH_CONNECT' };

/** The API returns points newest-first. Reversing here keeps that honest. */
export const newestFirst = <T>(a: T[]): T[] => a.slice().reverse();

export const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
/** Local wall-clock on a civil date → UTC instant, given a +2h offset. */
const utcFromLocal = (date: CivilDate, hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 120) * 60_000;
};

export const rollupPoint = (date: CivilDate, container: string, payload: unknown) => ({
  civilStartTime: { date: ghDateFromCivil(date), time: {} },
  civilEndTime: { date: ghDateFromCivil(addDays(date, 1)), time: {} },
  [container]: payload,
});
export const listPoint = (dataSource: unknown, container: string, payload: unknown) => ({
  dataSource,
  [container]: payload,
});
export const sampleTime = (isoStr: string, date: CivilDate, offset = OFF) => ({
  physicalTime: isoStr,
  utcOffset: offset,
  civilTime: { date: ghDateFromCivil(date), time: { hours: 12 } },
});

export interface FixturePayloads {
  [key: string]: any;
}

export function buildFixturePayloads(days: FixtureDay[] = parseFixtureSeries()): FixturePayloads {
  const out: FixturePayloads = {};
  const have = <K extends keyof FixtureDay>(k: K) => days.filter((d) => d[k] !== null);

  // ── movement rollups. Note the string-encoded int64s and mm units.
  out['steps'] = {
    rollupDataPoints: newestFirst(
      have('steps').map((d) => rollupPoint(d.date, 'steps', { countSum: String(d.steps) })),
    ),
  };
  out['distance'] = {
    rollupDataPoints: newestFirst(
      have('distanceKm').map((d) =>
        rollupPoint(d.date, 'distance', { millimetersSum: String(Math.round(d.distanceKm! * 1_000_000)) }),
      ),
    ),
  };
  out['active-minutes'] = {
    rollupDataPoints: newestFirst(
      have('activeMinutes').map((d) =>
        rollupPoint(d.date, 'activeMinutes', {
          activeMinutesRollupByActivityLevel: (
            [
              ['LIGHT', d.activeMinutes![0]],
              ['MODERATE', d.activeMinutes![1]],
              ['VIGOROUS', d.activeMinutes![2]],
            ] as const
          )
            .filter(([, v]) => v > 0)
            .map(([activityLevel, v]) => ({ activityLevel, activeMinutesSum: String(v) })),
        }),
      ),
    ),
  };
  out['active-zone-minutes'] = {
    rollupDataPoints: newestFirst(
      have('activeMinutes').map((d) =>
        rollupPoint(d.date, 'activeZoneMinutes', {
          sumInCardioHeartZone: String(Math.round(d.activeMinutes![2] * 0.14)),
          sumInPeakHeartZone: '0',
          sumInFatBurnHeartZone: String(
            Math.round(d.activeMinutes![1] * 0.6 + d.activeMinutes![2] * 0.25),
          ),
        }),
      ),
    ),
  };
  out['total-calories'] = {
    rollupDataPoints: newestFirst(
      have('totalKcal').map((d) => rollupPoint(d.date, 'totalCalories', { kcalSum: d.totalKcal! + 0.412 })),
    ),
  };
  out['active-energy-burned'] = {
    rollupDataPoints: newestFirst(
      have('activeKcal').map((d) =>
        rollupPoint(d.date, 'activeEnergyBurned', { kcalSum: d.activeKcal! + 0.318 }),
      ),
    ),
  };

  // Streams that exist but hold nothing — a 200 with an empty array, which must
  // read as "never logged", not as an error.
  out['floors'] = { rollupDataPoints: [] };
  out['hydration-log'] = { rollupDataPoints: [] };
  out['blood-glucose'] = { rollupDataPoints: [] };

  // ── daily vitals
  out['daily-resting-heart-rate'] = {
    dataPoints: newestFirst(
      have('restingHr').map((d) =>
        listPoint(FITBIT, 'dailyRestingHeartRate', {
          date: ghDateFromCivil(d.date),
          beatsPerMinute: String(d.restingHr), // string, not number
          dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' },
        }),
      ),
    ),
  };
  // Each day's heart rate zones, set from that day's resting heart rate the Karvonen way: a share of
  // the reserve between it and a maximum of 220 − 41 (the demo person's age). Like Google's, Light
  // starts at a floor of 30 bpm.
  out['daily-heart-rate-zones'] = {
    dataPoints: newestFirst(
      have('restingHr').map((d) => {
        const rest = d.restingHr!;
        const max = 220 - 41;
        const at = (share: number) => Math.round(rest + share * (max - rest));
        const zone = (heartRateZoneType: string, min: number, to: number | null) => ({
          heartRateZoneType,
          minBeatsPerMinute: String(min),
          maxBeatsPerMinute: String(to === null ? max : at(to) - 1),
        });
        return listPoint(FITBIT, 'dailyHeartRateZones', {
          date: ghDateFromCivil(d.date),
          heartRateZones: [zone('LIGHT', 30, 0.4), zone('MODERATE', at(0.4), 0.6), zone('VIGOROUS', at(0.6), 0.85), zone('PEAK', at(0.85), null)],
        });
      }),
    ),
  };
  out['daily-heart-rate-variability'] = {
    dataPoints: newestFirst(
      have('hrv').map((d) =>
        listPoint(FITBIT, 'dailyHeartRateVariability', {
          date: ghDateFromCivil(d.date),
          averageHeartRateVariabilityMilliseconds: d.hrv,
          nonRemHeartRateBeatsPerMinute: String((d.restingHr ?? 63) + 1),
          entropy: Math.round((2.4 + d.hrv! / 100) * 1000) / 1000,
          deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds:
            Math.round((d.hrv! * 0.98 + 2) * 10) / 10,
        }),
      ),
    ),
  };
  out['daily-oxygen-saturation'] = {
    dataPoints: [
      ...newestFirst(
        have('spo2').map((d) =>
          listPoint(FITBIT_PASSIVE, 'dailyOxygenSaturation', {
            date: ghDateFromCivil(d.date),
            averagePercentage: d.spo2![0],
            lowerBoundPercentage: d.spo2![1],
            upperBoundPercentage: d.spo2![2],
            standardDeviationPercentage: 0.8,
          }),
        ),
      ),
      // A second device reporting the same day with no real envelope (lo == hi).
      // The registry must keep the Fitbit reading, not the last one it sees.
      listPoint(SAMSUNG, 'dailyOxygenSaturation', {
        date: ghDateFromCivil('2026-07-21'),
        averagePercentage: 95,
        lowerBoundPercentage: 95,
        upperBoundPercentage: 95,
        standardDeviationPercentage: 0.5,
      }),
    ],
  };
  out['daily-respiratory-rate'] = {
    dataPoints: newestFirst(
      have('respiratoryRate').map((d) =>
        listPoint(FITBIT, 'dailyRespiratoryRate', {
          date: ghDateFromCivil(d.date),
          breathsPerMinute: d.respiratoryRate,
        }),
      ),
    ),
  };
  out['daily-sleep-temperature-derivations'] = {
    dataPoints: newestFirst(
      have('tempDeviation').map((d, i) =>
        listPoint(FITBIT, 'dailySleepTemperatureDerivations', {
          date: ghDateFromCivil(d.date),
          nightlyTemperatureCelsius: Math.round((35 + d.tempDeviation!) * 1000) / 1000,
          // The literal string "NaN" until the 30-night baseline exists.
          baselineTemperatureCelsius: i < 2 ? 'NaN' : 35,
          relativeNightlyStddev30dCelsius: i < 2 ? 'NaN' : 0.332,
        }),
      ),
    ),
  };

  // VO₂max: a real step change, plus pre-calibration days reporting 0.
  const vo2 = days.map((d) => {
    const v = d.date < '2026-07-27' ? 35.379612 : 40.148982;
    return listPoint(FITBIT, 'dailyVo2Max', {
      date: ghDateFromCivil(d.date),
      vo2Max: v,
      cardioFitnessLevel: v < 36.5 ? 'FAIR' : 'AVERAGE',
      vo2MaxCovariance: 2.46,
    });
  });
  for (const d of ['2026-06-10', '2026-06-12', '2026-06-14', '2026-06-16']) {
    vo2.unshift(
      listPoint(FITBIT, 'dailyVo2Max', {
        date: ghDateFromCivil(d),
        vo2Max: 0,
        cardioFitnessLevel: 'POOR',
        vo2MaxCovariance: 0.15,
      }),
    );
  }
  out['daily-vo2-max'] = { dataPoints: newestFirst(vo2) };

  // ── body: hand-logged, sparse, three different apps
  out['weight'] = {
    dataPoints: [
      listPoint(FITBIT_MANUAL, 'weight', { sampleTime: sampleTime('2026-07-07T10:24:36Z', '2026-07-07'), weightGrams: 108000 }),
      listPoint(SAMSUNG, 'weight', { sampleTime: sampleTime('2026-06-16T21:16:17Z', '2026-06-16'), weightGrams: 109699 }),
      listPoint(SAMSUNG, 'weight', { sampleTime: sampleTime('2026-06-03T17:51:52Z', '2026-06-03'), weightGrams: 112000 }),
      listPoint(FITBIT_MANUAL, 'weight', { sampleTime: sampleTime('2026-05-21T05:22:05Z', '2026-05-21'), weightGrams: 114000 }),
      listPoint(OURA, 'weight', { sampleTime: sampleTime('2026-02-26T16:15:08Z', '2026-02-26', '3600s'), weightGrams: 110000 }),
    ],
  };
  out['body-fat'] = {
    dataPoints: [
      listPoint(FITBIT_MANUAL, 'bodyFat', {
        sampleTime: sampleTime('2026-07-07T10:24:36Z', '2026-07-07'),
        percentage: 39.1,
      }),
      listPoint(SAMSUNG, 'bodyFat', {
        sampleTime: sampleTime('2026-06-16T21:16:17Z', '2026-06-16'),
        percentage: 39.8,
      }),
      listPoint(SAMSUNG, 'bodyFat', {
        sampleTime: sampleTime('2026-06-03T17:51:52Z', '2026-06-03'),
        percentage: 40.56782531738281,
      }),
      listPoint(FITBIT_MANUAL, 'bodyFat', {
        sampleTime: sampleTime('2026-05-21T05:22:05Z', '2026-05-21'),
        percentage: 41.2,
      }),
    ],
  };
  out['height'] = {
    dataPoints: [
      listPoint(FITBIT_MANUAL, 'height', {
        sampleTime: sampleTime('2026-05-21T05:22:05Z', '2026-05-21'),
        heightMillimeters: '1750',
      }),
    ],
  };

  // ── sleep sessions, newest-first, with one nap in the middle
  const sleepPoints = days
    .filter((d) => d.sleep)
    .map((d) => {
      const sl = d.sleep!;
      const bedHour = Number(sl.bedtime.split(':')[0]);
      // A bedtime before noon belongs to the morning you woke; otherwise last evening.
      const bedDate = bedHour < 12 ? d.date : addDays(d.date, -1);
      const startT = utcFromLocal(bedDate, sl.bedtime);
      const endT = utcFromLocal(d.date, sl.wake);
      const isLastNight = d.date === '2026-08-18';
      return listPoint(FITBIT, 'sleep', {
        interval: {
          startTime: iso(startT), startUtcOffset: OFF,
          endTime: iso(endT), endUtcOffset: OFF,
        },
        type: 'STAGES',
        stages: isLastNight ? buildStages(startT) : [],
        metadata: { stagesStatus: 'SUCCEEDED', processed: true, mainSleep: true },
        summary: {
          minutesInSleepPeriod: String(sl.asleep + sl.awake),
          minutesAfterWakeUp: '0',
          minutesToFallAsleep: '0',
          minutesAsleep: String(sl.asleep),
          minutesAwake: String(sl.awake),
          stagesSummary: [
            { type: 'AWAKE', minutes: String(sl.awake), count: '1' },
            { type: 'LIGHT', minutes: String(sl.light), count: '9' },
            { type: 'DEEP', minutes: String(sl.deep), count: '3' },
            { type: 'REM', minutes: String(sl.rem), count: '5' },
          ],
        },
        shortAwakenings: isLastNight
          ? SHORT_AWAKENINGS.map((m) => ({
              startTime: iso(startT + m * 60_000), startUtcOffset: OFF,
              endTime: iso(startT + m * 60_000 + 30_000), endUtcOffset: OFF,
              type: 'AWAKE',
            }))
          : [],
      });
    });

  // The 25-minute afternoon nap that the old build presented as "last night".
  sleepPoints.push(
    listPoint(FITBIT, 'sleep', {
      interval: {
        startTime: '2026-08-09T21:44:00Z', startUtcOffset: OFF,
        endTime: '2026-08-09T22:22:00Z', endUtcOffset: OFF,
      },
      type: 'STAGES',
      stages: [],
      metadata: { stagesStatus: 'SUCCEEDED', processed: true, nap: true },
      summary: {
        minutesInSleepPeriod: '38', minutesAsleep: '25', minutesAwake: '13',
        stagesSummary: [
          { type: 'AWAKE', minutes: '13', count: '1' },
          { type: 'LIGHT', minutes: '25', count: '1' },
        ],
      },
      shortAwakenings: [],
    }),
  );
  out['sleep'] = { dataPoints: newestFirst(sleepPoints) };

  // ── intraday heart rate: ~45 min of raw 3 s samples, paged newest-first.
  // The sync never lists these; the fixture server rolls them up on request.
  const hr: any[] = [];
  const hrBase = Date.parse('2026-08-18T21:00:00Z');
  for (let i = 0; i < 900; i++) {
    const t = hrBase + i * 3000;
    let bpm = Math.round(60 + 4 * Math.sin(i / 40) + 1.5 * Math.sin(i / 7));
    // Add tachycardia spike between 400 and 650 (250 * 3s = 750s = 12.5 mins)
    if (i >= 400 && i <= 650) {
      bpm = 115 + Math.random() * 5;
    }
    hr.push(
      listPoint(FITBIT_PASSIVE, 'heartRate', {
        sampleTime: { physicalTime: iso(t), utcOffset: OFF, civilTime: { date: ghDateFromCivil('2026-08-18'), time: { hours: 23 } } },
        beatsPerMinute: String(bpm),
      }),
    );
  }
  // ── and three days of it a minute at a time, ending at the demo clock, so the heart rate chart
  // has days to move through: nights asleep, walks to work, a hike, a gym session, a lunchtime run
  // and a ride home, with the watch off for a shower each morning. Made up, deterministically.
  const minuteHr: any[] = [];
  const dayEnd = FIXTURE_CLOCK.now.getTime();
  const minuteStart = dayEnd - 3 * 24 * 60 * 60_000;
  const rawSpan = [hrBase, hrBase + 900 * 3000];
  for (let t = Math.ceil(minuteStart / 60_000) * 60_000 + 30_000; t < dayEnd; t += 60_000) {
    if (t >= rawSpan[0] && t < rawSpan[1]) continue;
    const local = new Date(t + 2 * 3_600_000);
    const date = local.toISOString().slice(0, 10);
    const h = local.getUTCHours() + local.getUTCMinutes() / 60;
    const i = Math.round(t / 60_000);
    const wobble = Math.sin(i * 12.9898) * 43758.5453;
    const noise = (wobble - Math.floor(wobble) - 0.5) * 7;
    let base: number | null;
    if (h >= 23.75 || h < 6.9) base = 57 + 3 * Math.sin(i / 37);
    else if (h < 7.5) base = 64 + (h - 6.9) * 18;
    else if (h < 7.75) base = null;
    else if (h < 8.4) base = 76 + 4 * Math.sin(i / 7);
    else if (h < 9.1) base = date === '2026-08-16' ? 82 + 5 * Math.sin(i / 9) : 103 + 5 * Math.sin(i / 5);
    else if (date === '2026-08-18' && h >= 12.2 && h < 12.85) base = 120 + 46 * Math.sin(Math.PI * Math.min(1, ((h - 12.2) / 0.65) * 1.1));
    else if (date === '2026-08-18' && h >= 12.85 && h < 13.4) base = 96 - (h - 12.85) * 30;
    else if (date === '2026-08-16' && h >= 13 && h < 15.2) base = 108 + 9 * Math.sin(i / 13);
    else if (date === '2026-08-18' && h >= 17.6 && h < 18.3) base = 116 + 15 * Math.sin(i / 8);
    else if (date === '2026-08-17' && h >= 18.5 && h < 19.25) base = 112 + 38 * Math.max(0, Math.sin(i / 3));
    else if (h < 17.6) base = 77 + 8 * Math.sin(i / 41);
    else if (h < 22.9) base = 71 + 5 * Math.sin(i / 29);
    else base = 64 - (h - 22.9) * 6;
    if (base === null) continue;
    minuteHr.push(
      listPoint(FITBIT_PASSIVE, 'heartRate', {
        sampleTime: { physicalTime: iso(t), utcOffset: OFF },
        beatsPerMinute: String(Math.round(base + noise)),
      }),
    );
  }

  const desc = [...hr, ...minuteHr].sort((a, b) =>
    Date.parse(b.heartRate.sampleTime.physicalTime) - Date.parse(a.heartRate.sampleTime.physicalTime));
  const pages = Math.ceil(desc.length / 300);
  for (let p = 0; p < pages; p++) {
    out[p === 0 ? 'heart-rate' : `heart-rate:PAGE_${p + 1}`] = {
      dataPoints: desc.slice(p * 300, (p + 1) * 300),
      ...(p + 1 < pages ? { nextPageToken: `PAGE_${p + 2}` } : {}),
    };
  }

  
  // ── IRN: Irregular rhythm notifications
  out['irregular-rhythm-notification'] = {
    dataPoints: [
      listPoint(FITBIT_PASSIVE, 'irregularRhythmNotification', {
        sampleTime: sampleTime('2026-08-10T02:15:00Z', '2026-08-10'),
      }),
      listPoint(FITBIT_PASSIVE, 'irregularRhythmNotification', {
        sampleTime: sampleTime('2026-07-22T04:30:00Z', '2026-07-22'),
      })
    ]
  };
  return out;
}

function buildStages(startT: number) {
  let t = startT;
  return HYPNOGRAM.map(([stage, dur]) => {
    const s = t;
    t += dur * 60_000;
    return {
      startTime: iso(s), startUtcOffset: OFF,
      endTime: iso(t), endUtcOffset: OFF,
      type: stage.toUpperCase(),
    };
  });
}

/**
 * A `fetch` that serves the fixtures. Honours the real URL shapes, so the
 * transport's chunking, pagination and error handling all get exercised.
 */
export function createFixtureFetch(
  payloads: FixturePayloads = buildFixturePayloads(),
  opts: { latencyMs?: number } = {},
): FetchLike {
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'https://health.googleapis.com');
    // The account profile: the demo person's age.
    if (u.pathname.endsWith('/profile')) return json({ name: 'users/me/profile', age: 41 });
    const m = u.pathname.match(/dataTypes\/([^/]+)\/dataPoints/);
    const dataType = m?.[1] ?? '';
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));

    const entry = payloads[dataType];
    if (!entry) return json({ error: { code: 404, message: `Unknown dataType ${dataType}`, status: 'NOT_FOUND' } }, 404);
    if (entry.__httpError) return new Response(entry.__httpError.body, { status: entry.__httpError.status });

    const isRollup = u.pathname.endsWith(':dailyRollUp');
    if (isRollup) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const start = fromGh(body?.range?.start?.date);
      const end = fromGh(body?.range?.end?.date); // exclusive
      const points = (entry.rollupDataPoints ?? []).filter((p: any) => {
        const d = fromGh(p.civilStartTime?.date);
        return d && (!start || d >= start) && (!end || d < end);
      });
      return json({ rollupDataPoints: points });
    }

    if (u.pathname.endsWith(':rollUp')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (entry.minutes) return json(rollUpMinutes(entry.minutes, body));
      return json(rollUpWindows(allListPoints(payloads, dataType), body));
    }

    const token = u.searchParams.get('pageToken');
    const pageSize = Number(u.searchParams.get('pageSize') ?? 1000);
    // A fixture without a page chain of its own is paged by offset, like a long list from the API.
    if (!entry.nextPageToken && (!token || /^\d+$/.test(token))) {
      const offset = Number(token ?? 0);
      const points = entry.dataPoints ?? [];
      return json({
        dataPoints: points.slice(offset, offset + pageSize),
        ...(offset + pageSize < points.length ? { nextPageToken: String(offset + pageSize) } : {}),
      });
    }
    const page = token ? payloads[`${dataType}:${token}`] : entry;
    if (!page) return json({ dataPoints: [] });
    return json({
      dataPoints: (page.dataPoints ?? []).slice(0, pageSize),
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
    });
  };
}

/** Every raw point of a list fixture, across its page chain. */
function allListPoints(payloads: FixturePayloads, dataType: string): any[] {
  const out: any[] = [];
  let page = payloads[dataType];
  while (page) {
    out.push(...(page.dataPoints ?? []));
    page = page.nextPageToken ? payloads[`${dataType}:${page.nextPageToken}`] : undefined;
  }
  return out;
}

/**
 * The `rollUp` contract for heart rate: fixed UTC windows over [startTime,
 * endTime), newest first, empty windows omitted, paged by offset.
 */
function rollUpWindows(points: any[], body: any) {
  const start = Date.parse(body?.range?.startTime);
  const end = Date.parse(body?.range?.endTime);
  const windowMs = parseFloat(body?.windowSize) * 1000;
  const buckets = new Map<number, number[]>();
  for (const dp of points) {
    const t = Date.parse(dp?.heartRate?.sampleTime?.physicalTime);
    const bpm = Number(dp?.heartRate?.beatsPerMinute);
    if (!(t >= start && t < end) || !Number.isFinite(bpm)) continue;
    const key = start + Math.floor((t - start) / windowMs) * windowMs;
    const list = buckets.get(key) ?? [];
    list.push(bpm);
    buckets.set(key, list);
  }
  const all = [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, v]) => ({
      startTime: new Date(key).toISOString(),
      endTime: new Date(Math.min(key + windowMs, end)).toISOString(),
      heartRate: {
        beatsPerMinuteAvg: v.reduce((a, b) => a + b, 0) / v.length,
        beatsPerMinuteMin: Math.min(...v),
        beatsPerMinuteMax: Math.max(...v),
      },
    }));
  const offset = Number(body?.pageToken ?? 0);
  const size = Number(body?.pageSize ?? 1440);
  return {
    rollupDataPoints: all.slice(offset, offset + size),
    ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {}),
  };
}

/** Minute heart rate held compactly: each minute's start and its bpm, oldest first. */
export interface MinuteSeries {
  t: Float64Array;
  bpm: Uint8Array;
}

/** The same `rollUp` contract as rollUpWindows, over a compact minute series instead of raw samples. */
function rollUpMinutes(series: MinuteSeries, body: any) {
  const start = Date.parse(body?.range?.startTime);
  const end = Date.parse(body?.range?.endTime);
  const windowMs = parseFloat(body?.windowSize) * 1000;
  const first = (time: number) => {
    let a = 0;
    let b = series.t.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (series.t[m] < time) a = m + 1;
      else b = m;
    }
    return a;
  };
  const windows: { startTime: string; endTime: string; heartRate: { beatsPerMinuteAvg: number; beatsPerMinuteMin: number; beatsPerMinuteMax: number } }[] = [];
  let i = first(start);
  const stop = first(end);
  while (i < stop) {
    const key = start + Math.floor((series.t[i] - start) / windowMs) * windowMs;
    let sum = 0;
    let n = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (; i < stop && series.t[i] < key + windowMs; i++) {
      const v = series.bpm[i];
      sum += v;
      n++;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    windows.push({
      startTime: new Date(key).toISOString(),
      endTime: new Date(Math.min(key + windowMs, end)).toISOString(),
      heartRate: { beatsPerMinuteAvg: sum / n, beatsPerMinuteMin: lo, beatsPerMinuteMax: hi },
    });
  }
  windows.reverse();
  const offset = Number(body?.pageToken ?? 0);
  const size = Number(body?.pageSize ?? 1440);
  return {
    rollupDataPoints: windows.slice(offset, offset + size),
    ...(offset + size < windows.length ? { nextPageToken: String(offset + size) } : {}),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fromGh = (d: any): CivilDate | null =>
  d?.year ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null;

export { parseFixtureSeries };
export type { FixtureDay };
