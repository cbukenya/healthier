import { addDays, daysBetween } from '../../../lib/date';
import type { DailyRecord } from '../../../types/health';
import {
  circularMeanMinutes, compareToBaseline, findGaps, firstObserved, series, sleepDebt, sleepRegularity, stats, values,
} from '../../derive';
import { scoreSleep } from '../../sleep';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, beforeLatestMorning, circDelta, clk, cut, dayMonth, heldFor, hm, hoursText, isWorkday, plural, sinceNote,
  sleepMins, trailingDays,
} from '../helpers';
import {
  WEEKDAYS, bestBedtime, sleepHrvAssociation, weekdayExtremes, workFreeNights, type BestBedtime,
} from '../patterns';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'sleep' as const, page: 'sleep' as const };

/** Last night, the week's debt, timing and regularity, how you sleep, and the gaps in the record. */
export function sleepRules(ctx: InsightContext, add: Add): void {
  lastNight(ctx, add);
  debtCleared(ctx, add);
  restedStreak(ctx, add);
  sleepNeed(ctx, add);
  const laterShiftNews = timing(ctx, add);
  const best = bestBedtimeCard(ctx, add);
  windDown(ctx, add, laterShiftNews, best);
  rhythm(ctx, add);
  weekdays(ctx, add);
  weekShape(ctx, add);
  quality(ctx, add);
  rem(ctx, add);
  naps(ctx, add);
  hrvLink(ctx, add);
  coverage(ctx, add);
}

/** A clock time to the nearest five minutes, for "about". */
const clk5 = (m: number) => clk(Math.round(m / 5) * 5);
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

function lastNight(ctx: InsightContext, add: Add): void {
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
        title: "Last night wasn't your best sleep",
        text: `Your sleep score is ${sc.total} out of 100 from last night. You slept ${hm(night.minutesAsleep)} compared to your ${needH} need.${second ? ' That makes two short nights in a row.' : ''}`,
        action: second
          ? 'Missed sleep adds up, so tonight matters more than last night did.'
          : 'Going to bed even 30 minutes earlier tonight will help you catch up.',
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
      title: 'You slept really well',
      text: `Your sleep score is ${sc.total} out of 100 from last night. You slept ${hm(night.minutesAsleep)} and were asleep for ${Math.round(night.efficiency)}% of your time in bed.${weeksSince !== null && weeksSince >= 2 ? ` It's your best night in ${weeksSince} weeks.` : ''}`,
    });
  }

  // Deep sleep against your own usual: rare by construction.
  const deep = compareToBaseline(series(days, (d) => d.sleep?.stages?.deep ?? null));
  if (night.stages && deep.z !== null && deep.z >= 1.5 && deep.n >= 8) {
    add({
      ...base, id: 'deep-high', kind: 'pattern', tone: 'good',
      importance: 60, topic: 'sleep-stage', family: 'sleep-stages', today: 'never', news: true,
      title: 'Lots of deep sleep last night',
      text: `You got ${Math.round(night.stages.deep)} minutes of deep sleep last night. You usually get about ${Math.round(deep.baseline!)}. Deep sleep is when your body does most of its physical recovery.`,
    });
  }

  debt(ctx, add, n.good ? night.minutesAsleep : null);
}

/**
 * The battery's own debt figure, netted over the week before last night. A week with under 5
 * recorded nights is an estimate, not a weekly total, so the card stays quiet rather than
 * extrapolating. A good last night becomes a clause here instead of a card of its own.
 */
function debt(ctx: InsightContext, add: Add, goodNightMin: number | null): void {
  const { debtMin } = ctx;
  if (debtMin === null || debtMin <= 180) return;
  const severe = debtMin > 360;
  const nights = ctx.debt!.nightsKnown;
  add({
    ...base, id: 'sleep-debt', kind: 'alert', tone: 'watch',
    importance: 89, topic: 'sleep-debt', family: 'sleep-amount', today: 'while-true', news: true, advice: 'rest',
    title: severe ? "You're very short on sleep this week" : "You're short on sleep this week",
    text: `${goodNightMin !== null ? `Last night's ${hm(goodNightMin)} helped. Over the ${nights} nights before it` : `Over the ${nights} nights before last night`}, you slept ${hoursText(debtMin)} less than you need.${severe ? ' Short nights like these add up and wear on your focus and recovery.' : ''}`,
    action: severe
      ? 'Debt like this clears over several nights. Try adding 30 to 45 minutes of sleep over the next few nights.'
      : 'A few earlier nights would help you catch up.',
  });
}

/** "within about 25 minutes of 23:10", or "at about 23:10 every night" when the spread rounds to nothing. */
const within = (sdMin: number, mean: number, every: 'night' | 'morning') =>
  Math.round(sdMin) < 5 ? `at about ${clk(mean)} every ${every}` : `within about ${Math.round(sdMin)} minutes of ${clk(mean)}`;

