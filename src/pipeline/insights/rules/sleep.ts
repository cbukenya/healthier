import { addDays, daysBetween } from '../../../lib/date';
import { names, t } from '../../../i18n';
import {
  formatClock, formatDayMonthLong, formatDuration, formatHours, formatHoursDecimal, formatMonth,
} from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import {
  NEED_ESTIMATE, circularMeanMinutes, compareToBaseline, findGaps, firstObserved, series, sleepDebt, sleepNeedFor, sleepRegularity,
  stats, values,
} from '../../derive';
import { scoreSleep } from '../../sleep';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, beforeLatestMorning, circDelta, cut, heldFor, isWorkday, pastYear, reachesYear, freshEntry, sinceNote, sleepMins,
  trailingDays,
} from '../helpers';
import {
  bestBedtime, dayRecord, lastMonthBest, monthsOf, sleepHrvAssociation, weekdayExtremes, workFreeNights,
  type BestBedtime,
} from '../patterns';
import type { HistoryQueries } from '../../history';
import type { Daypart, Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'sleep' as const, page: 'sleep' as const };

/** What Sleep asks of the past year before the window: monthly sleep score and length, and the best night. */
export const sleepQueries = {
  sleepScoreByMonth: { measure: 'sleepScore', group: 'month', aggregate: ['sum', 'count'], back: 365 },
  sleepMinutesByMonth: { measure: 'sleepMinutes', group: 'month', aggregate: ['sum', 'count'], back: 365 },
  bestNight: { measure: 'sleepScore', aggregate: ['max', 'count', 'first'], back: 365 },
} satisfies HistoryQueries;

/** Last night, the week's debt, timing and regularity, how you sleep, and the gaps in the record. */
export function sleepRules(ctx: InsightContext, add: Add): void {
  const shift = bedtimeShift(ctx.days);
  const tonight = windDownDue(ctx, shift);
  lastNight(ctx, add, tonight);
  debtCleared(ctx, add);
  restedStreak(ctx, add);
  sleepNeed(ctx, add);
  timing(ctx, add, shift);
  const best = bestBedtimeCard(ctx, add);
  if (tonight) windDown(ctx, add, shift, best);
  rhythm(ctx, add);
  weekdays(ctx, add);
  weekShape(ctx, add);
  quality(ctx, add);
  rem(ctx, add);
  naps(ctx, add);
  hrvLink(ctx, add);
  bestMonth(ctx, add);
  bestNight(ctx, add);
  coverage(ctx, add);
}

/** A clock time to the nearest five minutes, for "about". */
const clk5 = (m: number) => formatClock(Math.round(m / 5) * 5);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Last night is a short night (watch) or a good one (win), never both. */
const nightOf = (ctx: InsightContext) => {
  const night = ctx.lastNightIsRecent ? ctx.lastNight : null;
  if (!night) return null;
  const sc = scoreSleep(night);
  const short = sc.total <= 55 || night.minutesAsleep <= ctx.need - 90;
  const good = !short && (sc.total >= 85 || (night.minutesAsleep >= ctx.need + 40 && sc.total >= 70));
  return { night, sc, short, good };
};

