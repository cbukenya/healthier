import { addDays, daysBetween, isoWeekdayIndex, startOfCivilDay, type CivilDate } from '../lib/date';
import {
  buildFixturePayloads, iso, listPoint, newestFirst, rollupPoint, sampleTime, type FixtureDay, type FixturePayloads,
  type MinuteSeries,
} from './fixtures';

/**
 * The demo person: a year of made-up data from a watch and a scale, built so demo mode shows what
 * the app does. Every number is invented, from a seeded generator, so the demo is the same on
 * every device and every run; none of it comes from a real person.
 *
 * Over the year they get a little fitter and a little lighter: resting heart rate drifts down,
 * HRV up, cardio fitness steps up, and the scale goes down slowly, nearly all of it fat. The last
 * weeks hold the things the app looks for:
 *
 *   - a busy week of short nights before a good one, so sleep debt and a good night meet;
 *   - bedtimes creeping later over the last fortnight;
 *   - a fortnight of more walking than usual, and a long hike that's the biggest day of the year;
 *   - a few nights with oxygen, breathing and time awake off together, which the Labs breathing
 *     card watches for, and stretches of fast heart rate in some of them;
 *   - minute heart rate for the whole 62-day window: commutes, runs, hikes, nights asleep, and a
 *     run yesterday evening, so the last 24 hours climb through the zones.
 *
 * It goes through buildFixturePayloads and the fixture server like the test data, so demo mode
 * runs the real pipeline on it, end to end, history backfill included.
 */

/** Monday morning, so Today has a week to review. */
export const DEMO_CLOCK: { readonly now: Date; readonly timeZone: string } = {
  now: new Date('2026-10-12T07:40:00+02:00'),
  timeZone: 'Europe/Stockholm',
};

/** Days of history the demo holds, so the 90-day, 1-year and All views have something to show. */
export const DEMO_DAYS = 400;

const TODAY: CivilDate = '2026-10-12';
const AGE = 41;
const MAX_HR = 220 - AGE;

const WATCH = { recordingMethod: 'DERIVED', device: { displayName: 'Google Fitbit Air' }, platform: 'FITBIT' };
const WATCH_PASSIVE = { recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Google Fitbit Air' }, platform: 'FITBIT' };
const SCALE = { recordingMethod: 'PASSIVELY_MEASURED', device: { displayName: 'Smart scale', formFactor: 'SCALE' }, platform: 'FITBIT' };

/** A small seeded generator (mulberry32): the same numbers on every run. */
function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Roughly normal: mean 0, spread about `sd`. */
  const normal = (sd = 1) => (next() + next() + next() + next() - 2) * sd * 1.7;
  return { next, normal, chance: (p: number) => next() < p };
}

const round = (v: number, digits = 0) => Math.round(v * 10 ** digits) / 10 ** digits;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hhmm = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Local midnight on a date, as a UTC instant: worked out once a date, since minute heart rate asks often. */
const midnights = new Map<CivilDate, number>();
const midnight = (date: CivilDate) => {
  let at = midnights.get(date);
  if (at === undefined) midnights.set(date, (at = startOfCivilDay(date, DEMO_CLOCK.timeZone)));
  return at;
};
/** The zone's offset on a date, as Google sends it ("7200s"), from local midnight. */
const offsetOn = (date: CivilDate) => `${Math.round((Date.parse(`${date}T00:00:00Z`) - midnight(date)) / 1000)}s`;
/** A wall-clock time on a date, as the UTC instant it was. */
const instant = (date: CivilDate, minutesOfDay: number) => midnight(date) + minutesOfDay * 60_000;

/** What each day held, beyond the columns the test fixture has. */
interface DemoDay extends FixtureDay {
  floors: number | null;
  /** Minutes past midnight of the evening before (may pass 24 h), and of the morning. */
  bed: number | null;
  wake: number | null;
  /** A nap's start, minutes past midnight, and its length. */
  nap: { at: number; minutes: number } | null;
  /** Nights the Labs breathing card should see: oxygen, breathing and time awake off together. */
  rough: boolean;
  workout: 'run' | 'hike' | null;
  weight: number | null;
  bodyFat: number | null;
}

