import { addDays, daysBetween, weekdayIndex, type CivilDate } from '../lib/date';
import { t, type MessageKey } from '../i18n';
import { formatCivil, formatDuration, formatFixed, formatRounded } from '../i18n/format';
import type { DailyRecord, HealthDataset, SleepSession } from '../types/health';
import { scoreSleep } from './sleep';
import { fillSource } from './sources';

/**
 * Derived analytics. Every function here is pure: rows in, numbers out, no fetching,
 * no dates from the system clock. That's what makes them testable, and it's why the
 * numbers on screen can be traced back to a payload.
 *
 * The organising idea across the whole app: **a raw value is close to useless.**
 * "HRV 44 ms" means nothing on its own. "44 ms, versus a 28-day baseline of 34 ±6,
 * so unusually high" is actionable. So every metric flows through the same
 * `compareToBaseline` treatment, and the UI reads one consistent shape.
 */

export interface Point {
  date: CivilDate;
  value: number | null;
  /**
   * The source of a value that isn't its stream's first choice (a fill, pipeline/sources.ts).
   * A comparison reads a point only against earlier points from the same source.
   */
  source?: string;
}

export type Accessor = (d: DailyRecord) => number | null;

/** Extract one metric as a date-aligned series, nulls preserved. */
export function series(days: DailyRecord[], get: Accessor): Point[] {
  return days.map((d) => {
    const value = get(d);
    const source = fillSource(d, get, value);
    return source === undefined ? { date: d.date, value } : { date: d.date, value, source };
  });
}

export const values = (s: Point[]): number[] =>
  s.map((p) => p.value).filter((v): v is number => v !== null);

// ─────────────────────────────────────────────────────────────── statistics

export interface Stats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  sd: number;
  /** Median absolute deviation — robust to the one 17,915-step day. */
  mad: number;
  sum: number;
  first: number;
  last: number;
}

export function stats(input: number[]): Stats | null {
  const v = input.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = quantile(sorted, 0.5);
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const mad = quantile([...v.map((x) => Math.abs(x - median))].sort((a, b) => a - b), 0.5);
  return {
    n,
    mean,
    median,
    min: sorted[0],
    max: sorted[n - 1],
    sd: Math.sqrt(variance),
    mad,
    sum,
    first: v[0],
    last: v[n - 1],
  };
}

export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** Trailing rolling mean over `window` days. Null until enough observations exist. */
export function rollingMean(s: Point[], window: number, minPoints = Math.ceil(window / 2)): Point[] {
  return s.map((p, i) => {
    const slice = values(s.slice(Math.max(0, i - window + 1), i + 1));
    return {
      date: p.date,
      value: slice.length >= minPoints ? slice.reduce((a, b) => a + b, 0) / slice.length : null,
    };
  });
}

// ───────────────────────────────────────────────────────────────── baselines

export type Band = 'far-below' | 'below' | 'typical' | 'above' | 'far-above';

export interface Comparison {
  date?: string;
  value: number | null;
  /** Robust centre of the trailing window, excluding the day being judged. */
  baseline: number | null;
  spread: number | null;
  delta: number | null;
  deltaPct: number | null;
  /** Robust z-score: (value − median) / (1.4826 × MAD). */
  z: number | null;
  band: Band | null;
  /** Observations behind the baseline — the UI hides bands below ~10. */
  n: number;
  /** The value came from a source other than its stream's first choice, and is judged against that source's own readings. */
  source?: string;
}

const NEUTRAL: Comparison = {
  value: null, baseline: null, spread: null, delta: null,
  deltaPct: null, z: null, band: null, n: 0,
};

/** "Usual" is the days before a reading: this many of them, and at least this many with readings. */
export const BASELINE_DAYS = 28;
export const BASELINE_MIN_READINGS = 8;

/**
 * Compare the latest observation against its own recent history.
 * Uses median + MAD rather than mean + SD: health series are spiky, and one
 * 12,000-step Saturday shouldn't move the definition of "normal".
 */
export function compareToBaseline(s: Point[], window = BASELINE_DAYS, minPoints = BASELINE_MIN_READINGS, floor = 0): Comparison {
  if (!s.length) return NEUTRAL;
  const lastIdx = lastIndexWithValue(s);
  if (lastIdx < 0) return NEUTRAL;
  const value = s[lastIdx].value!;
  // Like with like: a reading is judged only against earlier readings from the same source.
  const source = s[lastIdx].source;
  const priors = values(s.slice(Math.max(0, lastIdx - window), lastIdx).filter((p) => p.source === source));
  const date = s[lastIdx].date;
  const from = source === undefined ? {} : { source };
  if (priors.length < minPoints) {
    return { ...NEUTRAL, value, date, n: priors.length, ...from };
  }
  const st = stats(priors)!;
  const spread = spreadOf(priors, st, floor);
  const delta = value - st.median;
  const z = spread > 0 ? delta / spread : 0;
  return {
    date,
    value,
    baseline: st.median,
    spread,
    delta,
    deltaPct: st.median !== 0 ? (delta / Math.abs(st.median)) * 100 : null,
    z,
    band: bandFor(z),
    n: priors.length,
    ...from,
  };
}

/**
 * The spread a baseline claims: max(robust, classical, floor). A flat baseline
 * must not turn a genuine jump into z = 0 ("typical"), nor a rounding wiggle into
 * a huge z. The classical SD is taken after clipping values beyond three robust
 * spreads, so one outlier night can't inflate it and mute a real change.
 */
function spreadOf(priors: number[], st: Stats, floor: number): number {
  const robust = st.mad * 1.4826;
  const lo = st.median - 3 * robust;
  const hi = st.median + 3 * robust;
  const sd = robust > 0 ? stats(priors.map((v) => Math.min(hi, Math.max(lo, v))))!.sd : st.sd;
  return Math.max(robust, sd, floor);
}

function bandFor(z: number): Band {
  if (z <= -2) return 'far-below';
  if (z <= -1) return 'below';
  if (z >= 2) return 'far-above';
  if (z >= 1) return 'above';
  return 'typical';
}

export function lastIndexWithValue(s: Point[]): number {
  for (let i = s.length - 1; i >= 0; i--) if (s[i].value !== null) return i;
  return -1;
}

export const latestPoint = (s: Point[]): Point | null => {
  const i = lastIndexWithValue(s);
  return i < 0 ? null : s[i];
};

/**
 * Whether a reading is current on `today`: from that day or the one before. Last night's sleep and
 * overnight vitals are keyed to the morning they ended, so "yesterday" still covers a device that hasn't
 * synced this morning; anything older is history, not last night.
 */
export function isRecent(date: CivilDate | null | undefined, today: CivilDate | null | undefined): boolean {
  return !!date && !!today && daysBetween(date, today) <= 1;
}