function lastNight(ctx: InsightContext, add: Add, tonight: boolean): void {
  const n = nightOf(ctx);
  if (!n) return;
  const { night, sc } = n;
  const { days, need, needH } = ctx;

  if (n.short) {
    // Escalates on the second short night; the third hands over to the debt card.
    const shortNights = trailingDays(days, (d) => (d.sleep ? d.sleep.minutesAsleep <= need - 90 : null));
    if (shortNights < 3) {
      const second = shortNights === 2;
      add({
        ...base, id: 'night-short', kind: 'alert', tone: 'watch',
        importance: 86, topic: 'sleep-night', family: 'sleep-amount', today: 'while-true', news: true, daypart: ['morning'],
        title: t('insights.sleep.nightShort.title'),
        text: t('insights.sleep.nightShort.text', { score: sc.total, slept: formatDuration(night.minutesAsleep), need: needH })
          + (second ? t('insights.sleep.nightShort.secondNight') : ''),
        action: second ? t('insights.sleep.nightShort.actionSecond') : t('insights.sleep.nightShort.action'),
      });
    }
  } else if (n.good) {
    // Wins carry no homework.
    const nights = days.filter((d) => d.sleep && d.date !== ctx.lastNightDay!.date);
    const lastBetter = [...nights].reverse().find((d) => scoreSleep(d.sleep!).total >= sc.total);
    const weeksSince = lastBetter ? Math.floor(daysBetween(lastBetter.date, ctx.lastNightDay!.date) / 7) : null;
    add({
      ...base, id: 'night-good', kind: 'milestone', tone: 'good',
      importance: 72, topic: 'sleep-night', family: 'sleep-amount', today: 'while-true', news: true, daypart: ['morning'],
      title: t('insights.sleep.nightGood.title'),
      text: t('insights.sleep.nightGood.text', {
        score: sc.total, slept: formatDuration(night.minutesAsleep), efficiency: Math.round(night.efficiency),
      }) + (weeksSince !== null && weeksSince >= 2 ? t('insights.sleep.nightGood.bestInWeeks', { weeks: weeksSince }) : ''),
    });
  }

  // Deep sleep against your own usual: rare by construction.
  const deep = compareToBaseline(series(days, (d) => d.sleep?.stages?.deep ?? null));
  if (night.stages && deep.z !== null && deep.z >= 1.5 && deep.n >= 8) {
    add({
      ...base, id: 'deep-high', kind: 'pattern', tone: 'good',
      importance: 60, topic: 'sleep-stage', family: 'sleep-stages', today: 'never', news: true,
      title: t('insights.sleep.deepHigh.title'),
      text: t('insights.sleep.deepHigh.text', { minutes: Math.round(night.stages.deep), usual: Math.round(deep.baseline!) }),
    });
  }

  debt(ctx, add, n.good ? night.minutesAsleep : null, tonight);
}

/** Sleep debt worth a card, and debt worth calling very short. */
const SHORT_DEBT = 180;
const SEVERE_DEBT = 360;

/**
 * The battery's own debt figure, netted over the week before last night. A week with under 5
 * recorded nights is an estimate, not a weekly total, so the card stays quiet rather than
 * extrapolating. A good last night becomes a clause here instead of a card of its own.
 *
 * Debt can last for weeks, and the same warning every morning stops being read. So it's on
 * Today as it starts and again when it deepens into very short; in between it waits on the
 * Sleep page, saying how long it has lasted. In the evening the wind-down nudge carries it.
 */
function debt(ctx: InsightContext, add: Add, goodNightMin: number | null, tonight: boolean): void {
  const { debtMin, days } = ctx;
  if (debtMin === null || debtMin <= SHORT_DEBT) return;
  const severe = debtMin > SEVERE_DEBT;
  const nights = ctx.debt!.nightsKnown;
  // The debt as the card showed it on an earlier day, against the need as it stood then.
  const owed = (w: DailyRecord[]) => {
    const d = sleepDebt(w, sleepNeedFor(w, ctx.goals.sleepNeed));
    return d && d.coverage === 'full' ? d.netMin : 0;
  };
  const news = freshEntry((n) => owed(cut(days, n)) > SHORT_DEBT)
    || (severe && freshEntry((n) => owed(cut(days, n)) > SEVERE_DEBT));
  const held = heldFor(days, (w) => owed(w) > SHORT_DEBT);
  const shortfall = formatHoursDecimal(debtMin);
  add({
    ...base, id: 'sleep-debt', kind: 'alert', tone: 'watch',
    importance: 89, topic: 'sleep-debt', family: 'sleep-amount', today: 'as-news', news, advice: 'rest',
    ...(tonight ? { daypart: ['morning', 'midday'] as Daypart[] } : {}),
    title: severe ? t('insights.sleep.sleepDebt.titleSevere') : t('insights.sleep.sleepDebt.title'),
    text: (goodNightMin !== null
      ? t('insights.sleep.sleepDebt.textAfterGoodNight', { slept: formatDuration(goodNightMin), nights, shortfall })
      : t('insights.sleep.sleepDebt.text', { nights, shortfall }))
      + (severe ? t('insights.sleep.sleepDebt.severe') : '')
      + (news ? '' : sinceNote(held, 'night')),
    action: severe ? t('insights.sleep.sleepDebt.actionSevere') : t('insights.sleep.sleepDebt.action'),
  });
}

/**
 * The arguments for "within about 25 minutes of 23:10", or "at about 23:10 every night" when the
 * spread rounds to nothing.
 */
const within = (sdMin: number, mean: number) =>
  ({ exact: Math.round(sdMin) < 5, minutes: Math.round(sdMin), time: formatClock(mean) });

