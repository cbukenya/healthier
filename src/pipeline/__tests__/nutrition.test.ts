import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { normalize, emptyRecord } from '../normalize';
import { STREAMS } from '../registry';
import { combineNutritionPoints } from '../nutrition';
import {
  KCAL_PER_KG, againstRange, averageDay, isComplete, latestMaintenance, maintenanceAt, maintenanceTrend, mealClock, plateNote,
  plateSquares, sharesOf, towardTarget,
} from '../eating';
import type { DailyRecord, DayNutrition } from '../../types/health';
import { compareDays, MIN_EACH } from '../insights/cards/nutrition';

const NUTRITION = STREAMS.find((s) => s.dataType === 'nutrition-log')!;

/** One logged food as Google Health lists it (v4 NutritionLog), at a local time on a date, two hours east of UTC. */
function entry(date: CivilDate, hhmm: string, food: { kcal?: number; protein?: number; carbs?: number; fat?: number; fibre?: number; meal?: string }, source: unknown = { recordingMethod: 'MANUAL', platform: 'FITBIT' }) {
  const [h, m] = hhmm.split(':').map(Number);
  const start = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m - 120) * 60_000;
  const [y, mo, d] = date.split('-').map(Number);
  return {
    dataSource: source,
    nutritionLog: {
      interval: {
        startTime: new Date(start).toISOString(), startUtcOffset: '7200s',
        civilStartTime: { date: { year: y, month: mo, day: d }, time: { hours: h, minutes: m } },
      },
      mealType: food.meal,
      ...(food.kcal !== undefined ? { energy: { kcal: food.kcal } } : {}),
      ...(food.carbs !== undefined ? { totalCarbohydrate: { grams: food.carbs } } : {}),
      ...(food.fat !== undefined ? { totalFat: { grams: food.fat } } : {}),
      nutrients: [
        ...(food.protein !== undefined ? [{ nutrient: 'PROTEIN', quantity: { grams: food.protein } }] : []),
        ...(food.fibre !== undefined ? [{ nutrient: 'DIETARY_FIBER', quantity: { grams: food.fibre } }] : []),
      ],
    },
  };
}

const read = (points: any[]) => normalize([{ stream: NUTRITION, points }]);

describe('the food log', () => {
  it('reads a day of logged foods into totals and meals', () => {
    const day = '2026-10-05';
    const { days } = read([
      entry(day, '07:30', { kcal: 300, protein: 12, carbs: 40, fat: 9, fibre: 4, meal: 'BREAKFAST' }),
      entry(day, '07:40', { kcal: 120, protein: 6, carbs: 10, fat: 6, meal: 'BREAKFAST' }),
      entry(day, '12:30', { kcal: 650, protein: 35, carbs: 70, fat: 22, fibre: 6, meal: 'LUNCH' }),
      entry(day, '19:10', { kcal: 800, protein: 45, carbs: 80, fat: 30, fibre: 9, meal: 'DINNER' }),
    ]);
    const n = days.get(day)!.nutrition!;
    assert.equal(n.kcal, 1870);
    assert.equal(n.proteinG, 98);
    assert.equal(n.carbsG, 200);
    assert.equal(n.fatG, 67);
    assert.equal(n.fibreG, 19, 'fibre from the foods that recorded it');
    assert.deepEqual(n.meals.map((m) => [m.minutes, m.kcal]), [[450, 420], [750, 650], [1150, 800]], 'two foods ten minutes apart are one breakfast');
    assert.deepEqual(n.mealKinds, ['breakfast', 'lunch', 'dinner']);
    assert.ok(days.get(day)!.present.includes('nutrition-log'));
  });

  it('works energy out from the macros when a food has none, and leaves fibre unknown when nothing recorded it', () => {
    const day = '2026-10-06';
    const n = read([entry(day, '13:00', { protein: 20, carbs: 50, fat: 10 })]).days.get(day)!.nutrition!;
    assert.equal(n.kcal, 20 * 4 + 50 * 4 + 10 * 9);
    assert.equal(n.fibreG, null);
  });

  it('keeps two apps logging the same day apart, never adding one on top of the other', () => {
    const day = '2026-10-07';
    const app = { recordingMethod: 'MANUAL', platform: 'ANDROID', application: { packageName: 'com.example.food' } };
    const result = read([
      entry(day, '08:00', { kcal: 500, protein: 20, carbs: 60, fat: 15 }),
      entry(day, '19:00', { kcal: 900, protein: 50, carbs: 90, fat: 30 }),
      entry(day, '08:05', { kcal: 480, protein: 19, carbs: 58, fat: 15 }, app),
      entry(day, '19:05', { kcal: 950, protein: 52, carbs: 95, fat: 32 }, app),
    ]);
    const kcal = result.days.get(day)!.nutrition!.kcal;
    assert.ok(kcal === 1400 || kcal === 1430, `one source's day, not both added: ${kcal}`);
    const variants = result.variants.get('nutrition-log')!.get(day)!;
    assert.deepEqual([...variants.values()].map((r) => r.nutrition!.kcal).sort(), [1400, 1430], 'each source kept for the person to choose');
    assert.equal(combineNutritionPoints([]).length, 0);
  });
});