/** Every day of the demo, oldest first, ending today with the morning so far. */
function demoDays(): DemoDay[] {
  const r = seeded(20261012);
  const first = addDays(TODAY, -(DEMO_DAYS - 1));
  const out: DemoDay[] = [];
  // Nights the watch was on its charger, and a weekend away from the scale.
  const charging = new Set([addDays(TODAY, -201), addDays(TODAY, -133), addDays(TODAY, -77), addDays(TODAY, -38)]);
  const rough = new Set([3, 6, 9, 12].map((n) => addDays(TODAY, -n)));
  const hike = addDays(TODAY, -4);
  for (let i = 0; i < DEMO_DAYS; i++) {
    const date = addDays(first, i);
    const ago = daysBetween(date, TODAY);
    const progress = i / (DEMO_DAYS - 1); // 0 a year ago, 1 today
    const wd = isoWeekdayIndex(date); // 0 Monday … 6 Sunday
    const month = Number(date.slice(5, 7));
    const winter = month === 12 || month <= 2;

    // ── movement: weekdays to work and back, longer weekends, runs on Tuesday and Thursday.
    let workout: DemoDay['workout'] = date === hike || (wd === 5 && r.chance(0.35)) ? 'hike' : (wd === 1 || wd === 3) && r.chance(0.85) ? 'run' : null;
    if (ago === 1) workout = 'run'; // yesterday evening, so the last 24 hours of heart rate cross the zones
    let steps = wd <= 4 ? 8600 : wd === 5 ? 11000 : 7400;
    if (winter) steps *= 0.86;
    if (ago < 14) steps *= 1.18; // the last fortnight, more walking than usual
    if (workout === 'run') steps += 3800;
    if (workout === 'hike') steps = 16000 + r.next() * 5000;
    steps = Math.max(1200, Math.round(steps * (1 + r.normal(0.12))));
    if (date === hike) steps = 27412; // the biggest day of the year
    const vigorous = workout === 'run' ? round(32 + r.normal(5)) : workout === 'hike' ? round(28 + r.normal(8)) : Math.max(0, round(r.normal(3)));
    const moderate = Math.max(0, round((workout === 'hike' ? 70 : 16) + r.normal(7)));
    const light = Math.max(40, round(170 + steps / 120 + r.normal(25)));
    const activeKcal = round(steps * 0.042 + vigorous * 7 + moderate * 3);
    const floors = Math.max(0, round((workout === 'hike' ? 55 : 9) + r.normal(3)));

    // ── sleep: about 7h20 a night, later at weekends, a short busy week before a good last night.
    const weekendNight = wd === 5 || wd === 6; // the nights into Saturday and Sunday
    let bed = (weekendNight ? 24 * 60 + 20 : 23 * 60 + 5) + r.normal(22);
    if (ago < 14) bed += (14 - ago) * 4.5; // creeping later over the fortnight
    let asleep = 440 + r.normal(26);
    if (ago >= 1 && ago <= 7) asleep = 362 + r.normal(14);
    if (ago === 0) asleep = 478;
    const awake = Math.max(8, round((rough.has(date) ? 58 : 28) + r.normal(8)));
    const deep = round(asleep * (0.16 + r.normal(0.02)));
    const rem = round(asleep * (0.21 + r.normal(0.025)));
    asleep = round(asleep);
    const wake = bed + asleep + awake - 24 * 60;
    const slept = !charging.has(date);

    // ── overnight vitals: fitter over the year, a dip in HRV in the short week.
    const rhr = round(62.5 - 4.5 * progress + (ago >= 1 && ago <= 7 ? 1.4 : 0) + r.normal(1.1));
    let hrv = 43 + 6 * progress + r.normal(3.2);
    if (ago >= 1 && ago <= 6) hrv *= 0.86;
    const breathing = round(14.4 + r.normal(0.35) + (rough.has(date) ? 1.5 : 0), 1);
    const spo2avg = round((rough.has(date) ? 93.6 : 95.6) + r.normal(0.35), 1);
    const temp = round(r.normal(0.14), 2);

    // ── the scale: most mornings, slowly down, body fat on the days it reads it.
    const weighs = (wd === 0 || wd === 2 || wd === 4 || wd === 6) && r.chance(0.82) && !(ago >= 30 && ago < 36);
    // Down slowly over the year, then about a quarter of a kilo a week over the last four months,
    // nearly all of it fat: lean mass holds, and edges up.
    const weight = weighs ? round(80.4 + 0.034 * Math.min(ago, 120) + 0.007 * Math.max(0, ago - 120) + r.normal(0.3), 1) : null;
    const lean = 61.9 - 0.002 * Math.min(ago, 120) - 0.0005 * Math.max(0, ago - 120);
    const bodyFat = weight !== null && r.chance(0.7) ? round(100 * (1 - (lean + r.normal(0.25)) / weight), 1) : null;

    const day: DemoDay = {
      date,
      steps,
      distanceKm: round(steps * 0.00071, 2),
      activeMinutes: [light, moderate, vigorous],
      activeKcal,
      totalKcal: activeKcal + 1740,
      restingHr: rhr,
      hrv: round(hrv, 1),
      respiratoryRate: breathing,
      spo2: [spo2avg, round(spo2avg - (rough.has(date) ? 6.5 : 3) - r.next(), 1), round(Math.min(100, spo2avg + 2.4), 1)],
      tempDeviation: temp,
      sleep: slept ? {
        asleep, awake, deep, rem, light: asleep - deep - rem, bedtime: hhmm(bed), wake: hhmm(wake),
      } : null,
      floors,
      bed: slept ? bed : null,
      wake: slept ? wake : null,
      nap: wd === 6 && r.chance(0.45) ? { at: 14 * 60 + 20 + round(r.normal(20)), minutes: round(28 + r.normal(6)) } : null,
      rough: rough.has(date),
      workout,
      weight,
      bodyFat,
    };
    out.push(day);
  }
  // Today, at twenty to eight: last night is in, the day's movement has barely begun.
  const today = out[out.length - 1];
  today.steps = 412;
  today.distanceKm = 0.29;
  today.activeMinutes = [9, 0, 0];
  today.activeKcal = 21;
  today.totalKcal = 560;
  today.floors = 1;
  today.workout = null;
  today.nap = null;
  return out;
}

