import { NOISE_FLOOR, compareToBaseline, isRecent, latestPoint, periodShift, series, weightTrend } from '../derive';
import type { InsightContext } from './context';
import { dayMonth, fmtInt, hm, plural, sentence, sleepMins } from './helpers';
import { TREND_KG_PER_WEEK } from './rules/body';
import type { Finding, InsightPage, Observation } from './types';

/**
 * The cards that show when a carousel has nothing else. Each one only says
 * what the data shows: a floor never calls something steady unless the
 * numbers say so, and never contradicts a card showing elsewhere.
 */

const floor = { kind: 'review' as const, tone: 'neutral' as const, importance: 0, family: 'review', topic: 'floor', today: 'while-true' as const, news: false };

/** Today's card when nothing key is due. */
export function todayFloor(ctx: InsightContext): Finding {
  const base = { ...floor, page: 'today' as const };
  const battery = ctx.rNow.score;
  const steps = ctx.todayRow.steps;
  if (ctx.part === 'morning') {
    const night = ctx.lastNightIsRecent ? ctx.lastNight : null;
    return {
      ...base, id: 'floor-morning', domain: 'sleep',
      title: 'A quiet morning',
      text: `${night ? `You slept ${hm(night.minutesAsleep)}` : 'No sleep has synced for last night yet'}${battery !== null ? ` and your body battery is ${battery}` : ''}. Nothing new needs your attention this morning.`,
    };
  }
  if (ctx.part === 'midday') {
    return {
      ...base, id: 'floor-midday', domain: 'movement',
      title: 'A steady day so far',
      text: `${steps !== null ? `You've taken ${fmtInt(steps)} steps so far` : 'No steps have synced yet today'}${battery !== null ? ` and your body battery is ${battery}` : ''}. Nothing new needs your attention right now.`,
    };
  }
  const brisk = ctx.todayRow.activeMinutes;
  const ratio = ctx.load.ratio;
  // The ratio is the week's steps against the three weeks before, so it speaks for the week, not today.
  const compared = ratio === null ? '' : ratio > 1.2 ? ' This week has been busier than usual.' : ratio < 0.8 ? ' This week has been quieter than usual.' : ' This week has been about as active as usual.';
  return {
    ...base, id: 'floor-evening', domain: 'movement',
    title: 'A calm day',
    text: `${steps !== null ? `Today you took ${fmtInt(steps)} steps` : 'No steps have synced today'}${brisk ? ` and had ${brisk.moderate + brisk.vigorous} minutes of brisk activity` : ''}.${steps !== null ? compared : ''}`,
  };
}

const quoteList = (titles: string[]) =>
  titles.length === 1 ? `“${titles[0]}”` : `${titles.slice(0, -1).map((t) => `“${t}”`).join(', ')} and “${titles[titles.length - 1]}”`;

/**
 * A page with nothing of its own while Today shows its news points there
 * instead of repeating it, or calling the page steady beside it.
 */
export function pageFloor(page: InsightPage, ctx: InsightContext, onToday: Observation[]): Finding {
  if (onToday.length) {
    const titles = onToday.map((o) => o.title);
    return {
      ...floor, id: `${page}-on-today`, page, domain: domainOf[page],
      title: 'See Today for the latest',
      text: `${quoteList(titles)} ${titles.length === 1 ? 'is' : 'are'} on Today right now, so ${titles.length === 1 ? "it isn't" : "they aren't"} repeated here.`,
    };
  }
  return { ...floor, id: `${page}-floor`, page, domain: domainOf[page], ...floors[page](ctx) };
}

const domainOf = { activity: 'movement', sleep: 'sleep', vitals: 'cardio', body: 'body' } as const;

type FloorCopy = { title: string; text: string };

const floors: Record<InsightPage, (ctx: InsightContext) => FloorCopy> = {
  activity(ctx) {
    const sh = periodShift(ctx.doneSteps, 7);
    if (sh.current === null) {
      return { title: 'No steps yet', text: 'Once your steps sync, this is where insights about how you move will show.' };
    }
    const steady = sh.previous !== null && sh.deltaPct !== null && sh.nCurrent >= 5 && sh.nPrevious >= 5 && Math.abs(sh.deltaPct) < 20;
    return {
      title: steady ? 'A steady week' : 'Your week so far',
      text: `You've averaged ${fmtInt(sh.current)} steps a day over the last 7 days${sh.previous !== null ? `, compared with ${fmtInt(sh.previous)} the week before` : ''}.`,
    };
  },

  sleep(ctx) {
    const nights = sleepMins(ctx.days.slice(-7), (s) => s.minutesAsleep);
    if (!nights.length) {
      return { title: 'No nights recorded yet', text: 'Once your sleep syncs, this is where insights about your nights will show.' };
    }
    const avg = nights.reduce((a, b) => a + b, 0) / nights.length;
    return {
      title: 'Your sleep this week',
      text: `You've slept ${hm(avg)} a night on average this week. You need about ${ctx.needH}.${nights.length < 7 ? ` That's from ${plural(nights.length, 'recorded night')}.` : ''}`,
    };
  },

  vitals(ctx) {
    const rhr = compareToBaseline(series(ctx.days, (d) => d.restingHr), 28, 8, NOISE_FLOOR.restingHr);
    const hrv = compareToBaseline(series(ctx.days, (d) => d.hrv), 28, 8, NOISE_FLOOR.hrv);
    const rhrNow = isRecent(rhr.date, ctx.today) ? rhr : null;
    const hrvNow = isRecent(hrv.date, ctx.today) ? hrv : null;
    if (!rhrNow && !hrvNow) {
      return { title: 'No recent heart data', text: 'Once your watch syncs your resting heart rate and HRV, this is where insights about them will show.' };
    }
    const readings = [
      rhrNow && `your resting heart rate is ${Math.round(rhrNow.value!)} bpm`,
      hrvNow && `your HRV is ${Math.round(hrvNow.value!)} ms`,
    ].filter((s): s is string => !!s);
    const steady = !ctx.illness && rhrNow?.band === 'typical' && hrvNow?.band === 'typical';
    return {
      title: steady ? 'Everything looks steady' : 'Your latest readings',
      text: `${sentence(readings.join(' and '))}.${steady ? ' Both are inside your usual range.' : ''}`,
    };
  },

  body(ctx) {
    const s = series(ctx.days, (d) => d.weightKg);
    const latest = latestPoint(s);
    if (!latest) {
      // The page can show an older weigh-in from long history; the engine sees only its window.
      return {
        title: 'No recent weigh-ins',
        text: `You haven't logged your weight in the last ${plural(ctx.days.length, 'day')}, so there's no trend to read yet. A few weigh-ins over the next weeks will show it.`,
      };
    }
    const trend = weightTrend(s);
    const last = `Your latest weigh-in was ${latest.value} kg on ${dayMonth(latest.date)}.`;
    if (!trend) {
      return { title: 'Your latest weigh-in', text: `${last} A few more weigh-ins over the next weeks will show your trend.` };
    }
    // Only reached while the trend sits under the threshold and the scale isn't stale: the rules own both.
    return {
      title: 'No clear change in your weight',
      text: `Your weight trend is moving by less than ${TREND_KG_PER_WEEK} kg a week either way. ${last}`,
    };
  },
};
