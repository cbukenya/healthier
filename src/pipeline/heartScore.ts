import { addDays, type CivilDate } from '../lib/date';
import type { DailyRecord } from '../types/health';
import { WHO_WEEK } from './goals';
import { ownReading as own } from './sources';

/**
 * The heart score: a slow score out of 100 for how the heart is doing, from four parts, each turned
 * into 0–100 on a fixed rule and then averaged by weight.
 *
 * - Activity, 35%: brisk minutes a week over 4 weeks, moderate plus vigorous counting double, as the
 *   WHO counts them, on the AHA's Life's Essential 8 table (≥150 a week scores 100). The largest
 *   share: the clearest outcome evidence (about 31% lower mortality at the guideline against none,
 *   Arem et al. 2015) and the part people can change fastest. Minutes of movement, not heart-rate
 *   zone minutes: a less fit heart reaches its zones at lower effort, so zone minutes would partly
 *   reward a weaker heart and cancel against the other parts.
 * - Cardio fitness, 30%: Google's own level for the VO2 max it estimates, for your age and sex. The
 *   strongest single predictor (each 1 MET about 13% lower mortality, Kodama et al. 2009), but an
 *   estimate, partly worked out from resting heart rate, so not more than this. Steepest at the
 *   bottom: leaving the least-fit group matters most (Blair et al. 1989).
 * - Resting heart rate, 25%: the median of the last 60 days, from the same source. About 9% higher
 *   mortality per 10 bpm (Zhang et al. 2016), still there after allowing for fitness (Jensen et al.
 *   2013), and the steadiest thing a wrist measures (Quer et al. 2020). Never marked down for being low.
 * - HRV trend, 10%: the last 4 weeks against the 4 before, on the log scale. Low HRV goes with more
 *   heart events (Hillebrand et al. 2013), but Google's nightly figure has no population norms, so
 *   only its direction counts, and nothing links a trend to outcomes: the smallest share.
 *
 * Every window holds a whole menstrual cycle or more, so the cycle's swings in resting heart rate
 * and HRV average out. Everything fits in the dashboard's 62 days, so today's score never needs
 * the stored history; the trend reads the same rules on older days.
 */

export type HeartPart = 'activity' | 'fitness' | 'restingHr' | 'hrv';

/** The parts, in the order ties go: what changes fastest first. */
export const HEART_PARTS: readonly HeartPart[] = ['activity', 'fitness', 'restingHr', 'hrv'];

/** How much each part counts, in percent. */
export const HEART_WEIGHTS: Record<HeartPart, number> = { activity: 35, fitness: 30, restingHr: 25, hrv: 10 };

export type HeartStage = 'thriving' | 'strong' | 'building' | 'low';

/** Where each stage starts, highest first. */
export const HEART_STAGES: readonly { id: HeartStage; min: number }[] = [
  { id: 'thriving', min: 85 },
  { id: 'strong', min: 70 },
  { id: 'building', min: 50 },
  { id: 'low', min: 0 },
];

export const stageOf = (score: number): HeartStage => (HEART_STAGES.find((s) => score >= s.min) ?? HEART_STAGES[3]).id;

/** The stage above, and the score it starts at; null at the top. */
export function nextStage(score: number): { id: HeartStage; min: number } | null {
  const above = HEART_STAGES.filter((s) => s.min > score);
  return above.length ? above[above.length - 1] : null;
}

/** Fewer parts than this and there's no score yet. */
export const HEART_PARTS_NEEDED = 3;

// ───────────────────────────────────────────────────────────── each part's points

/** Life's Essential 8's physical activity points, for brisk minutes a week. */
export function activityPoints(perWeek: number): number {
  if (perWeek >= WHO_WEEK) return 100;
  if (perWeek >= 120) return 90;
  if (perWeek >= 90) return 80;
  if (perWeek >= 60) return 60;
  if (perWeek >= 30) return 40;
  if (perWeek >= 1) return 20;
  return 0;
}

/** Points for Google's cardio fitness levels, steepest at the bottom. */
export const FITNESS_POINTS: Record<string, number> = {
  POOR: 20,
  FAIR: 40,
  AVERAGE: 60,
  GOOD: 75,
  VERY_GOOD: 90,
  EXCELLENT: 100,
};