type BedtimeShift = { later: boolean; news: boolean; held: number };

/**
 * This week's average bedtime against the two weeks before, when it moved 30 minutes or more.
 * News uses hysteresis (not if it was already halfway there) and a quiet week (not if the
 * same shift held days ago and is only coming back).
 */
function bedtimeShift(days: DailyRecord[]): BedtimeShift | null {
  const shiftDelta = (w: DailyRecord[]): number | null => {
    const recent = circularMeanMinutes(sleepMins(w.slice(-7), (x) => x.bedtimeMin));
    const prior = circularMeanMinutes(sleepMins(w.slice(-21, -7), (x) => x.bedtimeMin));
    if (!recent || !prior || recent.n < 4 || prior.n < 5) return null;
    return circDelta(recent.mean, prior.mean);
  };
  const now = shiftDelta(days);
  if (now === null || Math.abs(now) < 30) return null;
  const sameWay = (w: DailyRecord[]) => {
    const d = shiftDelta(w);
    return d !== null && Math.abs(d) >= 30 && Math.sign(d) === Math.sign(now);
  };
  const then = shiftDelta(cut(days, ENTRY_WINDOW + 1));
  const news = (then === null || Math.abs(then) < 15 || Math.sign(then) !== Math.sign(now))
    && freshEntry((n) => sameWay(cut(days, n)));
  return { later: now > 0, news, held: heldFor(days, sameWay) };
}

/** Bedtime shifts and spread, and wake-time steadiness: all on the 24-hour circle. */
function timing(ctx: InsightContext, add: Add, shift: BedtimeShift | null): void {
  const { days } = ctx;

  if (shift) {
    const { later, news, held } = shift;
    const recent = circularMeanMinutes(sleepMins(days.slice(-7), (x) => x.bedtimeMin))!;
    const prior = circularMeanMinutes(sleepMins(days.slice(-21, -7), (x) => x.bedtimeMin))!;
    const times = { recent: formatClock(recent.mean), prior: formatClock(prior.mean) };
    add({
      ...base, id: later ? 'bed-creep-later' : 'bed-creep-earlier', kind: 'trend', tone: later ? 'watch' : 'good',
      direction: later ? 'up' : 'down',
      importance: later ? 68 : 58, topic: 'bedtime-shift', family: 'sleep-timing', today: later ? 'as-news' : 'never', news,
      claims: { metric: 'bedtime', direction: later ? 'up' : 'down' }, evidence: recent.n + prior.n,
      title: later ? t('insights.sleep.bedCreepLater.title') : t('insights.sleep.bedCreepEarlier.title'),
      text: t('insights.sleep.common.bedtimeShift', times) + (news ? '' : sinceNote(held)),
    });
  }

  const spread = (w: DailyRecord[]) => circularMeanMinutes(sleepMins(w.slice(-14), (x) => x.bedtimeMin));
  const s14 = spread(days);
  if (s14 && s14.n >= 7) {
    if (s14.sdMin > 60) {
      // Hysteresis: fires above ±60 and counts as already on unless it was under ±45.
      const was = spread(cut(days, ENTRY_WINDOW + 1));
      add({
        ...base, id: 'bed-drifting', kind: 'trend', tone: 'watch',
        importance: 66, topic: 'bedtime-spread', family: 'sleep-timing', today: 'as-news',
        news: !(was !== null && was.n >= 7 && was.sdMin >= 45),
        claims: { metric: 'bedtime-spread', direction: 'up' }, evidence: s14.n,
        title: t('insights.sleep.bedDrifting.title'),
        text: t('insights.sleep.bedDrifting.text', { minutes: Math.round(s14.sdMin), time: formatClock(s14.mean) }),
      });
    } else if (s14.sdMin < 30) {
      const was = spread(cut(days, ENTRY_WINDOW + 1));
      const news = !(was !== null && was.n >= 7 && was.sdMin <= 40);
      add({
        ...base, id: 'bed-settling', kind: 'trend', tone: 'good',
        importance: 50, topic: 'bedtime-spread', family: 'sleep-timing', today: 'never', news,
        claims: { metric: 'bedtime', direction: 'steady' }, evidence: s14.n,
        title: news ? t('insights.sleep.bedSettling.titleSettling') : t('insights.sleep.bedSettling.titleSteady'),
        text: t('insights.sleep.bedSettling.text', within(s14.sdMin, s14.mean)),
      });
    }
  }

  const wakeSpread = (w: DailyRecord[]) => circularMeanMinutes(sleepMins(w.slice(-14), (x) => x.wakeMin));
  const w14 = wakeSpread(days);
  if (w14 && w14.n >= 7 && w14.sdMin < 25) {
    const was = wakeSpread(cut(days, ENTRY_WINDOW + 1));
    add({
      ...base, id: 'wake-rhythm', kind: 'pattern', tone: 'good',
      importance: 45, topic: 'wake-time', family: 'sleep-timing', today: 'never',
      news: !(was !== null && was.n >= 7 && was.sdMin <= 35),
      title: t('insights.sleep.wakeRhythm.title'),
      text: t('insights.sleep.wakeRhythm.text', within(w14.sdMin, w14.mean)),
    });
  }

  // Regularity climbing a band: the first two days of the month.
  if (ctx.dom <= 2 && days.length >= 55) {
    const now = sleepRegularity(days.slice(-31));
    const before = sleepRegularity(days.slice(-62, -31));
    const rank = { critical: 0, bad: 1, good: 2, excellent: 3 } as const;
    if (now && before && rank[now.band] > rank[before.band]) {
      add({
        ...base, id: 'sri-climbing', kind: 'trend', tone: 'good', direction: 'up',
        importance: 64, topic: 'sleep-regularity', family: 'sleep-timing', today: 'as-news', news: true,
        title: t('insights.sleep.sriClimbing.title'),
        text: t('insights.sleep.sriClimbing.text', { before: before.score, now: now.score }),
      });
    }
  }
}

