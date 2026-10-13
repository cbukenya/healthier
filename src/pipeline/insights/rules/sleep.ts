import type { DailyRecord } from '../../../types/health';
import {
  circularMeanMinutes, compareToBaseline, findGaps, firstObserved, series, sleepRegularity, stats, values,
} from '../../derive';
import { scoreSleep } from '../../sleep';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, circDelta, clk, cut, dayMonth, heldFor, hm, hoursText, isWorkday, sinceNote, sleepMins, trailingDays,
} from '../helpers';
import type { Finding } from '../types';
import { daysBetween } from '../../../lib/date';

type Add = (f: Finding) => void;

const base = { domain: 'sleep' as const, page: 'sleep' as const };

/** Last night, the week's debt, timing and regularity, and the gaps in the record. */
export function sleepRules(ctx: InsightContext, add: Add): void {
  lastNight(ctx, add);
  const laterShiftNews = timing(ctx, add);
  windDown(ctx, add, laterShiftNews);
  weekdays(ctx, add);
  coverage(ctx, add);
}

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

/** The evening nudge, anchored to your own bedtime, only when it earns its place. */
function windDown(ctx: InsightContext, add: Add, laterShiftNews: boolean): void {
  const { debtMin } = ctx;
  const owed = debtMin !== null && debtMin > 120;
  if (ctx.part !== 'evening' || !(owed || laterShiftNews)) return;
  const avg = circularMeanMinutes(sleepMins(ctx.days.slice(-14), (x) => x.bedtimeMin));
  if (!avg || avg.n < 5) return;
  add({
    ...base, id: 'wind-down', kind: 'nudge', tone: 'neutral',
    importance: 52, topic: 'sleep-tonight', family: 'sleep-tonight', today: 'while-true', news: true, daypart: ['evening'], advice: 'rest',
    title: 'Time to start winding down',
    text: `You've been going to bed around ${clk(avg.mean)} lately${laterShiftNews ? ", and it's been getting later" : ''}.${owed ? ` You're also ${hoursText(debtMin!)} short on sleep this week.` : ''}`,
    action: 'Getting to bed around your usual time tonight will help. A steady bedtime matters as much as the extra sleep.',
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
    importance: 46, topic: 'weekday-sleep', family: 'sleep-week', today: 'never', news: ctx.dom <= 2,
    title: 'You sleep less on weekdays',
    text: `On free days you usually sleep about ${hm(free.median)}, but on workdays only ${hm(work.median)}. Catching up at the weekend helps, but it doesn't fully make up for the week.`,
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
