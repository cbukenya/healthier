import { addDays, daysBetween, isoWeekdayIndex, type CivilDate } from '../../../lib/date';
import { t, type MessageKey } from '../../../i18n';
import { formatDayMonthLong, formatFixed, formatMonth, formatRounded } from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import { bodyComposition, coverage, latestPoint, series, stats, weightTrend } from '../../derive';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW } from '../helpers';
import { trendLine } from '../patterns';
import type { HistoryQueries } from '../../history';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'body' as const, page: 'body' as const };

/** What Body asks of your older days: your first weigh-in on record. */
export const bodyQueries = {
  firstWeighIn: { measure: 'weightKg', aggregate: 'first', back: 'all' },
} satisfies HistoryQueries;

/** A trend fires from this slope, either way. */
export const TREND_KG_PER_WEEK = 0.15;
/** From here a weigh-in is overdue, and the trend gives way to the card that says so. */
const STALE_AFTER = 15;

/** Weight and body composition: neutral by design, whichever way they move. */
export function bodyCards(ctx: InsightContext, add: Add): void {
  weight(ctx, add);
  fastChange(ctx, add);
  holdingSteady(ctx, add);
  staleWeight(ctx, add);
  swings(ctx, add);
  composition(ctx, add);
  fatTrend(ctx, add);
  weighInRhythm(ctx, add);
  bmi(ctx, add);
  sinceStart(ctx, add);
}

type Reading = { date: CivilDate; value: number };

/** Readings of one body measure, oldest first, from the last `n` days of the window. */
const readings = (days: DailyRecord[], get: (d: DailyRecord) => number | null, n = days.length): Reading[] =>
  series(days.slice(-n), get).filter((p): p is Reading => p.value !== null);

/** The usual change between weigh-ins on back-to-back days: water, food and timing, not body change. */
const dailySwing = (pts: Reading[]): number | null => {
  const steps = pts.slice(1).flatMap((p, i) => (daysBetween(pts[i].date, p.date) === 1 ? [Math.abs(p.value - pts[i].value)] : []));
  return steps.length >= 4 ? stats(steps)!.median : null;
};

/** One decimal, rounded up, so "within 0.4 kg" is always true of the readings behind it. */
const ceil1 = (v: number) => Math.max(0.1, Math.ceil(v * 10) / 10);

function weight(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const s = series(days, (d) => d.weightKg);
  const trend = weightTrend(s);
  const latest = latestPoint(s);
  if (!trend || !latest || Math.abs(trend.kgPerWeek) < TREND_KG_PER_WEEK) return;
  const age = daysBetween(latest.date, today);
  if (age >= STALE_AFTER) return;
  // News when the newest weigh-in is the one that took the slope past the threshold.
  const before = weightTrend(s.filter((pt) => pt.date !== latest.date))?.kgPerWeek ?? null;
  const crossed = before === null || Math.abs(before) < TREND_KG_PER_WEEK || Math.sign(before) !== Math.sign(trend.kgPerWeek);
  const down = trend.kgPerWeek < 0;
  add({
    ...base, id: down ? 'weight-down' : 'weight-up', kind: 'trend', tone: 'neutral', direction: down ? 'down' : 'up',
    importance: 44, topic: 'weight', family: 'weight', today: 'as-news', news: crossed && age <= ENTRY_WINDOW + 1,
    claims: { metric: 'weight', direction: down ? 'down' : 'up' }, evidence: trend.readings,
    title: t(down ? 'insights.body.weightDown.title' : 'insights.body.weightUp.title'),
    text: t(down ? 'insights.body.weightDown.text' : 'insights.body.weightUp.text', {
      rate: formatFixed(Math.abs(trend.kgPerWeek), 2), weight: formatRounded(latest.value!, 3), date: formatDayMonthLong(latest.date),
      readings: trend.readings, days: trend.spanDays,
    }),
  });
}

/** Standing while the scale is quiet, so the page never calls a frozen trend steady. */
function staleWeight(ctx: InsightContext, add: Add): void {
  // i18n-ignore: 'Weight' only names the coverage row inside this function; the card reads its dates, never its label.
  const row = coverage(ctx.days, [{ dataType: 'weight', label: 'Weight' }])[0];
  if (!row.latest || row.staleDays === null || row.staleDays < STALE_AFTER) return;
  add({
    ...base, domain: 'data', id: 'weight-stale', kind: 'data', tone: 'neutral',
    importance: 30, topic: 'weight', family: 'data', today: 'never',
    news: [STALE_AFTER, 30, 60].some((mark) => row.staleDays! >= mark && row.staleDays! <= mark + ENTRY_WINDOW),
    title: t('insights.body.weightStale.title'),
    text: t('insights.body.weightStale.text', { count: row.staleDays, date: formatDayMonthLong(row.latest) }),
  });
}