/**
 * The evening nudge earns its place after a short night, or when a later bedtime is news:
 * the evenings when tonight matters most. Every evening of a long debt would make it wallpaper.
 */
function windDownDue(ctx: InsightContext, shift: BedtimeShift | null): boolean {
  if (ctx.part !== 'evening') return false;
  if (!nightOf(ctx)?.short && !(shift?.later && shift.news)) return false;
  const avg = circularMeanMinutes(sleepMins(ctx.days.slice(-14), (x) => x.bedtimeMin));
  return !!avg && avg.n >= 5;
}

/**
 * The evening nudge, anchored to your own bedtime. Once your best bedtime is known, it leads
 * with that. It carries the week's debt, so the debt card doesn't sit beside it.
 */
function windDown(ctx: InsightContext, add: Add, shift: BedtimeShift | null, best: BestBedtime | null): void {
  const { debtMin } = ctx;
  const laterShiftNews = !!shift?.later && shift.news;
  const owed = debtMin !== null && debtMin > 120;
  const shortNight = !!nightOf(ctx)?.short;
  const avg = circularMeanMinutes(sleepMins(ctx.days.slice(-14), (x) => x.bedtimeMin))!;
  const target = best?.earlierBetter ? best.cut : null;
  const week = circularMeanMinutes(sleepMins(ctx.days.slice(-7), (x) => x.bedtimeMin));
  const pastTarget = target !== null && week !== null && circDelta(week.mean, target) > 0;
  add({
    ...base, id: 'wind-down', kind: 'nudge', tone: 'neutral',
    importance: 52, topic: 'sleep-tonight', family: 'sleep-tonight', today: 'while-true', news: true, daypart: ['evening'], advice: 'rest',
    title: t('insights.sleep.windDown.title'),
    text: target !== null
      ? t('insights.sleep.windDown.textBest', { time: formatClock(target) }) + (owed
        ? t('insights.sleep.windDown.bestAlsoShort', { shortfall: formatHoursDecimal(debtMin!) })
        : shortNight ? t('insights.sleep.windDown.bestLastNightShort')
        : pastTarget ? t('insights.sleep.windDown.bestThisWeek', { time: formatClock(week!.mean) })
        : t('insights.sleep.windDown.bestGettingLater'))
      : t('insights.sleep.windDown.textUsual', { time: formatClock(avg.mean), later: laterShiftNews }) + (owed
        ? t('insights.sleep.windDown.usualAlsoShort', { shortfall: formatHoursDecimal(debtMin!) })
        : shortNight ? t('insights.sleep.windDown.usualLastNightShort') : ''),
    action: target !== null
      ? t('insights.sleep.windDown.actionBest', { time: formatClock(target) })
      : t('insights.sleep.windDown.actionUsual'),
  });
}

