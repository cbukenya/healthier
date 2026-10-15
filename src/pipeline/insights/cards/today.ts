import { addDays, daysBetween, isoWeekdayIndex } from '../../../lib/date';
import { t, type MessageKey } from '../../../i18n';
import {
  capitalize, formatDayMonthLong, formatDuration, formatFixed, formatHoursDecimal, formatList, formatRounded,
} from '../../../i18n/format';
import type { DailyRecord } from '../../../types/health';
import { readiness, series, sleepRegularity, stats, values, type Readiness, type ReadinessPartId } from '../../derive';
import { dipping, entropyShift, illnessDates, nocturnalTachycardia, sdbScreen } from '../../labs';
import type { InsightContext } from '../context';
import { CHARGED, COAST_BELOW, ENTRY_WINDOW, beforeLatestMorning, briskMins, entered, zoneMins } from '../helpers';
import type { Finding } from '../types';

type Add = (f: Finding) => void;
type ReadinessPart = Readiness['parts'][number];

/**
 * Cards about the whole day rather than one page: the body battery, the
 * several-signals pattern, the week and month in review and the Labs
 * reminders. They live on Today and nowhere else.
 */
export function todayCards(ctx: InsightContext, add: Add): void {
  battery(ctx, add);
  weeklyReview(ctx, add);
  monthlyReview(ctx, add);
  labsReminders(ctx, add);
}

/** Where a reason goes: after "the main reason is that" or "mostly because", or standing as a sentence. */
type ReasonForm = 'because' | 'statement';

/**
 * Each battery part's reason in both forms. Many languages order a clause's words differently after
 * "because" than in a sentence of its own, so each form has a message.
 */
const REASONS = {
  sleep: { because: 'insights.today.reasons.sleep.because', statement: 'insights.today.reasons.sleep.statement' },
  sleepDebt: { because: 'insights.today.reasons.sleepDebt.because', statement: 'insights.today.reasons.sleepDebt.statement' },
  hrv: { because: 'insights.today.reasons.hrv.because', statement: 'insights.today.reasons.hrv.statement' },
  restingHr: { because: 'insights.today.reasons.restingHr.because', statement: 'insights.today.reasons.restingHr.statement' },
  breathing: { because: 'insights.today.reasons.breathing.because', statement: 'insights.today.reasons.breathing.statement' },
  skinTemp: { because: 'insights.today.reasons.skinTemp.because', statement: 'insights.today.reasons.skinTemp.statement' },
  strain: { because: 'insights.today.reasons.strain.because', statement: 'insights.today.reasons.strain.statement' },
} as const satisfies Record<ReadinessPartId, Record<ReasonForm, MessageKey>>;

/** A battery part as a plain clause, in the form its sentence needs: "you slept 5h 50m compared to your 7h 20m need". */
function reason(p: ReadinessPart, ctx: InsightContext, form: ReasonForm): string {
  const low = p.contribution < 0;
  switch (p.id) {
    case 'sleep': {
      // The battery scores sleep only when last night is in the window, so it is the night here too.
      const n = ctx.lastNight!;
      return t(REASONS.sleep[form], {
        night: low ? 'short' : n.minutesAsleep >= ctx.need ? 'enough' : 'underNeed',
        slept: formatDuration(n.minutesAsleep),
        need: ctx.needH,
      });
    }
    case 'sleepDebt':
      return ctx.debt && ctx.debt.netMin > 0
        ? t(REASONS.sleepDebt[form], { balance: 'short', hours: formatHoursDecimal(ctx.debt.netMin) })
        : t(REASONS.sleepDebt[form], { balance: 'extra' });
    case 'hrv':
      return t(REASONS.hrv[form], { direction: low ? 'lower' : 'higher' });
    case 'restingHr':
      return t(REASONS.restingHr[form], { direction: low ? 'higher' : 'lower' });
    case 'breathing':
      return t(REASONS.breathing[form]);
    case 'skinTemp':
      return t(REASONS.skinTemp[form]);
    case 'strain':
      return t(REASONS.strain[form]);
  }
}

