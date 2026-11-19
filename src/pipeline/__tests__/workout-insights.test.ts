import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { emptyRecord } from '../normalize';
import { buildContext } from '../insights/context';
import { workoutCards } from '../insights/cards/workouts';
import type { Finding } from '../insights/types';
import type { Answer, HistoryAnswers } from '../history';
import type { DailyRecord, DayNutrition, SleepSession, Workout } from '../../types/health';

/**
 * The Workouts tab's insights, each on days made for it: the records within the past year, the
 * same pace at a lower heart rate, strength days against the guideline, protein on strength days,
 * and a late hard workout on the evening it happens.
 */

const TODAY: CivilDate = '2026-10-12';
const MORNING = new Date('2026-10-12T07:40:00Z');
const EVENING = new Date('2026-10-12T21:30:00Z');

const workout = (fields: Partial<Workout> = {}): Workout => ({
  type: 'RUNNING', displayName: null, startIso: '2026-10-05T16:00:00.000Z', endIso: '2026-10-05T16:45:00.000Z', startMin: 18 * 60,
  elapsedMin: 45, activeMin: 45, distanceKm: null, kcal: null, steps: null, avgHr: null, zoneMinutes: null, zones: null,
  climbM: null, cadence: null, swimLengths: null, splits: [], hasGps: false, ...fields,
});

/** `n` days to today, each with what `on` gives it. */
function daysWith(n: number, on: (ago: number, date: CivilDate) => Partial<DailyRecord>): DailyRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const ago = n - 1 - i;
    const date = addDays(TODAY, -ago);
    return { ...emptyRecord(date), ...on(ago, date) };
  });
}

function cards(days: DailyRecord[], opts: { answers?: HistoryAnswers; now?: Date; protein?: number } = {}): Finding[] {
  const ctx = buildContext(
    { days, heartRateSamples: [], meta: {} as never, answers: opts.answers },
    opts.now ?? MORNING,
    { timeZone: 'UTC', ...(opts.protein ? { goals: { steps: 10000, briskMinutes: 30, sleepNeed: null, protein: opts.protein, fibre: 30, water: 2000 } } : {}) },
  )!;
  const out: Finding[] = [];
  workoutCards(ctx, (f) => out.push(f));
  return out;
}

/** The year before the window, as the server answers a record query. */
const year = (best: number, count = 20): Answer => ({
  from: addDays(TODAY, -365), to: addDays(TODAY, -62),
  rows: [{ key: null, max: { date: addDays(TODAY, -200), value: best }, min: { date: addDays(TODAY, -200), value: best }, count, first: { date: addDays(TODAY, -360), value: best } }],
});

describe('workout records within the past year', () => {
  const hikes = (latest: number) =>
    daysWith(60, (ago) => (ago % 7 === 2 ? { workouts: [workout({ type: 'HIKING', distanceKm: ago === 2 ? latest : 10 })] } : {}));

  it('celebrates the longest hike in a year, and its reach is the history, not the first hike', () => {
    const found = cards(hikes(15), { answers: { workoutHikeKm: year(12) } }).find((f) => f.id === 'workout-longest-hike');
    assert.ok(found);
    assert.equal(found!.title, 'Your longest hike in a year');
    assert.match(found!.text, /^15\.0 km on 10 October\. Your longest before that in the past year was 12\.0 km\.$/);
    assert.equal(found!.news, true);
  });

  it('stays quiet when the year held a longer one', () => {
    assert.equal(cards(hikes(15), { answers: { workoutHikeKm: year(16) } }).some((f) => f.id === 'workout-longest-hike'), false);
  });

  it('finds the fastest 5 km inside a run, from its kilometre splits', () => {
    const km = (seconds: number) => ({ distanceKm: 1, seconds, avgHr: null });
    const days = daysWith(60, (ago) =>
      ago % 7 === 1
        ? { workouts: [workout({ distanceKm: 6, splits: ago === 1 ? [km(420), km(380), km(380), km(381), km(379), km(380)] : Array.from({ length: 6 }, () => km(400)) })] }
        : {},
    );
    const found = cards(days, { answers: { workoutRun5k: year(1990) } }).find((f) => f.id === 'workout-fastest-5k');
    assert.ok(found);
    assert.match(found!.text, /^31:40 from kilometre 2 to 6 of your run on 11 October\. Your best before that in the past year was 33:10\.$/);
  });
});