/** Workdays against free days: the social-jetlag signature. */
function weekdays(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const minutes = (ds: DailyRecord[]) => values(series(ds, (d) => d.sleep?.minutesAsleep ?? null));
  const work = stats(minutes(days.filter((d) => isWorkday(d.date))));
  const free = stats(minutes(days.filter((d) => !isWorkday(d.date))));
  if (!work || !free || work.n < 9 || free.n < 6 || free.median - work.median < 60) return;
  add({
    ...base, id: 'weekday-deficit', kind: 'pattern', tone: 'neutral',
    importance: 46, topic: 'week-sleep', family: 'sleep-week', today: 'never', news: ctx.dom <= 2,
    title: t('insights.sleep.weekdayDeficit.title'),
    text: t('insights.sleep.weekdayDeficit.text', { free: formatDuration(free.median), work: formatDuration(work.median) }),
  });
}

/** The week's debt cleared: it reached over 3 hours in the last week and is now under 1. */
function debtCleared(ctx: InsightContext, add: Add): void {
  const { days, need, debtMin } = ctx;
  if (debtMin === null || debtMin >= 60) return;
  const weekDebt = (w: DailyRecord[]) => {
    const d = sleepDebt(w, need);
    return d && d.coverage === 'full' ? d.netMin : null;
  };
  let peak = { min: 0, daysAgo: 0 };
  for (let k = 1; k <= 7; k++) {
    const d = weekDebt(cut(days, k)) ?? 0;
    if (d > peak.min) peak = { min: d, daysAgo: k };
  }
  if (peak.min <= 180) return;
  const before = weekDebt(beforeLatestMorning(days));
  const when = peak.daysAgo >= 5 ? 'lastWeek' : peak.daysAgo === 1 ? 'yesterday' : 'fewDaysAgo';
  add({
    ...base, id: 'sleep-debt-cleared', kind: 'milestone', tone: 'good',
    importance: 66, topic: 'sleep-debt', family: 'sleep-amount', today: 'as-news', news: before !== null && before >= 60,
    title: t('insights.sleep.sleepDebtCleared.title'),
    text: t('insights.sleep.sleepDebtCleared.text', {
      when, shortfall: formatHoursDecimal(peak.min), nights: ctx.debt!.nightsKnown, met: debtMin <= 0,
    }),
  });
}

/** Nights in a row at your need or more: 3 and 5 on the page, a week or two on Today too. */
function restedStreak(ctx: InsightContext, add: Add): void {
  const { days, need, needH, lastNightDay, today } = ctx;
  if (!ctx.lastNightIsRecent) return;
  const run = trailingDays(days, (d) => (d.sleep ? d.sleep.minutesAsleep >= need : null));
  if (run < 3) return;
  add({
    ...base, id: 'sleep-rested-streak', kind: 'milestone', tone: 'good',
    importance: 62, topic: 'rested-streak', family: 'sleep-amount', today: run >= 7 ? 'as-news' : 'never',
    // A run grows by one each morning, so it's news only on the morning its night arrives.
    news: [3, 5, 7, 14].includes(run) && lastNightDay?.date === today,
    title: t('insights.sleep.sleepRestedStreak.title'),
    text: t('insights.sleep.sleepRestedStreak.text', { need: needH, nights: run }),
  });
}

/** What every sleep card measures against, and where that figure comes from. */
function sleepNeed(ctx: InsightContext, add: Add): void {
  const nights = sleepMins(ctx.days, (x) => x.minutesAsleep);
  if (nights.length < 14) return;
  const median = stats(nights)!.median;
  const text = ctx.goals.sleepNeed !== null
    ? t('insights.sleep.sleepNeed.textSet', { need: formatHours(ctx.need), usual: formatDuration(median) })
    : median < NEED_ESTIMATE.floor
      ? t('insights.sleep.sleepNeed.textFloor', { hours: NEED_ESTIMATE.floor / 60, usual: formatDuration(median) })
      : median > NEED_ESTIMATE.ceiling
        ? t('insights.sleep.sleepNeed.textCeiling', { need: ctx.needH, usual: formatDuration(median) })
        : t('insights.sleep.sleepNeed.textEstimate', { need: ctx.needH, nights: nights.length });
  add({
    ...base, id: 'sleep-need', kind: 'pattern', tone: 'neutral',
    importance: 36, topic: 'sleep-need', family: 'sleep-need', today: 'never', news: false,
    title: t('insights.sleep.sleepNeed.title'),
    text,
  });
}