/** 100 at 60 bpm or below, 2.5 points less for each bpm above, 0 from 100 bpm. */
export const restingHrPoints = (bpm: number): number => Math.max(0, Math.min(100, 100 - 2.5 * (bpm - 60)));

/**
 * 50 for no change, 1.25 points for each percent up or down, so ±40% reaches 0 or 100. A month's HRV
 * often sits 10–20% off the month before with nothing wrong; at twice the slope, replays of real
 * history had this part swinging between 0 and 100 from month to month and the score with it.
 */
export const hrvTrendPoints = (changePct: number): number => Math.max(0, Math.min(100, 50 + 1.25 * changePct));

// ───────────────────────────────────────────────────────────── the windows

/** Days the activity average reads, ending the day before: today's is still under way. */
export const ACTIVITY_DAYS = 28;
const ACTIVITY_MIN_DAYS = 7;
/** Days the resting heart rate median reads, and the readings it needs. */
export const RESTING_DAYS = 60;
const RESTING_MIN_READINGS = 14;
/** The HRV trend's two blocks, each this long, and the readings each needs. */
export const HRV_BLOCK_DAYS = 28;
const HRV_MIN_READINGS = 10;
/** How old the latest fitness level may be and still count. */
const FITNESS_MAX_AGE_DAYS = 30;

export interface ActivityReading { points: number; perWeek: number }
export interface FitnessReading { points: number; vo2Max: number; level: string }
export interface RestingReading { points: number; bpm: number }
export interface HrvReading { points: number; changePct: number }

export interface HeartParts {
  activity?: ActivityReading;
  fitness?: FitnessReading;
  restingHr?: RestingReading;
  hrv?: HrvReading;
}

