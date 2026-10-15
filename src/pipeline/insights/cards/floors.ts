import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR, compareToBaseline, isRecent, latestPoint, periodShift, series, weightTrend,
} from '../../derive';
import type { InsightContext } from '../context';
import { sleepMins } from '../helpers';
import { TREND_KG_PER_WEEK } from './body';
import type { Finding, InsightPage, Observation } from '../types';
import { t } from '../../../i18n';
import { formatDayMonthLong, formatDuration, formatInteger, formatList, formatRounded } from '../../../i18n/format';

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
      title: t('insights.floors.floorMorning.title'),
      text: t('insights.floors.floorMorning.text', {
        known: night ? (battery !== null ? 'both' : 'sleep') : battery !== null ? 'battery' : 'none',
        slept: night ? formatDuration(night.minutesAsleep) : '', score: battery,
      }),
    };
  }
  if (ctx.part === 'midday') {
    return {
      ...base, id: 'floor-midday', domain: 'movement',
      title: t('insights.floors.floorMidday.title'),
      text: t('insights.floors.floorMidday.text', {
        known: steps !== null ? (battery !== null ? 'both' : 'steps') : battery !== null ? 'battery' : 'none',
        steps: Math.round(steps ?? 0), score: battery,
      }),
    };
  }
  const brisk = ctx.todayRow.activeMinutes;
  const ratio = ctx.load.ratio;
  // The ratio is the week's steps against the three weeks before, so it speaks for the week, not today.
  const compared = ratio === null ? '' : t(ratio > 1.2 ? 'insights.floors.floorEvening.busier' : ratio < 0.8 ? 'insights.floors.floorEvening.quieter' : 'insights.floors.floorEvening.usual');
  return {
    ...base, id: 'floor-evening', domain: 'movement',
    title: t('insights.floors.floorEvening.title'),
    text: t('insights.floors.floorEvening.text', {
      known: steps !== null ? (brisk ? 'both' : 'steps') : brisk ? 'brisk' : 'none',
      steps: Math.round(steps ?? 0), brisk: brisk ? brisk.moderate + brisk.vigorous : 0,
    }) + (steps !== null ? compared : ''),
  };
}

const quoteList = (titles: string[]) => formatList(titles.map((title) => t('insights.floors.onToday.quoted', { title })));

/**
 * A page with nothing of its own while Today shows its news points there
 * instead of repeating it, or calling the page steady beside it.
 */
export function pageFloor(page: InsightPage, ctx: InsightContext, onToday: Observation[]): Finding {
  if (onToday.length) {
    const titles = onToday.map((o) => o.title);
    return {
      ...floor, id: `${page}-on-today`, page, domain: domainOf[page],
      title: t('insights.floors.onToday.title', { tab: t('app.nav.today') }),
      text: t('insights.floors.onToday.text', { titles: quoteList(titles), count: titles.length, tab: t('app.nav.today') }),
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
      return { title: t('insights.floors.activityFloor.titleEmpty'), text: t('insights.floors.activityFloor.textEmpty') };
    }
    const steady = sh.previous !== null && sh.deltaPct !== null && sh.nCurrent >= 5 && sh.nPrevious >= 5 && Math.abs(sh.deltaPct) < 20;
    return {
      title: t('insights.floors.activityFloor.title', { steady: steady ? 'yes' : 'no' }),
      text: t('insights.floors.activityFloor.text', {
        weekBefore: sh.previous !== null ? 'known' : 'none',
        steps: Math.round(sh.current), previous: sh.previous !== null ? formatInteger(sh.previous) : '',
      }),
    };
  },

  sleep(ctx) {
    const nights = sleepMins(ctx.days.slice(-7), (s) => s.minutesAsleep);
    if (!nights.length) {
      return { title: t('insights.floors.sleepFloor.titleEmpty'), text: t('insights.floors.sleepFloor.textEmpty') };
    }
    const avg = nights.reduce((a, b) => a + b, 0) / nights.length;
    return {
      title: t('insights.floors.sleepFloor.title'),
      text: t('insights.floors.sleepFloor.text', { slept: formatDuration(avg), need: ctx.needH })
        + (nights.length < 7 ? t('insights.floors.sleepFloor.recorded', { count: nights.length }) : ''),
    };
  },

  vitals(ctx) {
    const rhr = compareToBaseline(series(ctx.days, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);
    const hrv = compareToBaseline(series(ctx.days, (d) => d.hrv), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
    const rhrNow = isRecent(rhr.date, ctx.today) ? rhr : null;
    const hrvNow = isRecent(hrv.date, ctx.today) ? hrv : null;
    if (!rhrNow && !hrvNow) {
      return { title: t('insights.floors.vitalsFloor.titleEmpty'), text: t('insights.floors.vitalsFloor.textEmpty') };
    }
    const steady = !ctx.illness && rhrNow?.band === 'typical' && hrvNow?.band === 'typical';
    return {
      title: t('insights.floors.vitalsFloor.title'),
      text: t('insights.floors.vitalsFloor.text', {
        known: rhrNow && hrvNow ? 'both' : rhrNow ? 'restingHr' : 'hrv',
        restingHr: rhrNow ? Math.round(rhrNow.value!) : null, hrv: hrvNow ? Math.round(hrvNow.value!) : null,
      }) + (steady ? t('insights.floors.vitalsFloor.steady') : ''),
    };
  },

  body(ctx) {
    const s = series(ctx.days, (d) => d.weightKg);
    const latest = latestPoint(s);
    if (!latest) {
      // The page can show an older weigh-in from long history; the engine sees only its window.
      return {
        title: t('insights.floors.bodyFloor.titleEmpty'),
        text: t('insights.floors.bodyFloor.textEmpty', { count: ctx.days.length }),
      };
    }
    const trend = weightTrend(s);
    const last = { weight: formatRounded(latest.value!, 3), date: formatDayMonthLong(latest.date) };
    if (!trend) {
      return { title: t('insights.floors.bodyFloor.titleLatest'), text: t('insights.floors.bodyFloor.textLatest', last) };
    }
    // Only reached while the trend sits under the threshold and the scale isn't stale: the body cards own both.
    return {
      title: t('insights.floors.bodyFloor.title'),
      text: t('insights.floors.bodyFloor.text', { threshold: formatRounded(TREND_KG_PER_WEEK, 3), ...last }),
    };
  },
};
