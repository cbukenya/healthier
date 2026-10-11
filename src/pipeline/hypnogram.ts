/**
 * The staged hypnogram for the night of 17→18 Aug 2026, as the watch reported it:
 * [stage, minutes] in order, from lights-out. Totals 339 minutes, matching that
 * night's `minutesInSleepPeriod`.
 *
 * Kept as real data because a hand-invented hypnogram wouldn't have this night's
 * distinctive shape — a 57-minute deep block within 20 minutes of falling asleep,
 * then REM crowding into the last two hours.
 */
export const HYPNOGRAM: [string, number][] = [
  ['awake', 6.5], ['light', 11], ['deep', 57.5], ['light', 4.5], ['rem', 19],
  ['light', 32.5], ['deep', 21.5], ['light', 12], ['deep', 5.5], ['light', 29.5],
  ['rem', 10.5], ['light', 0.5], ['rem', 27.5], ['light', 62], ['rem', 3.5],
  ['light', 0.5], ['rem', 5.5], ['light', 29.5],
];

/** Sub-minute wakeups, minutes from lights-out. */
export const SHORT_AWAKENINGS = [90, 158, 183.5, 198, 207, 209.5];
