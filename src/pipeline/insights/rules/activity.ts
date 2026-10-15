import { addDays, daysBetween, isoWeekdayIndex, type CivilDate } from '../../../lib/date';
import { t } from '../../../i18n';
import {
  formatClock, formatDayMonthLong, formatFixed, formatInteger, formatList, formatMonth, isoWeekdayName,
} from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import { completedDays, goalStreak, loadRatio, periodShift, series, stats, values, type Point } from '../../derive';
import { WHO_DAY, WHO_WEEK } from '../../goals';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW, briskMins, heldFor, pastYear, reachesYear, freshEntry, sinceNote, zoneMins } from '../helpers';
import { movementHrvAssociation } from '../association';
import { activeHours, dayRecord, lastMonthBest, monthsOf, weekdayExtremes } from '../patterns';
import type { HistoryQueries } from '../../history';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'movement' as const, page: 'activity' as const };

/**
 * What Activity asks of the past year before the window: monthly steps, and the
 * best day and week for the records it celebrates.
 */
export const activityQueries = {
  stepsByMonth: { measure: 'steps', group: 'month', aggregate: ['sum', 'count'], back: 365 },
  biggestStepDay: { measure: 'steps', aggregate: ['max', 'first'], back: 365 },
  mostActiveWeek: { measure: 'steps', rolling: { days: 7, minReadings: 7 }, aggregate: ['max', 'count', 'first'], back: 365 },
  longestWalk: { measure: 'distanceKm', aggregate: ['max', 'count', 'first'], back: 365 },
  mostFloors: { measure: 'floors', aggregate: ['max', 'count', 'first'], back: 365 },
  hardestDay: { measure: 'activeZoneMinutes', aggregate: ['max', 'count', 'first'], back: 365 },
  hardestBriskDay: { measure: 'briskMinutes', aggregate: ['max', 'count', 'first'], back: 365 },
} satisfies HistoryQueries;

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
  weekRecord(ctx, add);
  dayRecords(ctx, add);
  nudges(ctx, add);
  association(ctx, add);
}

/** A round figure to say "about" in front of. */
const about = (v: number, to = 100) => Math.round(v / to) * to;

/** How far back a record reaches, for its title: 'year' ("in a year") or 'history' ("yet"). */
type Reach = 'year' | 'history';
const reachOf = (first: CivilDate | null, today: CivilDate): Reach => (reachesYear(first, today) ? 'year' : 'history');

