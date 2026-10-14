import { daysBetween } from '../../../lib/date';
import type { DailyRecord } from '../../../types/health';
import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR, compareToBaseline, completedDays, isRecent, periodShift, quantile, series, stats, values, type Point,
} from '../../derive';
import type { HistoryQueries } from '../../history';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, briskMins, dayMonth, entered, heldFor, listOf, monthName, pastYear, freshEntry, sinceNote, trailingDays,
  zoneMins,
} from '../helpers';
import {
  WEEKDAYS, dayRecord, lastMonthBest, monthsOf, nightsAgainstUsual, trailingRun, weekdayExtremes, weekdayMedians,
  type NightReading,
} from '../patterns';
import type { Finding } from '../types';

type Add = (f: Finding) => void;

const base = { domain: 'cardio' as const, page: 'vitals' as const };

/**
 * What Vitals asks of the past year before the window: monthly resting heart
 * rate, the best weeks, and the lowest resting heart rate.
 */
export const vitalsQueries = {
  restingHrByMonth: { measure: 'restingHr', group: 'month', aggregate: ['sum', 'count'], back: 365 },
  calmestWeek: { measure: 'restingHr', rolling: { days: 7, minReadings: 5 }, aggregate: ['min', 'first'], back: 365 },
  bestHrvWeek: { measure: 'hrv', rolling: { days: 7, minReadings: 5 }, aggregate: ['max', 'first'], back: 365 },
  lowestRestingHr: { measure: 'restingHr', aggregate: ['min', 'count', 'first'], back: 365 },
} satisfies HistoryQueries;