/**
 * The window without its last day. The window ends on the user's today, which is still in progress, so
 * movement read as whole days (averages, streaks, week on week, ramp) uses only finished ones. Overnight
 * readings are keyed to the morning they ended and don't need this.
 */
export const completedDays = (days: DailyRecord[]): DailyRecord[] => days.slice(0, -1);

/**
 * A metric's series keeping only readings from the device behind the latest one.
 * A new watch measures HRV and resting HR its own way; judged against the old
 * one's numbers it reads as a physiological change for weeks. Filtered like this,
 * the baseline restarts with the device. Days with no recorded source are kept.
 */
export function sameDevice(days: DailyRecord[], dataType: string, get: Accessor): Point[] {
  const s = series(days, get);
  // A fill (pipeline/sources.ts) keeps its own source, and is judged against that source's readings.
  let device: string | undefined;
  for (let i = days.length - 1; i >= 0 && device === undefined; i--) {
    if (s[i].value !== null && s[i].source === undefined) device = days[i].sourceByType?.[dataType] ?? '';
  }
  return s.map((p, i) => {
    const source = days[i].sourceByType?.[dataType];
    return p.value === null || p.source !== undefined || !(device && source && source !== device) ? p : { ...p, value: null };
  });
}

/** Mean of the most recent `n` observations (not the most recent n *days*). */
export function recentMean(s: Point[], n: number): number | null {
  const v = values(s);
  if (!v.length) return null;
  const tail = v.slice(-n);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

/** Compare two equal-length tails: "last 14 days vs the 14 before". */
export interface PeriodShift {
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPct: number | null;
  nCurrent: number;
  nPrevious: number;
}

export function periodShift(s: Point[], window: number): PeriodShift {
  const cur = values(s.slice(-window));
  const prev = values(s.slice(-window * 2, -window));
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const current = mean(cur);
  const previous = mean(prev);
  const delta = current !== null && previous !== null ? current - previous : null;
  return {
    current,
    previous,
    delta,
    deltaPct: delta !== null && previous ? (delta / Math.abs(previous)) * 100 : null,
    nCurrent: cur.length,
    nPrevious: prev.length,
  };
}

/**
 * First `n` observations vs the last `n` — the change across the whole window,
 * which is a different question from `periodShift`'s "this fortnight vs last".
 * Over a 62-day window the two can disagree sharply, and both are worth stating:
 * one is the trend, the other is the current move.
 */
export function windowShift(s: Point[], n: number): PeriodShift {
  const v = values(s);
  const head = v.slice(0, n);
  const tail = v.slice(-n);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const previous = mean(head);
  const current = mean(tail);
  const delta = current !== null && previous !== null ? current - previous : null;
  return {
    current,
    previous,
    delta,
    deltaPct: delta !== null && previous ? (delta / Math.abs(previous)) * 100 : null,
    nCurrent: tail.length,
    nPrevious: head.length,
  };
}

/** Least-squares slope per day, for "is this drifting" questions. */
export function slopePerDay(s: Point[]): number | null {
  const pts = s
    .map((p, i) => ({ x: i, y: p.value }))
    .filter((p): p is { x: number; y: number } => p.y !== null);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  const num = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  return den === 0 ? null : num / den;
}

// ────────────────────────────────────────────────────────── domain rollups

export interface GoalProgress {
  value: number | null;
  goal: number;
  pct: number | null;
  met: boolean;
}

export const goal = (value: number | null, target: number): GoalProgress => ({
  value,
  goal: target,
  pct: value === null ? null : (value / target) * 100,
  met: value !== null && value >= target,
});

/** Consecutive days (ending at the most recent day with data) meeting a predicate. */
export function currentStreak(s: Point[], meets: (v: number) => boolean): number {
  let streak = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i].value;
    if (v === null) break;
    if (!meets(v)) break;
    streak++;
  }
  return streak;
}

/**
 * Days in a row meeting a daily goal, up to today. Today joins the streak once it meets the goal, and
 * while it's still in progress it never breaks it.
 */
export function goalStreak(s: Point[], meets: (v: number) => boolean): number {
  const today = s[s.length - 1];
  return currentStreak(today && today.value !== null && meets(today.value) ? s : s.slice(0, -1), meets);
}

/**
 * Activity ramp: this week against the three weeks before it.
 *
 * Two deliberate departures from the familiar acute:chronic workload ratio.
 * First, the windows do not overlap — the classic form divides the last 7 days
 * by a 28-day mean that CONTAINS those same days, which mathematically damps
 * the ratio and couples numerator to denominator. Second, the name and copy
 * make no injury-risk claim: the ACWR literature's predictive interpretation
 * has been heavily criticised for exactly that coupling, for confounding and
 * for arbitrary categorisation. This answers only a descriptive question:
 * how different has this week been from what preceded it?
 */
export function loadRatio(s: Point[]): { acute: number | null; chronic: number | null; ratio: number | null } {
  const acute = recentMean(s.slice(-7), 7);
  const prior = recentMean(s.slice(-28, -7), 21);
  return {
    acute,
    chronic: prior,
    ratio: acute !== null && prior ? acute / prior : null,
  };
}

/** Bedtime consistency: SD of clock time, handling the midnight wrap. */
export function bedtimeConsistency(days: DailyRecord[]): { meanMin: number; sdMin: number; n: number } | null {
  const mins = days
    .map((d) => d.sleep?.bedtimeMin)
    .filter((m): m is number => m !== undefined && m !== null)
    // Fold post-midnight bedtimes onto the previous evening so 23:50 and 00:10
    // are 20 minutes apart, not 23 hours.
    .map((m) => (m < 12 * 60 ? m + 1440 : m));
  if (mins.length < 3) return null;
  const st = stats(mins)!;
  return { meanMin: st.mean % 1440, sdMin: st.sd, n: st.n };
}


/** Where the sleep-need estimate stops: never below 7 h, nor above 8.5 h, and 7.5 h before any nights. */
export const NEED_ESTIMATE = { floor: 420, ceiling: 510, fallback: 450 } as const;

/**
 * Personal sleep-need estimate: the median of your own recorded nights, clamped
 * to never fall below 7 h — chronic restriction must not be allowed to redefine
 * "enough" (Van Dongen 2003) — nor above 8.5 h. One definition, shared by
 * readiness, the debt insight and the duration insights, so no two cards can
 * ever argue about what a full night means.
 */
export function estimatedSleepTarget(days: DailyRecord[]): number {
  const nights = days
    .map((d) => d.sleep?.minutesAsleep ?? null)
    .filter((m): m is number => m !== null);
  const st = stats(nights);
  return st ? Math.min(NEED_ESTIMATE.ceiling, Math.max(NEED_ESTIMATE.floor, st.median)) : NEED_ESTIMATE.fallback;
}

/**
 * The sleep need every night is judged against: the person's own figure when
 * they've set one (a goal, on the Settings page), else the estimate from these nights.
 */
export const sleepNeedFor = (days: DailyRecord[], set?: number | null): number => set ?? estimatedSleepTarget(days);

