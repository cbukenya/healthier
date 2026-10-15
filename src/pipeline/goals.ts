/**
 * The person's goals: what the rings, the charts' goal lines and the insights
 * measure against.
 *
 * Google Health doesn't share the goals set in Fitbit, so they're set on the
 * Data tab and kept on the account. Every screen and rule reads them from here;
 * none of the figures below appears as a literal anywhere else.
 */
export interface Goals {
  /** Steps a day. */
  steps: number;
  /** Brisk minutes a day: the inner ring. */
  briskMinutes: number;
  /** Minutes asleep a night, or null to work it out from the person's own nights. */
  sleepNeed: number | null;
}

export const DEFAULT_GOALS: Goals = { steps: 10_000, briskMinutes: 30, sleepNeed: null };

/**
 * The WHO's weekly bar for adults: 150 minutes of moderate activity, vigorous
 * minutes counting double (WHO guidelines on physical activity, 2020). It's a
 * guideline everyone is measured against rather than a goal, so it isn't a setting.
 */
export const WHO_WEEK = 150;

/** A day's share of the WHO's week, rounded up. */
export const WHO_DAY = Math.ceil(WHO_WEEK / 7);

export interface GoalLimit {
  min: number;
  max: number;
  step: number;
}

/**
 * What each goal can be set to. Outside these bounds the cards and insights
 * would stop meaning anything, and each bound comes from the evidence:
 *
 *   steps         2,000 is the low end of what healthy older adults average
 *                 (Tudor-Locke et al. 2011) and the inactive reference in the
 *                 largest meta-analysis of steps and health (Ding et al., Lancet
 *                 Public Health 2025): below it a goal is met by getting through
 *                 the day. 25,000 is twice where "highly active" starts (12,500;
 *                 Tudor-Locke & Bassett 2004), far past where the benefits level
 *                 off at around 7,000 to 10,000 (Paluch et al. 2022; Ding 2025).
 *   briskMinutes  10 a day is about the 75 minutes a week linked with a quarter
 *                 lower risk of early death (Garcia et al., BJSM 2023). 120 is
 *                 past where the benefit tops out, at 3 to 5 times the WHO's 150
 *                 a week (Arem et al., JAMA Internal Medicine 2015).
 *   sleepNeed     7 to 9 hours. Adults need 7 or more, and more than 9 suits only
 *                 some, such as young adults or anyone ill or recovering (AASM and
 *                 SRS consensus, Watson et al. 2015). People kept to 6 hours don't
 *                 notice how impaired they become (Van Dongen et al. 2003), so a
 *                 lower need set by feel would hide real debt. 7 hours is also
 *                 where the estimate from your own nights stops.
 */
export const GOAL_LIMITS = {
  steps: { min: 2_000, max: 25_000, step: 500 },
  briskMinutes: { min: 10, max: 120, step: 5 },
  sleepNeed: { min: 420, max: 540, step: 15 },
} as const satisfies Record<keyof Goals, GoalLimit>;

/** A value moved onto its goal's steps and inside its bounds. */
export const fitGoal = (value: number, limit: GoalLimit): number =>
  Math.min(limit.max, Math.max(limit.min, limit.min + Math.round((value - limit.min) / limit.step) * limit.step));

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Goals as stored: a missing or unreadable one falls back to its default, and
 * one outside today's bounds is pulled inside them, so tightening a bound later
 * never leaves anyone with a goal the cards can't use.
 */
export function readGoals(raw: unknown): Goals {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const steps = finite(o.steps);
  const brisk = finite(o.briskMinutes);
  const need = finite(o.sleepNeed);
  return {
    steps: steps === null ? DEFAULT_GOALS.steps : fitGoal(steps, GOAL_LIMITS.steps),
    briskMinutes: brisk === null ? DEFAULT_GOALS.briskMinutes : fitGoal(brisk, GOAL_LIMITS.briskMinutes),
    sleepNeed: need === null ? null : fitGoal(need, GOAL_LIMITS.sleepNeed),
  };
}

/** Goals sent to be saved: null unless each one sits on its steps inside its bounds. Sleep need may be null, for automatic. */
export function parseGoals(raw: unknown): Goals | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const valid = (v: unknown, limit: GoalLimit) => {
    const n = finite(v);
    return n !== null && fitGoal(n, limit) === n;
  };
  if (!valid(o.steps, GOAL_LIMITS.steps) || !valid(o.briskMinutes, GOAL_LIMITS.briskMinutes)) return null;
  if (o.sleepNeed !== null && !valid(o.sleepNeed, GOAL_LIMITS.sleepNeed)) return null;
  return { steps: o.steps as number, briskMinutes: o.briskMinutes as number, sleepNeed: o.sleepNeed as number | null };
}

export const sameGoals = (a: Goals, b: Goals) =>
  a.steps === b.steps && a.briskMinutes === b.briskMinutes && a.sleepNeed === b.sleepNeed;
