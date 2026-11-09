import { civilFromGH, civilFromInstant, type CivilDate } from '../lib/date';
import { int, num } from './coerce';
import type { DayNutrition, Meal, MealKind } from '../types/health';

/**
 * Reading the food log.
 *
 * Google Health keeps food as `nutrition-log` points, one per logged food: what it was, when, its
 * meal type, its energy and its macros (`energy.kcal`, `totalCarbohydrate.grams`, `totalFat.grams`,
 * and protein and fibre among `nutrients`). People log in the Google Health app, or in an app that
 * writes to it through Health Connect or Apple Health; Healthier only reads.
 *
 * The points are listed rather than rolled up, because a daily total can't say when the meals
 * were. A day's points from one source are folded into one day (combineNutritionPoints) before
 * the registry applies them, so two apps logging the same day stay apart, and the day's reading
 * is picked from one of them, the way every reading is (pipeline/sources.ts).
 */

/** The main meals a log can name; snacks and unnamed entries count toward the day but not here. */
const MEAL_KINDS: Record<string, MealKind> = { BREAKFAST: 'breakfast', LUNCH: 'lunch', DINNER: 'dinner' };

/**
 * Entries this close together are one meal: a main and a side logged a few minutes apart. Long
 * enough for a slow dinner, short enough that lunch and an afternoon snack stay two.
 */
export const MEAL_GAP_MIN = 45;

interface Entry {
  minutes: number | null;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fibreG: number | null;
  kind: MealKind | null;
}

const grams = (q: any) => num(q?.grams ?? q?.gramsSum);

function nutrient(c: any, name: string): number | null {
  const hit = Array.isArray(c?.nutrients) ? c.nutrients.find((n: any) => n?.nutrient === name) : undefined;
  return hit ? grams(hit.quantity) : null;
}

/** Where an entry sits: its civil date, and minutes past midnight when the log says. */
export function entryTime(c: any): { date: CivilDate; minutes: number | null } | null {
  const iv = c?.interval;
  const date = civilFromGH(iv?.civilStartTime?.date);
  const time = iv?.civilStartTime?.time;
  if (date && time) return { date, minutes: (int(time.hours) ?? 0) * 60 + (int(time.minutes) ?? 0) };
  const at = civilFromInstant(iv?.startTime, iv?.startUtcOffset);
  if (at) return { date: at.date, minutes: at.minutesOfDay };
  return date ? { date, minutes: null } : null;
}

/** One logged food, or null when it holds neither energy nor any macro. */
function readEntry(c: any): Entry | null {
  const proteinG = nutrient(c, 'PROTEIN');
  const carbsG = grams(c?.totalCarbohydrate) ?? nutrient(c, 'CARBOHYDRATES');
  const fatG = grams(c?.totalFat);
  const fibreG = nutrient(c, 'DIETARY_FIBER');
  const logged = num(c?.energy?.kcal);
  if (logged === null && proteinG === null && carbsG === null && fatG === null) return null;
  // An entry with macros and no energy: 4 kcal a gram of protein and carbohydrate, 9 of fat (Atwater).
  const kcal = logged ?? (proteinG ?? 0) * 4 + (carbsG ?? 0) * 4 + (fatG ?? 0) * 9;
  return {
    minutes: entryTime(c)?.minutes ?? null,
    kcal,
    proteinG: proteinG ?? 0,
    carbsG: carbsG ?? 0,
    fatG: fatG ?? 0,
    fibreG,
    kind: MEAL_KINDS[c?.mealType] ?? null,
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A day's entries as one day: its totals, and its entries grouped into meals by time. */
export function dayOf(entries: Entry[]): DayNutrition {
  const timed = entries.filter((e) => e.minutes !== null).sort((a, b) => a.minutes! - b.minutes!);
  const meals: Meal[] = [];
  let last: number | null = null;
  for (const e of timed) {
    const meal = meals[meals.length - 1];
    if (meal && last !== null && e.minutes! - last <= MEAL_GAP_MIN) {
      meal.kcal += e.kcal;
      meal.proteinG += e.proteinG;
      meal.carbsG += e.carbsG;
      meal.fatG += e.fatG;
    } else {
      meals.push({ minutes: e.minutes!, kcal: e.kcal, proteinG: e.proteinG, carbsG: e.carbsG, fatG: e.fatG });
    }
    last = e.minutes;
  }
  const sum = (get: (e: Entry) => number) => entries.reduce((a, e) => a + get(e), 0);
  const fibres = entries.map((e) => e.fibreG).filter((v): v is number => v !== null);
  return {
    kcal: Math.round(sum((e) => e.kcal)),
    proteinG: r1(sum((e) => e.proteinG)),
    carbsG: r1(sum((e) => e.carbsG)),
    fatG: r1(sum((e) => e.fatG)),
    fibreG: fibres.length ? r1(fibres.reduce((a, b) => a + b, 0)) : null,
    meals: meals.map((m) => ({ ...m, kcal: Math.round(m.kcal), proteinG: r1(m.proteinG), carbsG: r1(m.carbsG), fatG: r1(m.fatG) })),
    mealKinds: (['breakfast', 'lunch', 'dinner'] as const).filter((k) => entries.some((e) => e.kind === k)),
  };
}

/**
 * The registry's `prepare` for the food log: each source's entries on each day folded into one
 * point, `{ dataSource, nutritionLog: { day, nutrition } }`, so the registry applies a whole day
 * at once and a second app's day is a second reading, never added on top.
 */
export function combineNutritionPoints(points: any[]): any[] {
  const groups = new Map<string, { dataSource: unknown; day: CivilDate; entries: Entry[] }>();
  for (const dp of points) {
    const c = dp?.nutritionLog;
    const at = entryTime(c);
    const entry = c && at ? readEntry(c) : null;
    if (!at || !entry) continue;
    const key = `${at.date}|${JSON.stringify(dp.dataSource ?? null)}`;
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { dataSource: dp.dataSource, day: at.date, entries: [entry] });
  }
  return [...groups.values()].map((g) => ({ dataSource: g.dataSource, nutritionLog: { day: g.day, nutrition: dayOf(g.entries) } }));
}