/** Bedtime shifts and spread, and wake-time steadiness: all on the 24-hour circle. Returns whether a later bedtime is news. */
function timing(ctx: InsightContext, add: Add): boolean {
  const { days } = ctx;
  const shiftDelta = (w: DailyRecord[]): number | null => {
    const recent = circularMeanMinutes(sleepMins(w.slice(-7), (x) => x.bedtimeMin));
    const prior = circularMeanMinutes(sleepMins(w.slice(-21, -7), (x) => x.bedtimeMin));
    if (!recent || !prior || recent.n < 4 || prior.n < 5) return null;
    return circDelta(recent.mean, prior.mean);
  };

  let laterNews = false;
  const now = shiftDelta(days);
  if (now !== null && Math.abs(now) >= 30) {
    const then = shiftDelta(cut(days, ENTRY_WINDOW + 1));
    const news = then === null || Math.abs(then) < 15 || Math.sign(then) !== Math.sign(now);
    const later = now > 0;
    laterNews = later && news;
    const recent = circularMeanMinutes(sleepMins(days.slice(-7), (x) => x.bedtimeMin))!;
    const prior = circularMeanMinutes(sleepMins(days.slice(-21, -7), (x) => x.bedtimeMin))!;
    const held = heldFor(days, (w) => {
      const d = shiftDelta(w);
      return d !== null && Math.abs(d) >= 30 && Math.sign(d) === Math.sign(now);
    });
    add({
      ...base, id: later ? 'bed-creep-later' : 'bed-creep-earlier', kind: 'trend', tone: later ? 'watch' : 'good',
      direction: later ? 'up' : 'down',
      importance: later ? 68 : 58, topic: 'bedtime-shift', family: 'sleep-timing', today: later ? 'as-news' : 'never', news,
      claims: { metric: 'bedtime', direction: later ? 'up' : 'down' }, evidence: recent.n + prior.n,
      title: later ? "You're going to bed later" : "You're going to bed earlier",
      text: `This week your average bedtime was ${clk(recent.mean)}. In the two weeks before, it was ${clk(prior.mean)}.${news ? '' : sinceNote(held)}`,
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
        title: 'Your bedtime has been all over the place',
        text: `Over the last two weeks your bedtime has moved by about ${Math.round(s14.sdMin)} minutes either side of ${clk(s14.mean)}. A steady bedtime often matters more than the total hours.`,
      });
    } else if (s14.sdMin < 30) {
      const was = spread(cut(days, ENTRY_WINDOW + 1));
      const news = !(was !== null && was.n >= 7 && was.sdMin <= 40);
      add({
        ...base, id: 'bed-settling', kind: 'trend', tone: 'good',
        importance: 50, topic: 'bedtime-spread', family: 'sleep-timing', today: 'never', news,
        claims: { metric: 'bedtime', direction: 'steady' }, evidence: s14.n,
        title: news ? 'Your bedtime is settling down' : 'Your bedtime has been steady',
        text: `For two weeks you've gone to bed ${within(s14.sdMin, s14.mean, 'night')}.`,
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
      title: "You're waking at a steady time",
      text: `For two weeks you've woken up ${within(w14.sdMin, w14.mean, 'morning')}.`,
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
        title: 'Your sleep schedule is more regular',
        text: `Your sleep regularity score rose from ${before.score} to ${now.score} this month. Keeping regular hours is linked to better long-term health.`,
      });
    }
  }
  return laterNews;
}

/**
 * The evening nudge, anchored to your own bedtime, only when it earns its place.
 * Once your best bedtime is known, it leads with that.
 */
