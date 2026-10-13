import { daysBetween } from '../../../lib/date';
import { coverage, latestPoint, series, weightTrend } from '../../derive';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW, dayMonth, plural } from '../helpers';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'body' as const, page: 'body' as const };

/** A trend fires from this slope, either way. */
export const TREND_KG_PER_WEEK = 0.15;
/** From here a weigh-in is overdue, and the trend gives way to the card that says so. */
const STALE_AFTER = 15;

/** Weight: neutral by design, whichever way it moves. */
export function bodyRules(ctx: InsightContext, add: Add): void {
  weight(ctx, add);
  staleWeight(ctx, add);
}

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
    title: down ? 'Your weight is slowly going down' : 'Your weight is slowly going up',
    text: `You're ${down ? 'losing' : 'gaining'} about ${Math.abs(trend.kgPerWeek).toFixed(2)} kg a week. Your latest weigh-in was ${latest.value} kg on ${dayMonth(latest.date)}. That's based on ${trend.readings} weigh-ins over ${trend.spanDays} days, so treat it as a rough guide.`,
  });
}

/** Standing while the scale is quiet, so the page never calls a frozen trend steady. */
function staleWeight(ctx: InsightContext, add: Add): void {
  const row = coverage(ctx.days, [{ dataType: 'weight', label: 'Weight' }])[0];
  if (!row.latest || row.staleDays === null || row.staleDays < STALE_AFTER) return;
  add({
    ...base, domain: 'data', id: 'weight-stale', kind: 'data', tone: 'neutral',
    importance: 30, topic: 'weight', family: 'data', today: 'never',
    news: [STALE_AFTER, 30, 60].some((t) => row.staleDays! >= t && row.staleDays! <= t + ENTRY_WINDOW),
    title: 'Time for a weigh-in',
    text: `You haven't logged your weight in ${plural(row.staleDays, 'day')}, so your weight trend is stuck at your last reading on ${dayMonth(row.latest)}.`,
  });
}