describe('the same pace at a lower heart rate', () => {
  /** `each` runs at 6:40 /km in each of the last two stretches of 4 weeks, every fourth day. */
  const runs = (before: number, now: number, each = 6) => {
    const recent = Array.from({ length: each }, (_, i) => 1 + 4 * i);
    const earlier = recent.map((ago) => ago + 28);
    return daysWith(60, (ago) =>
      recent.includes(ago) || earlier.includes(ago)
        ? { workouts: [workout({ distanceKm: 6, activeMin: 40, avgHr: ago < 28 ? now : before })] }
        : {},
    );
  };

  it('says so when the last 4 weeks took 3 bpm or more less than the 4 before', () => {
    const found = cards(runs(145, 140)).find((f) => f.id === 'workout-same-pace-run');
    assert.ok(found);
    assert.equal(found!.text, 'Your runs at about 6:40 /km took 140 bpm on average over the last 4 weeks, down from 145 in the 4 weeks before. Your heart is doing less work for the same speed.');
  });

  it('not for a smaller drop, a rise, or too few runs', () => {
    assert.equal(cards(runs(142, 140)).some((f) => f.id === 'workout-same-pace-run'), false);
    assert.equal(cards(runs(140, 145)).some((f) => f.id === 'workout-same-pace-run'), false);
    assert.equal(cards(runs(145, 140, 5)).some((f) => f.id === 'workout-same-pace-run'), false);
  });
});

describe('strength days', () => {
  const lifting = (every: number) => daysWith(60, (ago) => (ago % every === 3 ? { workouts: [workout({ type: 'WEIGHTLIFTING' })] } : {}));

  it('says how far under two a week the last 4 weeks were, for someone who lifts', () => {
    const found = cards(lifting(9)).find((f) => f.id === 'workout-strength-days');
    assert.ok(found);
    assert.equal(found!.text, 'You did strength training on 3 days in the last 4 weeks. Guidelines suggest at least 2 days a week, or 8 in 4 weeks.');
  });

  it('never for someone who reaches it, or who doesn’t lift at all', () => {
    assert.equal(cards(lifting(3)).some((f) => f.id === 'workout-strength-days'), false);
    assert.equal(cards(daysWith(60, () => ({}))).some((f) => f.id === 'workout-strength-days'), false);
  });

  it('notices protein short of the target on strength days, from whole days of food', () => {
    const day = (protein: number): DayNutrition => ({
      kcal: 2200, proteinG: protein, carbsG: 250, fatG: 80, fibreG: 25, mealKinds: ['breakfast', 'lunch', 'dinner'],
      meals: [{ minutes: 480, kcal: 500, proteinG: 20, carbsG: 60, fatG: 15 }, { minutes: 1140, kcal: 900, proteinG: 40, carbsG: 90, fatG: 30 }],
    });
    const days = daysWith(40, (ago) =>
      ago % 7 === 3 ? { workouts: [workout({ type: 'WEIGHTLIFTING' })], nutrition: day(80) } : { nutrition: day(125) },
    );
    const found = cards(days, { protein: 120 }).find((f) => f.id === 'workout-strength-protein');
    assert.ok(found);
    assert.equal(found!.text, 'On your strength days you ate 80 g of protein on average, under your 120 g target. On other days you reach it.');
  });
});

describe('a late hard workout', () => {
  const night = (bedtimeMin: number) => ({ bedtimeMin } as SleepSession);
  /** Hard workouts ending at 22:00 on `late` days; asleep at 23:00, or 23:30 after them. */
  const evenings = (late: number[], today: boolean) =>
    daysWith(40, (ago) => {
      const hard = late.includes(ago) || (today && ago === 0);
      const previous = late.includes(ago + 1);
      return {
        sleep: ago === 0 && !previous ? night(23 * 60) : night(previous ? 23 * 60 + 30 : 23 * 60),
        workouts: hard ? [workout({ startMin: 21 * 60, elapsedMin: 60, zones: { light: 10, moderate: 20, vigorous: 25, peak: 5 } })] : [],
      };
    });

  it('on its evening, says how much later sleep has come after such workouts', () => {
    const found = cards(evenings([3, 8, 13, 18, 23], true), { now: EVENING }).find((f) => f.id === 'workout-late-sleep');
    assert.ok(found);
    assert.equal(found!.text, 'Tonight’s Run ended at 22:00. After hard workouts that end this late, you’ve fallen asleep about 30 minutes later than usual.');
    assert.deepEqual(found!.daypart, ['evening']);
  });

  it('not on other days, nor without the person’s own pattern', () => {
    assert.equal(cards(evenings([3, 8, 13, 18, 23], false), { now: EVENING }).some((f) => f.id === 'workout-late-sleep'), false);
    assert.equal(cards(evenings([3, 8], true), { now: EVENING }).some((f) => f.id === 'workout-late-sleep'), false);
  });
});
