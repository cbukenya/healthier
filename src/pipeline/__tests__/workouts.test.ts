import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { emptyRecord, normalize } from '../normalize';
import { STREAMS } from '../registry';
import {
  KINDS, KNOWN_TYPES, LEVELS, calorieBurn, combineExercisePoints, familyOf, kindOf, kindsIn, levelHistory, levelIndex, loadAdvice,
  mainKinds, paceOf,
  parseWorkout, progressOf, restingKcalPerMinute, weeklyZoneMinutes, workoutHeart, workoutLevel, workoutLoad,
  workoutsIn, zoneMinutesOf,
} from '../workouts';
import { WHO_WEEK } from '../goals';
import { hasMessage } from '../../i18n';
import { DEMO_CLOCK, DEMO_DAYS, buildDemoPayloads } from '../demo';
import { createFixtureFetch } from '../fixtures';
import { HISTORY_QUERIES } from '../insights';
import { DASHBOARD_WINDOW_DAYS, syncWithHistory, type SyncResult } from '../sync';
import type { DailyRecord, IntradaySample, Workout } from '../../types/health';

/**
 * Google's exercise types, as its Health API v4 reference lists them (Exercise.ExerciseType at
 * developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints, read 2026-11-19),
 * EXERCISE_TYPE_UNSPECIFIED left out. If Google adds one, add it here and give it a kind.
 */
const GOOGLE_EXERCISE_TYPES = [
  'AEROBIC_WORKOUT', 'ARCHERY', 'ASSAULT_BIKE', 'BACKPACKING', 'BADMINTON', 'BALLET', 'BALLROOM_DANCE',
  'BARRE_CLASS', 'BASEBALL', 'BASKETBALL', 'BIKING', 'BILLIARDS', 'BODY_WEIGHT', 'BOOTCAMP', 'BOWLING', 'BOXING',
  'BREAKDANCING', 'CALISTHENICS', 'CANOEING', 'CARDIO_SCULPT', 'CARDIO_WORKOUT', 'CARPENTRY', 'CHEERLEADING',
  'CIRCUIT_TRAINING', 'CLEANING', 'CLIMBING', 'CORE_TRAINING', 'CRICKET', 'CROQUET', 'CROSS_COUNTRY_SKI',
  'CROSS_TRAINING', 'CROSSFIT', 'CURLING', 'DANCING', 'DIVING', 'ELECTRIC_BIKE', 'ELECTRIC_SCOOTER', 'ELLIPTICAL',
  'EQUESTRIAN_SPORTS', 'EXERCISE_CLASS', 'FENCING', 'FIELD_HOCKEY', 'FISHING', 'FITNESS_GAMING', 'FOILING',
  'FOOTBALL_AMERICAN', 'FOOTBALL_AUSTRALIAN', 'FREE_WEIGHTS', 'FRISBEE_PLAYING_GENERAL',
  'FUNCTIONAL_STRENGTH_TRAINING', 'GARDENING', 'GOLF', 'GYMNASTICS', 'HANDBALL', 'HAND_CYCLING', 'HIIT', 'HIKING',
  'HIP_HOP', 'HOCKEY', 'HOEING', 'HOUSEHOLD_CHORES', 'HUNTING', 'ICE_SKATING', 'INCLINE_RUN', 'INCLINE_WALK',
  'INDOOR_CLIMBING', 'INTERVAL_WORKOUT', 'JAZZ_DANCE', 'JIU_JITSU', 'JUMPING_ROPE', 'KARATE', 'KAYAKING',
  'KICKBOXING', 'KITESURFING', 'LACROSSE', 'MARTIAL_ARTS', 'MEDITATE', 'MODERN_DANCE', 'MOTOCROSS', 'MOTORCYCLE',
  'MOUNTAIN_BIKE', 'MOWING_LAWN', 'MUAY_THAI', 'MULTISPORT', 'MUSICAL_PERFORMANCE', 'NORDIC_WALKING',
  'ORIENTEERING', 'OTHER', 'OUTDOOR_BIKE', 'OUTDOOR_WORKOUT', 'PADDLEBOARDING', 'PADEL', 'PAINTING',
  'PARAGLIDING', 'PARKOUR', 'PICKELBALL', 'PILATES', 'POLO', 'POWERLIFTING', 'POWER_WALKING', 'RACKET_SPORTS',
  'RACQUETBALL', 'RESISTANCE_BANDS', 'ROCK_CLIMBING', 'ROLLERBLADING', 'ROLLER_SKATING', 'ROWING',
  'ROWING_MACHINE', 'RUCKING', 'RUGBY', 'RUNNING', 'SAILING', 'SCOOTERING', 'SCUBA_DIVING', 'SHOOTING',
  'SHOVELING', 'SKATEBOARDING', 'SKATING', 'SKIING', 'SKYDIVING', 'SNORKELING', 'SNOWBOARDING', 'SNOWMOBILING',
  'SNOWSHOEING', 'SNOW_SPORT', 'SOCCER', 'SOFTBALL', 'SPEED_SKATING', 'SPINNING', 'SPORT', 'SQUASH',
  'STAIRCLIMBER', 'STATIONARY_BIKE', 'STEP_TRAINING', 'STRENGTH_TRAINING', 'STRETCHING', 'STROLLER_WALK',
  'SURFING', 'SWIMMING', 'SWIMMING_OPEN_WATER', 'SWIMMING_POOL', 'SYNCHRONIZED_SWIMMING', 'TABATA_WORKOUT',
  'TABLE_TENNIS', 'TAEKWONDO', 'TAI_CHI', 'TANGO', 'TENNIS', 'TRACK_AND_FIELD', 'TRAIL_RUN', 'TRAMPOLINE',
  'TREADMILL', 'TREADMILL_WALK', 'TRX', 'ULTIMATE_FRISBEE', 'UNICYCLING', 'VOLLEYBALL', 'VOLLEYBALL_BEACH',
  'WAKEBOARDING', 'WALKING', 'WALK_WITH_WEIGHTS', 'WATER_AEROBICS', 'WATER_JOGGING', 'WATER_POLO', 'WATER_SKIING',
  'WATER_SPORT', 'WATER_VOLLEYBALL', 'WEEDING', 'WEIGHTLIFTING', 'WEIGHT_MACHINES', 'WEIGHTS', 'WHEELCHAIR',
  'WINDSURFING', 'WORKOUT', 'WRESTLING', 'YOGA', 'YOGA_BIKRAM', 'YOGA_HATHA', 'YOGA_POWER', 'YOGA_VINYASA',
  'ZUMBA',
];

