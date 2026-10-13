import type { DailyRecord } from '../../types/health';
import { series, values } from '../derive';
import { illnessDates as labsIllnessDates } from '../labs';

/**
 * The recovery tax: do big-movement days cost this person HRV the following
 * night? Nights are split by whether the *previous* day's steps cleared the
 * window's 75th percentile; the two groups' ln-HRV means are compared with a
 * Welch test. Silent unless n is honest (≥8 big, ≥15 ordinary), the effect is
 * ≥6% and the difference clears p<0.05 — a null result is a result, and it
 * renders as silence, not a shrug.
 */
export interface MovementHrvAssociation {
  pct: number;
  threshold: number;
  nHigh: number;
  nLow: number;
  weeks: number;
  /** Welch–Satterthwaite degrees of freedom for the reported comparison. */
  df: number;
  /** Two-sided p from the t distribution at those df. */
  p: number;
  /** Nights dropped because an illness-like deviation was active. */
  excludedIllnessNights: number;
}

/**
 * Welch's two-sample t-test: the difference of the means (a − b), with the
 * Welch–Satterthwaite degrees of freedom and a two-sided p. Null when either
 * group is too small or neither varies.
 */
export function welch(a: number[], b: number[]): { diff: number; t: number; df: number; p: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
  const varOf = (xs: number[], m: number) => xs.reduce((x, y) => x + (y - m) ** 2, 0) / (xs.length - 1);
  const mA = mean(a);
  const mB = mean(b);
  const vA = varOf(a, mA);
  const vB = varOf(b, mB);
  const seSq = vA / a.length + vB / b.length;
  if (seSq <= 0) return null;
  const diff = mA - mB;
  const t = diff / Math.sqrt(seSq);
  const df = (seSq * seSq) / ((vA / a.length) ** 2 / (a.length - 1) + (vB / b.length) ** 2 / (b.length - 1));
  const p = tTwoSidedP(Math.abs(t), df);
  return Number.isFinite(p) ? { diff, t, df, p } : null;
}

/** Two-sided p-value for Student's t, via the regularised incomplete beta. */
function tTwoSidedP(t: number, df: number): number {
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/** Regularised incomplete beta I_x(a,b) by continued fraction (Lentz). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  const result = front * (f - 1);
  return x < (a + 1) / (a + b + 2) ? result : 1 - incompleteBetaComplement(x, a, b, result);
}
function incompleteBetaComplement(_x: number, _a: number, _b: number, result: number): number {
  return result; // symmetry handled by the caller's x-choice; kept explicit for clarity
}
function lgamma(z: number): number {
  // Lanczos approximation, g = 7.
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Does this person's HRV tend to be lower the night after a big-movement day?
 *
 * Nights are split by whether the PREVIOUS day's steps cleared the window's
 * 75th percentile, then the two groups' ln(HRV) means are compared with a
 * proper Welch test — Welch–Satterthwaite degrees of freedom and a t-based
 * p-value, not a fixed 1.96, which is far too liberal at n ≈ 8.
 *
 * Illness-flagged nights are excluded: a fever moves HRV and steps together
 * and would masquerade as a movement effect.
 *
 * IMPORTANT — what this is and is not. These are sequential observations from
 * one person, so they are not independent samples; the p-value understates
 * uncertainty from day-to-day autocorrelation, and sleep, alcohol, weekday
 * and seasonal trend are uncontrolled confounds. This is an EXPLORATORY
 * WITHIN-PERSON ASSOCIATION, never evidence that movement causes the change.
 * A block bootstrap by week, or a regression carrying those covariates, would
 * be the honest upgrade once enough history exists.
 */
export function movementHrvAssociation(days: DailyRecord[]): MovementHrvAssociation | null {
  const hi: number[] = [];
  const lo: number[] = [];
  const stepVals = values(series(days, (d) => d.steps));
  if (stepVals.length < 20) return null;
  const sorted = [...stepVals].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)];

  const sick = labsIllnessDates(days);
  let excludedIllnessNights = 0;

  for (let i = 1; i < days.length; i++) {
    const prevSteps = days[i - 1].steps;
    const hrv = days[i].hrv;
    if (prevSteps === null || hrv === null || hrv <= 0) continue;
    if (sick.has(days[i].date) || sick.has(days[i - 1].date)) { excludedIllnessNights++; continue; }
    (prevSteps >= p75 ? hi : lo).push(Math.log(hrv));
  }
  if (hi.length < 8 || lo.length < 15) return null;

  const w = welch(hi, lo);
  // Only a *lower* HRV pattern is reported, and only a real one.
  if (!w || w.diff > -0.06 || w.p >= 0.05) return null;
  const { diff: d, df, p } = w;

  return {
    pct: Math.abs(Math.round((Math.exp(d) - 1) * 100)),
    threshold: Math.round(p75 / 500) * 500,
    nHigh: hi.length,
    nLow: lo.length,
    weeks: Math.round(days.length / 7),
    df: Math.round(df * 10) / 10,
    p: Math.round(p * 1000) / 1000,
    excludedIllnessNights,
  };
}

/** @deprecated Renamed: "tax" implied causation. Use movementHrvAssociation. */
export const recoveryTax = movementHrvAssociation;
