import { addDays, type CivilDate } from '../../../lib/date';
import { hasMessage, t } from '../../../i18n';
import { formatClock, formatDayMonthLong, formatFixed } from '../../../i18n/format';
import type { DailyRecord, Workout } from '../../../types/health';
import { WHO_STRENGTH_DAYS, proteinTarget } from '../../goals';
import { isComplete } from '../../eating';
import { fastestStretch, hardMinutesOf, kindOf, paceOf, workoutsIn, type DatedWorkout, type WorkoutKind } from '../../workouts';
import type { Answer, HistoryQueries, Measure } from '../../history';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW, circDelta, pastYear, reachesYear } from '../helpers';
import { dayRecord } from '../patterns';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'movement' as const, page: 'workouts' as const };

/**
 * What the Workouts tab asks of the year before the window: each distance kind's longest workout,
 * and the fastest 5 km run, for the records it celebrates.
 */
export const workoutQueries = {
  workoutRunKm: { measure: 'runKm', aggregate: ['max', 'count', 'first'], back: 365 },
  workoutWalkKm: { measure: 'walkKm', aggregate: ['max', 'count', 'first'], back: 365 },
  workoutHikeKm: { measure: 'hikeKm', aggregate: ['max', 'count', 'first'], back: 365 },
  workoutRideKm: { measure: 'rideKm', aggregate: ['max', 'count', 'first'], back: 365 },
  workoutSwimKm: { measure: 'swimKm', aggregate: ['max', 'count', 'first'], back: 365 },
  workoutRun5k: { measure: 'run5kSeconds', aggregate: ['min', 'count', 'first'], back: 365 },
} satisfies HistoryQueries;

/**
 * The Workouts tab's cards: records within the past year, fitness that shows in the workouts,
 * strength days against the guideline, protein on strength days, and a late hard workout's likely
 * cost to sleep, on the evening it happens.
 */
export function workoutCards(ctx: InsightContext, add: Add): void {
  longest(ctx, add);
  fastest5k(ctx, add);
  samePace(ctx, add);
  strengthDays(ctx, add);
  strengthProtein(ctx, add);
  lateWorkout(ctx, add);
}

/** Sessions of a kind behind a record, before it counts: a handful, so the first few aren't all records. */
const RECORD_MIN_SESSIONS = 6;

const reachOf = (first: CivilDate | null, today: CivilDate) => (reachesYear(first, today) ? 'year' : 'history');

/**
 * Where a workout record's reach starts: the stored history's start, not the first workout of the
 * kind, since a year with only a few hikes in it is still a year of hikes.
 */
const sinceOf = (answer: Answer | null | undefined, first: CivilDate) => answer?.from ?? first;

/** A workout's name, by its own type, as the Workouts tab names it. */
const nameOf = (w: Workout) => {
  const key = `workouts.types.${w.type}`;
  return hasMessage(key) ? t(key) : w.displayName ?? t('workouts.types.OTHER');
};

/** Seconds as minutes and seconds: "33:43". */
const minSec = (seconds: number) => {
  const s = Math.round(seconds);
  return t('workouts.units.paceValue', { minutes: Math.floor(s / 60), seconds: String(s % 60).padStart(2, '0') });
};

/** The longest of each kind that goes a distance, within the past year: news for a few days, then on the page for the week. */
function longest(ctx: InsightContext, add: Add): void {
  const { days, today, answers } = ctx;
  const defs: { kind: WorkoutKind; measure: Measure; answer: string; mustReach: number; digits: number }[] = [
    { kind: 'hike', measure: 'hikeKm', answer: 'workoutHikeKm', mustReach: 5, digits: 1 },
    { kind: 'run', measure: 'runKm', answer: 'workoutRunKm', mustReach: 3, digits: 1 },
    { kind: 'ride', measure: 'rideKm', answer: 'workoutRideKm', mustReach: 10, digits: 1 },
    { kind: 'swim', measure: 'swimKm', answer: 'workoutSwimKm', mustReach: 0.5, digits: 2 },
    { kind: 'walk', measure: 'walkKm', answer: 'workoutWalkKm', mustReach: 3, digits: 1 },
  ];
  for (const def of defs) {
    const r = dayRecord(days, today, def.measure, 'max', answers[def.answer], { mustReach: def.mustReach, minDays: RECORD_MIN_SESSIONS });
    if (!r) continue;
    const since = sinceOf(answers[def.answer], r.since);
    add({
      ...base, id: `workout-longest-${def.kind}`, kind: 'milestone', tone: 'good',
      importance: 64, topic: `workout-longest-${def.kind}`, family: 'workout-milestone', today: 'as-news', news: r.age <= ENTRY_WINDOW + 1,
      title: t('insights.workouts.longest.title', { reach: reachOf(since, today), kind: def.kind }),
      text: t('insights.workouts.longest.text', {
        km: formatFixed(r.value, def.digits), date: formatDayMonthLong(r.date), span: pastYear(since, today), previous: formatFixed(r.previous, def.digits),
      }),
    });
  }
}

