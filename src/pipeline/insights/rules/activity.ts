import { daysBetween, isoWeekdayIndex } from '../../../lib/date';
import { completedDays, goalStreak, periodShift, series, type Point } from '../../derive';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, STEP_GOAL, briskMins, clk, dayMonth, fmtInt, heldFor, plural, sinceNote, zoneMins,
} from '../helpers';
import { movementHrvAssociation } from '../association';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'movement' as const, page: 'activity' as const };

/** Steps, active minutes and the moments in the day worth a nudge. */
export function activityRules(ctx: InsightContext, add: Add): void {
  volume(ctx, add);
  milestones(ctx, add);
  intensity(ctx, add);
  nudges(ctx, add);
  association(ctx, add);
}

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
    const priorMax = Math.max(...finished.slice(0, at).map((pt) => pt.value!));
    if (age <= 7) {
      add({
        ...base, id: 'step-record', kind: 'milestone', tone: 'good',
        importance: 77, topic: 'step-record', family: 'movement-milestone', today: 'as-news', news: age <= ENTRY_WINDOW + 1,
        title: 'Your biggest day yet',
        text: `You walked ${fmtInt(record.value!)} steps on ${dayMonth(record.date)}. That's your biggest day in the last two months. Your previous best was ${fmtInt(priorMax)}.`,
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