function windDown(ctx: InsightContext, add: Add, laterShiftNews: boolean, best: BestBedtime | null): void {
  const { debtMin } = ctx;
  const owed = debtMin !== null && debtMin > 120;
  if (ctx.part !== 'evening' || !(owed || laterShiftNews)) return;
  const avg = circularMeanMinutes(sleepMins(ctx.days.slice(-14), (x) => x.bedtimeMin));
  if (!avg || avg.n < 5) return;
  const target = best?.earlierBetter ? best.cut : null;
  const week = circularMeanMinutes(sleepMins(ctx.days.slice(-7), (x) => x.bedtimeMin));
  const pastTarget = target !== null && week !== null && circDelta(week.mean, target) > 0;
  add({
    ...base, id: 'wind-down', kind: 'nudge', tone: 'neutral',
    importance: 52, topic: 'sleep-tonight', family: 'sleep-tonight', today: 'while-true', news: true, daypart: ['evening'], advice: 'rest',
    title: 'Time to start winding down',
    text: target !== null
      ? `You tend to sleep best when you're asleep by ${clk(target)}.${owed
        ? ` You're also ${hoursText(debtMin!)} short on sleep this week, so an early night would help.`
        : pastTarget ? ` This week you've been going to bed around ${clk(week!.mean)}.` : ' Lately your bedtime has been getting later.'}`
      : `You've been going to bed around ${clk(avg.mean)} lately${laterShiftNews ? ", and it's been getting later" : ''}.${owed ? ` You're also ${hoursText(debtMin!)} short on sleep this week.` : ''}`,
    action: target !== null
      ? `Being asleep by ${clk(target)} tonight would help.`
      : 'Getting to bed around your usual time tonight will help. A steady bedtime matters as much as the extra sleep.',
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
    title: 'You sleep less on weekdays',
    text: `On free days you usually sleep about ${hm(free.median)}, but on workdays only ${hm(work.median)}. Catching up at the weekend helps, but it doesn't fully make up for the week.`,
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
  const was = peak.daysAgo >= 5
    ? `Last week you were ${hoursText(peak.min)} short on sleep.`
    : `${peak.daysAgo === 1 ? 'Yesterday' : 'A few days ago'} you were ${hoursText(peak.min)} short on sleep over the past week.`;
  add({
    ...base, id: 'sleep-debt-cleared', kind: 'milestone', tone: 'good',
    importance: 66, topic: 'sleep-debt', family: 'sleep-amount', today: 'as-news', news: before !== null && before >= 60,
    title: "You're no longer short on sleep",
    text: `${was} Over the ${ctx.debt!.nightsKnown} nights before last night, your sleep ${debtMin <= 0 ? 'added up to what you need' : 'came within an hour of what you need'}.`,
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
    title: 'A run of good nights',
    text: `You've slept at least the ${needH} you need for ${run} nights in a row.`,
  });
}

/** What every sleep card measures against, and where that figure comes from. */
function sleepNeed(ctx: InsightContext, add: Add): void {
  const nights = sleepMins(ctx.days, (x) => x.minutesAsleep);
  if (nights.length < 14) return;
  const median = stats(nights)!.median;
  const text = median < 420
    ? `Your sleep cards measure each night against 7 hours. Your nights are usually shorter, about ${hm(median)}, but most adults need at least 7 hours.`
    : median > 510
      ? `Your sleep cards measure each night against ${ctx.needH}. You usually sleep longer, about ${hm(median)}, but the cards don't aim higher than ${ctx.needH}.`
      : `Your sleep cards measure each night against about ${ctx.needH}. That's the middle of your last ${nights.length} recorded nights.`;
  add({
    ...base, id: 'sleep-need', kind: 'pattern', tone: 'neutral',
    importance: 36, topic: 'sleep-need', family: 'sleep-need', today: 'never', news: false,
    title: 'How much sleep you need',
    text,
  });
}

/** Sleep score by bedtime, split at your usual bedtime. Returns the pattern for the wind-down nudge. */
function bestBedtimeCard(ctx: InsightContext, add: Add): BestBedtime | null {
  const best = bestBedtime(ctx.days);
  if (!best) return null;
  const [first, second] = best.earlierBetter ? [best.early, best.late] : [best.late, best.early];
  add({
    ...base, id: 'sleep-best-bedtime', kind: 'pattern', tone: 'neutral',
    importance: 48, topic: 'best-bedtime', family: 'sleep-timing', today: 'never', news: false,
    title: best.earlierBetter ? `You sleep best before ${clk(best.cut)}` : 'Your later nights score better',
    text: `On nights you went to sleep ${best.earlierBetter ? 'by' : 'after'} ${clk(best.cut)}, your sleep score averaged ${Math.round(first.mean)}. On ${best.earlierBetter ? 'later' : 'earlier'} nights it averaged ${Math.round(second.mean)}. That's based on ${first.n} ${best.earlierBetter ? 'earlier' : 'later'} nights and ${second.n} ${best.earlierBetter ? 'later' : 'earlier'} ones, so it's a pattern rather than a rule.`,
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
    title: 'Your natural sleep rhythm',
    text: `When you don't have to be up early, you usually sleep from about ${clk5(free.bed)} to ${clk5(free.wake)}. ${catchUp
      ? `Some of that is catching up on the week, so the middle of your natural night is around ${clk5(wf.midCorrected)}.`
      : `The middle of your sleep falls around ${clk5(free.mid)}.`}`,
  });

  const shift = circDelta(free.mid, work.mid);
  if (Math.abs(shift) < 60) return;
  add({
    ...base, id: 'sleep-weekend-shift', kind: 'pattern', tone: 'neutral',
    importance: 47, topic: 'weekend-shift', family: 'sleep-timing', today: 'never', news: false,
    title: 'Your weekend sleep shift',
    text: `At weekends you sleep about ${hm(Math.abs(shift))} ${shift > 0 ? 'later' : 'earlier'} than on weekdays. For your body, that's a bit like flying across a time zone and back every week.`,
  });
}

/** Your shortest and longest nights of the week, named by the evening they start. */
function weekShape(ctx: InsightContext, add: Add): void {
  const nights = ctx.days
    .filter((d) => d.sleep)
    .map((d) => ({ date: addDays(d.date, -1), value: d.sleep!.minutesAsleep }));
  const ext = weekdayExtremes(nights, 5);
  if (!ext || ext.high.median! - ext.low.median! < 45) return;
  add({
    ...base, id: 'sleep-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 42, topic: 'week-sleep', family: 'sleep-week', today: 'never', news: false,
    title: 'Your shortest and longest nights',
    text: `${WEEKDAYS[ext.low.weekday]} night is usually your shortest, at about ${hm(ext.low.median!)}. ${WEEKDAYS[ext.high.weekday]} night is usually your longest, at about ${hm(ext.high.median!)}.`,
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
      title: 'More time awake at night',
      text: `You spent about ${Math.round(a.now)} minutes awake each night this week, compared with your usual ${Math.round(a.typical)}. Late meals, alcohol, heat and stress can all cause more wake-ups.`,
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
      title: 'More of your time in bed is spent awake',
      text: `In the last 30 days you were asleep for ${Math.round(month.pct)}% of your time in bed. In the 30 days before, it was ${Math.round(before.pct)}%.`,
    });
    return;
  }
  const good = month.pct >= 85;
  add({
    ...base, id: 'sleep-efficiency', kind: 'pattern', tone: good ? 'good' : 'neutral',
    importance: 35, topic: 'efficiency', family: 'sleep-quality', today: 'never', news: false,
    title: good ? 'You use your time in bed well' : 'Time in bed and time asleep',
    text: `In the last 30 days you were asleep for ${Math.round(month.pct)}% of your time in bed, about ${hm(month.asleep)} out of ${hm(month.inBed)} a night.`,
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
    const mad = stats(usual.map((v) => Math.abs(v - st.median)))!.median;
    const floor = st.median - Math.max(10, 1.4826 * mad);
    return { n: recent.filter((v) => v < floor).length, of: recent.length, now: stats(recent)!.median, typical: st.median };
  };
  const r = low(days);
  if (!r || r.n < 5) return;
  const was = low(cut(days, ENTRY_WINDOW + 1));
  add({
    ...base, id: 'sleep-rem-short', kind: 'trend', tone: 'watch', direction: 'down',
    importance: 55, topic: 'rem', family: 'sleep-rem', today: 'never', news: !was || was.n < 5,
    claims: { metric: 'rem', direction: 'down' }, evidence: r.of,
    title: 'Less REM sleep than usual',
    text: `On ${r.n === r.of ? 'each' : r.n} of the last ${r.of} nights you got less REM sleep than usual, about ${Math.round(r.now)} minutes instead of ${Math.round(r.typical)}. Most REM comes late in the night, so short nights cut it first.`,
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
    title: 'A few naps this week',
    text: `You took ${week.length} naps in the last week, about ${Math.round(mean(week.map((x) => x.nap.minutesAsleep)))} minutes each.${afterShort ? ` Each one came after a night shorter than your ${ctx.needH} need.` : ''}`,
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
    title: higher ? 'Good sleep shows in your HRV' : 'Your HRV and how long you sleep',
    text: `On nights of 7 hours or more, your overnight HRV is usually about ${Math.abs(a.pct)}% ${higher ? 'higher' : 'lower'} than on shorter nights. That's based on ${plural(a.nLong, 'longer night')} and ${plural(a.nShort, 'shorter one')}. It's a pattern in your data, not proof that one causes the other.`,
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
      title: isNew ? 'Still getting to know your sleep' : 'Some nights have no record',
      text: isNew
        ? `Your sleep records start on ${dayMonth(start)}, so there ${recorded === 1 ? 'is 1 night' : `are ${recorded} nights`} so far. Comparisons will get sharper as more nights come in.`
        : `Your watch recorded sleep on ${recorded} of the last ${days.length} nights. Nights without a record are left out of your averages rather than counted as zero.`,
    });
  }
  const gaps = findGaps(days, 'sleep', 3);
  if (gaps.length) {
    const g = gaps[gaps.length - 1];
    if (daysBetween(g.to, today) <= 7) {
      add({
        ...card, id: 'sleep-gap', importance: 28,
        title: 'A few nights are missing',
        text: `There's no sleep data from ${dayMonth(g.from)} to ${dayMonth(g.to)}. Those nights are left out of your averages rather than counted as zero.`,
      });
    }
  }
}