/** The fastest 5 km within the past year, found inside any run from its kilometre splits. */
function fastest5k(ctx: InsightContext, add: Add): void {
  const { days, today, answers } = ctx;
  const r = dayRecord(days, today, 'run5kSeconds', 'min', answers.workoutRun5k, { minDays: RECORD_MIN_SESSIONS });
  if (!r) return;
  const since = sinceOf(answers.workoutRun5k, r.since);
  // Which kilometres it was, from the run itself, which is in the window.
  const runs = days.find((d) => d.date === r.date)?.workouts.filter((w) => kindOf(w) === 'run') ?? [];
  const stretch = runs.map((w) => fastestStretch(w, 5)).find((s) => s && s.seconds === r.value) ?? null;
  add({
    ...base, id: 'workout-fastest-5k', kind: 'milestone', tone: 'good',
    importance: 65, topic: 'workout-fastest-5k', family: 'workout-milestone', today: 'as-news', news: r.age <= ENTRY_WINDOW + 1,
    title: t('insights.workouts.fastest5k.title', { reach: reachOf(since, today) }),
    text: t('insights.workouts.fastest5k.text', {
      time: minSec(r.value), date: formatDayMonthLong(r.date), whole: stretch && stretch.from === 1 ? 'start' : 'inside',
      from: stretch?.from ?? 1, to: (stretch?.from ?? 1) + 4, span: pastYear(since, today), previous: minSec(r.previous),
    }),
  });
}

/** Workouts in the 4 weeks to `end`, oldest first. */
const fourWeeks = (days: DailyRecord[], end: CivilDate) => workoutsIn(days.filter((d) => d.date > addDays(end, -28) && d.date <= end)).reverse();

/** How close a session's pace or speed must be to the median to count as much the same. */
const SAME = { pace: 15, speed: 1.5 } as const;
/** Sessions each side, so a couple of easy days can't make a trend. */
const SAME_MIN_SESSIONS = 6;
/** The drop in heart rate that counts as one, in bpm: past a watch's own wobble from run to run. */
const SAME_MIN_DROP = 3;

/**
 * Runs (or rides) at much the same pace now taking a lower heart rate than in the 4 weeks before:
 * the plainest sign of getting fitter the workouts hold. Only the good news: a rise has too many
 * everyday causes (heat, a short night) to say anything on its own.
 */
function samePace(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  for (const kind of ['run', 'ride'] as const) {
    const pick = (list: DatedWorkout[]) =>
      list.flatMap((s) => {
        const p = paceOf(s.workout);
        return kindOf(s.workout) === kind && p && s.workout.avgHr !== null ? [{ p: p.value, hr: s.workout.avgHr, measure: p.measure }] : [];
      });
    const now = pick(fourWeeks(days, today));
    const before = pick(fourWeeks(days, addDays(today, -28)));
    if (!now.length || !before.length) continue;
    const measure = now[0].measure === 'speed' ? 'speed' : 'pace';
    const all = [...now, ...before].map((x) => x.p).sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)];
    const near = (x: { p: number }) => Math.abs(x.p - median) <= SAME[measure];
    const a = now.filter(near);
    const b = before.filter(near);
    if (a.length < SAME_MIN_SESSIONS || b.length < SAME_MIN_SESSIONS) continue;
    const mean = (xs: { hr: number }[]) => xs.reduce((s, x) => s + x.hr, 0) / xs.length;
    const hrNow = mean(a);
    const hrBefore = mean(b);
    if (hrBefore - hrNow < SAME_MIN_DROP) continue;
    add({
      ...base, id: `workout-same-pace-${kind}`, kind: 'trend', tone: 'good', direction: 'down',
      importance: 58, topic: 'workout-fitness', family: 'workout-fitness', today: 'as-news', news: false,
      claims: { metric: `workout-hr-${kind}`, direction: 'down' }, evidence: a.length + b.length,
      title: t('insights.workouts.samePace.title'),
      text: t('insights.workouts.samePace.text', {
        kind,
        pace: measure === 'speed' ? formatFixed(median, 1) : minSec(median),
        now: Math.round(hrNow), before: Math.round(hrBefore),
      }),
    });
  }
}

/** Distinct days with a strength workout among the days. */
const strengthDates = (days: DailyRecord[]) => days.filter((d) => (d.workouts ?? []).some((w) => kindOf(w) === 'strength')).map((d) => d.date);

/**
 * Strength training on fewer days than the guideline's two a week, over the last 4 weeks. Only for
 * people who already lift now and then: it never tells a runner to start.
 */