/** A night's stages, lights-out to waking, in sleep cycles of about 90 minutes: deep early, REM late. */
function stagesFor(day: DemoDay, start: number, seed: number) {
  const r = seeded(seed);
  const s = day.sleep!;
  const segments: { type: string; minutes: number }[] = [{ type: 'AWAKE', minutes: Math.min(12, s.awake) }];
  let deep = s.deep;
  let rem = s.rem;
  let light = s.light;
  let awake = s.awake - segments[0].minutes;
  const cycles = Math.max(3, Math.round(s.asleep / 92));
  for (let c = 0; c < cycles; c++) {
    const share = (c + 1) / cycles;
    const d = c === cycles - 1 ? deep : round(deep * (c === 0 ? 0.45 : 0.35));
    const rm = c === cycles - 1 ? rem : round(rem * (0.12 + share * 0.2));
    const l = c === cycles - 1 ? light : round(light / (cycles - c) * (0.9 + r.next() * 0.2));
    deep -= d;
    rem -= rm;
    light -= l;
    segments.push({ type: 'LIGHT', minutes: round(l * 0.55) }, { type: 'DEEP', minutes: d }, { type: 'LIGHT', minutes: l - round(l * 0.55) }, { type: 'REM', minutes: rm });
    if (awake > 0 && c < cycles - 1) {
      const a = Math.min(awake, round(3 + r.next() * 6));
      segments.push({ type: 'AWAKE', minutes: a });
      awake -= a;
    }
  }
  if (awake > 0) segments.push({ type: 'AWAKE', minutes: awake });
  let t = start;
  return segments
    .filter((x) => x.minutes > 0)
    .map((x) => {
      const from = t;
      t += x.minutes * 60_000;
      return { startTime: iso(from), startUtcOffset: offsetOn(day.date), endTime: iso(t), endUtcOffset: offsetOn(day.date), type: x.type };
    });
}