/** Sleep score by bedtime, split at your usual bedtime. Returns the pattern for the wind-down nudge. */
function bestBedtimeCard(ctx: InsightContext, add: Add): BestBedtime | null {
  const best = bestBedtime(ctx.days);
  if (!best) return null;
  const [first, second] = best.earlierBetter ? [best.early, best.late] : [best.late, best.early];
  const scores = {
    time: formatClock(best.cut), score: Math.round(first.mean), otherScore: Math.round(second.mean),
    nights: first.n, otherNights: second.n,
  };
  add({
    ...base, id: 'sleep-best-bedtime', kind: 'pattern', tone: 'neutral',
    importance: 48, topic: 'best-bedtime', family: 'sleep-timing', today: 'never', news: false,
    title: best.earlierBetter
      ? t('insights.sleep.sleepBestBedtime.titleEarlier', scores)
      : t('insights.sleep.sleepBestBedtime.titleLater'),
    text: best.earlierBetter
      ? t('insights.sleep.sleepBestBedtime.textEarlier', scores)
      : t('insights.sleep.sleepBestBedtime.textLater', scores),
  });
  return best;
}

/** Your natural timing on free nights, and how far weekends shift it. */
function rhythm(ctx: InsightContext, add: Add): void {
  const wf = workFreeNights(ctx.days);
  if (!wf) return;
  const { work, free } = wf;
  const catchUp = free.span > work.span && Math.abs(circDelta(wf.midCorrected, free.mid)) >= 15;
  add({
    ...base, id: 'sleep-natural-rhythm', kind: 'pattern', tone: 'neutral',
    importance: 40, topic: 'natural-rhythm', family: 'sleep-timing', today: 'never', news: false,
    title: t('insights.sleep.sleepNaturalRhythm.title'),
    text: t('insights.sleep.sleepNaturalRhythm.text', {
      bed: clk5(free.bed), wake: clk5(free.wake), catchUp, mid: clk5(catchUp ? wf.midCorrected : free.mid),
    }),
  });

  const shift = circDelta(free.mid, work.mid);
  if (Math.abs(shift) < 60) return;
  add({
    ...base, id: 'sleep-weekend-shift', kind: 'pattern', tone: 'neutral',
    importance: 47, topic: 'weekend-shift', family: 'sleep-timing', today: 'never', news: false,
    title: t('insights.sleep.sleepWeekendShift.title'),
    text: t('insights.sleep.sleepWeekendShift.text', { shift: formatDuration(Math.abs(shift)), later: shift > 0 }),
  });
}

/** Your shortest and longest nights of the week, named by the evening they start. */
function weekShape(ctx: InsightContext, add: Add): void {
  const nights = ctx.days
    .filter((d) => d.sleep)
    .map((d) => ({ date: addDays(d.date, -1), value: d.sleep!.minutesAsleep }));
  const ext = weekdayExtremes(nights, 5);
  if (!ext || ext.high.median! - ext.low.median! < 45) return;
  // Each night by the evening it starts, Sunday first, as the language names it ("Monday night").
  const nightNames = names('insights.sleep.sleepWeekShape.nights');
  add({
    ...base, id: 'sleep-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 42, topic: 'week-sleep', family: 'sleep-week', today: 'never', news: false,
    title: t('insights.sleep.sleepWeekShape.title'),
    text: t('insights.sleep.sleepWeekShape.text', {
      shortestNight: nightNames[(ext.low.weekday + 1) % 7], shortest: formatDuration(ext.low.median!),
      longestNight: nightNames[(ext.high.weekday + 1) % 7], longest: formatDuration(ext.high.median!),
    }),
  });
}