const EXERCISE = STREAMS.find((s) => s.dataType === 'exercise')!;
const WATCH = { recordingMethod: 'ACTIVELY_RECORDED', device: { displayName: 'Watch' }, platform: 'FITBIT' };
const PHONE = { recordingMethod: 'ACTIVELY_RECORDED', application: { packageName: 'com.example.runs' }, platform: 'HEALTH_CONNECT' };

/** A workout as Google Health lists it (v4 Exercise), at a local time on a date, two hours east of UTC. */
function exercise(date: CivilDate, hhmm: string, minutes: number, fields: Record<string, unknown> = {}, source: unknown = WATCH) {
  const [h, m] = hhmm.split(':').map(Number);
  const start = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 120) * 60_000;
  return {
    dataSource: source,
    exercise: {
      interval: {
        startTime: new Date(start).toISOString(), startUtcOffset: '7200s',
        endTime: new Date(start + minutes * 60_000).toISOString(), endUtcOffset: '7200s',
      },
      exerciseType: 'RUNNING',
      activeDuration: `${minutes * 60}s`,
      ...fields,
    },
  };
}

/** A made-up workout, for the sums. */
const workout = (fields: Partial<Workout> = {}): Workout => ({
  type: 'RUNNING', displayName: null, startIso: '2026-10-05T16:00:00.000Z', endIso: '2026-10-05T16:45:00.000Z', startMin: 1080,
  elapsedMin: 45, activeMin: 45, distanceKm: null, kcal: null, steps: null, avgHr: null, zoneMinutes: null, zones: null,
  climbM: null, cadence: null, swimLengths: null, splits: [], hasGps: false, ...fields,
});

