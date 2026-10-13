import { daysBetween } from '../../../lib/date';
import type { DailyRecord } from '../../../types/health';
import { NOISE_FLOOR, compareToBaseline, isRecent, periodShift, series, values, type Point } from '../../derive';
import type { InsightContext } from '../context';
import { ENTRY_WINDOW, entered, heldFor, sinceNote, trailingDays } from '../helpers';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'cardio' as const, page: 'vitals' as const };

/** HRV and resting heart rate, cardio fitness and record weeks. */
export function vitalsRules(ctx: InsightContext, add: Add): void {
  const hrvTrend = hrvTrends(ctx, add);
  hrvNight(ctx, add, hrvTrend);
  restingHeartRate(ctx, add);
  vo2(ctx, add);
  records(ctx, add);
}

const lnHrv = (days: DailyRecord[]): Point[] =>
  series(days, (d) => d.hrv).map((pt) => ({ date: pt.date, value: pt.value === null || pt.value <= 0 ? null : Math.log(pt.value) }));

/** A week of HRV against the week before, in the log domain. Returns the direction that holds, if any. */
function hrvTrends(ctx: InsightContext, add: Add): 'up' | 'down' | null {
  const { days } = ctx;
  const holds = (w: Point[], dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.delta !== null && sh.nCurrent >= 4 && sh.nPrevious >= 4 && sh.delta * dir >= 0.08;
  };
  const ln = lnHrv(days);
  for (const dir of [-1, 1] as const) {
    if (!holds(ln, dir)) continue;
    const sh = periodShift(ln, 7);
    const rel = Math.abs(Math.round((Math.exp(sh.delta!) - 1) * 100));
    const cur = Math.round(Math.exp(sh.current!));
    const prev = Math.round(Math.exp(sh.previous!));
    const news = !holds(ln.slice(0, -(ENTRY_WINDOW + 1)), dir);
    const held = heldFor(days, (w) => holds(lnHrv(w), dir));
    const up = dir === 1;
    add({
      ...base, id: up ? 'hrv-trend-up' : 'hrv-trend-down', kind: 'trend', tone: up ? 'good' : 'watch',
      direction: up ? 'up' : 'down',
      importance: up ? 80 : 90, topic: 'hrv', family: 'recovery', today: 'as-news', news,
      claims: { metric: 'hrv', direction: up ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      advice: up ? undefined : 'rest',
      title: up ? 'Your recovery is improving' : 'Your recovery has been slipping',
      text: up
        ? `Your average HRV this week is ${cur} ms, ${rel}% higher than last week's ${prev} ms. A rise that lasts several days usually means real recovery, not just one good night.${news ? '' : sinceNote(held)}`
        : `Your average HRV this week is ${cur} ms, ${rel}% lower than last week's ${prev} ms. A slide like this often comes with heavy training, short sleep, stress or a cold.${news ? '' : sinceNote(held)}`,
    });
    return up ? 'up' : 'down';
  }
  return null;
}

/** Last night's HRV against your own 28 days, when no trend already tells the story. */
function hrvNight(ctx: InsightContext, add: Add, trend: 'up' | 'down' | null): void {
  const { days, today } = ctx;
  const hrv = compareToBaseline(series(days, (d) => d.hrv), 28, 8, NOISE_FLOOR.hrv);
  if (ctx.illness || !isRecent(hrv.date, today)) return;
  const value = Math.round(hrv.value!);
  const usual = Math.round(hrv.baseline!);

  if ((hrv.band === 'above' || hrv.band === 'far-above') && trend !== 'up') {
    add({
      ...base, id: 'hrv-acute-high', kind: 'pattern', tone: 'good',
      importance: 70, topic: 'hrv', family: 'recovery', today: 'never', news: true,
      claims: { metric: 'hrv', direction: 'up' }, evidence: 1,
      title: 'Great recovery last night',
      text: `Your HRV was ${value} ms last night, near the top of your usual range. It's usually around ${usual} ms.`,
    });
  } else if ((hrv.band === 'below' || hrv.band === 'far-below') && trend !== 'down') {
    const lowNights = trailingDays(days, (d) =>
      d.hrv === null ? null : hrv.baseline !== null && hrv.spread !== null ? d.hrv < hrv.baseline - hrv.spread : null,
    );
    add({
      ...base, id: 'hrv-acute-low', kind: 'alert', tone: 'watch', direction: 'down',
      importance: 85, topic: 'hrv', family: 'recovery', today: 'while-true', news: true, advice: 'rest',
      claims: { metric: 'hrv', direction: 'down' }, evidence: Math.max(1, lowNights),
      title: 'Your HRV is lower than usual',
      text: lowNights >= 2
        ? `Your HRV has been below normal for ${lowNights} nights in a row. Last night it was ${value} ms, and it's usually around ${usual} ms. This is starting to look like a trend rather than one night.`
        : `Your HRV was ${value} ms last night, lower than your usual ${usual} ms. One low night isn't a trend. Two or three in a row usually mean your body needs more recovery.`,
    });
  }
}

/**
 * Precedence: a short elevated streak (1–5 mornings, far above range) is an acute EVENT
 * (late meals, alcohol, heat, an oncoming illness) and gets the escalating alert. Broad
 * elevation is a DRIFT and belongs to the fortnight-shift card. Without this split, three
 * loud mornings drag the 14-day mean just far enough to fire the shift card, which would
 * then misframe an acute event as a gradual trend.
 */
function restingHeartRate(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const rhrSeries = series(days, (d) => d.restingHr);
  const rhr = compareToBaseline(rhrSeries, 28, 8, NOISE_FLOOR.restingHr);
  const recent = isRecent(rhr.date, today);
  const highStreak = trailingDays(days, (d) =>
    d.restingHr === null ? null : rhr.baseline !== null && rhr.spread !== null ? d.restingHr > rhr.baseline + 2 * rhr.spread : null,
  );
  const acute = !ctx.illness && recent && rhr.band === 'far-above' && highStreak >= 1 && highStreak <= 5;

  const shiftP = (w: Point[], dir: 1 | -1) => {
    const sh = periodShift(w, 14);
    return sh.delta !== null && sh.nCurrent >= 7 && sh.nPrevious >= 7 && sh.delta * dir >= 1.5;
  };
  let shiftDir: 'up' | 'down' | null = null;
  for (const dir of [1, -1] as const) {
    if (dir === 1 && acute) continue; // the event owns the up-story
    if (!shiftP(rhrSeries, dir)) continue;
    shiftDir = dir === 1 ? 'up' : 'down';
    const sh = periodShift(rhrSeries, 14);
    const news = !shiftP(rhrSeries.slice(0, -(ENTRY_WINDOW + 1)), dir);
    const held = heldFor(days, (w) => shiftP(series(w, (d) => d.restingHr), dir));
    const up = dir === 1;
    add({
      ...base, id: up ? 'rhr-shift-up' : 'rhr-shift-down', kind: 'trend', tone: up ? 'watch' : 'good',
      direction: up ? 'up' : 'down',
      importance: up ? 88 : 75, topic: 'rhr', family: 'recovery', today: 'as-news', news,
      claims: { metric: 'rhr', direction: up ? 'up' : 'down' }, evidence: sh.nCurrent + sh.nPrevious,
      title: up ? 'Your resting heart rate is creeping up' : 'Your resting heart rate is coming down',
      text: `Over the last two weeks your resting heart rate averaged ${sh.current!.toFixed(1)} bpm, ${Math.abs(sh.delta!).toFixed(1)} bpm ${up ? 'higher' : 'lower'} than in the two weeks before.${news ? '' : sinceNote(held)}`,
    });
  }

  if (ctx.illness) return;
  const value = Math.round(rhr.value!);
  const usual = Math.round(rhr.baseline!);
  if (acute) {
    add({
      ...base, id: 'rhr-acute-high', kind: 'alert', tone: 'watch', direction: 'up',
      importance: 92, topic: 'rhr', family: 'recovery', today: 'while-true', news: highStreak === 1, advice: 'rest',
      claims: { metric: 'rhr', direction: 'up' }, evidence: highStreak,
      title: 'Your heart rate is higher than usual',
      text: highStreak >= 3
        ? `This is the third morning your resting heart rate has been above your usual range. It's ${value} bpm today, and it's usually around ${usual}.`
        : `Your resting heart rate is ${value} bpm this morning. It's usually around ${usual}. This often follows a late meal, alcohol or heat, and sometimes comes before a cold.`,
      action: highStreak >= 3 ? 'If nothing obvious explains it, keep today easy.' : "If it's still high tomorrow, take an easier day.",
    });
  } else if (recent && rhr.band === 'far-below' && shiftDir !== 'down') {
    add({
      ...base, id: 'rhr-acute-low', kind: 'pattern', tone: 'good',
      importance: 65, topic: 'rhr', family: 'recovery', today: 'never',
      news: entered(days, (w) => compareToBaseline(series(w, (d) => d.restingHr)).band === 'far-below'),
      claims: { metric: 'rhr', direction: 'down' }, evidence: 1,
      title: 'Your heart is nicely relaxed',
      text: `Your resting heart rate is ${value} bpm this morning, lower than your usual ${usual}.`,
    });
  }
}

/** VO₂ max revisions, only when bigger than the estimate's own uncertainty. */
function vo2(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const readings = series(days, (d) => d.vo2Max).filter((pt) => pt.value !== null);
  if (readings.length < 2) return;
  const last = readings[readings.length - 1];
  // The revision is the first reading of the latest run of equal values.
  let i = readings.length - 1;
  while (i > 0 && readings[i - 1].value === last.value) i--;
  if (i === 0) return;
  const firstAtNew = readings[i];
  const age = daysBetween(firstAtNew.date, today);
  // A revision stays on the page for a month, and is news on Today in its first days.
  if (age > 30) return;
  const delta = last.value! - readings[i - 1].value!;
  // The covariance from the same day as the revision gates it: max(0.3, √cov), a change gate that can only be stricter.
  const cov = days.find((d) => d.date === last.date)?.vo2MaxCovariance ?? null;
  const gate = Math.max(0.3, cov !== null && cov > 0 ? Math.sqrt(cov) : 0.3);
  if (Math.abs(delta) < gate) return;
  const up = delta > 0;
  add({
    ...base, id: up ? 'vo2-up' : 'vo2-down', kind: up ? 'milestone' : 'trend', tone: up ? 'good' : 'watch',
    direction: up ? 'up' : 'down',
    importance: up ? 60 : 70, topic: 'vo2', family: 'fitness', today: up ? 'as-news' : 'never',
    news: age <= ENTRY_WINDOW + 1,
    claims: { metric: 'vo2', direction: up ? 'up' : 'down' },
    title: up ? 'Your cardio fitness went up' : 'Your cardio fitness dipped slightly',
    text: up
      ? `Your VO₂ max estimate rose by ${delta.toFixed(1)} to ${last.value!.toFixed(1)}. It only moves up when the trend is clear, so you earned this one.`
      : `Your VO₂ max estimate went down by ${Math.abs(delta).toFixed(1)} to ${last.value!.toFixed(1)}. It reacts slowly, so this may reflect a quieter few weeks rather than today.`,
  });
}

/** Your lowest resting-HR week, or highest HRV week, in the window: news in its first days, then on the page while it holds. */
function records(ctx: InsightContext, add: Add): void {
  const defs = [
    {
      id: 'record-rhr', get: (d: DailyRecord) => d.restingHr, better: 'min' as const,
      title: 'Your calmest week in two months',
      text: (v: number) => `Your resting heart rate averaged ${v.toFixed(1)} bpm this week. That's your lowest week in the last two months.`,
    },
    {
      id: 'record-hrv', get: (d: DailyRecord) => d.hrv, better: 'max' as const,
      title: 'Your best week of recovery in two months',
      text: (v: number) => `Your HRV averaged ${v.toFixed(1)} ms this week. That's your highest week in the last two months.`,
    },
  ];
  for (const def of defs) {
    const s = series(ctx.days, def.get);
    const weeks: { end: number; mean: number }[] = [];
    for (let end = 7; end <= s.length; end++) {
      const v = values(s.slice(end - 7, end));
      if (v.length >= 5) weeks.push({ end, mean: v.reduce((a, b) => a + b, 0) / v.length });
    }
    if (weeks.length < 6) continue;
    const last = weeks[weeks.length - 1];
    if (last.end !== s.length) continue;
    const beats = (w: { mean: number }, others: { mean: number }[]) =>
      def.better === 'min' ? w.mean < Math.min(...others.map((x) => x.mean)) : w.mean > Math.max(...others.map((x) => x.mean));
    if (!beats(last, weeks.slice(0, -1))) continue;
    const prevWasRecord = beats(weeks[weeks.length - 2], weeks.slice(0, -2));
    add({
      ...base, id: def.id, kind: 'milestone', tone: 'good',
      importance: 53, topic: 'records', family: 'recovery', today: 'as-news', news: !prevWasRecord,
      title: def.title,
      text: def.text(last.mean),
    });
  }
}