/** This week's step volume against the weeks before it. */
function volume(ctx: InsightContext, add: Add): void {
  const { load, doneSteps, days } = ctx;
  if (load.ratio !== null && load.ratio > 1.5) {
    // On Today as the jump starts; after that it waits on Activity, saying how long it has lasted,
    // because a big week stays in the ratio for days and the same warning every morning is noise.
    const ramping = (steps: Point[]) => (loadRatio(steps).ratio ?? 0) > 1.5;
    const news = freshEntry((n) => ramping(doneSteps.slice(0, doneSteps.length - n)));
    const held = heldFor(days, (w) => ramping(series(w, (d) => d.steps).slice(0, -1)));
    add({
      ...base, id: 'ramp', kind: 'alert', tone: 'watch', direction: 'up',
      importance: 84, topic: 'movement-volume', family: 'movement-volume', today: 'as-news', news,
      claims: { metric: 'steps', direction: 'up' }, evidence: 28,
      title: t('insights.activity.ramp.title'),
      text: t('insights.activity.ramp.text', { ratio: formatFixed(load.ratio, 1) }) + (news ? '' : sinceNote(held)),
    });
  }

  const shiftP = (w: Point[], dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.deltaPct !== null && sh.nCurrent >= 5 && sh.nPrevious >= 5 && sh.deltaPct * dir >= 20 && Math.abs(sh.delta!) >= 1500;
  };
  for (const dir of [1, -1] as const) {
    if (!shiftP(doneSteps, dir)) continue;
    const sh = periodShift(doneSteps, 7);
    const news = freshEntry((n) => shiftP(doneSteps.slice(0, doneSteps.length - n), dir));
    const held = heldFor(days, (w) => shiftP(series(w, (d) => d.steps).slice(0, -1), dir));
    add({
      ...base, id: dir === 1 ? 'steps-up' : 'steps-down', kind: 'trend', tone: dir === 1 ? 'good' : 'neutral',
      direction: dir === 1 ? 'up' : 'down',
      importance: dir === 1 ? 62 : 40, topic: 'movement-volume', family: 'movement-volume',
      today: dir === 1 ? 'as-news' : 'never', news,
      claims: { metric: 'steps', direction: dir === 1 ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      title: t(dir === 1 ? 'insights.activity.stepsUp.title' : 'insights.activity.stepsDown.title'),
      text: dir === 1
        ? t('insights.activity.stepsUp.text', {
          count: Math.round(sh.current!), previous: formatInteger(sh.previous!), pct: Math.round(sh.deltaPct!),
        }) + (news ? '' : sinceNote(held))
        : t('insights.activity.stepsDown.text', { count: Math.round(sh.current!), previous: formatInteger(sh.previous!) }),
    });
    break;
  }
}

/** Streaks, records and the weekly target. Broken streaks get silence, always. */
function milestones(ctx: InsightContext, add: Add): void {
  const { stepsSeries, doneSteps, today, days } = ctx;
  const goal = ctx.goals.steps;

  const STREAK_SET = new Set([3, 5, 7, 10, 14, 21, 30]);
  const streak = goalStreak(stepsSeries, (v) => v >= goal);
  if (streak >= 3) {
    add({
      ...base, id: 'streak', kind: 'milestone', tone: 'good',
      importance: 63, topic: 'step-streak', family: 'movement-milestone',
      // Short streaks stay on the page; from a week they're worth Today on the day they land.
      today: streak >= 7 ? 'as-news' : 'never',
      news: STREAK_SET.has(streak) && goalStreak(doneSteps, (v) => v >= goal) !== streak,
      title: t('insights.activity.streak.title'),
      text: t('insights.activity.streak.text', { goal, count: streak }),
    });
  }

  // Record day: the window's biggest finished day, with two weeks before it to beat and a floor so
  // tiny records stay quiet: most of a goal day. News the mornings after it lands, then on the page
  // for the rest of the week.
  const finished = doneSteps.filter((pt) => pt.value !== null);
  const at = finished.reduce((best, pt, i) => (pt.value! > finished[best].value! ? i : best), 0);
  const record = finished[at];
  if (record && at >= 14 && record.value! >= goal * 0.8) {
    const age = daysBetween(record.date, today);
    const answered = ctx.answers.biggestStepDay?.rows[0];
    const before = answered?.max ?? null;
    // A year's record once it also beats every stored day in the past year before the window.
    const yearly = before !== null && record.value! > before.value;
    const priorMax = Math.max(...finished.slice(0, at).map((pt) => pt.value!), yearly ? before!.value : 0);
    const first = answered?.first?.date ?? null;
    const span = pastYear(first, today);
    if (age <= 7) {
      const reach = yearly ? reachOf(first, today) : 'twoMonths';
      add({
        ...base, id: 'step-record', kind: 'milestone', tone: 'good',
        importance: 77, topic: 'step-record', family: 'movement-milestone', today: 'as-news', news: age <= ENTRY_WINDOW + 1,
        title: t('insights.activity.stepRecord.title', { reach }),
        text: t('insights.activity.stepRecord.text', {
          reach, count: Math.round(record.value!), date: formatDayMonthLong(record.date), span, previous: formatInteger(priorMax),
        }),
      });
    }
  }

  // The WHO's weekly bar, on the day it's crossed: harder minutes count double.
  const weekStart = days.findIndex((d) => daysBetween(d.date, today) <= isoWeekdayIndex(today));
  if (weekStart >= 0) {
    const hasAzm = days.slice(weekStart).some((d) => d.zoneMinutes !== null);
    const minutes = (upto: number) => days.slice(weekStart, upto).reduce((a, d) => a + (hasAzm ? zoneMins(d) : briskMins(d)), 0);
    const total = minutes(days.length);
    if (total >= WHO_WEEK) {
      const spare = 6 - isoWeekdayIndex(today);
      // The week's minutes print as they always have, without digit grouping: a hard week passes 1000.
      const earned = Math.round(total);
      add({
        ...base, id: 'who-week', kind: 'milestone', tone: 'good',
        importance: 58, topic: 'weekly-target', family: 'movement-milestone', today: 'as-news',
        news: minutes(days.length - 1) < WHO_WEEK,
        title: t('insights.activity.whoWeek.title'),
        text: t('insights.activity.whoWeek.text', {
          source: hasAzm ? 'zone' : 'brisk', count: earned, minutes: earned, spare, target: WHO_WEEK,
        }),
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
    // Printed without digit grouping, as it always has been.
    const minutes = Math.round(sh.current!);
    add({
      ...base, id: dir === 1 ? 'mvpa-up' : 'mvpa-down', kind: 'trend', tone: dir === 1 ? 'good' : 'neutral',
      direction: dir === 1 ? 'up' : 'down',
      importance: dir === 1 ? 59 : 38, topic: 'movement-intensity', family: 'movement-volume', today: 'never',
      news: freshEntry((n) => shiftP(mvpa.slice(0, mvpa.length - n), dir)),
      claims: { metric: 'brisk', direction: dir === 1 ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      title: t(dir === 1 ? 'insights.activity.mvpaUp.title' : 'insights.activity.mvpaDown.title'),
      text: t(dir === 1 ? 'insights.activity.mvpaUp.text' : 'insights.activity.mvpaDown.text', {
        count: minutes, minutes, previous: Math.round(sh.previous!),
      }),
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
      title: t('insights.activity.slowDay.title'),
      text: t('insights.activity.slowDay.text', {
        time: formatClock(minutesNow), count: Math.round(steps), usual: formatInteger(stepMedian),
      }),
      action: t('insights.activity.slowDay.action'),
    });
  }
  if (part === 'midday' && hour < 13 && steps > stepMedian * 0.8) {
    add({
      ...nudge, id: 'ahead-of-yourself', tone: 'good', importance: 56, daypart: ['midday'],
      title: t('insights.activity.aheadOfYourself.title'),
      text: t('insights.activity.aheadOfYourself.text', { count: Math.round(steps) }),
    });
  }
  if (part === 'evening') {
    const gap = ctx.goals.steps - steps;
    if (gap >= 800 && gap <= 2500) {
      add({
        ...nudge, id: 'within-reach', tone: 'good', importance: 61, daypart: ['evening'],
        title: t('insights.activity.withinReach.title'),
        text: t('insights.activity.withinReach.text', { count: Math.round(gap), goal: formatInteger(ctx.goals.steps) }),
        action: t('insights.activity.withinReach.action'),
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
    title: t('insights.activity.movementHrvAssociation.title'),
    text: t('insights.activity.movementHrvAssociation.text', {
      weeks: a.weeks, pct: a.pct, threshold: Math.round(a.threshold), high: a.nHigh, low: a.nLow,
      illness: a.excludedIllnessNights > 0,
    }),
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
    title: t('insights.activity.activityQuietDays.title'),
    text: t('insights.activity.activityQuietDays.text', { count: n, line, usual: about(stepMedian) }),
  });
}

/** Active minutes every day, a day's share of the WHO's weekly bar. Short runs stay on the page. */
function activeStreak(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const azm = days.slice(-14).some((d) => d.zoneMinutes !== null);
  const daily = series(days, (d) => (azm ? (d.zoneMinutes ? zoneMins(d) : null) : d.activeMinutes ? briskMins(d) : null));
  const meets = (v: number) => v >= WHO_DAY;
  const n = goalStreak(daily, meets);
  if (n < 3) return;
  add({
    ...base, id: 'activity-azm-streak', kind: 'milestone', tone: 'good',
    importance: 60, topic: 'active-streak', family: 'movement-milestone',
    today: n >= 7 ? 'as-news' : 'never',
    news: [3, 5, 7, 14, 30].includes(n) && goalStreak(daily.slice(0, -1), meets) !== n,
    title: t('insights.activity.activityAzmStreak.title'),
    text: t('insights.activity.activityAzmStreak.text', {
      source: azm ? 'zone' : 'brisk', daily: WHO_DAY, count: n, target: WHO_WEEK,
    }),
  });
}

/** The first goal day after a week or more without one. No homework attached. */
function backOnTrack(ctx: InsightContext, add: Add): void {
  const { stepsSeries, today } = ctx;
  const goal = ctx.goals.steps;
  const goalDays = stepsSeries.filter((pt) => pt.value !== null && pt.value >= goal);
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
    title: t('insights.activity.activityBackAtIt.title'),
    text: t('insights.activity.activityBackAtIt.text', {
      when: age === 0 ? 'today' : 'earlier', goal, date: formatDayMonthLong(latest.date), gap,
    }),
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
      title: t('insights.activity.activityDistance.title'),
      text: t('insights.activity.activityDistance.text', { km: formatFixed(weekKm, 1) }),
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
      title: t('insights.activity.activityDistanceMonth.title', { mark }),
      text: t('insights.activity.activityDistanceMonth.text', { km: Math.floor(monthKm) }),
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
  // Printed without digit grouping, as it always has been: a week in the hills can pass 1000.
  const floors = Math.round(last.sum);
  add({
    ...base, id: 'activity-floors', kind: 'milestone', tone: 'good',
    importance: 50, topic: 'floors', family: 'movement-milestone', today: 'never',
    news: !beats(weeks.length - 2),
    title: t('insights.activity.activityFloors.title'),
    text: t('insights.activity.activityFloors.text', { count: floors, floors }),
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
  const mix = share >= 0.6 ? 'moderate' : share <= 0.4 ? 'hard' : 'even';
  add({
    ...base, id: 'activity-intensity-mix', kind: 'pattern', tone: 'neutral',
    importance: 43, topic: 'intensity-mix', family: 'activity-patterns', today: 'never', news: false,
    title: t('insights.activity.activityIntensityMix.title'),
    text: t('insights.activity.activityIntensityMix.text', { mix, count: hardDays }),
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
  const names = top.map((x) => isoWeekdayName(isoWeekdayIndex(x.date)));
  const weekend = top.every((x) => isoWeekdayIndex(x.date) >= 5);
  add({
    ...base, id: 'activity-weekend-load', kind: 'pattern', tone: 'neutral',
    importance: 42, topic: 'weekend-load', family: 'activity-patterns', today: 'never', news: isoWeekdayIndex(today) === 0,
    title: t('insights.activity.activityWeekendLoad.title', { split: weekend ? 'weekend' : 'twoDays' }),
    text: t('insights.activity.activityWeekendLoad.text', {
      source: azm ? 'zone' : 'brisk', share: Math.round(share * 100), days: formatList(names),
    }),
  });
}

/**
 * Goal days over four weeks: a trend when it moved by a day a week or more
 * against the four weeks before, otherwise a standing note when your usual day
 * sits far above or below the goal.
 */
function goalDays(ctx: InsightContext, add: Add): void {
  const goal = ctx.goals.steps;
  const tally = (s: Point[]) => {
    const v = values(s);
    return { n: v.length, hits: v.filter((x) => x >= goal).length };
  };
  // "every one of the last 28 days", or "12 of 25 recorded days in the last four weeks".
  const phrase = (x: { n: number; hits: number }) => {
    const every = x.hits === x.n;
    const shape = x.n === 28 ? (every ? 'everyDay' : 'someDays') : every ? 'everyRecorded' : 'someRecorded';
    return t('insights.activity.common.goalDays', { shape, hits: x.hits, count: x.n });
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
      title: t('insights.activity.activityConsistency.title', { trend: up ? 'up' : 'down' }),
      text: t('insights.activity.activityConsistency.text', { goal, days: phrase(now.a), hits: now.b.hits, total: now.b.n }),
    });
    return;
  }

  const recent = tally(ctx.doneSteps.slice(-28));
  const median = stats(values(ctx.doneSteps.slice(-28)))?.median ?? null;
  if (recent.n < 21 || median === null) return;
  const above = median >= goal * 1.3;
  if (!above && median > goal * 0.7) return;
  const fit = above ? 'above' : 'below';
  add({
    ...base, id: 'activity-goal-fit', kind: 'pattern', tone: 'neutral',
    importance: 37, topic: 'goal-days', family: 'activity-patterns', today: 'never', news: false,
    title: t('insights.activity.activityGoalFit.title', { fit }),
    text: t('insights.activity.activityGoalFit.text', { fit, count: about(median), goal: formatInteger(goal), days: phrase(recent) }),
  });
}

/** Your most and least active weekdays, once six weeks give each one enough days. */
function weekShape(ctx: InsightContext, add: Add): void {
  const ext = weekdayExtremes(ctx.doneSteps, 6);
  if (!ext || ext.high.median! < ext.low.median! * 1.2) return;
  add({
    ...base, id: 'activity-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 44, topic: 'activity-week-shape', family: 'activity-patterns', today: 'never', news: false,
    title: t('insights.activity.activityWeekShape.title'),
    text: t('insights.activity.activityWeekShape.text', {
      activeDay: isoWeekdayName(ext.high.weekday), count: about(ext.high.median!),
      quietDay: isoWeekdayName(ext.low.weekday), quietSteps: formatInteger(about(ext.low.median!)),
    }),
  });
}

/** When in the day you move, from minute heart rate, your resting heart rate and your age. */
function peakHours(ctx: InsightContext, add: Add): void {
  const { intraday, age, days } = ctx;
  const rest = stats(values(series(days.slice(-28), (d) => d.restingHr)))?.median ?? null;
  if (!intraday || age === null || rest === null) return;
  const h = activeHours(days, intraday, age, rest);
  if (!h || (!h.weekdays && !h.weekends)) return;
  // Each two-hour window's first and last hour on the clock, for "between 17:00 and 19:00".
  const from = (w: { fromHour: number } | null) => (w ? formatClock(w.fromHour * 60) : '');
  const to = (w: { fromHour: number } | null) => (w ? formatClock((w.fromHour + 2) * 60) : '');
  const { weekdays: wd, weekends: we } = h;
  const when = wd && we ? (wd.fromHour === we.fromHour ? 'same' : 'split') : wd ? 'weekdays' : 'weekends';
  add({
    ...base, id: 'activity-peak-hours', kind: 'pattern', tone: 'neutral',
    importance: 45, topic: 'peak-hours', family: 'activity-patterns', today: 'never', news: false,
    title: t('insights.activity.activityPeakHours.title'),
    text: t('insights.activity.activityPeakHours.text', {
      when, from: from(wd), to: to(wd), weekendFrom: from(we), weekendTo: to(we), threshold: h.threshold, count: h.days,
    }),
  });
}

/** Last month, if it was your most active on record: news on the 1st and 2nd, then on the page all month. */
function bestMonth(ctx: InsightContext, add: Add): void {
  const best = lastMonthBest(monthsOf(ctx.days, 'steps', ctx.answers.stepsByMonth), ctx.today, 20, 'max');
  if (!best) return;
  add({
    ...base, id: 'activity-best-month', kind: 'milestone', tone: 'good',
    importance: 64, topic: 'best-month-steps', family: 'monthly-best', today: 'as-news', news: ctx.dom <= 2,
    title: t('insights.activity.activityBestMonth.title'),
    text: t('insights.activity.activityBestMonth.text', {
      count: Math.round(best.value), month: formatMonth(best.month, ctx.today), span: pastYear(`${best.since}-01`, ctx.today),
    }),
  });
}

/**
 * Your most active 7 days in the past year, finished days only: news the
 * morning it's set, then on the page while it holds. It speaks for "You've
 * been moving more this week", and a ramp alert outranks it.
 */
function weekRecord(ctx: InsightContext, add: Add): void {
  const { doneSteps, today } = ctx;
  const weeks: { end: number; sum: number }[] = [];
  for (let end = 7; end <= doneSteps.length; end++) {
    const v = values(doneSteps.slice(end - 7, end));
    if (v.length === 7) weeks.push({ end, sum: v.reduce((a, b) => a + b, 0) });
  }
  const last = weeks[weeks.length - 1];
  if (!last || last.end !== doneSteps.length || last.sum < 35000) return;
  const answered = ctx.answers.mostActiveWeek?.rows[0];
  const before = answered?.max ? answered.max.value * 7 : null;
  // At least eight weeks behind it, from the window and the year before.
  if ((answered?.count ?? 0) + weeks.length - 1 < 56) return;
  const beats = (i: number) =>
    weeks[i].sum > Math.max(...weeks.slice(0, i).map((w) => w.sum), before ?? 0);
  if (!beats(weeks.length - 1)) return;
  const first = answered?.first?.date ?? ctx.days[0].date;
  const span = pastYear(first, today);
  add({
    ...base, id: 'activity-week-record', kind: 'milestone', tone: 'good',
    importance: 65, topic: 'movement-volume', family: 'movement-volume', today: 'as-news',
    news: weeks.length < 2 || !beats(weeks.length - 2),
    title: t('insights.activity.activityWeekRecord.title', { reach: reachOf(first, today) }),
    text: t('insights.activity.activityWeekRecord.text', { count: Math.round(last.sum), span }),
  });
}

/** Longest walk, most floors and hardest day: news the mornings after, then on the page for the rest of the week. */
function dayRecords(ctx: InsightContext, add: Add): void {
  const { days, today, answers } = ctx;
  const azm = days.slice(-28).some((d) => d.zoneMinutes !== null);
  const defs = [
    {
      id: 'activity-longest-walk', topic: 'distance-record', measure: 'distanceKm' as const, answer: answers.longestWalk, mustReach: 5,
      title: (reach: Reach) => t('insights.activity.activityLongestWalk.title', { reach }),
      text: (v: number, date: string, span: string, prev: number) =>
        t('insights.activity.activityLongestWalk.text', { km: formatFixed(v, 1), date, span, previous: formatFixed(prev, 1) }),
    },
    {
      id: 'activity-most-floors', topic: 'floors', measure: 'floors' as const, answer: answers.mostFloors, mustReach: 10,
      title: (reach: Reach) => t('insights.activity.activityMostFloors.title', { reach }),
      text: (v: number, date: string, span: string, prev: number) =>
        t('insights.activity.activityMostFloors.text', { count: Math.round(v), date, span, previous: formatInteger(prev) }),
    },
    {
      id: 'activity-hardest-day', topic: 'hardest-day', measure: azm ? 'activeZoneMinutes' as const : 'briskMinutes' as const,
      answer: azm ? answers.hardestDay : answers.hardestBriskDay, mustReach: 30,
      title: (reach: Reach) => t('insights.activity.activityHardestDay.title', { reach }),
      text: (v: number, date: string, span: string, prev: number) =>
        t('insights.activity.activityHardestDay.text', {
          source: azm ? 'zone' : 'brisk', count: Math.round(v), date, span, previous: formatInteger(prev),
        }),
    },
  ];
  for (const def of defs) {
    const r = dayRecord(days, today, def.measure, 'max', def.answer, { finishedOnly: true, mustReach: def.mustReach });
    if (!r) continue;
    const span = pastYear(r.since, today);
    add({
      ...base, id: def.id, kind: 'milestone', tone: 'good',
      importance: 66, topic: def.topic, family: 'movement-milestone', today: 'as-news', news: r.age <= ENTRY_WINDOW + 1,
      title: def.title(reachOf(r.since, today)),
      text: def.text(r.value, formatDayMonthLong(r.date), span, r.previous),
    });
  }
}