// ─────────────────────────────────────────────────────────────── readiness

/** The battery's components. Code tells them apart by id: the label and detail are in the person's language. */
export type ReadinessPartId = 'hrv' | 'restingHr' | 'sleep' | 'sleepDebt' | 'breathing' | 'skinTemp' | 'strain';

/** The core signals: HRV, resting heart rate and sleep. */
export type ReadinessSignal = 'hrv' | 'restingHr' | 'sleep';

/** Cross-signal patterns: several overnight signals off at once. */
export type ReadinessFlag = 'illness';

export interface ReadinessPart {
  id: ReadinessPartId;
  label: string;
  contribution: number;
  detail: string;
  /** A caveat attached to this component, e.g. the HRV-saturation caution. */
  note?: string;
}

export interface Readiness {
  score: number | null;
  /** Signed contribution of each component, for an honest breakdown. */
  parts: ReadinessPart[];
  label: string;
  /** How much of the score rests on real data. */
  confidence: 'low' | 'medium' | 'high';
  /** Core signals (HRV, resting heart rate, sleep) with nothing current to score. */
  missing: ReadinessSignal[];
  /** Core signals waiting for enough nights from a new device: HRV and resting heart rate, the two judged per device. */
  calibrating: Exclude<ReadinessSignal, 'sleep'>[];
  /** Cross-signal patterns worth surfacing, e.g. an illness-like deviation. */
  flags: ReadinessFlag[];
}

/**
 * The battery's one scale: its tag, label, colour and legend all read from these.
 * Most ordinary mornings land in Balanced; Charged (80+) is rare by design, and
 * Drained sits where Google's readiness draws "low" (under 30).
 */
export const BATTERY_TIERS = [
  { min: 80, tag: 'CHARGED', label: 'today.battery.tiers.charged.label' },
  { min: 55, tag: 'BALANCED', label: 'today.battery.tiers.balanced.label' },
  { min: 30, tag: 'LOW', label: 'today.battery.tiers.low.label' },
  { min: 0, tag: 'DRAINED', label: 'today.battery.tiers.drained.label' },
] as const satisfies readonly { min: number; tag: string; label: MessageKey }[];

export const batteryTier = (score: number) => BATTERY_TIERS.find((tier) => score >= tier.min) ?? BATTERY_TIERS[3];

/**
 * Readiness v2 — grounded in the published literature rather than intuition.
 *
 * What the research supports, and where it shows up here:
 *
 *   1. HRV is analysed as ln(RMSSD), never raw milliseconds. Raw RMSSD is
 *      right-skewed; the log transform is standard across the sport-science
 *      literature (Plews et al. 2013, Sports Med; Buchheit 2014, Front Physiol).
 *   2. A single night of HRV is too noisy to act on — day-to-day CV runs
 *      10–20%. The established decision variable is a ~7-day rolling average
 *      judged against a longer baseline (Plews' smallest-worthwhile-change
 *      method). We blend: 60% last night (the acute signal readiness is asking
 *      about) + 40% the 7-day mean vs the same 28-day baseline (the trend).
 *   3. Abnormally HIGH HRV is not simply "better". Parasympathetic saturation —
 *      elevated HRV during heavy overload — is documented in overreached
 *      athletes (Le Meur et al. 2013). So the upside is capped, and a reading
 *      far above baseline earns at most +8 (never more than its blend would),
 *      carries a caution, and can't make the battery "fully charged".
 *   4. Resting-HR treatment is asymmetric. An elevated RHR is a robust strain /
 *      incipient-illness marker (Natarajan et al. 2020, npj Digit Med; Mishra
 *      et al. 2020, Nat Biomed Eng); a suppressed one is only mildly good news.
 *   5. Sleep counts twice, on purpose: last night against a personal need
 *      estimate, and the debt accumulated across the prior week — restriction
 *      compounds (Van Dongen et al. 2003, Sleep). The need estimate is the
 *      median of recent nights clamped to ≥7 h, so chronic short sleep cannot
 *      quietly redefine "enough". A need the person sets themselves (7–9 h, the
 *      same floor) replaces the estimate.
 *   6. Elevated breathing rate and skin temperature are penalty-only illness
 *      signals (the same multi-signal deviation logic behind the wearable
 *      illness-detection studies). Being below baseline earns nothing.
 *   7. Unusually hard recent activity drags the score slightly — kept small and
 *      penalty-only, mirroring the original Fitbit "activity fatigue" pillar.
 *      (Google's 2024 revision dropped activity entirely in favour of RHR; we
 *      keep a light version because the data is present and the mechanism is
 *      real, but it can never dominate.) Finished days only, in one unit.
 *
 * Baselines are judged per device: when the watch behind HRV or resting HR
 * changes, that component waits for its own baseline ("calibrating") rather
 * than reading the new device's numbers as a change in you.
 *
 * For scale: Fitbit/Google's current readiness uses exactly HRV + RHR + sleep;
 * Whoop weights HRV at roughly 60%; Oura leans hard on temperature deviation.
 * This sits between them, with every weight visible below and every component
 * returned as a signed, explained contribution.
 */
