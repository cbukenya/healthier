import type { CivilDate } from '../lib/date';
import type { DailyRecord, DayNutrition, Meal } from '../types/health';
import { stats, theilSen } from './derive';

/**
 * What the Nutrition page works out from the food log (read in pipeline/nutrition.ts): which days
 * were logged in full, the average day, the person's maintenance from what they ate and how their
 * weight moved, and when they eat. Plain arithmetic on their own days; the page only draws it.
 */

/** Energy in a kilogram of body weight lost or gained, the long-standing rule of thumb (Wishnofsky 1958; Hall 2008). */
export const KCAL_PER_KG = 7700;

/**
 * A logged day below this is far more often missing meals than eaten that way: 800 kcal a day is
 * where a very-low-calorie diet begins (NICE CG189, 2014).
 */
export const LOW_DAY_KCAL = 800;

/** A day counts as logged in full when its meals run from the morning or midday into the evening. */
export const EVENING_MIN = 17 * 60;
export const FULL_DAY_SPAN_MIN = 6 * 60;

/**
 * Whether a day was logged in full, so it can count toward averages and maintenance. A day with
 * breakfast and lunch but no dinner almost always means dinner wasn't logged, not that it wasn't
 * eaten. When the log's times can't tell, its meal types can: a dinner and one more main meal.
 */
export function isComplete(n: DayNutrition): boolean {
  if (n.kcal < LOW_DAY_KCAL) return false;
  const first = n.meals[0];
  const last = n.meals[n.meals.length - 1];
  if (first && last && last.minutes >= EVENING_MIN && last.minutes - first.minutes >= FULL_DAY_SPAN_MIN) return true;
  return n.mealKinds.includes('dinner') && n.mealKinds.length >= 2;
}

export type DayLog = 'complete' | 'partial' | 'none' | 'today';

/** How a day's log counts: today is still going, so it's never judged. */
export function dayLog(d: DailyRecord, today: CivilDate): DayLog {
  if (d.date === today) return 'today';
  if (!d.nutrition) return 'none';
  return isComplete(d.nutrition) ? 'complete' : 'partial';
}

export interface Shares {
  protein: number;
  carbs: number;
  fat: number;
}

/**
 * How a day's energy splits between protein, carbs and fat, at 4, 4 and 9 kcal a gram (Atwater).
 * Fibre sits inside carbs, as total carbohydrate counts it.
 */
export function sharesOf(n: { proteinG: number; carbsG: number; fatG: number }): Shares | null {
  const p = n.proteinG * 4;
  const c = n.carbsG * 4;
  const f = n.fatG * 9;
  const e = p + c + f;
  return e > 0 ? { protein: p / e, carbs: c / e, fat: f / e } : null;
}

/**
 * The usual shares of energy for adults, carbs and fat: the Acceptable Macronutrient Distribution
 * Ranges (US National Academies, Dietary Reference Intakes, 2005). They describe eating over
 * months, so the page holds the average day to them, never a single day.
 */
export const USUAL_SHARE = { carbs: [45, 65], fat: [20, 35] } as const;

/** A day that reaches at least this much of a target is close to it. */
export const CLOSE_TO_TARGET = 0.85;

export type Standing = 'onTarget' | 'close' | 'short' | 'inRange' | 'above' | 'below';

/** How an amount stands against its target: on it, close to it, or short of it. */
export const towardTarget = (value: number, target: number): Standing =>
  value >= target ? 'onTarget' : value >= CLOSE_TO_TARGET * target ? 'close' : 'short';

