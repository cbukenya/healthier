import type { CivilDate } from '../../../lib/date';
import { t } from '../../../i18n';
import { formatDuration, formatInteger, formatRounded } from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import { latestBody, stats } from '../../derive';
import { dayLog, isComplete, latestMaintenance } from '../../eating';
import { proteinTarget } from '../../goals';
import { illnessDates } from '../../labs';
import { welch } from '../association';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW } from '../helpers';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'nutrition' as const, page: 'nutrition' as const };

/**
 * The Nutrition page's cards: how what a person eats and the rest of their days go together, said
 * only when their own days show it, and one plain nudge in the evening.
 *
 * The patterns compare two kinds of day from one person: sequential days, not independent samples,
 * with much uncontrolled. So each is an exploratory association, worded as what went together and
 * never as a cause, and held to more than a p-value: enough days on both sides, a difference big
 * enough to matter, and the same direction in the earlier and the later half of the condition's
 * days, so one odd fortnight can't make the card.
 */

/** Days needed on each side of a comparison. */
export const MIN_EACH = 8;
/** Condition days needed in each half, for the halves to agree. */
const MIN_EACH_HALF = 3;

interface Pair {
  date: CivilDate;
  /** Which side of the comparison the day falls on. */
  side: boolean;
  value: number;
}

interface Comparison {
  /** The mean on the condition's side, less the other side's. */
  diff: number;
  n: number;
  rest: number;
}

/**
 * Two kinds of day compared: Welch's test on the difference, then the earlier and later halves of the
 * days checked to lean the same way. Null unless every bar is cleared, and the difference is at least
 * `minDiff` in the expected direction (positive when `minDiff` is).
 */
export function compareDays(pairs: Pair[], minDiff: number): Comparison | null {
  const on = pairs.filter((p) => p.side).map((p) => p.value);
  const off = pairs.filter((p) => !p.side).map((p) => p.value);
  if (on.length < MIN_EACH || off.length < MIN_EACH) return null;
  const w = welch(on, off);
  if (!w || w.p >= 0.05 || (minDiff > 0 ? w.diff < minDiff : w.diff > minDiff)) return null;
  // The earlier and the later half of the condition's own days must each lean the same way against
  // the other days, so one odd stretch of them can't make the card.
  const dated = pairs.filter((p) => p.side).sort((a, b) => (a.date < b.date ? -1 : 1));
  const offMean = stats(off)!.mean;
  const half = Math.floor(dated.length / 2);
  for (const part of [dated.slice(0, half), dated.slice(half)]) {
    if (part.length < MIN_EACH_HALF) return null;
    const d = stats(part.map((p) => p.value))!.mean - offMean;
    if (Math.sign(d) !== Math.sign(w.diff)) return null;
  }
  return { diff: w.diff, n: on.length, rest: off.length };
}

/** A bedtime on a clock that runs past midnight, so 00:30 comes after 23:30. */
const late = (bed: number) => (bed < 12 * 60 ? bed + 24 * 60 : bed);

const full = (d: DailyRecord) => !!d.nutrition && isComplete(d.nutrition);

export function nutritionCards(ctx: InsightContext, add: Add): void {
  if (!ctx.days.some((d) => d.nutrition)) return;
  shortNightsAppetite(ctx, add);
  lateDinners(ctx, add);
  fibreDeepSleep(ctx, add);
  weekAgainstMaintenance(ctx, add);
  proteinBehind(ctx, add);
}

/**
 * The day after a short night, and what was eaten. Sleep loss raises the next day's eating by about
 * 250 to 400 kcal in controlled studies (Al Khatib et al., Eur J Clin Nutr 2017); the card says
 * only what this person's own days show. A short night is half an hour or more under their need.
 */