function sleepSessions(days: DemoDay[]) {
  const points: any[] = [];
  days.forEach((day, i) => {
    if (day.sleep && day.bed !== null) {
      const evening = addDays(day.date, -1);
      const start = instant(evening, day.bed);
      const s = day.sleep;
      const stages = stagesFor(day, start, 1000 + i);
      const end = Date.parse(stages[stages.length - 1].endTime);
      const offset = offsetOn(day.date);
      points.push(listPoint(WATCH, 'sleep', {
        interval: { startTime: iso(start), startUtcOffset: offsetOn(evening), endTime: iso(end), endUtcOffset: offset },
        type: 'STAGES',
        stages,
        metadata: { stagesStatus: 'SUCCEEDED', processed: true, mainSleep: true },
        summary: {
          minutesInSleepPeriod: String(Math.round((end - start) / 60_000)),
          minutesAfterWakeUp: '0',
          minutesToFallAsleep: '0',
          minutesAsleep: String(s.asleep),
          minutesAwake: String(s.awake),
          stagesSummary: [
            { type: 'AWAKE', minutes: String(s.awake), count: '4' },
            { type: 'LIGHT', minutes: String(s.light), count: '12' },
            { type: 'DEEP', minutes: String(s.deep), count: '4' },
            { type: 'REM', minutes: String(s.rem), count: '5' },
          ],
        },
        shortAwakenings: [95, 161, 238, 300].map((m) => ({
          startTime: iso(start + m * 60_000), startUtcOffset: offset,
          endTime: iso(start + m * 60_000 + 30_000), endUtcOffset: offset,
          type: 'AWAKE',
        })),
      }));
    }
    if (day.nap) {
      const start = instant(day.date, day.nap.at);
      const end = start + (day.nap.minutes + 6) * 60_000;
      const offset = offsetOn(day.date);
      points.push(listPoint(WATCH, 'sleep', {
        interval: { startTime: iso(start), startUtcOffset: offset, endTime: iso(end), endUtcOffset: offset },
        type: 'STAGES',
        stages: [],
        metadata: { stagesStatus: 'SUCCEEDED', processed: true, nap: true },
        summary: {
          minutesInSleepPeriod: String(day.nap.minutes + 6), minutesAsleep: String(day.nap.minutes), minutesAwake: '6',
          stagesSummary: [{ type: 'AWAKE', minutes: '6', count: '1' }, { type: 'LIGHT', minutes: String(day.nap.minutes), count: '1' }],
        },
        shortAwakenings: [],
      }));
    }
  });
  return { dataPoints: newestFirst(points) };
}

/**
 * Minute heart rate for the dashboard's window: asleep at night (lower in deep sleep), the
 * commutes, runs and hikes, a shower each morning with the watch off, and one stretch of fast
 * heart rate in a night of rough sleep.
 */
function minuteHeartRate(days: DemoDay[]): MinuteSeries {
  const window = days.slice(-62);
  const t: number[] = [];
  const bpm: number[] = [];
  const end = DEMO_CLOCK.now.getTime();
  window.forEach((day, k) => {
    const r = seeded(5000 + k);
    const next = days[days.indexOf(day) + 1];
    const rest = day.restingHr ?? 60;
    // Heart rate wanders: each minute leans on the one before, rather than jumping about.
    let drift = 0;
    for (let m = 0; m < 1440; m++) {
      drift = 0.92 * drift + r.normal(1.8);
      const at = instant(day.date, m);
      if (at >= end) break;
      // Asleep: from last night's bedtime (after midnight, or the evening before) until waking, or from tonight's.
      const lastBed = day.bed === null ? null : day.bed - 24 * 60;
      const asleepNow = (day.wake !== null && lastBed !== null && m >= lastBed && m < day.wake) || (next?.bed != null && m >= next.bed);
      let v: number | null;
      if (asleepNow) {
        v = rest - 5 + 3 * Math.sin(m / 47) + drift * 0.35 + r.normal(0.8);
        if (day.rough && m >= 130 && m < 146) v = 104 + r.normal(2.5);
      } else if (day.wake !== null && m >= day.wake + 25 && m < day.wake + 38) {
        v = null; // in the shower
      } else if (m >= 8 * 60 + 5 && m < 8 * 60 + 30 && isoWeekdayIndex(day.date) <= 4) {
        v = 96 + 4 * Math.sin(m / 5) + drift + r.normal(1.5);
      } else if (m >= 17 * 60 + 15 && m < 17 * 60 + 40 && isoWeekdayIndex(day.date) <= 4) {
        v = 94 + 4 * Math.sin(m / 6) + drift + r.normal(1.5);
      } else if (day.workout === 'run' && m >= 18 * 60 + 15 && m < 19 * 60) {
        const into = (m - 18 * 60 - 15) / 45;
        v = 118 + 44 * Math.sin(Math.PI * Math.min(1, into * 1.15)) + drift * 0.6 + r.normal(2);
      } else if (day.workout === 'hike' && m >= 10 * 60 && m < 14 * 60 + 30) {
        v = 106 + 14 * Math.sin(m / 23) + drift + r.normal(2);
      } else {
        v = rest + 15 + 6 * Math.sin(m / 53) + drift + r.normal(1.5);
      }
      if (v === null) continue;
      t.push(at);
      bpm.push(clamp(Math.round(v), 40, MAX_HR));
    }
  });
  return { t: Float64Array.from(t), bpm: Uint8Array.from(bpm) };
}