/** `n` days ending on `end`, with zone minutes from workouts on the days `azm` gives them. */
function daysWith(end: CivilDate, n: number, azm: (k: number) => number): DailyRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(end, i - n + 1);
    const minutes = azm(n - 1 - i);
    return { ...emptyRecord(date), workouts: minutes ? [workout({ zoneMinutes: minutes })] : [] };
  });
}

describe('workouts, as Google Health lists them', () => {
  it('reads a workout: its times, distance, calories, heart rate, zones, climb and splits', () => {
    const w = parseWorkout(exercise('2026-10-05', '18:15', 45, {
      displayName: 'Run',
      activeDuration: '2640s',
      metricsSummary: {
        caloriesKcal: 512.4, distanceMillimeters: 6_600_000, steps: '6950', averageHeartRateBeatsPerMinute: '142',
        activeZoneMinutes: '77', elevationGainMillimeters: 42_000,
        heartRateZoneDurations: { lightTime: '0s', moderateTime: '780s', vigorousTime: '1560s', peakTime: '360s' },
        mobilityMetrics: { avgCadenceStepsPerMinute: 157 },
      },
      splits: [
        { startTime: '2026-10-05T16:15:00Z', endTime: '2026-10-05T16:21:50Z', activeDuration: '410s', splitType: 'DISTANCE', metricsSummary: { distanceMillimeters: 1_000_000, averageHeartRateBeatsPerMinute: '136' } },
      ],
      exerciseMetadata: { hasGps: true },
    }).exercise)!;
    assert.equal(w.startMin, 18 * 60 + 15, 'on the clock where it was done');
    assert.equal(w.elapsedMin, 45);
    assert.equal(w.activeMin, 44, 'pauses left out');
    assert.equal(w.distanceKm, 6.6);
    assert.equal(w.kcal, 512);
    assert.equal(w.steps, 6950);
    assert.equal(w.avgHr, 142);
    assert.equal(w.zoneMinutes, 77);
    assert.deepEqual(w.zones, { light: 0, moderate: 13, vigorous: 26, peak: 6 });
    assert.equal(w.climbM, 42);
    assert.equal(w.cadence, 157);
    assert.deepEqual(w.splits, [{ distanceKm: 1, seconds: 410, avgHr: 136 }]);
    assert.equal(w.hasGps, true);
  });

  it('keeps what a workout leaves out as not recorded, never as nothing', () => {
    const w = parseWorkout(exercise('2026-10-05', '07:00', 30, { exerciseType: 'YOGA', metricsSummary: {} }).exercise)!;
    assert.equal(w.distanceKm, null);
    assert.equal(w.kcal, null);
    assert.equal(w.avgHr, null);
    assert.equal(w.zones, null);
    assert.equal(zoneMinutesOf(w), 0);
    assert.equal(parseWorkout({ interval: { startTime: 'nonsense' } }), null);
  });

  it("files workouts under the day they started, earliest first, a workout listed twice counted once", () => {
    const day = '2026-10-05';
    const { days } = normalize([{
      stream: EXERCISE,
      points: [exercise(day, '18:15', 45), exercise(day, '07:00', 30), exercise(day, '18:15', 45), exercise(day, '23:30', 60)],
    }]);
    assert.deepEqual(days.get(day)!.workouts.map((w) => w.startMin), [7 * 60, 18 * 60 + 15, 23 * 60 + 30], 'the late one stays on the day it began');
    assert.ok(days.get(day)!.present.includes('exercise'));
    assert.equal(days.get(addDays(day, 1)), undefined);
  });

  it("takes one source's workouts for a day, so the same run from a watch and an app isn't counted twice", () => {
    const day = '2026-10-05';
    const points = [exercise(day, '18:15', 45, {}, WATCH), exercise(day, '18:16', 44, {}, PHONE)];
    const { days, variants } = normalize([{ stream: EXERCISE, points }]);
    assert.equal(days.get(day)!.workouts.length, 1);
    assert.equal(variants.get('exercise')?.get(day)?.size, 2, 'each source kept, to pick from when read');
    assert.equal(combineExercisePoints(points).length, 2);
  });

  it("places every one of Google's 181 exercise types in a kind, and makes none up", () => {
    assert.equal(GOOGLE_EXERCISE_TYPES.length, 181);
    assert.deepEqual(GOOGLE_EXERCISE_TYPES.filter((type) => !KNOWN_TYPES.has(type)), [], 'each of Google\'s types has a kind');
    assert.deepEqual([...KNOWN_TYPES].filter((type) => !GOOGLE_EXERCISE_TYPES.includes(type)), [], 'no type Google doesn\'t have');
    assert.ok(Object.keys(KINDS).every((kind) => GOOGLE_EXERCISE_TYPES.some((type) => kindOf({ type }) === kind)), 'and every kind has a type');
  });

  it('names every type in the language file, and every kind', () => {
    assert.deepEqual(GOOGLE_EXERCISE_TYPES.filter((type) => !hasMessage(`workouts.types.${type}`)), []);
    assert.deepEqual(Object.keys(KINDS).filter((kind) => !hasMessage(`workouts.kinds.${kind}`)), []);
  });

  it('puts each type where it belongs', () => {
    const cases: [string, string][] = [
      ['TRAIL_RUN', 'run'], ['TREADMILL', 'run'], ['RUCKING', 'walk'], ['WHEELCHAIR', 'walk'], ['BACKPACKING', 'hike'],
      ['UNICYCLING', 'ride'], ['SPINNING', 'indoorRide'], ['ROWING_MACHINE', 'row'], ['KAYAKING', 'paddle'],
      ['ROLLERBLADING', 'skate'], ['SWIMMING_OPEN_WATER', 'swim'], ['SURFING', 'waterSport'], ['SNOWBOARDING', 'winter'],
      ['TRX', 'strength'], ['POWERLIFTING', 'strength'], ['WEIGHTS', 'strength'], ['BOULDERING', 'other'],
      ['INDOOR_CLIMBING', 'climbing'], ['TABATA_WORKOUT', 'hiit'], ['ZUMBA', 'dance'], ['DANCING', 'dance'],
      ['MUAY_THAI', 'martialArts'], ['PICKELBALL', 'sport'], ['SOCCER', 'sport'], ['BARRE_CLASS', 'pilates'],
      ['TAI_CHI', 'mobility'], ['GARDENING', 'other'], ['OTHER', 'other'],
    ];
    assert.deepEqual(cases.map(([type]) => [type, kindOf({ type })]), cases, 'a type Google may add later is other until placed');
  });

  it('times each family by what suits it', () => {
    assert.equal(familyOf({ type: 'MOUNTAIN_BIKE' }), 'speed');
    assert.equal(familyOf({ type: 'KAYAKING' }), 'speed');
    assert.equal(familyOf({ type: 'SWIMMING_POOL' }), 'water');
    assert.equal(familyOf({ type: 'WEIGHTLIFTING' }), 'strength');
    assert.equal(familyOf({ type: 'HIIT' }), 'cardio');
    assert.equal(familyOf({ type: 'YOGA_VINYASA' }), 'mind');
    assert.equal(familyOf({ type: 'GARDENING' }), 'other');
  });

  it('times each family its own way: a run a kilometre, a ride by the hour, a swim a hundred metres', () => {
    assert.deepEqual(paceOf(workout({ distanceKm: 6, activeMin: 36 })), { measure: 'pace', value: 360 });
    assert.deepEqual(paceOf(workout({ type: 'BIKING', distanceKm: 30, activeMin: 60 })), { measure: 'speed', value: 30 });
    assert.deepEqual(paceOf(workout({ type: 'SWIMMING', distanceKm: 1.5, activeMin: 30 })), { measure: 'swimPace', value: 120 });
    assert.equal(paceOf(workout({ type: 'WEIGHTLIFTING', distanceKm: null })), null);
  });
});

