import { addDays, daysBetween, isoWeekdayIndex } from '../../../lib/date';
import type { DailyRecord } from '../../../types/health';
import { completedDays, goalStreak, periodShift, series, stats, values, type Point } from '../../derive';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, STEP_GOAL, briskMins, clk, dayMonth, fmtInt, heldFor, listOf, monthName, plural, sinceHistory, sinceNote,
  zoneMins,
} from '../helpers';
import { movementHrvAssociation } from '../association';
import { WEEKDAYS, activeHours, lastMonthBest, weekdayExtremes } from '../patterns';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'movement' as const, page: 'activity' as const };

/** Steps, active minutes, when and how you move, and the moments in the day worth a nudge. */
export function activityRules(ctx: InsightContext, add: Add): void {
  volume(ctx, add);
  quietDays(ctx, add);
  milestones(ctx, add);
  activeStreak(ctx, add);
  backOnTrack(ctx, add);
  distance(ctx, add);
  floorsRecord(ctx, add);
  intensity(ctx, add);
  intensityMix(ctx, add);
  weekendLoad(ctx, add);
  goalDays(ctx, add);
  weekShape(ctx, add);
  peakHours(ctx, add);
  bestMonth(ctx, add);
  nudges(ctx, add);
  association(ctx, add);
}

/** A round figure to say "about" in front of. */
const about = (v: number, to = 100) => fmtInt(Math.round(v / to) * to);