/** Time awake at night, and how much of your time in bed is sleep. */
function quality(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const awake = (w: DailyRecord[]) => {
    const s = series(w, (d) => d.sleep?.minutesAwake ?? null);
    const recent = values(s.slice(-7));
    const usual = values(s.slice(-35, -7));
    if (recent.length < 5 || usual.length < 14) return null;
    const now = mean(recent);
    const typical = stats(usual)!.median;
    return { now, typical, holds: now >= typical * 1.5 && now - typical >= 15 };
  };
  const a = awake(days);
  if (a?.holds) {
    add({
      ...base, id: 'sleep-restless', kind: 'trend', tone: 'watch', direction: 'up',
      importance: 58, topic: 'night-wakes', family: 'sleep-quality', today: 'never',
      news: !awake(cut(days, ENTRY_WINDOW + 1))?.holds,
      claims: { metric: 'awake', direction: 'up' }, evidence: 7,
      title: t('insights.sleep.sleepRestless.title'),
      text: t('insights.sleep.sleepRestless.text', { minutes: Math.round(a.now), usual: Math.round(a.typical) }),
    });
  }

  const efficiency = (rows: DailyRecord[]) => {
    const nights = rows.filter((d) => d.sleep && d.sleep.minutesInBed > 0);
    if (nights.length < 14) return null;
    const asleep = nights.reduce((x, d) => x + d.sleep!.minutesAsleep, 0);
    const inBed = nights.reduce((x, d) => x + d.sleep!.minutesInBed, 0);
    return { pct: (asleep / inBed) * 100, asleep: asleep / nights.length, inBed: inBed / nights.length };
  };
  const month = efficiency(days.slice(-30));
  if (!month) return;
  const before = efficiency(days.slice(-60, -30));
  if (before && before.pct - month.pct >= 5) {
    add({
      ...base, id: 'sleep-efficiency', kind: 'trend', tone: 'watch', direction: 'down',
      importance: 53, topic: 'efficiency', family: 'sleep-quality', today: 'never', news: false,
      claims: { metric: 'efficiency', direction: 'down' },
      title: t('insights.sleep.sleepEfficiency.titleFalling'),
      text: t('insights.sleep.sleepEfficiency.textFalling', { pct: Math.round(month.pct), before: Math.round(before.pct) }),
    });
    return;
  }
  const good = month.pct >= 85;
  add({
    ...base, id: 'sleep-efficiency', kind: 'pattern', tone: good ? 'good' : 'neutral',
    importance: 35, topic: 'efficiency', family: 'sleep-quality', today: 'never', news: false,
    title: good ? t('insights.sleep.sleepEfficiency.titleGood') : t('insights.sleep.sleepEfficiency.titleNeutral'),
    text: t('insights.sleep.sleepEfficiency.text', {
      pct: Math.round(month.pct), asleep: formatDuration(month.asleep), inBed: formatDuration(month.inBed),
    }),
  });
}

/** Most of the last week's nights under your usual REM. */
function rem(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const low = (w: DailyRecord[]) => {
    const s = series(w, (d) => d.sleep?.stages?.rem ?? null);
    const recent = values(s.slice(-7));
    const usual = values(s.slice(-35, -7));
    if (recent.length < 5 || usual.length < 10) return null;
    const st = stats(usual)!;
    // Below the usual range: the median less its robust spread, never under 10 minutes.
    const floor = st.median - Math.max(10, 1.4826 * st.mad);
    return { n: recent.filter((v) => v < floor).length, of: recent.length, now: stats(recent)!.median, typical: st.median };
  };
  const r = low(days);
  if (!r || r.n < 5) return;
  const was = low(cut(days, ENTRY_WINDOW + 1));
  add({
    ...base, id: 'sleep-rem-short', kind: 'trend', tone: 'watch', direction: 'down',
    importance: 55, topic: 'rem', family: 'sleep-rem', today: 'never', news: !was || was.n < 5,
    claims: { metric: 'rem', direction: 'down' }, evidence: r.of,
    title: t('insights.sleep.sleepRemShort.title'),
    text: t('insights.sleep.sleepRemShort.text', {
      every: r.n === r.of, low: r.n, nights: r.of, minutes: Math.round(r.now), usual: Math.round(r.typical),
    }),
  });
}

/** Two or more naps in the last week, and whether short nights came before them. */
function naps(ctx: InsightContext, add: Add): void {
  const week = ctx.days.slice(-7).flatMap((d) => d.naps.map((nap) => ({ nap, night: d.sleep })));
  if (week.length < 2) return;
  const afterShort = week.every((x) => x.night !== null && x.night.minutesAsleep < ctx.need);
  add({
    ...base, id: 'sleep-naps', kind: 'pattern', tone: 'neutral',
    importance: 38, topic: 'naps', family: 'sleep-naps', today: 'never', news: false,
    title: t('insights.sleep.sleepNaps.title'),
    text: t('insights.sleep.sleepNaps.text', { naps: week.length, minutes: Math.round(mean(week.map((x) => x.nap.minutesAsleep))) })
      + (afterShort ? t('insights.sleep.sleepNaps.afterShortNights', { need: ctx.needH }) : ''),
  });
}