describe('the workout level', () => {
  it('has five steps, set from the weekly target', () => {
    assert.deepEqual([0, 29, 30, 74, 75, 149, 150, 299, 300, 900].map(levelIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    assert.equal(levelIndex(WHO_WEEK), LEVELS.indexOf('blaze'), 'the weekly target is a Blaze');
  });

  it('averages 4 weeks of zone minutes from workouts into a week', () => {
    const end = '2026-10-11';
    // A 60-minute workout every other day: 14 in 28 days.
    const days = daysWith(end, 60, (k) => (k % 2 === 0 ? 60 : 0));
    assert.equal(weeklyZoneMinutes(days, end), 210);
    const level = workoutLevel(days)!;
    assert.equal(LEVELS[level.index], 'blaze');
    assert.equal(level.toNext, 90, 'to reach Wildfire');
    assert.equal(level.before, LEVELS.indexOf('blaze'));
    assert.ok(Math.abs(level.position - (3 + 60 / 150) / 5) < 1e-9);
    assert.equal(weeklyZoneMinutes(days.slice(-6), end), null, 'not from under a week of days');
  });

  it('says where it was 4 weeks before, so it can say it moved', () => {
    const days = daysWith('2026-10-11', 60, (k) => (k < 28 ? (k % 7 === 0 ? 100 : 0) : k % 2 === 0 ? 100 : 0));
    const level = workoutLevel(days)!;
    assert.equal(LEVELS[level.index], 'flame');
    assert.equal(LEVELS[level.before!], 'wildfire');
  });

  it("tells its history a week at a time, or a month's average week, each with the 4-week average at its end", () => {
    const end = '2026-10-11'; // a Sunday
    const days = daysWith(end, 120, (k) => (k % 7 === 2 ? 70 : 0));
    const weeks = levelHistory(days, addDays(end, -27), 'week');
    assert.equal(weeks.length, 4);
    assert.equal(weeks[0].date, '2026-09-14', 'from the Monday');
    assert.ok(weeks.every((w) => w.bar === 70 && w.line === 70 && !w.partial), 'the last week ends today, a Sunday');
    assert.equal(levelHistory(days.slice(0, -2), addDays(end, -27), 'week').at(-1)!.partial, true, 'on a Friday the week is under way');
    const months = levelHistory(days, '2026-07-01', 'month');
    assert.deepEqual(months.map((m) => m.date), ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    assert.deepEqual(months.map((m) => m.partial), [false, false, false, true]);
    assert.ok(Math.abs(months[2].bar - (70 * 4 * 7) / 30) < 1e-9, "September's average week");
  });
});

describe('the workout load', () => {
  it('sets the last 7 days against the 3 weeks before, without overlap', () => {
    const days = daysWith('2026-10-11', 28, (k) => (k < 7 ? 60 : k % 7 === 0 ? 200 : 0));
    const load = workoutLoad(days)!;
    assert.equal(load.week, 420);
    assert.equal(load.usual, 200);
    assert.equal(load.base, 'usual');
    assert.equal(load.ratio, 2.1);
    assert.equal(workoutLoad(days.slice(-20))!.ratio, null, 'not without the 3 weeks before');
  });

  it('sets a usual week under the weekly target against the target instead', () => {
    // A usual week of 25 and a week of 60: 2.4× the usual week, but 0.4× the target.
    const days = daysWith('2026-10-11', 28, (k) => (k === 0 ? 60 : k >= 7 && k % 7 === 3 ? 25 : 0));
    const load = workoutLoad(days)!;
    assert.equal(load.usual, 25);
    assert.equal(load.base, 'target');
    assert.equal(load.ratio, 60 / WHO_WEEK);
    // From nothing at all, twice the target is still a big jump.
    const jump = workoutLoad(daysWith('2026-10-11', 28, (k) => (k < 7 ? 300 / 7 : 0)))!;
    assert.equal(jump.usual, 0);
    assert.ok(Math.abs(jump.ratio! - 2) < 1e-9);
  });

  it('says what to do with it and the body battery together', () => {
    assert.equal(loadAdvice(1.6, false), 'recover');
    assert.equal(loadAdvice(1.6, true), 'recover', 'whatever the battery');
    assert.equal(loadAdvice(1.2, true), 'easy');
    assert.equal(loadAdvice(0.5, true), 'easy');
    assert.equal(loadAdvice(0.5, false), 'push');
    assert.equal(loadAdvice(1.5, false), 'keep');
    assert.equal(loadAdvice(0.8, false), 'keep');
  });
});

describe("a workout's heart rate", () => {
  const date = '2026-10-05';
  const w = workout({ startIso: '2026-10-05T16:00:00.000Z', endIso: '2026-10-05T16:10:00.000Z', startMin: 18 * 60, elapsedMin: 10, activeMin: 10 });
  const zones = { light: 30, moderate: 110, vigorous: 130, peak: 160 };
  const samples = (bpm: number[]): Record<string, IntradaySample[]> => ({
    [date]: bpm.map((value, k) => ({ iso: new Date(Date.parse(w.startIso) + (k - 2) * 60_000).toISOString(), date, minutesOfDay: 18 * 60 + k - 2, value })),
  });

  it('takes the minutes of the workout and the 5 after it, with its low, its peak and how fast it fell', () => {
    const heart = workoutHeart(w, date, samples([80, 82, 100, 120, 140, 150, 165, 158, 150, 145, 140, 138, 120, 110, 100, 95, 92, 90, 88]), zones)!;
    assert.equal(heart.points[0].at, 0, 'from the start');
    assert.equal(heart.points.at(-1)!.at, 14, 'to 5 minutes after the end');
    assert.equal(heart.low.bpm, 100);
    assert.equal(heart.peak.bpm, 165);
    assert.equal(heart.recovery, 18, 'the last minute against the one after the end');
  });

  it("leaves recovery out when the workout ended easy, and the chart out without readings", () => {
    const heart = workoutHeart(w, date, samples([80, 82, 100, 120, 130, 125, 120, 115, 110, 105, 100, 100, 95, 92, 90]), zones)!;
    assert.equal(heart.recovery, null);
    assert.equal(workoutHeart(w, date, {}, zones), null);
    assert.equal(workoutHeart(w, date, undefined, zones), null);
  });
});

describe('calorie burn', () => {
  it('is a workout’s calories less the resting burn for its length, as the day’s burn is', () => {
    const days = [
      { ...emptyRecord('2026-10-04'), totalKcal: 2880, activeKcal: 720 },
      { ...emptyRecord('2026-10-05'), totalKcal: 900, activeKcal: 300 },
    ];
    assert.equal(restingKcalPerMinute(days, '2026-10-04'), 1.5);
    assert.equal(restingKcalPerMinute(days, '2026-10-05'), 1.5, "today's totals are still coming in, so the day before's");
    assert.equal(calorieBurn(workout({ kcal: 500, elapsedMin: 60 }), 1.5), 410);
    assert.equal(calorieBurn(workout({ kcal: 500 }), null), null);
  });
});

describe('how a kind of workout is going', () => {
  it("shows a pace at much the same heart rate, so an easy day and a race don't pass for progress", () => {
    const sessions = [140, 141, 139, 158, 142, 140].map((hr, i) =>
      ({ id: String(i), date: addDays('2026-09-01', i * 3), workout: workout({ distanceKm: 6, activeMin: 40 - i, avgHr: hr }) }),
    ).reverse();
    const p = progressOf(sessions)!;
    assert.equal(p.measure, 'pace');
    assert.equal(p.points.length, 5, 'the race left out');
    assert.deepEqual(p.band, [135, 147]);
    assert.ok(p.trend![1] < p.trend![0], 'getting faster');
  });

  it('shows zone minutes a session for a kind without a distance', () => {
    const sessions = [30, 40, 50].map((z, i) => ({ id: String(i), date: addDays('2026-09-01', i), workout: workout({ type: 'WEIGHTLIFTING', zoneMinutes: z }) })).reverse();
    const p = progressOf(sessions)!;
    assert.equal(p.measure, 'zoneMinutes');
    assert.deepEqual(p.points.map((x) => x.value), [30, 40, 50]);
  });

  it('lists the kinds behind 95% of the zone minutes, so a walk now and then stays off the list', () => {
    const at = (type: string, zoneMinutes: number, day: number, minutes = 40) =>
      ({ id: `${type}${day}`, date: addDays('2026-10-01', day), workout: workout({ type, zoneMinutes, activeMin: minutes, startIso: `2026-10-0${day + 1}T16:00:00.000Z` }) });
    const list = [at('RUNNING', 70, 0), at('WEIGHTLIFTING', 20, 1), at('SWIMMING', 6, 2), at('WALKING', 4, 3)];
    assert.deepEqual(mainKinds(list).map((k) => k.kind), ['run', 'strength', 'swim'], '70 + 20 is 90%; the swim takes it past 95%');
    const easy = [at('YOGA', 0, 0, 60), at('WALKING', 0, 1, 30), at('PILATES', 0, 2, 2)];
    assert.deepEqual(mainKinds(easy).map((k) => k.kind), ['yoga', 'walk'], 'by time, when none earned zone minutes');
    const everything = ['RUNNING', 'BIKING', 'SWIMMING', 'YOGA', 'HIIT', 'WEIGHTLIFTING', 'TENNIS'].map((type, i) => at(type, 10, i));
    assert.equal(mainKinds(everything).length, 4, 'never more than four');
  });

  it('shares out zone minutes by kind, the biggest first', () => {
    const list = workoutsIn([
      { ...emptyRecord('2026-10-01'), workouts: [workout({ zoneMinutes: 70, startIso: '2026-10-01T16:00:00.000Z' }), workout({ type: 'WEIGHTLIFTING', zoneMinutes: 30, startIso: '2026-10-01T06:00:00.000Z' })] },
      { ...emptyRecord('2026-10-02'), workouts: [workout({ zoneMinutes: 75, startIso: '2026-10-02T16:00:00.000Z' })] },
    ]);
    assert.equal(list[0].date, '2026-10-02', 'newest first');
    assert.deepEqual(kindsIn(list).map((k) => [k.kind, k.sessions.length, k.zoneMinutes]), [['run', 2, 145], ['strength', 1, 30]]);
  });
});

describe('the demo’s workouts', () => {
  let data: SyncResult;
  let history: DailyRecord[];
  before(async () => {
    ({ data, history } = await syncWithHistory({
      token: 'demo', fetchImpl: createFixtureFetch(buildDemoPayloads()), windowDays: DASHBOARD_WINDOW_DAYS,
      historyDays: DEMO_DAYS, now: DEMO_CLOCK.now, timeZone: DEMO_CLOCK.timeZone, includeIntraday: true, queries: HISTORY_QUERIES,
    }));
  });

  it('does every kind of workout in the last 90 days, with a run yesterday evening whose heart rate is in the window', () => {
    const recent = new Set(workoutsIn(history.slice(-90)).map((w) => kindOf(w.workout)));
    assert.deepEqual([...recent].sort(), Object.keys(KINDS).sort(), 'one of each kind at least, so every layout shows');
    const latest = workoutsIn(data.days)[0];
    assert.equal(latest.date, '2026-10-11');
    assert.equal(kindOf(latest.workout), 'run');
    const intraday: Record<string, IntradaySample[]> = {};
    for (const s of data.heartRateSamples) (intraday[s.date] ??= []).push(s);
    const day = data.days.find((d) => d.date === latest.date)!;
    const heart = workoutHeart(latest.workout, latest.date, intraday, day.hrZones)!;
    assert.ok(heart.peak.bpm > day.hrZones!.vigorous, 'up into the vigorous zone');
    assert.ok(heart.recovery !== null && heart.recovery > 0, 'and down again after');
  });

  it('climbs from a Flame a year ago to a Blaze, and finds a big week to recover from', () => {
    const months = levelHistory(history, history[0].date, 'month').filter((m) => m.line !== null);
    assert.equal(LEVELS[levelIndex(months[0].line!)], 'flame');
    assert.equal(LEVELS[workoutLevel(data.days)!.index], 'blaze');
    assert.ok(workoutLoad(data.days)!.ratio! > 1.5);
  });
});