/** This week's step volume against the weeks before it. */
function volume(ctx: InsightContext, add: Add): void {
  const { load, doneSteps, days } = ctx;
  if (load.ratio !== null && load.ratio > 1.5) {
    add({
      ...base, id: 'ramp', kind: 'alert', tone: 'watch', direction: 'up',
      importance: 84, topic: 'movement-volume', family: 'movement-volume', today: 'while-true', news: true,
      claims: { metric: 'steps', direction: 'up' }, evidence: 28,
      title: "You're moving a lot more than usual",
      text: `This week you've taken ${load.ratio.toFixed(1)} times as many steps as in an average week over the three before. Big jumps are easy to make without noticing, so let how you feel be your guide.`,
    });
  }

  const shiftP = (w: Point[], dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.deltaPct !== null && sh.nCurrent >= 5 && sh.nPrevious >= 5 && sh.deltaPct * dir >= 20 && Math.abs(sh.delta!) >= 1500;
  };
  for (const dir of [1, -1] as const) {
    if (!shiftP(doneSteps, dir)) continue;
    const sh = periodShift(doneSteps, 7);
    const news = !shiftP(doneSteps.slice(0, -(ENTRY_WINDOW + 1)), dir);
    const held = heldFor(days, (w) => shiftP(series(w, (d) => d.steps).slice(0, -1), dir));
    add({
      ...base, id: dir === 1 ? 'steps-up' : 'steps-down', kind: 'trend', tone: dir === 1 ? 'good' : 'neutral',
      direction: dir === 1 ? 'up' : 'down',
      importance: dir === 1 ? 62 : 40, topic: 'movement-volume', family: 'movement-volume',
      today: dir === 1 ? 'as-news' : 'never', news,
      claims: { metric: 'steps', direction: dir === 1 ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      title: dir === 1 ? "You've been moving more this week" : 'A quieter week',
      text: dir === 1
        ? `You're averaging ${fmtInt(sh.current!)} steps a day this week, up from ${fmtInt(sh.previous!)} last week. That's ${Math.round(sh.deltaPct!)}% more.${news ? '' : sinceNote(held)}`
        : `You've averaged ${fmtInt(sh.current!)} steps a day this week, compared with ${fmtInt(sh.previous!)} last week. Maybe it was a rest week, or just a busy one at the desk.`,
    });
    break;
  }
}

/** Streaks, records and the weekly target. Broken streaks get silence, always. */
function milestones(ctx: InsightContext, add: Add): void {
  const { stepsSeries, doneSteps, today, days } = ctx;

  const STREAK_SET = new Set([3, 5, 7, 10, 14, 21, 30]);
  const streak = goalStreak(stepsSeries, (v) => v >= STEP_GOAL);
  if (streak >= 3) {
    add({
      ...base, id: 'streak', kind: 'milestone', tone: 'good',
      importance: 63, topic: 'step-streak', family: 'movement-milestone',
      // Short streaks stay on the page; from a week they're worth Today on the day they land.
      today: streak >= 7 ? 'as-news' : 'never',
      news: STREAK_SET.has(streak) && goalStreak(doneSteps, (v) => v >= STEP_GOAL) !== streak,
      title: "You're on a streak",
      text: `You've walked more than ${fmtInt(STEP_GOAL)} steps every day for ${streak} days in a row.`,
    });
  }

  // Record day: the window's biggest finished day, with two weeks before it to beat and a floor so
  // tiny records stay quiet. News the mornings after it lands, then on the page for the rest of the week.
  const finished = doneSteps.filter((pt) => pt.value !== null);
  const at = finished.reduce((best, pt, i) => (pt.value! > finished[best].value! ? i : best), 0);
  const record = finished[at];
  if (record && at >= 14 && record.value! >= 8000) {
    const age = daysBetween(record.date, today);
    const before = ctx.digest?.stepDay ?? null;
    // All time once it also beats every stored day before the window.
    const allTime = before !== null && record.value! > before.steps;
    const priorMax = Math.max(...finished.slice(0, at).map((pt) => pt.value!), allTime ? before!.steps : 0);
    if (age <= 7) {
      add({
        ...base, id: 'step-record', kind: 'milestone', tone: 'good',
        importance: 77, topic: 'step-record', family: 'movement-milestone', today: 'as-news', news: age <= ENTRY_WINDOW + 1,
        title: allTime ? 'Your biggest day yet' : 'Your biggest day in two months',
        text: `You walked ${fmtInt(record.value!)} steps on ${dayMonth(record.date)}. That's your biggest day ${allTime ? sinceHistory(ctx.months.find((m) => m.steps.n > 0)!.month, today) : 'in the last two months'}. Your previous best was ${fmtInt(priorMax)}.`,
      });
    }
  }

  // The WHO's weekly bar, on the day it's crossed: 150 minutes, harder minutes counting double.
  const weekStart = days.findIndex((d) => daysBetween(d.date, today) <= isoWeekdayIndex(today));
  if (weekStart >= 0) {
    const hasAzm = days.slice(weekStart).some((d) => d.zoneMinutes !== null);
    const minutes = (upto: number) => days.slice(weekStart, upto).reduce((a, d) => a + (hasAzm ? zoneMins(d) : briskMins(d)), 0);
    const total = minutes(days.length);
    if (total >= 150) {
      const spare = 6 - isoWeekdayIndex(today);
      add({
        ...base, id: 'who-week', kind: 'milestone', tone: 'good',
        importance: 58, topic: 'weekly-target', family: 'movement-milestone', today: 'as-news',
        news: minutes(days.length - 1) < 150,
        title: 'You hit the weekly activity target',
        text: `${hasAzm
          ? `You've earned ${Math.round(total)} active zone minutes this week.`
          : `You've done ${Math.round(total)} minutes of brisk activity this week, with harder minutes counting double.`} That passes the WHO's recommended 150${spare > 0 ? `, with ${plural(spare, 'day')} to spare` : ''}.`,
      });
    }
  }
}