/** Over 1% of body weight a week for four weeks or more, either way: the one weight card that's an alert. */
function fastChange(ctx: InsightContext, add: Add): void {
  const pts = readings(ctx.days, (d) => d.weightKg, 42);
  if (pts.length < 6) return;
  const last = pts[pts.length - 1];
  const span = daysBetween(pts[0].date, last.date);
  if (span < 28 || daysBetween(last.date, ctx.today) >= STALE_AFTER) return;
  const line = trendLine(pts)!;
  const pct = ((line.perDay * 7) / line.at(last.date)) * 100;
  if (Math.abs(pct) < 1) return;
  const down = pct < 0;
  const weeks = Math.floor(span / 7);
  add({
    ...base, id: 'body-fast-change', kind: 'alert', tone: 'watch', direction: down ? 'down' : 'up',
    importance: 80, topic: 'weight', family: 'weight', today: 'while-true', news: daysBetween(last.date, ctx.today) <= ENTRY_WINDOW + 1,
    claims: { metric: 'weight', direction: down ? 'down' : 'up' }, evidence: pts.length,
    title: t('insights.body.bodyFastChange.title'),
    text: t('insights.body.bodyFastChange.text', { direction: down ? 'down' : 'up', percent: formatFixed(Math.abs(pct), 1), weeks }),
  });
}

/** Four weeks or more inside a band no wider than your usual day-to-day swing. */
function holdingSteady(ctx: InsightContext, add: Add): void {
  const pts = readings(ctx.days, (d) => d.weightKg, 56);
  if (pts.length < 4) return;
  const last = pts[pts.length - 1];
  const span = daysBetween(pts[0].date, last.date);
  if (span < 28 || daysBetween(last.date, ctx.today) >= STALE_AFTER) return;
  const middle = stats(pts.map((p) => p.value))!.median;
  const widest = Math.max(...pts.map((p) => Math.abs(p.value - middle)));
  if (widest > Math.max(0.5, dailySwing(pts) ?? 0)) return;
  add({
    ...base, id: 'body-holding-steady', kind: 'pattern', tone: 'neutral',
    importance: 34, topic: 'weight', family: 'weight', today: 'never', news: false,
    claims: { metric: 'weight', direction: 'steady' }, evidence: pts.length,
    title: t('insights.body.bodyHoldingSteady.title'),
    text: t('insights.body.bodyHoldingSteady.text', {
      within: formatFixed(ceil1(widest), 1), middle: formatFixed(middle, 1), weeks: Math.floor(span / 7), count: pts.length,
    }),
  });
}

/** How much your weight moves between back-to-back days, and the trend underneath. */
function swings(ctx: InsightContext, add: Add): void {
  const pts = readings(ctx.days, (d) => d.weightKg);
  if (pts.length < 8) return;
  const swing = dailySwing(pts);
  if (swing === null || swing < 0.2) return;
  const trend = weightTrend(series(ctx.days, (d) => d.weightKg));
  const under = !trend ? 'none' : Math.abs(trend.kgPerWeek) < 0.05 ? 'flat' : trend.kgPerWeek < 0 ? 'down' : 'up';
  add({
    ...base, id: 'body-swings', kind: 'pattern', tone: 'neutral',
    importance: 36, topic: 'weight-swings', family: 'weight', today: 'never', news: false,
    title: t('insights.body.bodySwings.title'),
    text: t('insights.body.bodySwings.text', {
      swing: formatFixed(swing, 1), trend: under, rate: trend ? formatFixed(Math.abs(trend.kgPerWeek), 2) : '',
    }),
  });
}

/** Fat and lean mass from a scale that measures both, over four weeks or more. */
function composition(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const change = (grid: DailyRecord[]) => {
    const comp = bodyComposition(grid);
    if (!comp) return null;
    const weeks = comp.spanDays / 7;
    const lean = comp.leanKgPerWeek * weeks;
    const fat = comp.fatKgPerWeek * weeks;
    return { comp, weeks, lean, fat, moved: Math.abs(lean) >= 0.3 || Math.abs(fat) >= 0.3 };
  };
  const now = change(days);
  if (!now?.moved) return;
  const age = daysBetween(now.comp.latest.date, today);
  if (age >= STALE_AFTER) return;
  // News when the newest paired reading is the one that showed the change.
  const before = change(days.filter((d) => d.date !== now.comp.latest.date));
  const part = (kg: number, what: MessageKey) =>
    t(what, { change: Math.abs(kg) < 0.1 ? 'same' : kg > 0 ? 'gained' : 'lost', kg: formatFixed(Math.abs(kg), 1) });
  add({
    ...base, id: 'body-composition', kind: 'trend', tone: 'neutral',
    importance: 45, topic: 'composition', family: 'weight', today: 'as-news', news: age <= ENTRY_WINDOW + 1 && !before?.moved,
    title: t('insights.body.bodyComposition.title'),
    text: t('insights.body.bodyComposition.text', {
      weeks: Math.round(now.weeks), pairs: now.comp.pairs,
      lean: part(now.lean, 'insights.body.bodyComposition.lean'), fat: part(now.fat, 'insights.body.bodyComposition.fat'),
    }),
  });
}