function strengthDays(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const count = strengthDates(days.filter((d) => d.date > addDays(today, -28))).length;
  if (count < 2 || count / 4 >= WHO_STRENGTH_DAYS) return;
  add({
    ...base, id: 'workout-strength-days', kind: 'review', tone: 'neutral',
    importance: 48, topic: 'workout-strength-days', family: 'workout-strength', today: 'never', news: false,
    title: t('insights.workouts.strengthDays.title', { target: WHO_STRENGTH_DAYS }),
    text: t('insights.workouts.strengthDays.text', { count, target: WHO_STRENGTH_DAYS, total: WHO_STRENGTH_DAYS * 4 }),
  });
}

/** Complete food logs on strength days before it says anything about them. */
const PROTEIN_MIN_DAYS = 4;

/**
 * Protein on strength days against the protein target, from the food log: muscle is rebuilt from
 * the protein eaten around the session. Says so when the strength days fall short of it.
 */
function strengthProtein(ctx: InsightContext, add: Add): void {
  const { days, goals } = ctx;
  const weight = [...days].reverse().find((d) => d.weightKg !== null)?.weightKg ?? null;
  const target = proteinTarget(goals, weight);
  if (target === null) return;
  // Finished days with a whole day's food logged.
  const logged = days.slice(0, -1).filter((d) => d.nutrition && isComplete(d.nutrition));
  const lifting = new Set(strengthDates(logged));
  const on = logged.filter((d) => lifting.has(d.date));
  const off = logged.filter((d) => !lifting.has(d.date));
  if (on.length < PROTEIN_MIN_DAYS) return;
  const mean = (xs: DailyRecord[]) => xs.reduce((s, d) => s + d.nutrition!.proteinG, 0) / xs.length;
  const onDays = mean(on);
  if (onDays >= 0.9 * target) return;
  const others = off.length >= PROTEIN_MIN_DAYS && mean(off) >= target ? 'reach' : 'no';
  add({
    ...base, domain: 'nutrition', id: 'workout-strength-protein', kind: 'pattern', tone: 'neutral',
    importance: 50, topic: 'workout-strength-protein', family: 'workout-strength', today: 'never', news: false, evidence: on.length,
    title: t('insights.workouts.strengthProtein.title'),
    text: t('insights.workouts.strengthProtein.text', { grams: Math.round(onDays), target, others }),
  });
}

/** A workout that ends this close to the usual bedtime, or after it, is a late one. */
const LATE_WITHIN_MIN = 120;
/** Vigorous and peak minutes that make a workout a hard one. */
const HARD_MIN = 10;
/** Nights each side before the pattern counts, and the delay that makes one. */
const LATE_MIN_NIGHTS = 4;
const OTHER_MIN_NIGHTS = 10;
const LATE_MIN_DELAY = 15;

/**
 * On the evening of a hard workout that ended close to bedtime: how much later this person has
 * fallen asleep after such workouts, when their own nights show it. Vigorous exercise in the last
 * hour or so before bed is the one kind that tends to delay sleep (Stutz et al., Sports Med 2019);
 * evening exercise otherwise doesn't, so it stays quiet without the person's own pattern.
 */
function lateWorkout(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const beds = days.map((d) => d.sleep?.bedtimeMin).filter((b): b is number => b !== undefined && b !== null);
  if (beds.length < 14) return;
  // The usual bedtime, on the clock's circle, so 23:50 and 00:10 average to midnight.
  const usual = (beds[0] + beds.reduce((a, b) => a + circDelta(b, beds[0]), 0) / beds.length + 1440) % 1440;
  const lateHard = (w: Workout) => {
    const end = (w.startMin + w.elapsedMin) % 1440;
    return (hardMinutesOf(w) ?? 0) >= HARD_MIN && circDelta(usual, end) <= LATE_WITHIN_MIN && circDelta(usual, end) > -240;
  };
  const after: number[] = [];
  const others: number[] = [];
  for (let i = 0; i < days.length - 1; i++) {
    const night = days[i + 1].sleep;
    if (!night) continue;
    const delay = circDelta(night.bedtimeMin, usual);
    ((days[i].workouts ?? []).some(lateHard) ? after : others).push(delay);
  }
  if (after.length < LATE_MIN_NIGHTS || others.length < OTHER_MIN_NIGHTS) return;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const later = mean(after) - mean(others);
  if (later < LATE_MIN_DELAY) return;
  // Only on the evening it matters: today's workout was one of them.
  const tonight = [...(days.find((d) => d.date === today)?.workouts ?? [])].reverse().find(lateHard);
  if (!tonight) return;
  add({
    ...base, domain: 'sleep', id: 'workout-late-sleep', kind: 'nudge', tone: 'watch', daypart: ['evening'],
    importance: 62, topic: 'workout-late-sleep', family: 'workout-sleep', today: 'while-true', news: true, evidence: after.length,
    title: t('insights.workouts.lateSleep.title'),
    text: t('insights.workouts.lateSleep.text', {
      name: nameOf(tonight), time: formatClock((tonight.startMin + tonight.elapsedMin) % 1440), minutes: Math.round(later / 5) * 5,
    }),
  });
}