/** Moderate-plus-vigorous minutes: the band the guidelines actually count. */
function intensity(ctx: InsightContext, add: Add): void {
  const mvpa = series(completedDays(ctx.days), (d) => (d.activeMinutes ? d.activeMinutes.moderate + d.activeMinutes.vigorous : null));
  const shiftP = (w: Point[], dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.delta !== null && sh.nCurrent >= 4 && sh.nPrevious >= 4 && sh.deltaPct! * dir >= 25 && sh.delta * dir >= 8;
  };
  for (const dir of [1, -1] as const) {
    if (!shiftP(mvpa, dir)) continue;
    const sh = periodShift(mvpa, 7);
    add({
      ...base, id: dir === 1 ? 'mvpa-up' : 'mvpa-down', kind: 'trend', tone: dir === 1 ? 'good' : 'neutral',
      direction: dir === 1 ? 'up' : 'down',
      importance: dir === 1 ? 59 : 38, topic: 'movement-intensity', family: 'movement-volume', today: 'never',
      news: !shiftP(mvpa.slice(0, -(ENTRY_WINDOW + 1)), dir),
      claims: { metric: 'brisk', direction: dir === 1 ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      title: dir === 1 ? 'More brisk activity this week' : 'Less brisk activity this week',
      text: `You're averaging ${Math.round(sh.current!)} minutes of brisk activity a day this week, ${dir === 1 ? 'up' : 'down'} from ${Math.round(sh.previous!)} last week.${dir === 1 ? " That's the kind of activity the guidelines count." : ''}`,
    });
    break;
  }
}

/** Just-in-time cards for today's steps. They mean nothing outside their moment, so they live on Today only. */
function nudges(ctx: InsightContext, add: Add): void {
  const { todayRow, stepMedian, doneSteps, part, minutesNow } = ctx;
  const steps = todayRow.steps;
  if (steps === null || stepMedian === null) return;
  const hour = minutesNow / 60;
  const yesterday = [...doneSteps].reverse().find((pt) => pt.value !== null);
  const yesterdayLow = yesterday !== undefined && yesterday.value! < stepMedian * 0.5;
  const nudge = { ...base, kind: 'nudge' as const, topic: 'movement-today', family: 'movement-today', today: 'while-true' as const, news: true };

  if (part === 'midday' && hour >= 13 && steps < stepMedian * 0.3 && !yesterdayLow) {
    add({
      ...nudge, id: 'slow-day', tone: 'neutral', importance: 54, daypart: ['midday'],
      title: 'A slow start today',
      text: `It's ${clk(minutesNow)} and you've taken ${fmtInt(steps)} steps so far. On a normal day you reach about ${fmtInt(stepMedian)}.`,
      action: 'A 10-minute walk after lunch would get things moving. Short breaks from sitting make a real difference.',
    });
  }
  if (part === 'midday' && hour < 13 && steps > stepMedian * 0.8) {
    add({
      ...nudge, id: 'ahead-of-yourself', tone: 'good', importance: 56, daypart: ['midday'],
      title: "You're ahead of your usual pace",
      text: `You've already taken ${fmtInt(steps)} steps before lunch. That's most of a normal day for you.`,
    });
  }
  if (part === 'evening') {
    const gap = STEP_GOAL - steps;
    if (gap >= 800 && gap <= 2500) {
      add({
        ...nudge, id: 'within-reach', tone: 'good', importance: 61, daypart: ['evening'],
        title: 'Your step goal is within reach',
        text: `You're ${fmtInt(gap)} steps short of ${fmtInt(STEP_GOAL)}.`,
        action: 'A 15-minute walk would close the gap.',
      });
    }
  }
}

/**
 * Big step days and the next night's HRV: an exploratory association, worded
 * as a pattern and never a price. These are sequential days from one person,
 * with sleep, alcohol and weekday uncontrolled.
 */
function association(ctx: InsightContext, add: Add): void {
  const a = movementHrvAssociation(ctx.days);
  if (!a) return;
  add({
    ...base, id: 'movement-hrv-association', kind: 'pattern', tone: 'neutral',
    importance: 51, topic: 'correlation', family: 'correlation', today: 'never', news: false,
    title: 'Big days and your recovery',
    text: `Over the last ${a.weeks} weeks, your HRV was usually about ${a.pct}% lower on the night after a day of more than ${fmtInt(a.threshold)} steps. That's based on ${a.nHigh} big days and ${a.nLow} ordinary ones.${a.excludedIllnessNights > 0 ? ' Nights around signs of illness were left out.' : ''} It's a pattern in your data, not proof that one causes the other.`,
  });
}

/** Several days this week far under your usual day: said plainly, with no judgement. */
function quietDays(ctx: InsightContext, add: Add): void {
  const { stepMedian } = ctx;
  if (stepMedian === null) return;
  // A round line under half your usual day, so the card's figure is exactly the rule's.
  const line = Math.floor(stepMedian / 2 / 100) * 100;
  const count = (done: Point[]) => {
    const week = done.slice(-7).filter((pt) => pt.value !== null);
    return week.length >= 5 ? week.filter((pt) => pt.value! < line).length : 0;
  };
  const n = count(ctx.doneSteps);
  if (n < 3) return;
  add({
    ...base, id: 'activity-quiet-days', kind: 'trend', tone: 'neutral', direction: 'down',
    importance: 41, topic: 'movement-volume', family: 'movement-volume', today: 'never',
    news: count(ctx.doneSteps.slice(0, -(ENTRY_WINDOW + 1))) < 3,
    claims: { metric: 'steps', direction: 'down' }, evidence: 7,
    title: 'A few very quiet days',
    text: `You had ${n} days in the last week with fewer than ${fmtInt(line)} steps. That's under half of your usual day, which is about ${about(stepMedian)} steps.`,
  });
}

/** Active minutes every day, a day's share of the WHO's weekly 150. Short runs stay on the page. */
function activeStreak(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const azm = days.slice(-14).some((d) => d.zoneMinutes !== null);
  const daily = series(days, (d) => (azm ? (d.zoneMinutes ? zoneMins(d) : null) : d.activeMinutes ? briskMins(d) : null));
  const DAILY = 22; // 150 / 7, rounded up
  const meets = (v: number) => v >= DAILY;
  const n = goalStreak(daily, meets);
  if (n < 3) return;
  add({
    ...base, id: 'activity-azm-streak', kind: 'milestone', tone: 'good',
    importance: 60, topic: 'active-streak', family: 'movement-milestone',
    today: n >= 7 ? 'as-news' : 'never',
    news: [3, 5, 7, 14, 30].includes(n) && goalStreak(daily.slice(0, -1), meets) !== n,
    title: 'Active days in a row',
    text: azm
      ? `You've earned at least ${DAILY} active zone minutes every day for ${n} days. That's a day's share of the WHO's recommended 150 a week.`
      : `You've done at least ${DAILY} minutes of brisk activity every day for ${n} days, with harder minutes counting double. That's a day's share of the WHO's recommended 150 a week.`,
  });
}

/** The first goal day after a week or more without one. No homework attached. */
function backOnTrack(ctx: InsightContext, add: Add): void {
  const { stepsSeries, today } = ctx;
  const goalDays = stepsSeries.filter((pt) => pt.value !== null && pt.value >= STEP_GOAL);
  const latest = goalDays[goalDays.length - 1];
  const before = goalDays[goalDays.length - 2];
  if (!latest || !before) return;
  const age = daysBetween(latest.date, today);
  const gap = daysBetween(before.date, latest.date);
  // A stretch without the watch isn't a break: most of the days between must be recorded.
  const recorded = stepsSeries.filter((pt) => pt.date > before.date && pt.date < latest.date && pt.value !== null).length;
  if (age > 3 || gap < 8 || recorded < (gap - 1) * 0.7) return;
  add({
    ...base, id: 'activity-back-at-it', kind: 'milestone', tone: 'good',
    importance: 57, topic: 'back-on-track', family: 'movement-milestone', today: 'as-news', news: age <= 1,
    title: 'Back on track',
    text: `You passed ${fmtInt(STEP_GOAL)} steps ${age === 0 ? 'today' : `on ${dayMonth(latest.date)}`} for the first time in ${gap} days.`,
  });
}

/** A marathon's distance in a week, and 100, 200 or 300 km in a month: news the day they're passed. */
function distance(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const MARATHON_KM = 42.195;
  const sum = (rows: DailyRecord[]) => rows.reduce((a, d) => a + (d.distanceKm ?? 0), 0);

  const week = days.filter((d) => d.date >= addDays(today, -isoWeekdayIndex(today)));
  const weekKm = sum(week);
  if (weekKm >= MARATHON_KM) {
    add({
      ...base, id: 'activity-distance', kind: 'milestone', tone: 'good',
      importance: 55, topic: 'distance-week', family: 'movement-milestone', today: 'as-news',
      news: sum(week.slice(0, -1)) < MARATHON_KM,
      title: "A marathon's distance this week",
      text: `You've covered ${weekKm.toFixed(1)} km this week. That's more than the length of a marathon.`,
    });
  }

  const month = days.filter((d) => d.date.slice(0, 7) === today.slice(0, 7));
  const monthKm = sum(month);
  const mark = [300, 200, 100].find((m) => monthKm >= m);
  if (mark) {
    add({
      ...base, id: 'activity-distance-month', kind: 'milestone', tone: 'good',
      importance: 56, topic: 'distance-month', family: 'movement-milestone', today: 'as-news',
      news: sum(month.slice(0, -1)) < mark,
      title: `You've passed ${mark} km this month`,
      text: `You've covered ${Math.floor(monthKm)} km so far this month.`,
    });
  }
}

/** Your most floors in any week of the window, finished days only. */
function floorsRecord(ctx: InsightContext, add: Add): void {
  const s = series(completedDays(ctx.days), (d) => d.floors);
  if (values(s).length < 42) return;
  const weeks: { end: number; sum: number }[] = [];
  for (let end = 7; end <= s.length; end++) {
    const v = values(s.slice(end - 7, end));
    if (v.length >= 5) weeks.push({ end, sum: v.reduce((a, b) => a + b, 0) });
  }
  const last = weeks[weeks.length - 1];
  if (!last || last.end !== s.length || last.sum < 10 || weeks.length < 6) return;
  const beats = (i: number) => weeks[i].sum > Math.max(...weeks.slice(0, i).map((w) => w.sum));
  if (!beats(weeks.length - 1)) return;
  add({
    ...base, id: 'activity-floors', kind: 'milestone', tone: 'good',
    importance: 50, topic: 'floors', family: 'movement-milestone', today: 'never',
    news: !beats(weeks.length - 2),
    title: "You've been climbing more",
    text: `You climbed ${Math.round(last.sum)} floors in the last 7 days, the most in any week of the last two months.`,
  });
}

/** How your active minutes split between moderate and hard effort over four weeks. */
function intensityMix(ctx: InsightContext, add: Add): void {
  const recent = completedDays(ctx.days).slice(-28).filter((d) => d.zoneMinutes);
  if (recent.length < 14) return;
  const moderate = recent.reduce((a, d) => a + d.zoneMinutes!.fatBurn, 0);
  const hard = recent.reduce((a, d) => a + d.zoneMinutes!.cardio + d.zoneMinutes!.peak, 0);
  const total = moderate + hard;
  if (total < 60) return;
  const hardDays = recent.filter((d) => d.zoneMinutes!.cardio + d.zoneMinutes!.peak >= 5).length;
  const share = moderate / total;
  const lead = share >= 0.6
    ? 'Most of your active minutes in the last four weeks were at a moderate effort, in the fat-burn zone.'
    : share <= 0.4
      ? 'Most of your active minutes in the last four weeks were at a hard effort, in the cardio and peak zones.'
      : 'Your active minutes in the last four weeks were split fairly evenly between moderate and hard effort.';
  add({
    ...base, id: 'activity-intensity-mix', kind: 'pattern', tone: 'neutral',
    importance: 43, topic: 'intensity-mix', family: 'activity-patterns', today: 'never', news: false,
    title: "How hard you're working",
    text: `${lead} You spent at least 5 minutes in the cardio or peak zone on ${plural(hardDays, 'day')}.`,
  });
}

/** Last week's active minutes bunched into two days. Neutral: the weekly total counts the same. */
function weekendLoad(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const monday = addDays(today, -isoWeekdayIndex(today));
  const week = days.filter((d) => d.date >= addDays(monday, -7) && d.date < monday);
  const azm = week.some((d) => d.zoneMinutes);
  const recorded = week.filter((d) => (azm ? d.zoneMinutes : d.activeMinutes));
  if (week.length < 7 || recorded.length < 6) return;
  const mins = week.map((d) => ({ date: d.date, m: azm ? zoneMins(d) : briskMins(d) }));
  const total = mins.reduce((a, x) => a + x.m, 0);
  if (total < 60) return;
  const top = [...mins].sort((a, b) => b.m - a.m).slice(0, 2).sort((a, b) => (a.date < b.date ? -1 : 1));
  const share = (top[0].m + top[1].m) / total;
  if (share < 0.6) return;
  const names = top.map((x) => WEEKDAYS[isoWeekdayIndex(x.date)]);
  const weekend = top.every((x) => isoWeekdayIndex(x.date) >= 5);
  add({
    ...base, id: 'activity-weekend-load', kind: 'pattern', tone: 'neutral',
    importance: 42, topic: 'weekend-load', family: 'activity-patterns', today: 'never', news: isoWeekdayIndex(today) === 0,
    title: weekend ? 'Your weekends do most of the work' : 'Two days did most of the work',
    text: `Last week, ${Math.round(share * 100)}% of your ${azm ? 'active zone minutes' : 'brisk minutes'} came on ${listOf(names)}. Your weekly total counts the same however you spread it.`,
  });
}

/**
 * Goal days over four weeks: a trend when it moved by a day a week or more
 * against the four weeks before, otherwise a standing note when your usual day
 * sits far above or below the goal.
 */
function goalDays(ctx: InsightContext, add: Add): void {
  const tally = (s: Point[]) => {
    const v = values(s);
    return { n: v.length, hits: v.filter((x) => x >= STEP_GOAL).length };
  };
  const phrase = (t: { n: number; hits: number }, span: string) => {
    const days = t.n === 28 ? `the ${span} 28 days` : `${t.n} recorded days in the ${span} four weeks`;
    return t.hits === t.n ? `every one of ${days}` : `${t.hits} of ${days}`;
  };
  const shift = (done: Point[]) => {
    const a = tally(done.slice(-28));
    const b = tally(done.slice(-56, -28));
    if (a.n < 21 || b.n < 21) return null;
    return { a, b, perWeek: (a.hits / a.n - b.hits / b.n) * 7 };
  };
  const now = shift(ctx.doneSteps);
  if (now && Math.abs(now.perWeek) >= 1) {
    const up = now.perWeek > 0;
    const then = shift(ctx.doneSteps.slice(0, -(ENTRY_WINDOW + 1)));
    add({
      ...base, id: 'activity-consistency', kind: 'trend', tone: up ? 'good' : 'neutral', direction: up ? 'up' : 'down',
      importance: up ? 54 : 39, topic: 'goal-days', family: 'movement-volume', today: 'never',
      news: !then || Math.abs(then.perWeek) < 1 || Math.sign(then.perWeek) !== Math.sign(now.perWeek),
      claims: { metric: 'goal-days', direction: up ? 'up' : 'down' }, evidence: now.a.n + now.b.n,
      title: up ? "You're hitting your goal more often" : "You're reaching your goal less often",
      text: `You reached ${fmtInt(STEP_GOAL)} steps on ${phrase(now.a, 'last')}. In the four weeks before, it was ${now.b.hits} of ${now.b.n} days.`,
    });
    return;
  }

  const recent = tally(ctx.doneSteps.slice(-28));
  const median = stats(values(ctx.doneSteps.slice(-28)))?.median ?? null;
  if (recent.n < 21 || median === null) return;
  const above = median >= STEP_GOAL * 1.3;
  if (!above && median > STEP_GOAL * 0.7) return;
  add({
    ...base, id: 'activity-goal-fit', kind: 'pattern', tone: 'neutral',
    importance: 37, topic: 'goal-days', family: 'activity-patterns', today: 'never', news: false,
    title: above ? 'You usually beat your goal' : 'Your goal is a stretch most days',
    text: `On a typical day you take about ${about(median)} steps${above ? `, well past the ${fmtInt(STEP_GOAL)} goal` : ''}. You reached ${fmtInt(STEP_GOAL)} on ${phrase(recent, 'last')}.`,
  });
}

/** Your most and least active weekdays, once six weeks give each one enough days. */
function weekShape(ctx: InsightContext, add: Add): void {
  const ext = weekdayExtremes(ctx.doneSteps, 6);
  if (!ext || ext.high.median! < ext.low.median! * 1.2) return;
  add({
    ...base, id: 'activity-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 44, topic: 'activity-week-shape', family: 'activity-patterns', today: 'never', news: false,
    title: 'Your most and least active days',
    text: `${WEEKDAYS[ext.high.weekday]} is usually your most active day, at about ${about(ext.high.median!)} steps. ${WEEKDAYS[ext.low.weekday]} is usually your quietest, at about ${about(ext.low.median!)}.`,
  });
}

/** When in the day you move, from minute heart rate, your resting heart rate and your age. */
function peakHours(ctx: InsightContext, add: Add): void {
  const { intraday, age, days } = ctx;
  const rest = stats(values(series(days.slice(-28), (d) => d.restingHr)))?.median ?? null;
  if (!intraday || age === null || rest === null) return;
  const h = activeHours(days, intraday, age, rest);
  if (!h || (!h.weekdays && !h.weekends)) return;
  const span = (w: { fromHour: number }) => `between ${clk(w.fromHour * 60)} and ${clk((w.fromHour + 2) * 60)}`;
  const { weekdays: wd, weekends: we } = h;
  const lead = wd && we
    ? wd.fromHour === we.fromHour
      ? `You're usually most active ${span(wd)}, on weekdays and at weekends.`
      : `On weekdays you're most active ${span(wd)}. At weekends it's ${span(we)}.`
    : wd ? `On weekdays you're most active ${span(wd)}.` : `At weekends you're most active ${span(we!)}.`;
  add({
    ...base, id: 'activity-peak-hours', kind: 'pattern', tone: 'neutral',
    importance: 45, topic: 'peak-hours', family: 'activity-patterns', today: 'never', news: false,
    title: "When you're most active",
    text: `${lead} That's when your heart rate most often reaches a brisk-walking level, ${h.threshold} bpm or more. It's based on ${h.days} days of heart-rate readings from the last four weeks.`,
  });
}

/** Last month, if it was your most active on record: news on the 1st and 2nd, then on the page all month. */
function bestMonth(ctx: InsightContext, add: Add): void {
  const best = lastMonthBest(ctx.months, ctx.today, (m) => m.steps, 20, 'max');
  if (!best) return;
  add({
    ...base, id: 'activity-best-month', kind: 'milestone', tone: 'good',
    importance: 64, topic: 'best-month-steps', family: 'monthly-best', today: 'as-news', news: ctx.dom <= 2,
    title: 'Your most active month',
    text: `You averaged ${fmtInt(best.value)} steps a day in ${monthName(best.month, ctx.today)}. That's your most active month ${sinceHistory(best.since, ctx.today)}.`,
  });
}