export function readiness(days: DailyRecord[], needSet?: number | null): Readiness {
  const parts: ReadinessPart[] = [];
  const flags: ReadinessFlag[] = [];
  let score = 70;
  // Only last night counts. The window ends on the user's today, and a reading from before yesterday is
  // history: with the watch on its charger for three days the honest answer is no score, not a confident
  // one built from the last night it happened to see.
  const today = days.length ? days[days.length - 1].date : null;
  const recent = (date: CivilDate | null | undefined) => isRecent(date, today);

  // ── 1. HRV, in the log domain, acute + trend blended ──────────────────────
  const HRV = 'daily-heart-rate-variability';
  const overnightAll = series(days, (d) => d.hrv);
  const overnight = sameDevice(days, HRV, (d) => d.hrv);
  const deep = sameDevice(days, HRV, (d) => d.hrvDeepSleep);
  const ln = (s: Point[]) => s.map((p) => ({ ...p, value: p.value === null || p.value <= 0 ? null : Math.log(p.value) }));
  // Deep-sleep RMSSD is the cleaner series when last night has it and it has a
  // baseline of its own; otherwise the overnight average, never nothing.
  const lastOvernight = latestPoint(overnight);
  const lastDeep = latestPoint(deep);
  const deepCmp = lastDeep && (!lastOvernight || lastDeep.date >= lastOvernight.date) ? lnComparison(ln(deep)) : null;
  const useDeep = deepCmp !== null;
  const hrvDate = (useDeep ? lastDeep : lastOvernight)?.date;
  const hrv = !recent(hrvDate) ? null : useDeep ? deepCmp : lnComparison(ln(overnight));
  let hrvOk = false;
  let hrvSpike = false;
  if (hrv) {
    hrvOk = true;
    const z = 0.6 * hrv.zAcute + 0.4 * hrv.zTrend;
    // Suppression costs down to −20; a rise earns up to +14.
    let c = z < 0 ? Math.max(z, -2.5) * 8 : Math.min(z, 1.75) * 8;
    let note: string | undefined;
    if (hrv.zAcute > 2.5) {
      // Saturation guard: a night far above baseline earns no more than a solidly
      // good one, never more than its own blend would, and can't make the battery
      // read "fully charged".
      hrvSpike = true;
      c = Math.min(c, 8);
      note = t('today.battery.parts.hrv.note');
    }
    score += c;
    parts.push({
      id: 'hrv',
      label: t('today.battery.parts.hrv.label'),
      contribution: c,
      detail: t('today.battery.parts.hrv.detail', {
        last: fmt(Math.exp(hrv.lastLn)),
        week: fmt(Math.exp(hrv.mean7Ln)),
        typical: fmt(Math.exp(hrv.baselineLn)),
        source: useDeep ? 'deep' : 'overnight',
      }),
      note,
    });
  }

  // ── 2. Resting heart rate, asymmetric ──────────────────────────────────────
  const RHR = 'daily-resting-heart-rate';
  const rhrAll = series(days, (d) => d.restingHr);
  const rhr = compareToBaseline(sameDevice(days, RHR, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);
  const rhrOk = rhr.z !== null && rhr.n >= 8 && recent(rhr.date);
  if (rhrOk) {
    const z = rhr.z!;
    const c = z <= 0 ? Math.min(-z, 1.5) * 4 : -Math.min(z, 2.5) * 6;
    score += c;
    parts.push({
      id: 'restingHr',
      label: t('today.battery.parts.restingHr.label'),
      contribution: c,
      detail: t('today.battery.parts.restingHr.detail', { value: fmt(rhr.value), typical: fmt(rhr.baseline) }),
    });
  }

  // ── 3. Sleep: Holistic Quality & Need from scoreSleep() ──────────────────
  // The person's own need when they've set one; the estimate from their nights otherwise.
  const need = sleepNeedFor(days, needSet);
  const latestNight = [...days].reverse().find((d) => d.sleep)?.sleep ?? null;
  const lastNight = latestNight && recent(latestNight.date) ? latestNight : null;
  const sleepOk = lastNight !== null;
  if (lastNight) {
    const durationDeltaH = (lastNight.minutesAsleep - need) / 60;
    const durationC = clamp(durationDeltaH * 5, -14, 8);
    
    // Architecture and efficiency: a small bonus for a deep, unbroken night, a
    // small penalty for a shallow or broken one. Efficiency here is scoreSleep's
    // 0–25 points (85–100% asleep in bed), not the percentage. The penalty is
    // floored at zero: a deep night can soften a broken one, never turn it into
    // a bonus.
    const sc = scoreSleep(lastNight);
    const rest = sc.restorativePct;
    const effPoints = sc.efficiency;
    let qualityBonus = 0;
    if (rest !== null) {
      if (rest >= 40 && effPoints >= 20) {
        qualityBonus = Math.min(2.5, (rest - 35) * 0.2);
      } else if (rest < 25 || effPoints < 8) {
        qualityBonus = -Math.min(3.5, Math.max(0, (30 - rest) * 0.15 + (12 - effPoints) * 0.15));
      }
    }
    const c = clamp(durationC + qualityBonus, -15, 9);
    score += c;

    // A need the person set is exact; the estimate from their nights reads "~".
    const slept = formatDuration(lastNight.minutesAsleep);
    const needText = needSet == null ? t('today.battery.parts.sleep.needApprox', { need: formatDuration(need) }) : formatDuration(need);

    parts.push({
      id: 'sleep',
      label: t('today.battery.parts.sleep.label'),
      contribution: c,
      detail: sc.restorativePct !== null
        ? t('today.battery.parts.sleep.detailStages', { slept, need: needText, restorative: sc.restorativePct, efficiency: lastNight.efficiency })
        : t('today.battery.parts.sleep.detail', { slept, need: needText }),
    });
  }

  // ── 4. Sleep debt over the week before last night (the one shared figure) ──
  const debt = lastNight ? sleepDebt(days, need) : null;
  if (debt) {
    const debtH = debt.netMin / 60;
    const c = clamp(-debtH * 1.1, -8, 3);
    if (Math.abs(c) >= 0.5) {
      score += c;
      parts.push({
        id: 'sleepDebt',
        label: t('today.battery.parts.sleepDebt.label'),
        contribution: c,
        detail:
          debtH > 0
            ? t('today.battery.parts.sleepDebt.short', { hours: formatFixed(debtH, 1), count: debt.nightsKnown })
            : t('today.battery.parts.sleepDebt.banked', { hours: formatFixed(-debtH, 1), count: debt.nightsKnown }),
      });
    }
  }

  // ── 5. Breathing rate: penalty-only illness signal ─────────────────────────
  const resp = compareToBaseline(series(days, (d) => d.respiratoryRate), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.respiratoryRate);
  const respOk = resp.z !== null && resp.n >= 8 && recent(resp.date);
  if (respOk && resp.z! > 1.25) {
    const c = -Math.min((resp.z! - 1.25) * 4, 8);
    score += c;
    parts.push({
      id: 'breathing',
      label: t('today.battery.parts.breathing.label'),
      contribution: c,
      detail: t('today.battery.parts.breathing.detail', { value: fmt(resp.value), typical: fmt(resp.baseline) }),
    });
  }

  // ── 6. Skin temperature deviation: penalty-only illness signal ─────────────
  const tempPoint = latestPoint(series(days, (d) => d.skinTempDeviationC));
  const tempDev = tempPoint && recent(tempPoint.date) ? tempPoint.value : null;
  if (tempDev !== null && tempDev > 0.3) {
    const c = -Math.min((tempDev - 0.3) * 10, 8);
    score += c;
    parts.push({
      id: 'skinTemp',
      label: t('today.battery.parts.skinTemp.label'),
      contribution: c,
      detail: t('today.battery.parts.skinTemp.detail', { value: formatFixed(tempDev, 2) }),
    });
  }

  // ── 7. Recent strain: what's left of the last two days' load this morning ──
  // Finished days only: today's total is still climbing, and the battery must not
  // fall as you walk. One unit throughout: Active Zone Minutes when the last four
  // weeks have them, steps otherwise. No baseline, no verdict.
  const done = completedDays(days);
  const azm = series(done, (d) =>
    d.zoneMinutes ? d.zoneMinutes.fatBurn + 2 * (d.zoneMinutes.cardio + d.zoneMinutes.peak) : null,
  );
  const loadSeries = values(azm.slice(-28)).length >= 8 ? azm : series(done, (d) => d.steps);
  const load = compareToBaseline(loadSeries);
  if (load.baseline !== null && load.spread !== null && load.spread > 0 && recent(load.date)) {
    // Yesterday at half weight and the day before at a quarter, over 1.75: the
    // arithmetic the battery was tuned with each morning, when today (weight 1)
    // still stood at zero. Now it stays that way all day.
    const [before, yesterday] = loadSeries.slice(-2).map((p) => p.value ?? 0);
    const acuteZ = ((yesterday ?? 0) * 0.5 + (before ?? 0) * 0.25) / 1.75 / load.spread - load.baseline / load.spread;
    if (acuteZ > 1.25) {
      const c = -Math.min((acuteZ - 1.25) * 3.5, 7);
      score += c;
      parts.push({
        id: 'strain',
        label: t('today.battery.parts.strain.label'),
        contribution: c,
        detail: t(acuteZ > 2.0 ? 'today.battery.parts.strain.high' : 'today.battery.parts.strain.raised'),
      });
    }
  }

  // ── 8. Cross-signal illness pattern ───────────────────────────────────────
  const offSignals = [
    rhrOk && rhr.z! >= 1.5,
    respOk && resp.z! >= 1.5,
    tempDev !== null && tempDev >= 0.5,
    hrv !== null && hrv.zAcute <= -1.5,
  ].filter(Boolean).length;
  if (offSignals >= 2) flags.push('illness');

  // A signal that has readings from another device in the window, but not yet
  // enough nights from the current one, is calibrating rather than missing.
  const newDevice = (all: Point[], current: Point[]) =>
    values(current).length < values(all).length && recent(latestPoint(current)?.date);
  const calibrating = [
    !hrvOk && newDevice(overnightAll, overnight) ? 'hrv' : null,
    !rhrOk && newDevice(rhrAll, sameDevice(days, RHR, (d) => d.restingHr)) ? 'restingHr' : null,
  ].filter((s): s is Readiness['calibrating'][number] => s !== null);
  const missing = [
    !hrvOk && !calibrating.includes('hrv') ? 'hrv' : null,
    !rhrOk && !calibrating.includes('restingHr') ? 'restingHr' : null,
    !sleepOk ? 'sleep' : null,
  ].filter((s): s is ReadinessSignal => s !== null);

  const coreSignals = (hrvOk ? 1 : 0) + (rhrOk ? 1 : 0) + (sleepOk ? 1 : 0);
  if (coreSignals === 0) {
    // Readings that exist but stopped before yesterday mean "not current", not "not enough".
    const newest = [latestPoint(overnightAll)?.date, latestPoint(rhrAll)?.date, latestNight?.date]
      .filter((d): d is CivilDate => !!d)
      .sort()
      .at(-1);
    return {
      score: null,
      parts: [],
      label: newest && !recent(newest) ? t('today.battery.noReadingsSince', { date: formatCivil(newest) }) : t('today.battery.notEnoughData'),
      confidence: 'low',
      missing,
      calibrating,
      flags: [],
    };
  }

  // An HRV spike is the reading the guard distrusts: it can't make the battery "fully charged".
  const final = Math.round(clamp(score, 1, hrvSpike ? BATTERY_TIERS[0].min - 1 : 100));
  return {
    score: final,
    parts,
    label: t(batteryTier(final).label),
    confidence: coreSignals >= 3 ? 'high' : coreSignals === 2 ? 'medium' : 'low',
    missing,
    calibrating,
    flags,
  };
}

/**
 * ln-domain comparison: last value and 7-observation mean, both z-scored
 * against the robust centre/spread of the four weeks *preceding* the last
 * seven days. The lag matters: if the baseline included the current week, a
 * sustained decline would drag its own reference down and stop reading as
 * anomalous — exactly the failure the smallest-worthwhile-change method
 * guards against by judging the rolling week against an earlier period.
 */
function lnComparison(lnSeries: Point[]): {
  lastLn: number;
  mean7Ln: number;
  baselineLn: number;
  zAcute: number;
  zTrend: number;
} | null {
  const lastIdx = lastIndexWithValue(lnSeries);
  if (lastIdx < 0) return null;
  // Calendar windows, not observation counts. Mixing the two (positional
  // baseline slice vs "last 7 valid readings") lets the recent window reach
  // back into baseline days whenever nights are missing, so the trend partly
  // compares observations against themselves. "Last week" stays a week; a
  // coverage minimum protects the mean instead.
  const end = Math.max(0, lastIdx - 7);
  // Like with like, as compareToBaseline: only the judged night's own source.
  const own = (s: Point[]) => s.filter((p) => p.source === lnSeries[lastIdx].source);
  const priors = values(own(lnSeries.slice(Math.max(0, end - BASELINE_DAYS), end)));
  if (priors.length < BASELINE_MIN_READINGS) return null;
  const st = stats(priors)!;
  const spread = spreadOf(priors, st, NOISE_FLOOR.lnHrv);
  if (spread <= 0) return null;
  const lastLn = lnSeries[lastIdx].value!;
  const recent = values(own(lnSeries.slice(Math.max(0, lastIdx - 6), lastIdx + 1)));
  if (recent.length < 4) return null; // ≥4 of the last 7 calendar nights
  const mean7Ln = recent.reduce((a, b) => a + b, 0) / recent.length;
  return {
    lastLn,
    mean7Ln,
    baselineLn: st.median,
    zAcute: (lastLn - st.median) / spread,
    zTrend: (mean7Ln - st.median) / spread,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Per-metric noise floors: the smallest spread a baseline is allowed to claim,
 * roughly the night-to-night repeatability of the measurement itself. Without
 * them a perfectly flat history makes every wiggle infinitely significant (or,
 * worse, makes a real jump read as z=0 when the spread is exactly zero).
 * Provisional engineering estimates, not published repeatability figures.
 */
export const NOISE_FLOOR = {
  restingHr: 1,      // bpm
  lnHrv: 0.05,       // ln(ms) ≈ 5%
  hrv: 1.5,          // ms
  respiratoryRate: 0.3, // breaths/min
  skinTempC: 0.1,    // °C
  sleepMin: 10,      // minutes
  spo2: 0.2,         // percentage points
  generic: 0,
} as const;
const fmt = (v: number | null) => (v === null ? '—' : formatRounded(v, 1));

// ─────────────────────────────────────── typical sleep window (circular)

/**
 * Mean of clock times, done properly. Clock time is circular: the arithmetic
 * mean of 23:30 and 00:30 is 12:00 noon, which is nonsense. Map each time to
 * an angle on the 24 h circle, average the unit vectors, and read the angle
 * back. The resultant length R falls out for free: R = 1 means every time was
 * identical, R → 0 means the times are scattered around the whole clock, and
 * the circular standard deviation √(−2 ln R) converts it into honest ± minutes.
 */
export function circularMeanMinutes(
  mins: number[],
): { mean: number; sdMin: number; n: number } | null {
  if (mins.length < 2) return null;
  let cx = 0;
  let cy = 0;
  for (const m of mins) {
    const a = (m / 1440) * 2 * Math.PI;
    cx += Math.cos(a);
    cy += Math.sin(a);
  }
  cx /= mins.length;
  cy /= mins.length;
  const r = Math.hypot(cx, cy);
  // Times spread uniformly around the clock have no meaningful centre.
  if (r < 0.1) return null;
  let a = Math.atan2(cy, cx);
  if (a < 0) a += 2 * Math.PI;
  return {
    mean: (a / (2 * Math.PI)) * 1440,
    sdMin: Math.sqrt(-2 * Math.log(r)) * (1440 / (2 * Math.PI)),
    n: mins.length,
  };
}

export interface TypicalSleepWindow {
  /** Circular-mean bedtime, minutes of day 0..1439. */
  bedMean: number;
  bedSdMin: number;
  /** Circular-mean wake time. */
  wakeMean: number;
  wakeSdMin: number;
  nights: number;
}

/** The window you actually keep, from main sessions in the given slice. */
export function typicalSleepWindow(days: DailyRecord[]): TypicalSleepWindow | null {
  const beds: number[] = [];
  const wakes: number[] = [];
  for (const d of days) {
    if (!d.sleep) continue;
    beds.push(d.sleep.bedtimeMin);
    wakes.push(d.sleep.wakeMin);
  }
  if (beds.length < 3) return null;
  const bed = circularMeanMinutes(beds);
  const wake = circularMeanMinutes(wakes);
  if (!bed || !wake) return null;
  return {
    bedMean: bed.mean,
    bedSdMin: bed.sdMin,
    wakeMean: wake.mean,
    wakeSdMin: wake.sdMin,
    nights: beds.length,
  };
}

// ─────────────────────────────────────────────── sleep regularity (SRI)

export type RegularityBand = 'excellent' | 'good' | 'bad' | 'critical';

export interface SleepRegularity {
  /** 0–100. 100 = the same asleep/awake state at every minute, day over day. */
  score: number;
  band: RegularityBand;
  /** Adjacent-day pairs actually compared (gap days are skipped, not zeroed). */
  pairs: number;
  /** Recorded nights inside the window. */
  nights: number;
}

/**
 * Sleep Regularity Index (Phillips et al. 2017, Sci Rep): build a minute-level
 * asleep/awake grid across the window, then score how often adjacent days agree
 * at the same clock minute, rescaled so 0 = chance and 100 = perfectly regular.
 * In the UK Biobank cohorts this index predicts outcomes better than sleep
 * duration does, which is what earns it a place on the chart.
 *
 * Three implementation choices that matter:
 *
 *   - **Naps count as sleep.** SRI is about state, not "main session". A night
 *     that officially started at 04:57 after a 23:44 nap is far less irregular
 *     than the main-session times alone suggest.
 *   - **A day participates only if its morning session was recorded**
 *     (`day.sleep !== null`). A pair where either day is unrecorded is skipped
 *     entirely — a sync gap must read as "unknown", never as an all-nighter.
 *   - **Fewer than 5 valid pairs returns null.** Below that the index is noise,
 *     and a badge shouting CRITICAL at a data gap would be worse than silence.
 *
 * Values run high by construction — daytime awake-awake agreement counts too —
 * so the bands are anchored to the Biobank distribution (most-irregular
 * quintile below ~71.6, median ≈ 81, most-regular above ~87), not to intuition.
 */
export function sleepRegularity(days: DailyRecord[]): SleepRegularity | null {
  const n = days.length;
  if (n < 2) return null;

  const grid = Array.from({ length: n }, () => new Uint8Array(1440));
  const covered = new Array<boolean>(n).fill(false);
  const EVENING = 18 * 60;

  /** Paint [start … end) across day boundaries, clamped to the window. */
  const paint = (startDay: number, startMin: number, endDay: number, endMin: number) => {
    for (let d = startDay; d <= endDay; d++) {
      if (d < 0 || d >= n) continue;
      const from = d === startDay ? startMin : 0;
      const to = d === endDay ? endMin : 1440;
      grid[d].fill(1, Math.max(0, from), Math.min(1440, to));
    }
  };

  days.forEach((day, i) => {
    const main = day.sleep;
    if (main) {
      covered[i] = true;
      // Main sessions are keyed to the wake date; an evening bedtime belongs to
      // the previous calendar day.
      const bedDay = main.bedtimeMin >= EVENING ? i - 1 : i;
      paint(bedDay, main.bedtimeMin, i, main.wakeMin);
    }
    for (const nap of day.naps) {
      // Naps are keyed to their start date; one that crosses midnight ends on
      // the next calendar day.
      const endDay = nap.wakeMin > nap.bedtimeMin ? i : i + 1;
      paint(i, nap.bedtimeMin, endDay, nap.wakeMin);
    }
  });

  let agree = 0;
  let total = 0;
  let pairs = 0;
  for (let d = 0; d + 1 < n; d++) {
    if (!covered[d] || !covered[d + 1]) continue;
    const a = grid[d];
    const b = grid[d + 1];
    let pairAgree = 0;
    let pairTotal = 0;
    for (let m = 0; m < 1440; m++) {
      // A minute participates only when its state is genuinely known on both
      // days. Mornings and daytime are known via that day's own recorded night;
      // an evening's state comes from the *next* night's bedtime, so evenings
      // next to a gap — or on the window's last day — are unknown, not awake.
      // Any minute already painted asleep is known by definition.
      const evening = m >= EVENING;
      const knownA = a[m] === 1 || !evening || (d + 1 < n && covered[d + 1]);
      const knownB = b[m] === 1 || !evening || (d + 2 < n && covered[d + 2]);
      if (!knownA || !knownB) continue;
      pairTotal++;
      if (a[m] === b[m]) pairAgree++;
    }
    // Guard against degenerate pairs with almost no comparable minutes.
    if (pairTotal < 600) continue;
    pairs++;
    agree += pairAgree;
    total += pairTotal;
  }
  if (pairs < 5) return null;

  const raw = -100 + 200 * (agree / total);
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  return {
    score,
    band: score >= 87 ? 'excellent' : score >= 80 ? 'good' : score >= 70 ? 'bad' : 'critical',
    pairs,
    nights: covered.filter(Boolean).length,
  };
}

/** Sleep debt over the week before last night, against a nightly need. */
export interface SleepDebt {
  /** Σ (need − slept): a long night pays back a short one. Negative is sleep banked. */
  netMin: number;
  nightsKnown: number;
  nights: number;
  /** 'full' ≥5 of 7 · 'partial' 3–4 (label it) · below 3 we return null. */
  coverage: 'full' | 'partial';
}

/**
 * Sleep debt: how far the week before last night fell short of your need,
 * netted. One definition for the battery, the insight and every card, so they
 * can't disagree. Last night is scored on its own, by the battery and the
 * morning card.
 *
 * Netted rather than summing shortfalls alone: half of any steady sleeper's
 * nights fall below their own median, so a sum of shortfalls fired on ordinary
 * night-to-night variation. A week with under 3 recorded nights gets no figure;
 * 3–4 is 'partial' and callers must label it an estimate.
 */
export function sleepDebt(days: DailyRecord[], needMin: number, nights = 7): SleepDebt | null {
  const last = [...days].reverse().find((d) => d.sleep);
  if (!last) return null;
  const from = addDays(last.date, -nights);
  const slept = days
    .filter((d) => d.sleep && d.date >= from && d.date < last.date)
    .map((d) => d.sleep!.minutesAsleep);
  if (slept.length < 3) return null;
  return {
    netMin: slept.reduce((a, m) => a + (needMin - m), 0),
    nightsKnown: slept.length,
    nights,
    coverage: slept.length >= 5 ? 'full' : 'partial',
  };
}

// ────────────────────────────────────────────────────────────── coverage

export interface Gap {
  from: CivilDate;
  to: CivilDate;
  days: number;
}

/**
 * Contiguous runs where a dataType recorded nothing.
 *
 * Only *interior* gaps are reported — the stretch before a stream's first
 * observation isn't a gap, it's the period before you owned the device or granted
 * the scope. Reporting it produced noise like "79 nights with no sleep record"
 * when the honest statement is "sleep data starts on 8 August".
 */
export function findGaps(days: DailyRecord[], dataType: string, minDays = 2): Gap[] {
  const firstIdx = days.findIndex((d) => d.present.includes(dataType));
  if (firstIdx < 0) return [];
  const scope = days.slice(firstIdx);

  const gaps: Gap[] = [];
  let start: CivilDate | null = null;
  let count = 0;
  for (const d of scope) {
    const has = d.present.includes(dataType);
    if (!has) {
      start ??= d.date;
      count++;
    } else if (start) {
      if (count >= minDays) gaps.push({ from: start, to: addDays(d.date, -1), days: count });
      start = null;
      count = 0;
    }
  }
  if (start && count >= minDays) {
    gaps.push({ from: start, to: scope[scope.length - 1].date, days: count });
  }
  return gaps;
}

/** The civil date a stream first recorded anything, or null if it never did. */
export function firstObserved(days: DailyRecord[], dataType: string): CivilDate | null {
  return days.find((d) => d.present.includes(dataType))?.date ?? null;
}

export interface CoverageRow {
  dataType: string;
  label: string;
  days: boolean[];
  observed: number;
  total: number;
  latest: CivilDate | null;
  /** Days since the most recent observation, relative to the window end. */
  staleDays: number | null;
}

export function coverage(
  days: DailyRecord[],
  streams: { dataType: string; label: string }[],
): CoverageRow[] {
  const end = days.length ? days[days.length - 1].date : null;
  return streams.map(({ dataType, label }) => {
    const flags = days.map((d) => d.present.includes(dataType));
    let latest: CivilDate | null = null;
    for (let i = days.length - 1; i >= 0; i--) {
      if (flags[i]) {
        latest = days[i].date;
        break;
      }
    }
    return {
      dataType,
      label,
      days: flags,
      observed: flags.filter(Boolean).length,
      total: flags.length,
      latest,
      staleDays: latest && end ? daysBetween(latest, end) : null,
    };
  });
}

// ─────────────────────────────────────────────────────── weekday patterns

export function byWeekday(s: Point[]): { weekday: number; mean: number | null; n: number }[] {
  const buckets: number[][] = Array.from({ length: 7 }, () => []);
  for (const p of s) if (p.value !== null) buckets[weekdayIndex(p.date)].push(p.value);
  return buckets.map((b, weekday) => ({
    weekday,
    mean: b.length ? b.reduce((a, c) => a + c, 0) / b.length : null,
    n: b.length,
  }));
}

// ─────────────────────────────────────────────────── sleep architecture

export interface SleepArchitecture {
  /** Minutes from sleep onset to the first sustained (≥5 min) REM bout. */
  remLatencyMin: number | null;
  /** NREM→REM cycles: each sustained REM bout closes one. */
  cycles: number;
  /**
   * Time in bed ÷ detected cycles. NOT a median cycle length — that would
   * require true cycle boundaries; this is the average span per detected
   * REM-terminated cycle, and consumer staging makes it run long.
   */
  minutesPerCycleApprox: number | null;
  /** Share of deep sleep landing in the first third of the night, 0–100. */
  deepFirstThirdPct: number | null;
  /** Distinct-stage transitions per hour of the sleep period. */
  transitionsPerHour: number | null;
  /** Staged awake bouts after onset (the hypnogram kind, not sub-minute). */
  awakenings: number;
}

/**
 * Architecture metrics from the hypnogram. Micro-bouts (<5 min) are collapsed
 * into their neighbours first — consumer staging flickers, and cycle counting
 * on raw segments would count the flicker. Trends against the person's own
 * history are the defensible claim; absolute values inherit consumer-staging
 * accuracy and are treated as sketches.
 */
export function sleepArchitecture(s: SleepSession): SleepArchitecture | null {
  if (!s.segments.length) return null;

  // Collapse micro-bouts into the previous stage.
  const merged: { stage: string; offsetMin: number; durationMin: number }[] = [];
  for (const seg of s.segments) {
    const prev = merged.at(-1);
    if (prev && (seg.durationMin < 5 && prev.stage !== seg.stage)) {
      prev.durationMin += seg.durationMin;
    } else if (prev && prev.stage === seg.stage) {
      prev.durationMin += seg.durationMin;
    } else {
      merged.push({ ...seg });
    }
  }

  const onset = merged.find((m) => m.stage !== 'awake');
  if (!onset) return null;

  let remLatencyMin: number | null = null;
  let cycles = 0;
  for (const m of merged) {
    if (m.stage === 'rem' && m.durationMin >= 5 && m.offsetMin >= onset.offsetMin) {
      cycles++;
      if (remLatencyMin === null) remLatencyMin = m.offsetMin - onset.offsetMin;
    }
  }

  const totalDeep = merged.filter((x) => x.stage === 'deep')
    .reduce((a, x) => a + x.durationMin, 0);
  const third = s.minutesInBed / 3;
  let deepFirst = 0;
  for (const x of merged) {
    if (x.stage !== 'deep') continue;
    const end = Math.min(x.offsetMin + x.durationMin, third);
    if (end > x.offsetMin) deepFirst += end - x.offsetMin;
  }

  // Computed from the MERGED hypnogram, like cycles and awakenings above:
  // counting raw segments would count consumer-staging flicker as
  // fragmentation and make the two halves of this card disagree.
  let transitions = 0;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].stage !== merged[i - 1].stage) transitions++;
  }

  const awakenings = merged.filter((m, i) => i > 0 && m.stage === 'awake' && i < merged.length - 1).length;

  return {
    remLatencyMin,
    cycles,
    minutesPerCycleApprox: cycles > 0 ? Math.round(s.minutesInBed / cycles) : null,
    deepFirstThirdPct: totalDeep > 0 ? Math.round((deepFirst / totalDeep) * 100) : null,
    transitionsPerHour: s.minutesInBed > 0 ? Math.round((transitions / s.minutesInBed) * 60 * 10) / 10 : null,
    awakenings,
  };
}