function battery(ctx: InsightContext, add: Add): void {
  const { rNow, rPrev, topPos, topNeg, prevDays } = ctx;
  if (rNow.score === null) return;

  if (ctx.illness) {
    // The pattern outranks and replaces the single-signal cards. It's a multi-signal DEVIATION
    // detector, not an illness classifier: heavy training, alcohol, heat, short sleep, travel and
    // cycle effects all produce it, so it names the deviation and offers illness as one reason.
    const day2 = ctx.illnessBefore;
    add({
      id: 'illness-pattern', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
      importance: 95, topic: 'illness', family: 'recovery', today: 'while-true', news: !day2, advice: 'rest',
      title: t('insights.today.illnessPattern.title'),
      text: t(day2 ? 'insights.today.illnessPattern.textSecondMorning' : 'insights.today.illnessPattern.text'),
      action: t('insights.today.illnessPattern.action'),
    });
  }

  if (rNow.score < COAST_BELOW) {
    // Escalates with the run of low mornings, counted on the mornings before this one.
    const lowDays = rPrev.score !== null && rPrev.score < COAST_BELOW
      ? (readiness(beforeLatestMorning(prevDays), ctx.goals.sleepNeed).score ?? 99) < COAST_BELOW ? 3 : 2
      : 1;
    const why = topNeg && topNeg.contribution < 0 ? reason(topNeg, ctx, 'because') : null;
    add({
      id: 'battery-low', domain: 'body', page: 'today', kind: 'alert', tone: 'watch',
      importance: 82, topic: 'battery', family: 'recovery', today: 'while-true', news: lowDays === 1, advice: 'rest',
      title: t('insights.today.batteryLow.title'),
      text: t('insights.today.batteryLow.text', {
        score: rNow.score, hasReason: why ? 'yes' : 'no', reason: why ?? '', thirdLowMorning: lowDays >= 3 ? 'yes' : 'no',
      }),
      action: ctx.part === 'morning' ? t('insights.today.batteryLow.action') : undefined,
    });
  } else if (
    rNow.score >= CHARGED && topPos !== null && topPos.contribution > 0 &&
    entered(ctx.days, (w) => (readiness(w, ctx.goals.sleepNeed).score ?? 0) >= CHARGED)
  ) {
    const why = rNow.parts.filter((p) => p.contribution > 0).slice(0, 2).map((p) => reason(p, ctx, 'statement'));
    add({
      id: 'battery-green', domain: 'body', page: 'today', kind: 'nudge', tone: 'good',
      importance: 74, topic: 'battery', family: 'recovery', today: 'while-true', news: true, advice: 'push', daypart: ['morning'],
      title: t('insights.today.batteryGreen.title'),
      text: t('insights.today.batteryGreen.text', { score: rNow.score, reasons: capitalize(formatList(why)) }),
      action: t('insights.today.batteryGreen.action'),
    });
  }

  if (rPrev.score !== null && rNow.confidence !== 'low' && rPrev.confidence !== 'low') {
    const move = rNow.score - rPrev.score;
    if (move >= 8) {
      const why = topPos && topPos.contribution > 0 ? reason(topPos, ctx, 'because') : null;
      add({
        id: 'battery-recharge', domain: 'body', page: 'today', kind: 'trend', tone: 'good', direction: 'up',
        importance: 57, topic: 'battery', family: 'recovery', today: 'while-true', news: true,
        title: t('insights.today.batteryRecharge.title'),
        text: t('insights.today.batteryRecharge.text', { from: rPrev.score, to: rNow.score, hasReason: why ? 'yes' : 'no', reason: why ?? '' }),
      });
    } else if (move <= -8) {
      const why = topNeg && topNeg.contribution < 0 ? reason(topNeg, ctx, 'because') : null;
      add({
        id: 'battery-drain', domain: 'body', page: 'today', kind: 'alert', tone: 'watch', direction: 'down',
        importance: 81, topic: 'battery', family: 'recovery', today: 'while-true', news: true,
        title: t('insights.today.batteryDrain.title'),
        text: t('insights.today.batteryDrain.text', { from: rPrev.score, to: rNow.score, hasReason: why ? 'yes' : 'no', reason: why ?? '' }),
      });
    }
  }
}

/**
 * Monday mornings: last week, Monday to Sunday, against the week before. Only
 * measures with 5 or more days of readings get a sentence, and the card needs
 * two of them.
 */