export interface HeartScore {
  date: CivilDate;
  /** Null while fewer than HEART_PARTS_NEEDED parts can be read. */
  score: number | null;
  stage: HeartStage | null;
  parts: HeartParts;
  /** Each present part's weight among the parts there are, as a share of 1. */
  shares: Partial<Record<HeartPart, number>>;
  /** Points each part could still add to the score, at most. */
  gains: Partial<Record<HeartPart, number>>;
  /** The part with the most points still to gain: what would help most. */
  lever: HeartPart | null;
  /**
   * From Thriving, the strongest part instead: what keeps it there. Always, even with a weaker part:
   * a Thriving score is news to celebrate, and the part most often weak at the top is the HRV trend,
   * the noisiest and smallest, which would flip the card between praise and advice month to month.
   */
  keep: HeartPart | null;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const inRange = (days: DailyRecord[], from: CivilDate, to: CivilDate) => days.filter((d) => d.date >= from && d.date <= to);

function activityOn(days: DailyRecord[], end: CivilDate): ActivityReading | undefined {
  const span = inRange(days, addDays(end, -ACTIVITY_DAYS), addDays(end, -1)).filter((d) => d.activeMinutes);
  if (span.length < ACTIVITY_MIN_DAYS) return undefined;
  const total = span.reduce((a, d) => a + d.activeMinutes!.moderate + 2 * d.activeMinutes!.vigorous, 0);
  const perWeek = (total / span.length) * 7;
  return { points: activityPoints(perWeek), perWeek };
}

function fitnessOn(days: DailyRecord[], end: CivilDate): FitnessReading | undefined {
  const latest = inRange(days, addDays(end, -(FITNESS_MAX_AGE_DAYS - 1)), end)
    .filter((d) => d.vo2Max !== null && d.cardioFitnessLevel && FITNESS_POINTS[d.cardioFitnessLevel] !== undefined)
    .at(-1);
  if (!latest) return undefined;
  return { points: FITNESS_POINTS[latest.cardioFitnessLevel!], vo2Max: latest.vo2Max!, level: latest.cardioFitnessLevel! };
}

function restingOn(days: DailyRecord[], end: CivilDate): RestingReading | undefined {
  const bpm = inRange(days, addDays(end, -(RESTING_DAYS - 1)), end).map((d) => own(d, 'restingHr')).filter((v): v is number => v !== null);
  if (bpm.length < RESTING_MIN_READINGS) return undefined;
  const m = median(bpm);
  return { points: restingHrPoints(m), bpm: m };
}

function hrvOn(days: DailyRecord[], end: CivilDate): HrvReading | undefined {
  const logs = (from: CivilDate, to: CivilDate) =>
    inRange(days, from, to).map((d) => own(d, 'hrv')).filter((v): v is number => v !== null && v > 0).map(Math.log);
  const recent = logs(addDays(end, -(HRV_BLOCK_DAYS - 1)), end);
  const before = logs(addDays(end, -(2 * HRV_BLOCK_DAYS - 1)), addDays(end, -HRV_BLOCK_DAYS));
  if (recent.length < HRV_MIN_READINGS || before.length < HRV_MIN_READINGS) return undefined;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const changePct = (Math.exp(mean(recent) - mean(before)) - 1) * 100;
  return { points: hrvTrendPoints(changePct), changePct };
}

/** The heart score as of `end`, from the days up to it. Days may be the window, or the window with stored history before it. */
export function heartScoreOn(days: DailyRecord[], end: CivilDate): HeartScore {
  const parts: HeartParts = {
    activity: activityOn(days, end),
    fitness: fitnessOn(days, end),
    restingHr: restingOn(days, end),
    hrv: hrvOn(days, end),
  };
  const present = HEART_PARTS.filter((p) => parts[p]);
  const none = { date: end, score: null, stage: null, parts, shares: {}, gains: {}, lever: null, keep: null };
  if (present.length < HEART_PARTS_NEEDED) return none;

  const total = present.reduce((a, p) => a + HEART_WEIGHTS[p], 0);
  const shares = Object.fromEntries(present.map((p) => [p, HEART_WEIGHTS[p] / total])) as Partial<Record<HeartPart, number>>;
  const points = (p: HeartPart) => parts[p]!.points;
  const score = Math.round(present.reduce((a, p) => a + shares[p]! * points(p), 0));
  const gains = Object.fromEntries(present.map((p) => [p, shares[p]! * (100 - points(p))])) as Partial<Record<HeartPart, number>>;
  const stage = stageOf(score);

  // Ties go to the earlier part: reduce keeps the first of equals, compared to a hundredth of a point.
  const best = (by: (p: HeartPart) => number) => present.reduce((a, p) => (Math.round(by(p) * 100) > Math.round(by(a) * 100) ? p : a));
  const settled = stage === 'thriving';
  return {
    date: end, score, stage, parts, shares, gains,
    lever: settled ? null : best((p) => gains[p]!),
    keep: settled ? best(points) : null,
  };
}

export interface HeartTrendPoint {
  date: CivilDate;
  score: number | null;
}

/** The score at the end of each of the last `weeks` weeks, a week apart and ending on `end`, oldest first. */
export function heartScoreTrend(days: DailyRecord[], end: CivilDate, weeks = 26): HeartTrendPoint[] {
  return Array.from({ length: weeks }, (_, k) => {
    const date = addDays(end, -7 * (weeks - 1 - k));
    return { date, score: heartScoreOn(days, date).score };
  });
}

/** How the score has moved: at least this many points either way is rising or falling. */
export const HEART_MOVE = 3;

/** Where the score was about 3 months back (or as far as the trend reaches, from 4 weeks), and which way it has gone. */
export function heartDirection(trend: HeartTrendPoint[]): { from: HeartTrendPoint; change: number; direction: 'rising' | 'steady' | 'falling' } | null {
  const now = trend.at(-1);
  if (!now || now.score === null) return null;
  const scored = trend.filter((p) => p.score !== null);
  const back = scored.filter((p) => p.date <= addDays(now.date, -84)).at(-1) ?? scored.find((p) => p.date <= addDays(now.date, -28));
  if (!back) return null;
  const change = now.score - back.score!;
  return { from: back, change, direction: change >= HEART_MOVE ? 'rising' : change <= -HEART_MOVE ? 'falling' : 'steady' };
}