function shortNightsAppetite(ctx: InsightContext, add: Add): void {
  // Half an hour under the need, to the quarter hour, so the card's figure is exactly the rule's.
  const line = Math.round((ctx.need - 30) / 15) * 15;
  const pairs = ctx.days
    .filter((d) => d.date !== ctx.today && full(d) && d.sleep && d.sleep.isMainSleep)
    .map((d) => ({ date: d.date, side: d.sleep!.minutesAsleep < line, value: d.nutrition!.kcal }));
  const c = compareDays(pairs, 150);
  if (!c) return;
  add({
    ...base, id: 'nutrition-short-nights', kind: 'pattern', tone: 'neutral',
    importance: 52, topic: 'nutrition-sleep', family: 'correlation', today: 'never', news: false, evidence: c.n + c.rest,
    title: t('insights.nutrition.shortNights.title'),
    text: t('insights.nutrition.shortNights.text', { count: c.n, line: formatDuration(line), kcal: formatInteger(Math.round(c.diff / 10) * 10) }),
  });
}

/**
 * Dinner close to bedtime, and the next morning's resting heart rate. Studies disagree on late
 * eating and sleep, so this is the person's own nights only: the last meal within three hours of
 * that night's bedtime against the rest, illness nights left out.
 */
export const LATE_DINNER_MIN = 3 * 60;

function lateDinners(ctx: InsightContext, add: Add): void {
  const sick = illnessDates(ctx.days);
  const pairs: Pair[] = [];
  ctx.days.forEach((d, i) => {
    const next = ctx.days[i + 1];
    const meals = d.nutrition?.meals;
    if (!next?.sleep || next.restingHr === null || !full(d) || !meals?.length || sick.has(next.date)) return;
    const lastMeal = meals[meals.length - 1].minutes;
    const gap = late(next.sleep.bedtimeMin) - lastMeal;
    if (gap <= 0) return;
    pairs.push({ date: d.date, side: gap <= LATE_DINNER_MIN, value: next.restingHr });
  });
  const c = compareDays(pairs, 2);
  if (!c) return;
  add({
    ...base, id: 'nutrition-late-dinners', kind: 'pattern', tone: 'neutral',
    importance: 50, topic: 'nutrition-dinner', family: 'correlation', today: 'never', news: false, evidence: c.n + c.rest,
    title: t('insights.nutrition.lateDinners.title'),
    text: t('insights.nutrition.lateDinners.text', { count: c.n, hours: LATE_DINNER_MIN / 60, bpm: Math.round(c.diff) }),
    action: t('insights.nutrition.lateDinners.action'),
  });
}

/**
 * Fibre and the night's deep sleep. In a controlled study, days with more fibre were followed by
 * more slow-wave sleep (St-Onge et al., J Clin Sleep Med 2016). The line is the person's own middle
 * day, to the nearest 5 g, so the two sides are about even.
 */
function fibreDeepSleep(ctx: InsightContext, add: Add): void {
  const sick = illnessDates(ctx.days);
  const fibres = ctx.days.filter((d) => full(d) && d.nutrition!.fibreG !== null).map((d) => d.nutrition!.fibreG!);
  const middle = stats(fibres)?.median;
  if (middle === undefined) return;
  const line = Math.max(5, Math.round(middle / 5) * 5);
  const pairs: Pair[] = [];
  ctx.days.forEach((d, i) => {
    const deep = ctx.days[i + 1]?.sleep?.stages?.deep;
    if (deep === undefined || !full(d) || d.nutrition!.fibreG === null || sick.has(ctx.days[i + 1].date)) return;
    pairs.push({ date: d.date, side: d.nutrition!.fibreG! >= line, value: deep });
  });
  const c = compareDays(pairs, 5);
  if (!c) return;
  add({
    ...base, id: 'nutrition-fibre-deep-sleep', kind: 'pattern', tone: 'neutral',
    importance: 49, topic: 'nutrition-fibre', family: 'correlation', today: 'never', news: false, evidence: c.n + c.rest,
    title: t('insights.nutrition.fibreDeepSleep.title'),
    text: t('insights.nutrition.fibreDeepSleep.text', { grams: line, minutes: Math.round(c.diff) }),
  });
}