function weeklyReview(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  if (isoWeekdayIndex(today) !== 0) return;
  const monday = addDays(today, -7);
  const week = days.filter((d) => d.date >= monday && d.date < today);
  const before = days.filter((d) => d.date >= addDays(monday, -7) && d.date < monday);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sentences: string[] = [];
  // The first sentence opens with "Last week"; the ones after it don't repeat it, and bring the space
  // before them in their own words, so a language that writes none between sentences can leave it out.
  const opening = () => (sentences.length ? 'later' : 'first');

  // Steps always come first, so their sentence always opens with "Last week".
  const steps = values(series(week, (d) => d.steps));
  const stepsBefore = values(series(before, (d) => d.steps));
  if (steps.length >= 5) {
    const avg = mean(steps);
    // A week before with no steps at all has nothing to compare with.
    const pct = stepsBefore.length >= 5 && mean(stepsBefore) > 0 ? Math.round((avg / mean(stepsBefore) - 1) * 100) : null;
    sentences.push(t('insights.today.weeklyReview.steps', {
      change: pct === null ? 'none' : Math.abs(pct) < 3 ? 'same' : pct > 0 ? 'more' : 'fewer',
      steps: Math.round(avg),
      percent: Math.abs(pct ?? 0),
    }));
  }

  // Movement and sleep share a sentence: a message for each mix of the two.
  const azm = week.some((d) => d.zoneMinutes);
  const moved = week.filter((d) => (azm ? d.zoneMinutes : d.activeMinutes));
  const nights = week.filter((d) => d.sleep).map((d) => d.sleep!.minutesAsleep);
  const minutes = moved.length >= 5 ? Math.round(week.reduce((a, d) => a + (azm ? zoneMins(d) : briskMins(d)), 0)) : null;
  const sleep = nights.length >= 5 ? formatDuration(mean(nights)) : null;
  if (minutes !== null) {
    const key = sleep === null
      ? (azm ? 'insights.today.weeklyReview.zone' : 'insights.today.weeklyReview.brisk')
      : (azm ? 'insights.today.weeklyReview.zoneAndSleep' : 'insights.today.weeklyReview.briskAndSleep');
    sentences.push(t(key, { opening: opening(), minutes, sleep }));
  } else if (sleep !== null) {
    sentences.push(t('insights.today.weeklyReview.sleep', { opening: opening(), sleep }));
  }

  // HRV and weight are clauses of their own, listed in one sentence.
  const tail: string[] = [];
  const hrv = values(series(week, (d) => d.hrv));
  const weeksBefore = days.filter((d) => d.date >= addDays(monday, -28) && d.date < monday);
  const usual = stats(values(series(weeksBefore, (d) => d.hrv)));
  if (hrv.length >= 5 && usual && usual.n >= 14) {
    const pct = (mean(hrv) / usual.median - 1) * 100;
    const level = Math.abs(pct) < 3 ? 'usual'
      : Math.abs(pct) < 8 ? (pct > 0 ? 'littleAbove' : 'littleBelow')
        : pct > 0 ? 'above' : 'below';
    tail.push(t('insights.today.weeklyReview.hrv', { level }));
  }
  const kg = values(series(week, (d) => d.weightKg));
  const kgBefore = values(series(before, (d) => d.weightKg));
  if (kg.length >= 2 && kgBefore.length >= 2) {
    const change = mean(kg) - mean(kgBefore);
    if (Math.abs(change) >= 0.2) {
      tail.push(t('insights.today.weeklyReview.weight', { direction: change < 0 ? 'lower' : 'higher', kg: formatFixed(Math.abs(change), 1) }));
    }
  }
  if (tail.length) sentences.push(t('insights.today.weeklyReview.hrvAndWeight', { clauses: capitalize(formatList(tail)) }));

  if (sentences.length < 2) return;
  add({
    id: 'weekly-review', domain: 'data', page: 'today', kind: 'review', tone: 'neutral',
    importance: 50, topic: 'weekly-review', family: 'review', today: 'while-true', news: true, daypart: ['morning'],
    title: t('insights.today.weeklyReview.title'),
    text: sentences.join(''),
  });
}

/** The first two days of the month: the last 30 days against the 30 before, for metrics with real coverage. */
function monthlyReview(ctx: InsightContext, add: Add): void {
  const { days } = ctx;
  if (ctx.dom > 2 || days.length < 55) return;
  const lastMonth = days.slice(-31, -1);
  const priorMonth = days.slice(-62, -31);
  const bits: string[] = [];

  const stepA = stats(values(series(lastMonth, (d) => d.steps)));
  const stepB = stats(values(series(priorMonth, (d) => d.steps)));
  if (stepA && stepB && stepA.n >= 14 && stepB.n >= 14 && stepB.mean > 0) {
    const pct = Math.round(((stepA.mean - stepB.mean) / stepB.mean) * 100);
    bits.push(t('insights.today.monthlyLedger.steps', { change: pct === 0 ? 'same' : pct > 0 ? 'more' : 'less', percent: Math.abs(pct) }));
  }
  const rhrA = stats(values(series(lastMonth, (d) => d.restingHr)));
  const rhrB = stats(values(series(priorMonth, (d) => d.restingHr)));
  if (rhrA && rhrB && rhrA.n >= 14 && rhrB.n >= 14) {
    const delta = rhrA.mean - rhrB.mean;
    bits.push(t('insights.today.monthlyLedger.restingHr', {
      change: Math.abs(delta) < 0.1 ? 'steady' : delta < 0 ? 'down' : 'up',
      bpm: formatFixed(Math.abs(delta), 1),
    }));
  }
  const sriA = sleepRegularity(lastMonth);
  const sriB = sleepRegularity(priorMonth);
  if (sriA && sriB) bits.push(t('insights.today.monthlyLedger.regularity', { from: sriB.score, to: sriA.score }));

  if (bits.length >= 2) {
    add({
      id: 'monthly-ledger', domain: 'data', page: 'today', kind: 'review', tone: 'neutral',
      importance: 48, topic: 'monthly', family: 'review', today: 'as-news', news: true,
      title: t('insights.today.monthlyLedger.title'),
      text: t('insights.today.monthlyLedger.text', { changes: formatList(bits) }),
    });
  }
}