/** HRV and resting heart rate, breathing, oxygen and temperature, cardio fitness and record weeks. */
export function vitalsRules(ctx: InsightContext, add: Add): void {
  const hrvTrend = hrvTrends(ctx, add);
  hrvNight(ctx, add, hrvTrend);
  restingHeartRate(ctx, add);
  breathing(ctx, add);
  temperature(ctx, add);
  oxygen(ctx, add);
  allQuiet(ctx, add);
  hrvStability(ctx, add);
  bounceBack(ctx, add);
  hrvWeekShape(ctx, add);
  vo2(ctx, add);
  fitnessLevel(ctx, add);
  records(ctx, add);
  calmestMonth(ctx, add);
  lowestRestingHr(ctx, add);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

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
    const news = freshEntry((n) => holds(ln.slice(0, ln.length - n), dir));
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
  const hrv = compareToBaseline(series(days, (d) => d.hrv), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
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
  const rhr = compareToBaseline(rhrSeries, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);
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
    const news = freshEntry((n) => shiftP(rhrSeries.slice(0, rhrSeries.length - n), dir));
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

/**
 * Your lowest resting-HR week, or highest HRV week: in the window, and all time
 * once it also beats every stored week before it. News in its first days, then
 * on the page while it holds.
 */
function records(ctx: InsightContext, add: Add): void {
  const defs = [
    {
      id: 'record-rhr', get: (d: DailyRecord) => d.restingHr, better: 'min' as const, answer: ctx.answers.calmestWeek,
      title: (yet: string) => `Your calmest week ${yet}`,
      text: (v: number, span: string) => `Your resting heart rate averaged ${v.toFixed(1)} bpm this week. That's your lowest week ${span}.`,
    },
    {
      id: 'record-hrv', get: (d: DailyRecord) => d.hrv, better: 'max' as const, answer: ctx.answers.bestHrvWeek,
      title: (yet: string) => `Your best week of recovery ${yet}`,
      text: (v: number, span: string) => `Your HRV averaged ${v.toFixed(1)} ms this week. That's your highest week ${span}.`,
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
    const answered = def.answer?.rows[0];
    const before = (def.better === 'min' ? answered?.min : answered?.max) ?? null;
    // A year's record once it also beats every stored week in the past year before the window.
    const yearly = before !== null && beats(last, [{ mean: before.value }]);
    const span = pastYear(answered?.first?.date ?? null, ctx.today);
    add({
      ...base, id: def.id, kind: 'milestone', tone: 'good',
      importance: 53, topic: 'records', family: 'recovery', today: 'as-news', news: !prevWasRecord,
      title: def.title(!yearly ? 'in two months' : span === 'in the past year' ? 'in a year' : 'yet'),
      text: def.text(last.mean, yearly ? span : 'in the last two months'),
    });
  }
}

/** Where breathing, temperature and oxygen count as off: the lines their own cards use. */
const OFF = {
  breathing: (z: number) => z >= 1.5,
  warm: (deviationC: number) => deviationC >= 0.5,
  oxygen: (value: number, usual: number) => value <= usual - 1.5,
};

/** Two nights or more of faster breathing. The several-signals card speaks for it when it shows. */
function breathing(ctx: InsightContext, add: Add): void {
  if (ctx.illness) return;
  const nights = nightsAgainstUsual(ctx.days, (d) => d.respiratoryRate, NOISE_FLOOR.respiratoryRate, 7);
  const run = trailingRun(nights, (r) => r.z !== null && OFF.breathing(r.z));
  const last = run[run.length - 1];
  if (run.length < 2 || !isRecent(last.date, ctx.today)) return;
  add({
    ...base, id: 'vitals-breathing-up', kind: 'alert', tone: 'watch', direction: 'up',
    importance: 83, topic: 'breathing', family: 'recovery', today: 'while-true', news: run.length === 2,
    claims: { metric: 'breathing', direction: 'up' }, evidence: run.length,
    title: "You've been breathing faster at night",
    text: `Your breathing rate has been about ${mean(run.map((r) => r.value)).toFixed(1)} breaths a minute for the last ${run.length} nights. It's usually around ${last.baseline!.toFixed(1)}. Hard training, alcohol, heat or a cold on the way can all raise it.`,
  });
}

/** Two nights or more at least 0.5 °C over the device's own baseline. */
function temperature(ctx: InsightContext, add: Add): void {
  if (ctx.illness) return;
  // The device reports the deviation from its own baseline, so the reading is the comparison.
  const nights = nightsAgainstUsual(ctx.days, (d) => d.skinTempDeviationC, 0, 7);
  const run = trailingRun(nights, (r) => OFF.warm(r.value));
  const last = run[run.length - 1];
  if (run.length < 2 || !isRecent(last.date, ctx.today)) return;
  add({
    ...base, id: 'vitals-warm', kind: 'alert', tone: 'watch', direction: 'up',
    importance: 83, topic: 'temperature', family: 'recovery', today: 'while-true', news: run.length === 2,
    claims: { metric: 'temperature', direction: 'up' }, evidence: run.length,
    title: "You've been running warm",
    text: `Your skin temperature has been about ${mean(run.map((r) => r.value)).toFixed(1)} °C above your normal for the last ${run.length} nights. Heat, alcohol, late meals or a cold can all cause this.`,
  });
}

/** Overnight oxygen 1.5 points or more under your usual: on the page, and news on the third night. */
function oxygen(ctx: InsightContext, add: Add): void {
  if (ctx.illness) return;
  const nights = nightsAgainstUsual(ctx.days, (d) => d.spo2?.avg ?? null, NOISE_FLOOR.spo2, 7);
  const run = trailingRun(nights, (r) => r.baseline !== null && OFF.oxygen(r.value, r.baseline));
  const last = run[run.length - 1];
  if (!run.length || !isRecent(last.date, ctx.today)) return;
  const usual = `It's usually around ${last.baseline!.toFixed(1)}%.`;
  add({
    ...base, id: 'vitals-oxygen-lower', kind: 'trend', tone: 'watch', direction: 'down',
    importance: 79, topic: 'oxygen', family: 'recovery', today: run.length >= 3 ? 'as-news' : 'never',
    news: run.length === 3 && last.date === ctx.today,
    claims: { metric: 'oxygen', direction: 'down' }, evidence: run.length,
    title: 'Your oxygen was lower at night',
    text: `${run.length === 1
      ? `Your overnight oxygen was ${last.value.toFixed(1)}% last night.`
      : `Your overnight oxygen averaged ${mean(run.map((r) => r.value)).toFixed(1)}% over the last ${run.length} nights.`} ${usual} You can see these nights in Labs.`,
  });
}

/**
 * A week or more of nights with no overnight signal far from its usual range:
 * beyond two spreads, the "far" bands, or past the oxygen and temperature cards'
 * own lines. A night just outside the shaded band is ordinary; the cards that
 * speak about last night are cautious ones, and the conflict rules let them win.
 */
function allQuiet(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const N = 28;
  const signal = (name: string, get: (d: DailyRecord) => number | null, floor: number, ok: (r: NightReading) => boolean) =>
    ({ name, nights: nightsAgainstUsual(days, get, floor, N), ok });
  const near = (r: NightReading) => r.z === null || Math.abs(r.z) < 2;
  const signals = [
    signal('resting heart rate', (d) => d.restingHr, NOISE_FLOOR.restingHr, near),
    signal('HRV', (d) => d.hrv, NOISE_FLOOR.hrv, near),
    signal('breathing', (d) => d.respiratoryRate, NOISE_FLOOR.respiratoryRate, near),
    signal('oxygen', (d) => d.spo2?.avg ?? null, NOISE_FLOOR.spo2, (r) => r.baseline === null || !OFF.oxygen(r.value, r.baseline)),
    signal('temperature', (d) => d.skinTempDeviationC, 0, (r) => Math.abs(r.value) < 0.5),
  ];
  // A night counts once its resting heart rate or HRV has a usual range to sit in; every signal it has must be inside its own.
  const nights = signals[0].nights.map((_, k) => {
    const core = [signals[0].nights[k], signals[1].nights[k]].find((r) => r !== null && r.z !== null);
    if (!core) return null;
    const seen = signals.filter((sig) => sig.nights[k] !== null);
    return { date: core.date, ok: seen.every((sig) => sig.ok(sig.nights[k]!)), seen: seen.map((sig) => sig.name) };
  });
  const run = trailingRun(nights, (x) => x.ok);
  if (run.length < 7 || !isRecent(run[run.length - 1].date, ctx.today)) return;
  const names = signals.map((sig) => sig.name).filter((name) => run.some((x) => x.seen.includes(name)));
  add({
    ...base, id: 'vitals-all-quiet', kind: 'pattern', tone: 'good',
    importance: 46, topic: 'vitals-steady', family: 'recovery', today: 'never', news: run.length === 7,
    title: 'Everything looks steady',
    text: `Your ${listOf(names)} haven't strayed far from their usual range for ${run.length >= N ? `${N} nights or more` : `${run.length} nights`}.`,
  });
}

/**
 * HRV that varies less than usual from day to day (Plews: a smaller coefficient
 * of variation of ln rMSSD goes with good adaptation). Said as the typical
 * percentage swing around the week's average.
 */
function hrvStability(ctx: InsightContext, add: Add): void {
  const ln = lnHrv(ctx.days);
  const sdOf = (pts: Point[]) => {
    const v = values(pts);
    return v.length >= 5 ? stats(v)!.sd : null;
  };
  const now = sdOf(ln.slice(-7));
  const before = [1, 2, 3, 4, 5, 6, 7].map((k) => sdOf(ln.slice(-7 * (k + 1), -7 * k))).filter((x): x is number => x !== null);
  if (now === null || before.length < 4) return;
  const usual = stats(before)!.median;
  if (usual <= 0 || now > usual * 0.7) return;
  const pct = (sd: number) => Math.max(1, Math.round((Math.exp(sd) - 1) * 100));
  add({
    ...base, id: 'vitals-hrv-stability', kind: 'pattern', tone: 'good',
    importance: 47, topic: 'hrv-stability', family: 'recovery', today: 'never', news: false,
    title: 'Your recovery is steady',
    text: `This week your HRV varied by about ${pct(now)}% around its average. Usually it varies by about ${pct(usual)}%. Steadier HRV often goes with good recovery.`,
  });
}

/** How many nights HRV takes to be back in range after your hardest days of the last 8 weeks. */
function bounceBack(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const done = completedDays(days).slice(-56);
  const azm = done.some((d) => d.zoneMinutes);
  const load = (d: DailyRecord) => (azm ? (d.zoneMinutes ? zoneMins(d) : null) : d.activeMinutes ? briskMins(d) : null);
  const loads = values(series(done, load));
  if (loads.length < 28) return;
  const hardFrom = quantile([...loads].sort((a, b) => a - b), 0.75);
  if (hardFrom < 20) return;
  const hrv = series(days, (d) => d.hrv);
  const inRange = (j: number) => {
    if (hrv[j].value === null) return null;
    const c = compareToBaseline(hrv.slice(0, j + 1), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
    return c.z === null ? null : c.z > -1;
  };
  const nights: number[] = [];
  const offset = days.length - done.length - 1;
  done.forEach((d, k) => {
    const i = offset + k;
    const l = load(d);
    if (l === null || l < hardFrom || i + 3 >= days.length || inRange(i + 1) === null) return;
    const back = [1, 2, 3].find((n) => inRange(i + n) === true);
    nights.push(back ?? 4);
  });
  if (nights.length < 6) return;
  const typical = stats(nights)!.median;
  const unit = azm ? 'active zone minutes' : 'brisk minutes';
  add({
    ...base, id: 'vitals-bounce-back', kind: 'pattern', tone: typical <= 1 ? 'good' : 'neutral',
    importance: 44, topic: 'bounce-back', family: 'recovery', today: 'never', news: false,
    title: typical <= 1 ? 'You bounce back quickly' : 'How quickly you bounce back',
    text: `${typical <= 1
      ? 'After your hardest days, your HRV is usually in its normal range again by the next night.'
      : typical <= 3
        ? `After your hardest days, your HRV usually takes about ${Math.round(typical)} nights to get back to its normal range.`
        : 'After your hardest days, your HRV usually takes more than three nights to get back to its normal range.'} That's based on ${nights.length} days with ${Math.round(hardFrom)} ${unit} or more in the last 8 weeks.`,
  });
}

/** HRV by weekday morning, once six weeks back it and the gap beats night-to-night noise. */
function hrvWeekShape(ctx: InsightContext, add: Add): void {
  const s = series(ctx.days, (d) => d.hrv);
  const ext = weekdayExtremes(s, 6);
  if (!ext) return;
  const v = values(s);
  const noise = stats(v.slice(1).map((x, i) => Math.abs(x - v[i])))?.median ?? null;
  const avg = mean(weekdayMedians(s).map((m) => m.median!));
  const below = Math.round((1 - ext.low.median! / avg) * 100);
  if (noise === null || ext.high.median! - ext.low.median! < noise || below < 5) return;
  add({
    ...base, id: 'vitals-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 43, topic: 'hrv-week', family: 'recovery', today: 'never', news: false,
    title: 'Your recovery has a weekly pattern',
    text: `Your HRV is usually lowest on ${WEEKDAYS[ext.low.weekday]} mornings and highest on ${WEEKDAYS[ext.high.weekday]} mornings. On ${WEEKDAYS[ext.low.weekday]} mornings it's about ${below}% below your weekly average.`,
  });
}

const FITNESS_LEVELS: Record<string, string> = {
  POOR: 'Poor', FAIR: 'Fair', AVERAGE: 'Average', GOOD: 'Good', VERY_GOOD: 'Very good', EXCELLENT: 'Excellent',
};

/** Your VO₂ max, the device's own band for your age, and how it compares with the start of the window. */
function fitnessLevel(ctx: InsightContext, add: Add): void {
  const readings = ctx.days.filter((d) => d.vo2Max !== null);
  const last = readings[readings.length - 1];
  if (!last || daysBetween(last.date, ctx.today) > 30) return;
  const raw = last.cardioFitnessLevel;
  const level = raw ? FITNESS_LEVELS[raw] ?? raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, ' ') : null;
  const first = readings[0];
  const delta = last.vo2Max! - first.vo2Max!;
  const change = Math.abs(delta) >= 0.5 && daysBetween(first.date, last.date) >= 28
    ? ` It's ${Math.abs(delta).toFixed(1)} points ${delta > 0 ? 'higher' : 'lower'} than on ${dayMonth(first.date)}.`
    : '';
  add({
    ...base, id: 'vitals-fitness-level', kind: 'pattern', tone: 'neutral',
    importance: 34, topic: 'vo2', family: 'fitness', today: 'never', news: false,
    title: level ? 'Your cardio fitness for your age' : 'Your cardio fitness',
    text: `Your VO₂ max is ${last.vo2Max!.toFixed(1)}${level ? `, which Google rates as ${level} for your age` : ''}.${change}`,
  });
}

/** Last month, if it had your lowest average resting heart rate on record. */
function calmestMonth(ctx: InsightContext, add: Add): void {
  const best = lastMonthBest(monthsOf(ctx.days, 'restingHr', ctx.answers.restingHrByMonth), ctx.today, 15, 'min');
  if (!best) return;
  add({
    ...base, id: 'vitals-calmest-month', kind: 'milestone', tone: 'good',
    importance: 62, topic: 'best-month-rhr', family: 'monthly-best', today: 'as-news', news: ctx.dom <= 2,
    title: 'Your calmest month',
    text: `Your resting heart rate averaged ${best.value.toFixed(1)} bpm in ${monthName(best.month, ctx.today)}. That's your lowest month ${pastYear(`${best.since}-01`, ctx.today)}.`,
  });
}

/**
 * Your lowest resting heart rate in the past year: on Today the morning it
 * happens, then on the page for a couple of days. It speaks for "Your heart is
 * nicely relaxed". HRV gets no single-night record: a night far above your
 * baseline can follow overload, which is why the battery treats one with
 * suspicion, so HRV is celebrated by the week instead.
 */
function lowestRestingHr(ctx: InsightContext, add: Add): void {
  if (ctx.illness) return;
  const r = dayRecord(ctx.days, ctx.today, 'restingHr', 'min', ctx.answers.lowestRestingHr, { maxAge: 3 });
  if (!r) return;
  const span = pastYear(r.since, ctx.today);
  add({
    ...base, id: 'vitals-lowest-rhr', kind: 'milestone', tone: 'good',
    importance: 70, topic: 'rhr', family: 'recovery', today: 'as-news', news: r.age <= 1,
    title: span === 'in the past year' ? 'Your lowest resting heart rate in a year' : 'Your lowest resting heart rate yet',
    text: `${r.age === 0 ? 'Your resting heart rate was' : `On ${dayMonth(r.date)} your resting heart rate was`} ${Math.round(r.value)} bpm${r.age === 0 ? ' this morning' : ''}, your lowest ${span}. Your previous low was ${Math.round(r.previous)} bpm.`,
  });
}
