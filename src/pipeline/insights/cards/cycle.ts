import { addDays, daysBetween } from '../../../lib/date';
import { t } from '../../../i18n';
import { formatDayMonthLong, formatDuration, formatFixed } from '../../../i18n/format';
import { cycleShifts, FIRST_SEEN_NIGHTS, MAX_CYCLE, MIN_CYCLE, typicalShift } from '../../cycle';
import type { InsightContext } from '../context';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'cycle' as const, page: 'cycle' as const };

/**
 * The Cycle page's cards, written only while cycle tracking is on. Like every card they describe
 * the person's own cycles: patterns that repeat in them, and a period that's due. None of them
 * marks fertile days or names a condition.
 */
export function cycleCards(ctx: InsightContext, add: Add): void {
  if (!ctx.cycle) return;
  due(ctx, add);
  newCycle(ctx, add);
  sleepBefore(ctx, add);
  heartFollows(ctx, add);
  steady(ctx, add);
}

/** Cycle cards reach Today only when the person allows it on the Data page. */
const todayWhen = (ctx: InsightContext, when: 'while-true' | 'as-news') => (ctx.cycle!.log.settings.todayCards ? when : 'never');

/** A period that's likely within the next few days, from the person's own cycles. */
function due(ctx: InsightContext, add: Add): void {
  const { summary } = ctx.cycle!;
  const next = summary.next;
  const c = summary.current;
  if (!next || !c || c.day < MIN_CYCLE) return;
  if (ctx.today < addDays(next.from, -2) || ctx.today > next.to) return;
  const range = next.basis === 'early' ? summary.early : summary.length;
  const started = ctx.today >= next.from ? 'yes' : 'no';
  add({
    ...base, id: 'cycle-due', kind: 'review', tone: 'neutral',
    importance: 58, topic: 'cycle-due', family: 'cycle', today: todayWhen(ctx, 'while-true'),
    news: ctx.today === addDays(next.from, -2),
    title: t('insights.cycle.due.title', { started }),
    text: t('insights.cycle.due.text', {
      basis: next.basis,
      same: next.from === next.to ? 'yes' : 'no',
      started,
      count: range?.count ?? 0,
      min: range?.min ?? 0,
      max: range?.max ?? 0,
      from: formatDayMonthLong(next.from),
      to: formatDayMonthLong(next.to),
      tab: t('app.nav.cycle'),
    }),
  });
}

/**
 * A new cycle found in the nights and not yet confirmed: Today only, if allowed there, and only in
 * its first week. A start can be found once FIRST_SEEN_NIGHTS nights from it are in; the Cycle page
 * offers to confirm it for longer.
 */
function newCycle(ctx: InsightContext, add: Add): void {
  const { summary, log } = ctx.cycle!;
  const c = summary.current;
  if (!c || c.source !== 'found' || !log.settings.todayCards || c.day > FIRST_SEEN_NIGHTS + 4) return;
  add({
    ...base, id: 'cycle-new', kind: 'nudge', tone: 'neutral',
    importance: 57, topic: 'cycle-new', family: 'cycle', today: 'as-news', news: true,
    title: t('insights.cycle.newCycle.title'),
    text: t('insights.cycle.newCycle.text', {
      date: formatDayMonthLong(c.start),
      tab: t('app.nav.cycle'),
    }),
  });
}

/** Complete cycles of a usual length, newest last. */
const completeCycles = (ctx: InsightContext) =>
  ctx.cycle!.summary.cycles.filter((c) => c.length !== null && c.length >= MIN_CYCLE && c.length <= MAX_CYCLE);

/**
 * Sleep in the three nights before each period against the rest of those cycles, over the last
 * six: a card when it's a quarter of an hour or more less, in three cycles or more.
 */
function sleepBefore(ctx: InsightContext, add: Add): void {
  const cycles = completeCycles(ctx).slice(-6);
  const asleep = new Map<string, number>();
  for (const n of ctx.cycle!.nights) if (typeof n.asleep === 'number') asleep.set(n.date, n.asleep);
  const before: number[] = [];
  const rest: number[] = [];
  let counted = 0;
  for (const c of cycles) {
    const late: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const v = asleep.get(addDays(c.next!, -k));
      if (v !== undefined) late.push(v);
    }
    const others: number[] = [];
    for (let d = c.start; d < addDays(c.next!, -3); d = addDays(d, 1)) {
      const v = asleep.get(d);
      if (v !== undefined) others.push(v);
    }
    if (late.length >= 2 && others.length >= 10) {
      before.push(...late);
      rest.push(...others);
      counted++;
    }
  }
  if (counted < 3) return;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const diff = mean(rest) - mean(before);
  if (diff < 15) return;
  add({
    ...base, id: 'cycle-sleep-before', kind: 'pattern', tone: 'neutral',
    importance: 40, topic: 'cycle-sleep', family: 'cycle', today: 'never', news: false,
    title: t('insights.cycle.sleepBefore.title'),
    text: t('insights.cycle.sleepBefore.text', {
      count: counted,
      before: formatDuration(mean(before)),
      diff: Math.round(diff),
    }),
  });
}

/** The person's own second-half shift in the sleeping heart rate the finder reads, once three cycles show it. */
function heartFollows(ctx: InsightContext, add: Add): void {
  const { summary, nights, judged } = ctx.cycle!;
  const shift = typicalShift(nights, summary, 'sleepHr', 0, 6);
  if (shift === null || shift < 1) return;
  const cycles = cycleShifts(nights, summary, 'sleepHr').length;
  add({
    ...base, id: 'cycle-heart-follows', kind: 'pattern', tone: 'neutral',
    importance: 38, topic: 'cycle-heart', family: 'cycle', today: 'never', news: false,
    title: t('insights.cycle.heartFollows.title'),
    text: t('insights.cycle.heartFollows.text', {
      count: cycles,
      bpm: formatFixed(shift, 1),
      aware: judged ? 'yes' : 'no',
    }),
  });
}

/** Cycles within a week of each other, over the last six: steady. */
function steady(ctx: InsightContext, add: Add): void {
  const { summary } = ctx.cycle!;
  const length = summary.length;
  if (!length || length.count < 6 || length.max - length.min > 7) return;
  // News for the first few days after the cycle that made it six.
  const latest = completeCycles(ctx).at(-1);
  add({
    ...base, id: 'cycle-steady', kind: 'trend', tone: 'good',
    importance: 36, topic: 'cycle-steady', family: 'cycle', today: 'never',
    news: !!latest?.next && daysBetween(latest.next, ctx.today) <= 2,
    title: t('insights.cycle.steady.title'),
    text: t('insights.cycle.steady.text', {
      spread: length.min === length.max ? 'none' : 'some',
      count: length.count,
      min: length.min,
      max: length.max,
      periods: !summary.period ? 'none' : summary.period.min === summary.period.max ? 'same' : 'range',
      periodMin: summary.period?.min ?? 0,
      periodMax: summary.period?.max ?? 0,
    }),
  });
}