/**
 * One plain card per Labs pattern, as it appears and then once a month while
 * it lasts. Wording: describe what was observed with everyday explanations;
 * never name a condition or imply screening (Healthier is not a medical device).
 */
function labsReminders(ctx: InsightContext, add: Add): void {
  const { days, today } = ctx;
  const monthStart = ctx.dom <= 2;

  const sdb = sdbScreen(days);
  if (sdb.status === 'pattern') {
    add({
      id: 'labs-sdb-pattern', domain: 'sleep', page: 'today', kind: 'alert', tone: 'watch',
      importance: 93, topic: 'labs-sdb', family: 'labs', today: 'as-news',
      news: entered(days, (w) => sdbScreen(w).status === 'pattern') || monthStart,
      title: t('insights.today.labsSdbPattern.title'),
      text: t('insights.today.labsSdbPattern.text', { count: sdb.firedCount }),
      action: t('insights.today.labsSdbPattern.action'),
    });
  }

  const ent = entropyShift(days);
  if (ent.status === 'shift' && !ctx.illness) {
    add({
      id: 'labs-entropy-shift', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
      importance: 87, topic: 'labs-entropy', family: 'labs', today: 'as-news',
      news: entered(days, (w) => entropyShift(w).status === 'shift'),
      title: t('insights.today.labsEntropyShift.title'),
      // A shift always has both figures. labs.ts rounds them to two decimals; they read as they come: 2.1, not 2.10.
      text: t('insights.today.labsEntropyShift.text', {
        count: ent.shiftNights, lastNight: formatRounded(ent.lastNight!, 3), usual: formatRounded(ent.baselineMedian!, 3),
      }),
      action: t('insights.today.labsEntropyShift.action'),
    });
  }

  if (ctx.intraday) {
    const intraday = ctx.intraday;
    const sick = illnessDates(days, ctx.judged);
    const dip = dipping(days, intraday, sick);
    if (dip.status === 'pattern') {
      add({
        id: 'labs-dip-pattern', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
        importance: 91, topic: 'labs-dip', family: 'labs', today: 'as-news',
        news: entered(days, (w: DailyRecord[]) => dipping(w, intraday, sick).status === 'pattern') || monthStart,
        title: t('insights.today.labsDipPattern.title'),
        text: t('insights.today.labsDipPattern.text', {
          higherAtNight: dip.riser ? 'yes' : 'no',
          under: dip.nightsUnder10,
          measured: dip.measurableNights,
          illnessLeftOut: dip.excludedIllnessNights > 0 ? 'yes' : 'no',
        }),
        action: t('insights.today.labsDipPattern.action'),
      });
    }

    const tachy = nocturnalTachycardia(days, intraday);
    const fresh = tachy.events.filter((e) => daysBetween(e.date, today) <= ENTRY_WINDOW + 1);
    if (fresh.length) {
      const e = fresh[fresh.length - 1];
      const recur = tachy.events.length >= 2;
      add({
        id: 'labs-tachy-event', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
        importance: 94, topic: 'labs-tachy', family: 'labs', today: 'as-news', news: true,
        title: t('insights.today.labsTachyEvent.title'),
        text: t('insights.today.labsTachyEvent.text', {
          session: e.sessionType,
          date: formatDayMonthLong(e.date),
          minutes: e.durationMin,
          peak: e.peakBpm,
          recurring: recur ? 'yes' : 'no',
          count: tachy.events.length,
          nights: tachy.nightsScanned,
        }),
        action: recur ? t('insights.today.labsTachyEvent.action') : undefined,
      });
    }
  }
}
