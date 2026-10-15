import { daysBetween } from '../../../lib/date';
import { names, t, type MessageKey } from '../../../i18n';
import { formatDayMonthLong, formatFixed, formatList, formatMonth } from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR, compareToBaseline, completedDays, isRecent, periodShift, quantile, series, stats, values, type Point,
} from '../../derive';
import type { HistoryQueries } from '../../history';
import type { InsightContext } from '../context';
import {
  ENTRY_WINDOW, briskMins, entered, heldFor, pastYear, reachesYear, freshEntry, sinceNote, trailingDays, zoneMins,
} from '../helpers';
import {
  dayRecord, lastMonthBest, monthsOf, nightsAgainstUsual, trailingRun, weekdayExtremes, weekdayMedians,
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
      title: t(up ? 'insights.vitals.hrvTrendUp.title' : 'insights.vitals.hrvTrendDown.title'),
      text: t(up ? 'insights.vitals.hrvTrendUp.text' : 'insights.vitals.hrvTrendDown.text', { current: cur, change: rel, previous: prev })
        + (news ? '' : sinceNote(held)),
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
      title: t('insights.vitals.hrvAcuteHigh.title'),
      text: t('insights.vitals.hrvAcuteHigh.text', { value, usual }),
    });
  } else if ((hrv.band === 'below' || hrv.band === 'far-below') && trend !== 'down') {
    const lowNights = trailingDays(days, (d) =>
      d.hrv === null ? null : hrv.baseline !== null && hrv.spread !== null ? d.hrv < hrv.baseline - hrv.spread : null,
    );
    add({
      ...base, id: 'hrv-acute-low', kind: 'alert', tone: 'watch', direction: 'down',
      importance: 85, topic: 'hrv', family: 'recovery', today: 'while-true', news: true, advice: 'rest',
      claims: { metric: 'hrv', direction: 'down' }, evidence: Math.max(1, lowNights),
      title: t('insights.vitals.hrvAcuteLow.title'),
      text: lowNights >= 2
        ? t('insights.vitals.hrvAcuteLow.textRun', { count: lowNights, value, usual })
        : t('insights.vitals.hrvAcuteLow.textSingle', { value, usual }),
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
      title: t(up ? 'insights.vitals.rhrShiftUp.title' : 'insights.vitals.rhrShiftDown.title'),
      text: t(up ? 'insights.vitals.rhrShiftUp.text' : 'insights.vitals.rhrShiftDown.text', {
        average: formatFixed(sh.current!, 1),
        change: formatFixed(Math.abs(sh.delta!), 1),
      }) + (news ? '' : sinceNote(held)),
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
      title: t('insights.vitals.rhrAcuteHigh.title'),
      text: highStreak >= 3
        ? t('insights.vitals.rhrAcuteHigh.textThird', { value, usual })
        : t('insights.vitals.rhrAcuteHigh.text', { value, usual }),
      action: t(highStreak >= 3 ? 'insights.vitals.rhrAcuteHigh.actionThird' : 'insights.vitals.rhrAcuteHigh.action'),
    });
  } else if (recent && rhr.band === 'far-below' && shiftDir !== 'down') {
    add({
      ...base, id: 'rhr-acute-low', kind: 'pattern', tone: 'good',
      importance: 65, topic: 'rhr', family: 'recovery', today: 'never',
      news: entered(days, (w) => compareToBaseline(series(w, (d) => d.restingHr)).band === 'far-below'),
      claims: { metric: 'rhr', direction: 'down' }, evidence: 1,
      title: t('insights.vitals.rhrAcuteLow.title'),
      text: t('insights.vitals.rhrAcuteLow.text', { value, usual }),
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
    title: t(up ? 'insights.vitals.vo2Up.title' : 'insights.vitals.vo2Down.title'),
    text: t(up ? 'insights.vitals.vo2Up.text' : 'insights.vitals.vo2Down.text', {
      change: formatFixed(Math.abs(delta), 1),
      value: formatFixed(last.value!, 1),
    }),
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
      title: 'insights.vitals.recordRhr.title' as const, text: 'insights.vitals.recordRhr.text' as const,
    },
    {
      id: 'record-hrv', get: (d: DailyRecord) => d.hrv, better: 'max' as const, answer: ctx.answers.bestHrvWeek,
      title: 'insights.vitals.recordHrv.title' as const, text: 'insights.vitals.recordHrv.text' as const,
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
    const first = answered?.first?.date ?? null;
    const span = pastYear(first, ctx.today);
    // How far back the record reaches: the two-month window, a full year, or all the history there is.
    const reach = !yearly ? 'twoMonths' : reachesYear(first, ctx.today) ? 'year' : 'yet';
    add({
      ...base, id: def.id, kind: 'milestone', tone: 'good',
      importance: 53, topic: 'records', family: 'recovery', today: 'as-news', news: !prevWasRecord,
      title: t(def.title, { reach }),
      text: t(def.text, { reach, value: formatFixed(last.mean, 1), span }),
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
    title: t('insights.vitals.vitalsBreathingUp.title'),
    text: t('insights.vitals.vitalsBreathingUp.text', {
      rate: formatFixed(mean(run.map((r) => r.value)), 1),
      count: run.length,
      usual: formatFixed(last.baseline!, 1),
    }),
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
    title: t('insights.vitals.vitalsWarm.title'),
    text: t('insights.vitals.vitalsWarm.text', { value: formatFixed(mean(run.map((r) => r.value)), 1), count: run.length }),
  });
}

/** Overnight oxygen 1.5 points or more under your usual: on the page, and news on the third night. */
function oxygen(ctx: InsightContext, add: Add): void {
  if (ctx.illness) return;
  const nights = nightsAgainstUsual(ctx.days, (d) => d.spo2?.avg ?? null, NOISE_FLOOR.spo2, 7);
  const run = trailingRun(nights, (r) => r.baseline !== null && OFF.oxygen(r.value, r.baseline));
  const last = run[run.length - 1];
  if (!run.length || !isRecent(last.date, ctx.today)) return;
  const usual = formatFixed(last.baseline!, 1);
  add({
    ...base, id: 'vitals-oxygen-lower', kind: 'trend', tone: 'watch', direction: 'down',
    importance: 79, topic: 'oxygen', family: 'recovery', today: run.length >= 3 ? 'as-news' : 'never',
    news: run.length === 3 && last.date === ctx.today,
    claims: { metric: 'oxygen', direction: 'down' }, evidence: run.length,
    title: t('insights.vitals.vitalsOxygenLower.title'),
    text: run.length === 1
      ? t('insights.vitals.vitalsOxygenLower.textSingle', { value: formatFixed(last.value, 1), usual })
      : t('insights.vitals.vitalsOxygenLower.textRun', { value: formatFixed(mean(run.map((r) => r.value)), 1), count: run.length, usual }),
  });
}

/** What the all-quiet card calls each overnight signal. */
const SIGNAL_NAMES = {
  restingHr: 'insights.vitals.vitalsAllQuiet.signals.restingHr',
  hrv: 'insights.vitals.vitalsAllQuiet.signals.hrv',
  breathing: 'insights.vitals.vitalsAllQuiet.signals.breathing',
  oxygen: 'insights.vitals.vitalsAllQuiet.signals.oxygen',
  temperature: 'insights.vitals.vitalsAllQuiet.signals.temperature',
} as const satisfies Record<string, MessageKey>;
type Signal = keyof typeof SIGNAL_NAMES;

/**
 * A week or more of nights with no overnight signal far from its usual range:
 * beyond two spreads, the "far" bands, or past the oxygen and temperature cards'
 * own lines. A night just outside the shaded band is ordinary; the cards that
 * speak about last night are cautious ones, and the conflict rules let them win.
 */
function allQuiet(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  const N = 28;
  const signal = (name: Signal, get: (d: DailyRecord) => number | null, floor: number, ok: (r: NightReading) => boolean) =>
    ({ name, nights: nightsAgainstUsual(days, get, floor, N), ok });
  const near = (r: NightReading) => r.z === null || Math.abs(r.z) < 2;
  const signals = [
    signal('restingHr', (d) => d.restingHr, NOISE_FLOOR.restingHr, near),
    signal('hrv', (d) => d.hrv, NOISE_FLOOR.hrv, near),
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
    title: t('insights.vitals.vitalsAllQuiet.title'),
    text: t(run.length >= N ? 'insights.vitals.vitalsAllQuiet.textOrMore' : 'insights.vitals.vitalsAllQuiet.text', {
      signals: formatList(names.map((name) => t(SIGNAL_NAMES[name]))),
      // Alone, a signal is named: the sentence agrees with it.
      only: names.length === 1 ? names[0] : 'several',
      count: Math.min(run.length, N),
    }),
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
    title: t('insights.vitals.vitalsHrvStability.title'),
    text: t('insights.vitals.vitalsHrvStability.text', { now: pct(now), usual: pct(usual) }),
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
  // Back by the next night, within a few nights, or longer.
  const pace = typical <= 1 ? 'quick' : typical <= 3 ? 'few' : 'slow';
  add({
    ...base, id: 'vitals-bounce-back', kind: 'pattern', tone: typical <= 1 ? 'good' : 'neutral',
    importance: 44, topic: 'bounce-back', family: 'recovery', today: 'never', news: false,
    title: t('insights.vitals.vitalsBounceBack.title', { pace }),
    text: t('insights.vitals.vitalsBounceBack.text', {
      pace,
      nights: Math.round(typical),
      unit: azm ? 'zone' : 'brisk',
      days: nights.length,
      minutes: Math.round(hardFrom),
    }),
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
  // The mornings by name, Sunday first, as the language says them ("Monday mornings").
  const mornings = names('insights.vitals.vitalsWeekShape.mornings');
  add({
    ...base, id: 'vitals-week-shape', kind: 'pattern', tone: 'neutral',
    importance: 43, topic: 'hrv-week', family: 'recovery', today: 'never', news: false,
    title: t('insights.vitals.vitalsWeekShape.title'),
    text: t('insights.vitals.vitalsWeekShape.text', {
      low: mornings[(ext.low.weekday + 1) % 7],
      high: mornings[(ext.high.weekday + 1) % 7],
      below,
    }),
  });
}

const FITNESS_LEVELS: Record<string, MessageKey> = {
  POOR: 'insights.vitals.vitalsFitnessLevel.levels.poor',
  FAIR: 'insights.vitals.vitalsFitnessLevel.levels.fair',
  AVERAGE: 'insights.vitals.vitalsFitnessLevel.levels.average',
  GOOD: 'insights.vitals.vitalsFitnessLevel.levels.good',
  VERY_GOOD: 'insights.vitals.vitalsFitnessLevel.levels.veryGood',
  EXCELLENT: 'insights.vitals.vitalsFitnessLevel.levels.excellent',
};

/** Your VO₂ max, the device's own band for your age, and how it compares with the start of the window. */
function fitnessLevel(ctx: InsightContext, add: Add): void {
  const readings = ctx.days.filter((d) => d.vo2Max !== null);
  const last = readings[readings.length - 1];
  if (!last || daysBetween(last.date, ctx.today) > 30) return;
  const raw = last.cardioFitnessLevel;
  const known = raw ? FITNESS_LEVELS[raw] : undefined;
  // A band the language file doesn't name yet reads as the API spells it, in sentence case.
  const level = known ? t(known) : raw ? raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, ' ') : null;
  const first = readings[0];
  const delta = last.vo2Max! - first.vo2Max!;
  const change = Math.abs(delta) >= 0.5 && daysBetween(first.date, last.date) >= 28
    ? t('insights.vitals.vitalsFitnessLevel.change', {
      direction: delta > 0 ? 'up' : 'down',
      change: formatFixed(Math.abs(delta), 1),
      date: formatDayMonthLong(first.date),
    })
    : '';
  add({
    ...base, id: 'vitals-fitness-level', kind: 'pattern', tone: 'neutral',
    importance: 34, topic: 'vo2', family: 'fitness', today: 'never', news: false,
    title: t('insights.vitals.vitalsFitnessLevel.title', { rated: !!level }),
    text: t('insights.vitals.vitalsFitnessLevel.text', { rated: !!level, value: formatFixed(last.vo2Max!, 1), level }) + change,
  });
}

/** Last month, if it had your lowest average resting heart rate on record. */
function calmestMonth(ctx: InsightContext, add: Add): void {
  const best = lastMonthBest(monthsOf(ctx.days, 'restingHr', ctx.answers.restingHrByMonth), ctx.today, 15, 'min');
  if (!best) return;
  add({
    ...base, id: 'vitals-calmest-month', kind: 'milestone', tone: 'good',
    importance: 62, topic: 'best-month-rhr', family: 'monthly-best', today: 'as-news', news: ctx.dom <= 2,
    title: t('insights.vitals.vitalsCalmestMonth.title'),
    text: t('insights.vitals.vitalsCalmestMonth.text', {
      value: formatFixed(best.value, 1),
      month: formatMonth(best.month, ctx.today),
      span: pastYear(`${best.since}-01`, ctx.today),
    }),
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
    title: t('insights.vitals.vitalsLowestRhr.title', { reach: reachesYear(r.since, ctx.today) ? 'year' : 'yet' }),
    text: t('insights.vitals.vitalsLowestRhr.text', {
      when: r.age === 0 ? 'today' : 'earlier',
      date: formatDayMonthLong(r.date),
      value: Math.round(r.value),
      span,
      previous: Math.round(r.previous),
    }),
  });
}