/** Days needed in the last seven, all logged in full, for the week's balance to mean anything. */
const WEEK_DAYS = 6;
/** Net energy over the week worth a word: about a tenth of a kilo. */
const WEEK_NET_KCAL = 700;

/**
 * The last week against maintenance: most of its days on one side, by enough to move the scale.
 * Neutral either way, since eating above or below maintenance can be the plan; it says how much,
 * and roughly what that comes to in weight at 7,700 kcal a kilo.
 */
function weekAgainstMaintenance(ctx: InsightContext, add: Add): void {
  const state = (days: DailyRecord[]) => {
    const today = days[days.length - 1]?.date;
    const m = today ? latestMaintenance(days, today) : null;
    if (!m) return null;
    const week = days.slice(-8, -1).filter((d) => dayLog(d, today) === 'complete');
    if (week.length < WEEK_DAYS) return null;
    const diffs = week.map((d) => d.nutrition!.kcal - m.kcal);
    const over = diffs.filter((v) => v > 0).length;
    const net = diffs.reduce((a, b) => a + b, 0);
    const side = over >= week.length - 1 ? 'over' : over <= 1 ? 'under' : null;
    if (!side || Math.abs(net) < WEEK_NET_KCAL || Math.sign(net) !== (side === 'over' ? 1 : -1)) return null;
    return { side, count: side === 'over' ? over : week.length - over, days: week.length, net };
  };
  const now = state(ctx.days);
  if (!now) return;
  const before = state(ctx.days.slice(0, -(ENTRY_WINDOW + 1)));
  add({
    ...base, id: 'nutrition-week-balance', kind: 'trend', tone: 'neutral', direction: now.side === 'over' ? 'up' : 'down',
    importance: 45, topic: 'nutrition-balance', family: 'nutrition-balance', today: 'as-news', news: before?.side !== now.side,
    evidence: now.days,
    title: t('insights.nutrition.weekBalance.title', { side: now.side }),
    text: t('insights.nutrition.weekBalance.text', {
      side: now.side, count: now.count, days: now.days,
      kcal: formatInteger(Math.round(Math.abs(now.net) / 50) * 50),
      kg: formatRounded(Math.abs(now.net) / 7700, 2),
    }),
  });
}

/** How far behind protein must be, and how little, for the evening nudge: enough to matter, little enough for one dinner. */
const PROTEIN_GAP = { min: 20, max: 60 } as const;
/** A day of this many times the usual steps counts as a big one. */
const BIG_DAY = 1.25;

/**
 * In the evening, protein well behind its target with dinner still to come: how much a dinner would
 * need to bring. Said only while one meal can close the gap.
 */
function proteinBehind(ctx: InsightContext, add: Add): void {
  const day = ctx.todayRow.nutrition;
  if (ctx.part !== 'evening' || !day || !day.meals.length) return;
  const target = proteinTarget(ctx.goals, latestBody(ctx.days).latest?.value ?? null);
  if (target === null) return;
  const gap = Math.round((target - day.proteinG) / 5) * 5;
  if (gap < PROTEIN_GAP.min || gap > PROTEIN_GAP.max) return;
  const steps = ctx.todayRow.steps;
  const big = steps !== null && ctx.stepMedian !== null && steps >= BIG_DAY * ctx.stepMedian;
  add({
    ...base, id: 'nutrition-protein-behind', kind: 'nudge', tone: 'neutral',
    importance: 58, topic: 'nutrition-protein', family: 'nutrition-protein', today: 'while-true', news: true, daypart: ['evening'],
    title: t('insights.nutrition.proteinBehind.title'),
    text: t('insights.nutrition.proteinBehind.text', {
      got: formatInteger(day.proteinG), target: formatInteger(target), big: big ? 'yes' : 'no', steps: formatInteger(steps ?? 0),
    }),
    action: t('insights.nutrition.proteinBehind.action', { grams: gap }),
  });
}