// ─────────────────────────────────────────────────── body composition

/** Theil–Sen slope: the median of all pairwise slopes. Robust for sparse manual logs. */
export function theilSen(points: { x: number; y: number }[]): number | null {
  if (points.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx !== 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  return stats(slopes)?.median ?? null;
}

export interface WeightTrend {
  kgPerWeek: number;
  readings: number;
  spanDays: number;
}

/**
 * Weekly weight trend from sparse weigh-ins, by Theil–Sen so one odd reading can't tilt it. Silent below
 * three readings spanning three weeks: two weigh-ins a few days apart are mostly water and noise.
 */
export function weightTrend(s: Point[]): WeightTrend | null {
  const pts = s.filter((p): p is { date: CivilDate; value: number } => p.value !== null);
  if (pts.length < 3) return null;
  const spanDays = daysBetween(pts[0].date, pts[pts.length - 1].date);
  if (spanDays < 21) return null;
  const slope = theilSen(pts.map((p) => ({ x: daysBetween(pts[0].date, p.date), y: p.value })));
  return slope === null ? null : { kgPerWeek: slope * 7, readings: pts.length, spanDays };
}

export interface BodyComposition {
  pairs: number;
  spanDays: number;
  /** Candidate pairs dropped because the two readings came from different devices. */
  rejectedForSource: number;
  weightKgPerWeek: number;
  fatKgPerWeek: number;
  leanKgPerWeek: number;
  latest: { date: CivilDate; weightKg: number; fatKg: number; leanKg: number };
}

/** A weigh-in paired with a body-fat reading from the same scale, and the fat and lean mass they give. */
export interface CompositionPair {
  /** The day's position in the series, for slopes across it. */
  x: number;
  date: CivilDate;
  weightKg: number;
  fatPct: number;
  fatKg: number;
  leanKg: number;
}

/** Weigh-ins paired with body-fat readings, oldest first, by the rules below. */
export function compositionPairs(days: DailyRecord[]): { pairs: CompositionPair[]; rejectedForSource: number } {
  // Pairing rules, tightened after review:
  //   1. ONE-TO-ONE. A single fat% reading may serve exactly one weight
  //      reading; reusing it across neighbours manufactures pairs that the
  //      scale never produced.
  //   2. Same calendar day preferred, ≤1 day as fallback. BIA fat% moves with
  //      hydration, meals and glycogen, so a 48-hour window was too generous.
  //   3. Same source. The card claims the trend is "measured on the same
  //      scale"; a Withings fat% paired against a manual weight entry would
  //      make that claim false.
  const weights = days
    .map((d, i) => ({ i, date: d.date, kg: d.weightKg, src: d.sourceByType?.weight ?? null }))
    .filter((p): p is typeof p & { kg: number } => p.kg !== null);
  const fats = days
    .map((d, i) => ({ i, pct: d.bodyFatPct, src: d.sourceByType?.['body-fat'] ?? null }))
    .filter((p): p is typeof p & { pct: number } => p.pct !== null);
  if (!weights.length || !fats.length) return { pairs: [], rejectedForSource: 0 };

  const usedFat = new Set<number>();
  const pairs: CompositionPair[] = [];
  let rejectedForSource = 0;

  for (const w of weights) {
    let best: (typeof fats)[number] | null = null;
    let bestGap = 2;
    for (const f of fats) {
      if (usedFat.has(f.i)) continue;
      const gap = Math.abs(f.i - w.i);
      if (gap > 1 || gap >= bestGap) continue;
      if (w.src && f.src && w.src !== f.src) { rejectedForSource++; continue; }
      best = f;
      bestGap = gap;
    }
    if (!best) continue;
    usedFat.add(best.i);
    const fatKg = (w.kg * best.pct) / 100;
    pairs.push({ x: w.i, date: w.date, weightKg: w.kg, fatPct: best.pct, fatKg, leanKg: w.kg - fatKg });
  }
  return { pairs, rejectedForSource };
}

/** The newest body readings, whatever span is on screen. */
export interface LatestBody {
  /** The last eight weigh-ins at most, oldest first. */
  weighIns: Point[];
  latest: { date: CivilDate; value: number } | null;
  previous: { date: CivilDate; value: number } | null;
  /** The newest weigh-in that has a body-fat reading to pair with, and the pair before it. */
  composition: CompositionPair | null;
  previousComposition: CompositionPair | null;
}

export function latestBody(days: DailyRecord[]): LatestBody {
  const weighIns = days.flatMap((d) => (d.weightKg === null ? [] : [{ date: d.date, value: d.weightKg }]));
  const { pairs } = compositionPairs(days);
  return {
    weighIns: weighIns.slice(-8),
    latest: weighIns.at(-1) ?? null,
    previous: weighIns.at(-2) ?? null,
    composition: pairs.at(-1) ?? null,
    previousComposition: pairs.at(-2) ?? null,
  };
}

/**
 * Is weight change *fat* change? Pair weight and body-fat readings within
 * 48 h → fat mass = w × bf%, lean = w − fat; Theil–Sen slope per series.
 * Requires ≥4 pairs spanning ≥28 days — below that the honest answer is
 * silence. BIA fat% carries ±3–5-point absolute error and swings with
 * hydration, so same-scale trends are meaningful and absolute levels are not;
 * copy stays neutral in both directions.
 */
export function bodyComposition(days: DailyRecord[]): BodyComposition | null {
  const { pairs, rejectedForSource } = compositionPairs(days);
  if (pairs.length < 4) return null;
  const spanDays = pairs[pairs.length - 1].x - pairs[0].x;
  if (spanDays < 28) return null;

  const perWeek = (get: (p: (typeof pairs)[number]) => number) => {
    const sl = theilSen(pairs.map((p) => ({ x: p.x, y: get(p) })));
    return sl === null ? 0 : Math.round(sl * 7 * 100) / 100;
  };
  const last = pairs[pairs.length - 1];
  return {
    pairs: pairs.length,
    spanDays,
    rejectedForSource,
    weightKgPerWeek: perWeek((p) => p.weightKg),
    fatKgPerWeek: perWeek((p) => p.fatKg),
    leanKgPerWeek: perWeek((p) => p.leanKg),
    latest: {
      date: last.date,
      weightKg: Math.round(last.weightKg * 10) / 10,
      fatKg: Math.round(last.fatKg * 10) / 10,
      leanKg: Math.round(last.leanKg * 10) / 10,
    },
  };
}

export type { Observation } from './insights';