const n = (over: Partial<DayNutrition> = {}): DayNutrition => ({
  kcal: 2100, proteinG: 100, carbsG: 250, fatG: 80, fibreG: 22, mealKinds: ['breakfast', 'lunch', 'dinner'],
  meals: [{ minutes: 450, kcal: 500, proteinG: 20, carbsG: 60, fatG: 18 }, { minutes: 760, kcal: 700, proteinG: 35, carbsG: 80, fatG: 25 }, { minutes: 1150, kcal: 900, proteinG: 45, carbsG: 110, fatG: 37 }],
  ...over,
});

/** `count` days ending yesterday before 2026-10-12, each with the given food and weight. */
function daysOf(count: number, food: (i: number) => DayNutrition | null, weight: (i: number) => number | null, burned = 2400): DailyRecord[] {
  return Array.from({ length: count + 1 }, (_, i) => {
    const d = emptyRecord(addDays('2026-10-12', i - count));
    d.nutrition = i < count ? food(i) : null;
    d.weightKg = i < count ? weight(i) : null;
    d.totalKcal = burned;
    return d;
  });
}

describe('the Nutrition page', () => {
  it('counts a day only when it was logged into the evening', () => {
    assert.equal(isComplete(n()), true);
    assert.equal(isComplete(n({ meals: n().meals.slice(0, 2), mealKinds: ['breakfast', 'lunch'], kcal: 1200 })), false, 'no dinner logged');
    assert.equal(isComplete(n({ kcal: 600 })), false, 'too little for a whole day');
    assert.equal(isComplete(n({ meals: [], mealKinds: ['lunch', 'dinner'] })), true, 'meal types tell when the times can\'t');
  });

  it('works maintenance out from what was eaten and how the weight moved', () => {
    // 2,000 kcal eaten every day while the weight falls 0.05 kg a day: the body burns 2,000 + 0.05 × 7,700.
    const days = daysOf(28, () => n({ kcal: 2000 }), (i) => (i % 2 ? null : 80 - 0.05 * i));
    const m = maintenanceAt(days, 27, 28)!;
    assert.equal(m.kcal, Math.round(2000 + 0.05 * KCAL_PER_KG));
    assert.equal(m.ateKcal, 2000);
    assert.equal(m.days, 28);
    assert.equal(m.weighIns, 14);
    assert.ok(Math.abs(m.kgPerWeek + 0.35) < 1e-9);
    assert.ok(m.margin < 5, 'a perfect line leaves almost nothing in doubt');
    assert.equal(m.deviceKcal, 2400);
    assert.deepEqual(latestMaintenance(days, '2026-10-12')?.blockDays, 21, 'the shortest block that is good enough');
  });

  it('says nothing about maintenance without enough logged days or weigh-ins', () => {
    assert.equal(latestMaintenance(daysOf(28, (i) => (i % 3 ? null : n()), (i) => 80 - 0.01 * i), '2026-10-12'), null, 'a third of the days logged');
    assert.equal(latestMaintenance(daysOf(28, () => n(), (i) => (i % 7 ? null : 80)), '2026-10-12'), null, 'four weigh-ins');
  });

  it('follows maintenance week by week, leaving gaps rather than guessing', () => {
    const days = daysOf(70, (i) => (i < 20 ? null : n({ kcal: 2000 })), (i) => 80 - 0.02 * i);
    const trend = maintenanceTrend(days, '2026-10-12', addDays('2026-10-12', -60), 28);
    assert.equal(trend.at(-1)!.date, '2026-10-11', 'ending yesterday');
    assert.equal(trend.at(-1)!.value, Math.round(2000 + 0.02 * KCAL_PER_KG));
    assert.equal(trend[0].value, null, 'a block from before the log began');
  });

  it('averages the span\'s full days only, and judges them against targets and the usual ranges', () => {
    const span = daysOf(10, (i) => (i === 3 ? n({ kcal: 500, meals: [], mealKinds: ['breakfast'] }) : n()), () => null);
    const avg = averageDay(span, '2026-10-12')!;
    assert.equal(avg.finished, 10);
    assert.equal(avg.logged, 10);
    assert.equal(avg.complete, 9);
    assert.equal(avg.kcal, 2100);
    assert.equal(towardTarget(105, 113), 'close');
    assert.equal(towardTarget(90, 113), 'short');
    assert.equal(towardTarget(113, 113), 'onTarget');
    assert.equal(againstRange(0.354, [20, 35]), 'inRange', '35% as shown is inside 20–35%');
    assert.equal(againstRange(0.71, [45, 65]), 'above');
    const s = sharesOf({ proteinG: 100, carbsG: 250, fatG: 80 })!;
    assert.ok(Math.abs(s.protein + s.carbs + s.fat - 1) < 1e-9);
  });

  it('fills the plate a square for each 1% of maintenance, split by the day\'s own mix', () => {
    const squares = plateSquares(1240, 2300, sharesOf({ proteinG: 68, carbsG: 150, fatG: 41 }));
    assert.equal(squares.total, 54);
    assert.equal(squares.protein + squares.carbs + squares.fat, 54);
    assert.equal(plateSquares(2530, 2300, null).total, 110, 'past maintenance the plate spills over');
  });

  it('says one plain thing about today, only when it matters', () => {
    const usual = { protein: 0.2, carbs: 0.46, fat: 0.34 };
    const lowProtein = n({ kcal: 1780, proteinG: 40, carbsG: 315, fatG: 40 });
    assert.deepEqual(plateNote(lowProtein, usual, 113, 18 * 60 + 30), { kind: 'protein', got: 40, target: 113 });
    assert.equal(plateNote(lowProtein, usual, 113, 10 * 60)?.kind, 'mix', 'in the morning, protein isn\'t behind yet');
    assert.equal(plateNote(n(), usual, 113, 18 * 60), null, 'an ordinary day');
  });

  it('puts the week on the clock with the person\'s usual sleep', () => {
    const days = daysOf(10, () => n(), () => null);
    for (const d of days) d.sleep = { bedtimeMin: 23 * 60 + 30, wakeMin: 7 * 60 } as DailyRecord['sleep'];
    const clock = mealClock(days, '2026-10-12');
    assert.equal(clock.days.length, 7);
    assert.equal(clock.days.at(-1)!.date, '2026-10-11');
    assert.deepEqual(clock.sleep, { bed: 23 * 60 + 30, wake: 7 * 60 });
    assert.equal(clock.windowMin, 1150 - 450);
    assert.equal(clock.lastToBedMin, 23 * 60 + 30 - 1150);
  });
});

describe('the Nutrition page\'s patterns', () => {
  /** Days alternating between the two sides, the condition's side `diff` higher, with a little scatter. */
  const pairsOf = (n: number, diff: number, flipLaterHalf = false) =>
    Array.from({ length: n }, (_, i) => {
      const side = i % 3 === 0;
      const later = i >= n / 2;
      const shift = side ? (flipLaterHalf && later ? -diff : diff) : 0;
      return { date: addDays('2026-08-01', i), side, value: 2000 + shift + ((i * 37) % 11) * 10 };
    });

  it('says a pattern only with enough days on both sides and a difference that matters', () => {
    assert.ok(compareDays(pairsOf(45, 300), 150), 'fifteen days against thirty, 300 apart');
    assert.equal(compareDays(pairsOf(45, 100), 150), null, 'real, but too small to matter');
    assert.equal(compareDays(pairsOf(3 * (MIN_EACH - 1), 300), 150), null, 'too few days on the condition\'s side');
  });

  it('needs the earlier and the later of the condition\'s days to agree', () => {
    assert.equal(compareDays(pairsOf(60, 400, true), 150), null, 'higher early on, lower later: no pattern');
  });
});