/** How a share stands against its usual range, in whole percent as the page shows it. */
export function againstRange(share: number, [lo, hi]: readonly [number, number]): Standing {
  const pct = Math.round(share * 100);
  return pct < lo ? 'below' : pct > hi ? 'above' : 'inRange';
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface AverageDay {
  /** Finished days in the span, days with any food logged, and days logged in full. */
  finished: number;
  logged: number;
  complete: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  /** From the full days that recorded fibre; null when none did. */
  fibreG: number | null;
  meals: number;
  shares: Shares;
}

/** The span's average day, from the days logged in full; today is still going, so it waits. */
export function averageDay(span: DailyRecord[], today: CivilDate): AverageDay | null {
  const finished = span.filter((d) => d.date !== today);
  const full = finished.filter((d) => d.nutrition && isComplete(d.nutrition)).map((d) => d.nutrition!);
  if (!full.length) return null;
  const fibres = full.map((n) => n.fibreG).filter((v): v is number => v !== null);
  const avg = {
    proteinG: mean(full.map((n) => n.proteinG)),
    carbsG: mean(full.map((n) => n.carbsG)),
    fatG: mean(full.map((n) => n.fatG)),
  };
  return {
    finished: finished.length,
    logged: finished.filter((d) => d.nutrition).length,
    complete: full.length,
    kcal: mean(full.map((n) => n.kcal)),
    ...avg,
    fibreG: fibres.length ? mean(fibres) : null,
    meals: mean(full.map((n) => n.meals.length)),
    shares: sharesOf(avg)!,
  };
}

// ────────────────────────────────────────────────────────────── maintenance

/**
 * The blocks maintenance is worked out over, shortest first. Weight swings by half a kilo or more
 * from day to day with water and salt, so the trend needs weeks; a long block, though, blurs a
 * figure that drifts as weight and activity change. Each person gets the shortest block whose
 * figure is good to about ±MAINTENANCE_AIM, and none past ±MAINTENANCE_LIMIT.
 */
export const MAINTENANCE_BLOCKS = [21, 28, 42, 56] as const;
export const MAINTENANCE_AIM = 100;
export const MAINTENANCE_LIMIT = 250;

export interface Maintenance {
  /** What the body burns in a day, kcal. */
  kcal: number;
  /** Give or take, kcal: about 95% of the time the true figure is within it. */
  margin: number;
  /** The block it's worked out over, ending on `through`. */
  blockDays: number;
  through: CivilDate;
  /** What was eaten on the block's full days, their count, and the weigh-ins. */
  ateKcal: number;
  days: number;
  weighIns: number;
  kgPerWeek: number;
  /** What the person's devices estimate they burned over the block, when they recorded enough of it. */
  deviceKcal: number | null;
}

/**
 * Maintenance over the block ending at `end`: the average eaten on the full days, plus the energy
 * of the weight lost, or less that of the weight gained. The weight's slope is Theil–Sen, so one
 * odd weigh-in can't tilt it; the margin comes from the scatter around it and the spread of the
 * days eaten. Needs half the block logged in full, and six weigh-ins two weeks apart or more.
 */
export function maintenanceAt(days: DailyRecord[], end: number, blockDays: number): Maintenance | null {
  const start = end - blockDays + 1;
  if (start < 0 || end >= days.length) return null;
  const block = days.slice(start, end + 1);
  const ate = block.filter((d) => d.nutrition && isComplete(d.nutrition)).map((d) => d.nutrition!.kcal);
  if (ate.length < Math.ceil(blockDays / 2)) return null;
  const weights = block.flatMap((d, i) => (d.weightKg === null ? [] : [{ x: i, y: d.weightKg }]));
  if (weights.length < 6 || weights[weights.length - 1].x - weights[0].x < 14) return null;
  const slope = theilSen(weights);
  if (slope === null) return null;

  const n = weights.length;
  const mx = mean(weights.map((p) => p.x));
  const intercept = stats(weights.map((p) => p.y - slope * p.x))!.median;
  const sxx = weights.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const scatter = weights.reduce((a, p) => a + (p.y - intercept - slope * p.x) ** 2, 0) / (n - 2);
  const slopeError = Math.sqrt(scatter / sxx) * KCAL_PER_KG;
  const eaten = stats(ate)!;
  const eatenError = eaten.sd / Math.sqrt(ate.length);
  const burned = block.map((d) => d.totalKcal).filter((v): v is number => v !== null);

  return {
    kcal: Math.round(eaten.mean - slope * KCAL_PER_KG),
    margin: Math.round(1.96 * Math.hypot(slopeError, eatenError)),
    blockDays,
    through: block[block.length - 1].date,
    ateKcal: Math.round(eaten.mean),
    days: ate.length,
    weighIns: n,
    kgPerWeek: slope * 7,
    deviceKcal: burned.length >= blockDays / 2 ? Math.round(mean(burned)) : null,
  };
}

/** The index of the last finished day: today is still going. */
const lastFinished = (days: DailyRecord[], today: CivilDate) =>
  days.length && days[days.length - 1].date === today ? days.length - 2 : days.length - 1;

/** The person's maintenance now: from the shortest block that's good enough, through yesterday. */
export function latestMaintenance(days: DailyRecord[], today: CivilDate): Maintenance | null {
  const end = lastFinished(days, today);
  let fallback: Maintenance | null = null;
  for (const block of MAINTENANCE_BLOCKS) {
    const m = maintenanceAt(days, end, block);
    if (!m) continue;
    if (m.margin <= MAINTENANCE_AIM) return m;
    if (m.margin <= MAINTENANCE_LIMIT && (!fallback || m.margin < fallback.margin)) fallback = m;
  }
  return fallback;
}

/**
 * How maintenance has moved: the same block, worked out every 7 days back from yesterday as far
 * as `from`. Each point covers the block up to its own day, so neighbours overlap and the line is
 * smooth; a week without enough logged days or weigh-ins is a gap, not a guess.
 */
export function maintenanceTrend(days: DailyRecord[], today: CivilDate, from: CivilDate, blockDays: number): { date: CivilDate; value: number | null }[] {
  const out: { date: CivilDate; value: number | null }[] = [];
  for (let i = lastFinished(days, today); i >= 0 && days[i].date >= from; i -= 7) {
    out.push({ date: days[i].date, value: maintenanceAt(days, i, blockDays)?.kcal ?? null });
  }
  return out.reverse();
}

/** What the person's devices estimate they burn, on average over the last four weeks, when there's no maintenance yet. */
export function deviceBurn(days: DailyRecord[], today: CivilDate): number | null {
  const end = lastFinished(days, today);
  const burned = days.slice(Math.max(0, end - 27), end + 1).map((d) => d.totalKcal).filter((v): v is number => v !== null);
  return burned.length >= 14 ? Math.round(mean(burned)) : null;
}

// ────────────────────────────────────────────────────────────── the clock

export interface MealDay {
  date: CivilDate;
  meals: Meal[];
  shares: Shares | null;
  log: DayLog;
}

export interface MealClock {
  /** The last seven finished days, oldest first. */
  days: MealDay[];
  /** The person's usual bedtime and waking, minutes past midnight, over the last four weeks. */
  sleep: { bed: number; wake: number } | null;
  /** First meal to last, and last meal to bed, on average over the week's full days. */
  windowMin: number | null;
  lastToBedMin: number | null;
}

/** A bedtime on a clock that runs past midnight: 00:30 is 24:30, so the evening and the small hours average together. */
const late = (bed: number) => (bed < 12 * 60 ? bed + 24 * 60 : bed);

/** The week on the meal clock, with the person's usual sleep around it. */
export function mealClock(days: DailyRecord[], today: CivilDate): MealClock {
  const end = lastFinished(days, today);
  const week = days.slice(Math.max(0, end - 6), end + 1);
  const nights = days.slice(Math.max(0, end - 27), end + 2).map((d) => d.sleep).filter((s) => s !== null);
  const bed = stats(nights.map((s) => late(s.bedtimeMin)))?.median;
  const wake = stats(nights.map((s) => s.wakeMin))?.median;

  const windows: number[] = [];
  const toBed: number[] = [];
  for (const d of week) {
    const meals = d.nutrition && isComplete(d.nutrition) ? d.nutrition.meals : null;
    if (!meals || meals.length < 2) continue;
    const last = meals[meals.length - 1].minutes;
    windows.push(last - meals[0].minutes);
    const next = days[days.indexOf(d) + 1]?.sleep;
    if (next && late(next.bedtimeMin) > last) toBed.push(late(next.bedtimeMin) - last);
  }
  return {
    days: week.map((d) => ({
      date: d.date,
      meals: d.nutrition?.meals ?? [],
      shares: d.nutrition ? sharesOf(d.nutrition) : null,
      log: dayLog(d, today),
    })),
    sleep: bed !== undefined && wake !== undefined ? { bed: Math.round(bed) % (24 * 60), wake: Math.round(wake) } : null,
    windowMin: windows.length ? Math.round(mean(windows)) : null,
    lastToBedMin: toBed.length ? Math.round(mean(toBed)) : null,
  };
}

// ──────────────────────────────────────────────────────────── today's plate

/** The plate's squares: one for each 1% of the person's maintenance, split by the day's own mix. */
export function plateSquares(kcal: number, ref: number, shares: Shares | null): { protein: number; carbs: number; fat: number; total: number } {
  const total = Math.round((kcal / ref) * 100);
  if (!shares || total <= 0) return { protein: 0, carbs: 0, fat: 0, total: Math.max(0, total) };
  // Largest remainders, so the three always add up to the total.
  const raw = [shares.protein, shares.carbs, shares.fat].map((s) => s * total);
  const base = raw.map(Math.floor);
  const order = raw.map((r, i) => ({ i, rest: r - base[i] })).sort((a, b) => b.rest - a.rest);
  for (let k = 0; k < total - base.reduce((a, b) => a + b, 0); k++) base[order[k].i]++;
  return { protein: base[0], carbs: base[1], fat: base[2], total };
}

/** Past this hour, protein well short of the day's target gets a word about dinner. */
export const PROTEIN_CATCH_UP_FROM = 15 * 60;
/** Today's mix differs from the usual by this many points before the plate says so. */
export const MIX_SHIFT = 0.15;

export type PlateNote =
  | { kind: 'protein'; got: number; target: number }
  | { kind: 'mix'; macro: 'carbs' | 'fat'; share: number; usual: number }
  | null;

/**
 * One plain remark on today, or none: protein well behind late in the day, else a mix far from the
 * person's own usual. A single day is described, never judged.
 */
export function plateNote(today: DayNutrition, usual: Shares | null, proteinTarget: number | null, minutesNow: number): PlateNote {
  if (proteinTarget !== null && minutesNow >= PROTEIN_CATCH_UP_FROM && today.proteinG < 0.6 * proteinTarget) {
    return { kind: 'protein', got: Math.round(today.proteinG), target: proteinTarget };
  }
  const shares = sharesOf(today);
  if (!usual || !shares || today.kcal < LOW_DAY_KCAL) return null;
  for (const macro of ['carbs', 'fat'] as const) {
    if (Math.abs(shares[macro] - usual[macro]) >= MIX_SHIFT) return { kind: 'mix', macro, share: shares[macro], usual: usual[macro] };
  }
  return null;
}

export interface WaterSpan {
  /** Each day's water in litres, today's so far; null where nothing was logged. */
  points: { date: CivilDate; value: number | null }[];
  /** Finished days with water logged: what the average and the days on target count. */
  logged: number;
  /** Their average, in litres. */
  average: number | null;
  /** How many of them reached the target. */
  met: number;
  /** The most logged on one of them. */
  best: { date: CivilDate; litres: number } | null;
}

/**
 * Water across a span, from what was logged. A day with nothing logged is left out rather than
 * counted as none drunk, and today is drawn but not judged, as it's still going.
 */
export function waterSpan(span: DailyRecord[], today: CivilDate, targetL: number): WaterSpan {
  const points = span.map((d) => ({ date: d.date, value: d.hydrationL }));
  const done = span.filter((d) => d.date !== today && d.hydrationL !== null);
  const litres = done.map((d) => d.hydrationL!);
  const best = done.reduce<DailyRecord | null>((a, d) => (!a || d.hydrationL! > a.hydrationL! ? d : a), null);
  return {
    points,
    logged: done.length,
    average: litres.length ? litres.reduce((a, b) => a + b, 0) / litres.length : null,
    met: litres.filter((l) => l >= targetL).length,
    best: best ? { date: best.date, litres: best.hydrationL! } : null,
  };
}