/** Days ago each VO₂ max estimate began, and its value: oldest first. */
const VO2_REVISIONS: [number, number][] = [
  [DEMO_DAYS, 40.2], [352, 40.5], [301, 40.9], [262, 40.7], [214, 41.1], [168, 41.4], [119, 41.6], [73, 41.9], [21, 43.1],
];

/** Google-Health-shaped payloads for the whole demo, for the fixture server. */
export function buildDemoPayloads(): FixturePayloads {
  const days = demoDays();
  const out = buildFixturePayloads(days);
  const weighIns = days.filter((d) => d.weight !== null);

  out['floors'] = { rollupDataPoints: newestFirst(days.map((d) => rollupPoint(d.date, 'floors', { countSum: String(d.floors) }))) };
  out['daily-oxygen-saturation'] = {
    dataPoints: newestFirst(days.map((d) => listPoint(WATCH_PASSIVE, 'dailyOxygenSaturation', {
      date: { year: Number(d.date.slice(0, 4)), month: Number(d.date.slice(5, 7)), day: Number(d.date.slice(8, 10)) },
      averagePercentage: d.spo2![0], lowerBoundPercentage: d.spo2![1], upperBoundPercentage: d.spo2![2], standardDeviationPercentage: 0.8,
    }))),
  };
  // Cardio fitness: the watch revises its estimate now and then, a little higher most times, and
  // by more than its own uncertainty three weeks ago.
  out['daily-vo2-max'] = {
    dataPoints: newestFirst(days.map((d) => {
      const ago = daysBetween(d.date, TODAY);
      const v = VO2_REVISIONS.filter(([from]) => from >= ago).at(-1)![1];
      return listPoint(WATCH, 'dailyVo2Max', {
        date: { year: Number(d.date.slice(0, 4)), month: Number(d.date.slice(5, 7)), day: Number(d.date.slice(8, 10)) },
        vo2Max: v, cardioFitnessLevel: v < 41 ? 'AVERAGE' : 'GOOD', vo2MaxCovariance: 0.6,
      });
    })),
  };
  out['weight'] = {
    dataPoints: newestFirst(weighIns.map((d) => listPoint(SCALE, 'weight', {
      sampleTime: sampleTime(iso(instant(d.date, 7 * 60 + 5)), d.date, offsetOn(d.date)), weightGrams: Math.round(d.weight! * 1000),
    }))),
  };
  out['body-fat'] = {
    dataPoints: newestFirst(weighIns.filter((d) => d.bodyFat !== null).map((d) => listPoint(SCALE, 'bodyFat', {
      sampleTime: sampleTime(iso(instant(d.date, 7 * 60 + 5)), d.date, offsetOn(d.date)), percentage: d.bodyFat,
    }))),
  };
  out['height'] = {
    dataPoints: [listPoint(SCALE, 'height', {
      sampleTime: sampleTime(iso(instant(days[0].date, 8 * 60)), days[0].date, offsetOn(days[0].date)), heightMillimeters: '1780',
    })],
  };
  out['sleep'] = sleepSessions(days);
  // The test fixture's three days of heart rate give way to the demo's 62.
  for (const key of Object.keys(out)) if (key.startsWith('heart-rate')) delete out[key];
  out['heart-rate'] = { dataPoints: [], minutes: minuteHeartRate(days) };
  const irn = addDays(TODAY, -23);
  out['irregular-rhythm-notification'] = {
    dataPoints: [listPoint(WATCH_PASSIVE, 'irregularRhythmNotification', { sampleTime: sampleTime(iso(instant(irn, 3 * 60 + 12)), irn, offsetOn(irn)) })],
  };
  out['electrocardiogram'] = { dataPoints: [] };
  out['nutrition-log'] = { rollupDataPoints: [] };
  return out;
}