/** Long nights and overnight HRV: an association in your data, never a cause. */
function hrvLink(ctx: InsightContext, add: Add): void {
  const a = sleepHrvAssociation(ctx.days);
  if (!a) return;
  const higher = a.pct > 0;
  add({
    ...base, id: 'sleep-hrv-link', kind: 'pattern', tone: 'neutral',
    importance: 49, topic: 'sleep-hrv', family: 'correlation', today: 'never', news: false,
    title: higher ? t('insights.sleep.sleepHrvLink.titleHigher') : t('insights.sleep.sleepHrvLink.titleLower'),
    text: t('insights.sleep.sleepHrvLink.text', { higher, pct: Math.abs(a.pct), longer: a.nLong, shorter: a.nShort }),
  });
}

/** Last month, if its average sleep score was your best on record: news on the 1st and 2nd, then on the page. */
function bestMonth(ctx: InsightContext, add: Add): void {
  const best = lastMonthBest(monthsOf(ctx.days, 'sleepScore', ctx.answers.sleepScoreByMonth), ctx.today, 15, 'max');
  if (!best) return;
  const month = monthsOf(ctx.days, 'sleepMinutes', ctx.answers.sleepMinutesByMonth).find((m) => m.month === best.month)!;
  add({
    ...base, id: 'sleep-best-month', kind: 'milestone', tone: 'good',
    importance: 63, topic: 'best-month-sleep', family: 'monthly-best', today: 'as-news', news: ctx.dom <= 2,
    title: t('insights.sleep.sleepBestMonth.title'),
    text: t('insights.sleep.sleepBestMonth.text', {
      month: formatMonth(best.month, ctx.today), slept: formatDuration(month.sum / month.n), score: Math.round(best.value),
      span: pastYear(`${best.since}-01`, ctx.today),
    }),
  });
}

/**
 * Your best night's sleep in the past year, by sleep score: on Today the
 * morning after, then on the page for a couple of days. It speaks for "You
 * slept really well", and the debt card outranks it the way it does that one.
 */
function bestNight(ctx: InsightContext, add: Add): void {
  const r = dayRecord(ctx.days, ctx.today, 'sleepScore', 'max', ctx.answers.bestNight, { mustReach: 80, maxAge: 3 });
  if (!r) return;
  const span = pastYear(r.since, ctx.today);
  add({
    ...base, id: 'sleep-best-night', kind: 'milestone', tone: 'good',
    importance: 80, topic: 'sleep-night', family: 'sleep-amount', today: 'as-news', news: r.age <= 1,
    title: reachesYear(r.since, ctx.today)
      ? t('insights.sleep.sleepBestNight.titleYear')
      : t('insights.sleep.sleepBestNight.titleYet'),
    text: t('insights.sleep.sleepBestNight.text', {
      lastNight: r.age === 0, date: formatDayMonthLong(r.date), score: Math.round(r.value), span, previous: Math.round(r.previous),
    }),
  });
}

/**
 * Gaps and a short record, said plainly on the page. One card at a time: a
 * thin record explains the gaps too.
 */
function coverage(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const card = { ...base, domain: 'data' as const, kind: 'data' as const, tone: 'neutral' as const, topic: 'sleep-record', family: 'data', today: 'never' as const, news: false };
  const recorded = values(series(days, (d) => d.sleep?.minutesAsleep ?? null)).length;
  const start = firstObserved(days, 'sleep');
  if (start && recorded < days.length * 0.5) {
    // A record that began inside the window is new; one that began before it is thin.
    const isNew = daysBetween(days[0].date, start) > 7;
    add({
      ...card, id: 'sleep-coverage', importance: 29,
      title: isNew ? t('insights.sleep.sleepCoverage.titleNew') : t('insights.sleep.sleepCoverage.titleThin'),
      text: isNew
        ? t('insights.sleep.sleepCoverage.textNew', { date: formatDayMonthLong(start), nights: recorded })
        : t('insights.sleep.sleepCoverage.textThin', { recorded, nights: days.length }),
    });
  }
  const gaps = findGaps(days, 'sleep', 3);
  if (gaps.length) {
    const g = gaps[gaps.length - 1];
    if (daysBetween(g.to, today) <= 7) {
      add({
        ...card, id: 'sleep-gap', importance: 28,
        title: t('insights.sleep.sleepGap.title'),
        text: t('insights.sleep.sleepGap.text', { from: formatDayMonthLong(g.from), to: formatDayMonthLong(g.to) }),
      });
    }
  }
}