/** Body fat percentage over eight weeks, when the change is bigger than reading-to-reading noise. */
function fatTrend(ctx: InsightContext, add: Add): void {
  const pts = readings(ctx.days, (d) => d.bodyFatPct, 56);
  if (pts.length < 4) return;
  const last = pts[pts.length - 1];
  const span = daysBetween(pts[0].date, last.date);
  if (span < 28 || daysBetween(last.date, ctx.today) >= STALE_AFTER) return;
  const line = trendLine(pts)!;
  const from = line.at(pts[0].date);
  const to = line.at(last.date);
  const noise = stats(pts.slice(1).map((p, i) => Math.abs(p.value - pts[i].value)))!.median;
  if (Math.abs(to - from) < Math.max(0.5, noise)) return;
  const down = to < from;
  add({
    ...base, id: 'body-fat-trend', kind: 'trend', tone: 'neutral', direction: down ? 'down' : 'up',
    importance: 40, topic: 'composition', family: 'weight', today: 'never', news: false,
    claims: { metric: 'body-fat', direction: down ? 'down' : 'up' }, evidence: pts.length,
    title: t('insights.body.bodyFatTrend.title', { direction: down ? 'down' : 'up' }),
    text: t('insights.body.bodyFatTrend.text', {
      from: formatFixed(from, 1), to: formatFixed(to, 1), weeks: Math.round(span / 7), count: pts.length,
    }),
  });
}

/** A weigh-in every week, counted back from this week (which never breaks the run while it's in progress). */
function weighInRhythm(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const mondayOf = (date: CivilDate) => addDays(date, -isoWeekdayIndex(date));
  const weeks = new Set(days.filter((d) => d.weightKg !== null).map((d) => mondayOf(d.date)));
  let monday = mondayOf(today);
  if (!weeks.has(monday)) monday = addDays(monday, -7);
  let n = 0;
  while (weeks.has(monday)) {
    n++;
    monday = addDays(monday, -7);
  }
  if (n < 4) return;
  const latest = [...days].reverse().find((d) => d.weightKg !== null)!;
  add({
    ...base, id: 'body-weigh-in-rhythm', kind: 'milestone', tone: 'good',
    importance: 33, topic: 'weigh-ins', family: 'weigh-ins', today: 'never',
    news: [4, 8].includes(n) && daysBetween(latest.date, today) <= ENTRY_WINDOW,
    title: t('insights.body.bodyWeighInRhythm.title'),
    text: t('insights.body.bodyWeighInRhythm.text', { count: n }),
  });
}

/** On the first days of the month: your BMI over the last month, read off the weight trend so one heavy morning can't move it. */
function bmi(ctx: InsightContext, add: Add): void {
  if (ctx.dom > 2 || ctx.heightCm === null) return;
  const line = trendLine(readings(ctx.days, (d) => d.weightKg));
  if (!line || line.n < 3 || daysBetween(line.first, line.last) < 28 || daysBetween(line.last, ctx.today) >= STALE_AFTER) return;
  const m = ctx.heightCm / 100;
  const to = line.at(line.last) / (m * m);
  const from = line.at(addDays(line.last, -30)) / (m * m);
  if (Math.abs(to - from) < 0.3) return;
  add({
    ...base, id: 'body-bmi', kind: 'trend', tone: 'neutral', direction: to < from ? 'down' : 'up',
    importance: 32, topic: 'bmi', family: 'weight', today: 'never', news: true,
    title: t('insights.body.bodyBmi.title'),
    text: t('insights.body.bodyBmi.text', { height: formatFixed(m, 2), from: formatFixed(from, 1), to: formatFixed(to, 1) }),
  });
}

/**
 * Your latest weigh-in against your first on record, before the window or in
 * it: news on the 1st and 2nd of the month, then on the page. Silent under
 * 2 kg, where a single morning's swing could be most of it.
 */
function sinceStart(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const window = readings(days, (d) => d.weightKg);
  const first = ctx.answers.firstWeighIn?.rows[0]?.first ?? window[0];
  const last = window[window.length - 1];
  if (!first || !last || daysBetween(first.date, last.date) < 60 || daysBetween(last.date, today) >= 30) return;
  const change = last.value - first.value;
  if (Math.abs(change) < 2) return;
  add({
    ...base, id: 'body-since-start', kind: 'milestone', tone: 'neutral',
    importance: 42, topic: 'since-start', family: 'weight', today: 'as-news', news: ctx.dom <= 2,
    title: t('insights.body.bodySinceStart.title'),
    text: t('insights.body.bodySinceStart.text', {
      change: change < 0 ? 'lost' : 'gained', kg: formatFixed(Math.abs(change), 1), month: formatMonth(first.date, today),
      from: formatFixed(first.value, 1), to: formatFixed(last.value, 1),
    }),
  });
}
