import { daysBetween } from '../lib/date';
import { SECOND_HALF_DAYS, type Cycle, type CycleSummary } from './cycle';

/**
 * The phases of a cycle as the Cycle page names and draws them: where each one likely begins, how
 * sure that is, and how far a day or a length may be off. Arithmetic over the summary only; the
 * colours are the page's (views/cycleColours.ts).
 *
 * Nothing here is measured directly. A period is logged or found in the nights; the luteal phase is
 * counted back from the next period (SECOND_HALF_DAYS); ovulation is put the day before it. So
 * every boundary but a logged period's edge blends over the days it could fall on.
 */

export type Phase = 'menstrual' | 'follicular' | 'ovulation' | 'earlyLuteal' | 'lateLuteal';

/** How far a start found in the nights may be off, either way: 7 in 10 of those shown are within 3 days (mcPHASES). */
export const FOUND_START_DAYS = 3;
/** A cycle whose start and end were both found: the two errors together, about 4 days. */
export const BOTH_FOUND_DAYS = 4;
/** A period's length when only its start is known and none has been logged with an end. */
const DEFAULT_PERIOD_DAYS = 5;
/** The late luteal phase: the last days before the next period. */
const LATE_LUTEAL_DAYS = 5;
/**
 * Days a boundary blends over. A found period's end; the luteal phase's start when it is counted
 * back from a logged next period, from the cycle under way's likely one, or from a found one; and
 * the late luteal phase's start.
 */
const PERIOD_BLEND = 2;
const LUTEAL_BLEND_LOGGED = 2;
const LUTEAL_BLEND_UNDER_WAY = 3;
const LUTEAL_BLEND_FOUND = 4;
const LATE_BLEND = 2;
/** Ovulation shows on days where it is at least this likely, against the likely day. */
const OVULATION_FLOOR = 0.1;

/** One cycle's phases, by cycle day (day 1 is the period's first). */
export interface CycleShape {
  /** The period's days: as logged, or the usual logged length, or DEFAULT_PERIOD_DAYS. */
  periodDays: number;
  /** The start was found in the nights rather than logged. */
  foundStart: boolean;
  periodBlend: number;
  /** The luteal phase's first day, or null when it can't be placed yet. */
  luteal: number | null;
  lutealBlend: number;
  /** The late luteal phase's first day, or null with no length to count from. */
  lateFrom: number | null;
  lateBlend: number;
  /** The cycle's length, or for the one under way the typical length, when there is one. */
  length: number | null;
}

/** The phases of one of the summary's cycles; `next` is the cycle after it, if any. */
export function cycleShape(cycle: Cycle, next: Cycle | null, summary: CycleSummary): CycleShape {
  const underWay = cycle.next === null;
  const typical = summary.length?.typical ?? summary.early?.typical ?? null;
  const length = cycle.length ?? (underWay ? typical : null);
  const luteal = cycle.rise
    ? daysBetween(cycle.start, cycle.rise) + 1
    : underWay && typical !== null ? typical - SECOND_HALF_DAYS + 1 : null;
  return {
    periodDays: cycle.periodDays ?? summary.period?.typical ?? DEFAULT_PERIOD_DAYS,
    foundStart: cycle.source === 'found',
    periodBlend: cycle.source === 'found' ? PERIOD_BLEND : 0,
    luteal,
    lutealBlend: underWay ? LUTEAL_BLEND_UNDER_WAY : next?.source === 'logged' ? LUTEAL_BLEND_LOGGED : LUTEAL_BLEND_FOUND,
    lateFrom: length !== null && luteal !== null ? Math.max(luteal + 1, length - LATE_LUTEAL_DAYS + 1) : null,
    lateBlend: LATE_BLEND,
    length,
  };
}

/** The shape of the cycle under way, or null without one. */
export function currentShape(summary: CycleSummary): CycleShape | null {
  return summary.current ? cycleShape(summary.current, null, summary) : null;
}

/** The phase a day is named by: crisp, for words; drawings use phaseMix and ovulationOn. */
export function phaseOn(day: number, shape: CycleShape): Phase {
  if (day <= shape.periodDays) return 'menstrual';
  if (shape.luteal === null) return 'follicular';
  const ovulation = shape.luteal - 1;
  if (Math.abs(day - ovulation) <= 1) return 'ovulation';
  if (day < shape.luteal) return 'follicular';
  if (shape.lateFrom !== null && day >= shape.lateFrom) return 'lateLuteal';
  return 'earlyLuteal';
}

/** How far through a boundary at `at`, blended over `blend` days either side: 0 before, 1 after. */
const through = (day: number, at: number, blend: number) =>
  blend > 0 ? Math.max(0, Math.min(1, (day - (at - blend)) / (2 * blend))) : day >= at ? 1 : 0;

/** How much of each phase a day carries, for drawing the blends between them. The weights add to 1. */
export function phaseMix(day: number, shape: CycleShape): Record<Exclude<Phase, 'ovulation'>, number> {
  const pastPeriod = through(day, shape.periodDays + 0.5, shape.periodBlend);
  const pastLuteal = shape.luteal === null ? 0 : through(day, shape.luteal - 0.5, shape.lutealBlend);
  const pastLate = shape.lateFrom === null ? 0 : through(day, shape.lateFrom - 0.5, shape.lateBlend);
  return {
    menstrual: 1 - pastPeriod,
    follicular: pastPeriod * (1 - pastLuteal),
    earlyLuteal: pastPeriod * pastLuteal * (1 - pastLate),
    lateLuteal: pastPeriod * pastLuteal * pastLate,
  };
}

/** How likely ovulation is on a day against its likely day: 1 there, fading over the days it could be. */
export function ovulationOn(day: number, shape: CycleShape): number {
  if (shape.luteal === null) return 0;
  const spread = (1 + shape.lutealBlend) / 2;
  const likely = Math.exp(-0.5 * ((day - (shape.luteal - 1)) / spread) ** 2);
  return likely >= OVULATION_FLOOR ? likely : 0;
}

/** The likely day of ovulation, and the days either side it could be on. */
export function ovulationWindow(shape: CycleShape): { day: number; spread: number } | null {
  return shape.luteal === null ? null : { day: shape.luteal - 1, spread: 1 + shape.lutealBlend };
}

/** How far today's day count may be off, either way: a found start's error, else none. */
export const dayPlusMinus = (cycle: Cycle) => (cycle.source === 'found' ? FOUND_START_DAYS : 0);

/** How far a cycle's length may be off: none with both ends logged, more with each end found. */
export function lengthPlusMinus(cycle: Cycle, next: Cycle | null): number {
  const found = (cycle.source === 'found' ? 1 : 0) + (next?.source === 'found' ? 1 : 0);
  return found === 2 ? BOTH_FOUND_DAYS : found === 1 ? FOUND_START_DAYS : 0;
}
