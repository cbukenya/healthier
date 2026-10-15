import { addDays, daysBetween, isoWeekdayIndex } from '../../../lib/date';
import type { DailyRecord } from '../../../types/health';
import { readiness, series, sleepRegularity, stats, values, type Readiness } from '../../derive';
import { dipping, entropyShift, illnessDates, nocturnalTachycardia, sdbScreen } from '../../labs';
import type { InsightContext } from '../context';
import {
  CHARGED, COAST_BELOW, ENTRY_WINDOW, beforeLatestMorning, briskMins, dayMonth, entered, fmtInt, hm, hoursText, listOf, plural,
  sentence, zoneMins,
} from '../helpers';
import type { Finding } from '../types';

type Add = (f: Finding) => void;
type ReadinessPart = Readiness['parts'][number];

/**
 * Cards about the whole day rather than one page: the body battery, the
 * several-signals pattern, the week and month in review and the Labs
 * reminders. They live on Today and nowhere else.
 */
export function todayRules(ctx: InsightContext, add: Add): void {
  battery(ctx, add);
  weeklyReview(ctx, add);
  monthlyReview(ctx, add);
  labsReminders(ctx, add);
}

/** A battery part as a plain clause: "you slept 5h 50m compared to your 7h 20m need". */
function reason(p: ReadinessPart, ctx: InsightContext): string {
  const low = p.contribution < 0;
  switch (p.id) {
    case 'sleep': {
      const n = ctx.lastNight;
      if (!n) return low ? "last night's sleep was short" : 'you slept well last night';
      if (low) return `you slept ${hm(n.minutesAsleep)} compared to your ${ctx.needH} need`;
      return n.minutesAsleep >= ctx.need ? `you slept ${hm(n.minutesAsleep)}, more than your ${ctx.needH} need` : `you slept ${hm(n.minutesAsleep)}`;
    }
    case 'sleepDebt':
      return ctx.debt && ctx.debt.netMin > 0
        ? `you're ${hoursText(ctx.debt.netMin)} short on sleep this week`
        : "you've had a little extra sleep this week";
    case 'hrv':
      return low ? 'your HRV came in lower than usual' : 'your HRV is higher than usual';
    case 'restingHr':
      return low ? 'your resting heart rate is higher than usual' : 'your resting heart rate is lower than usual';
    case 'breathing':
      return 'your breathing rate is higher than usual';
    case 'skinTemp':
      return 'your skin temperature is running warm';
    case 'strain':
      return "you've had some hard days recently";
    default:
      return p.label.toLowerCase();
  }
}

function battery(ctx: InsightContext, add: Add): void {
  const { rNow, rPrev, topPos, topNeg, prevDays } = ctx;
  if (rNow.score === null) return;

  if (ctx.illness) {
    // The pattern outranks and replaces the single-signal cards. It's a multi-signal DEVIATION
    // detector, not an illness classifier: heavy training, alcohol, heat, short sleep, travel and
    // cycle effects all produce it, so it names the deviation and offers illness as one reason.
    const day2 = rPrev.flags.length > 0;
    add({
      id: 'illness-pattern', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
      importance: 95, topic: 'illness', family: 'recovery', today: 'while-true', news: !day2, advice: 'rest',
      title: 'Several of your signals are off',
      text: day2
        ? 'For a second morning, several of your overnight readings are outside their usual range together. When this lasts more than a day, it is worth taking seriously.'
        : 'Several of your overnight readings are outside their usual range at the same time. This can happen after hard training, a late meal, alcohol or travel, and sometimes when a cold is on the way.',
      action: 'Drink some extra water, keep today light, and see how tonight goes.',
    });
  }

  if (rNow.score < COAST_BELOW) {
    // Escalates with the run of low mornings, counted on the mornings before this one.
    const lowDays = rPrev.score !== null && rPrev.score < COAST_BELOW
      ? (readiness(beforeLatestMorning(prevDays), ctx.goals.sleepNeed).score ?? 99) < COAST_BELOW ? 3 : 2
      : 1;
    const why = topNeg && topNeg.contribution < 0 ? ` The main reason is that ${reason(topNeg, ctx)}.` : '';
    add({
      id: 'battery-low', domain: 'body', page: 'today', kind: 'alert', tone: 'watch',
      importance: 82, topic: 'battery', family: 'recovery', today: 'while-true', news: lowDays === 1, advice: 'rest',
      title: 'Take it easy today',
      text: `Your body battery is ${rNow.score} out of 100.${why}${lowDays >= 3 ? " This is your third low morning in a row. If your training doesn't explain it, it's worth listening to." : ''}`,
      action: ctx.part === 'morning' ? 'An easy day is the right call. Your fitness builds while you recover.' : undefined,
    });
  } else if (
    rNow.score >= CHARGED && topPos !== null && topPos.contribution > 0 &&
    entered(ctx.days, (w) => (readiness(w, ctx.goals.sleepNeed).score ?? 0) >= CHARGED)
  ) {
    const why = rNow.parts.filter((p) => p.contribution > 0).slice(0, 2).map((p) => reason(p, ctx));
    add({
      id: 'battery-green', domain: 'body', page: 'today', kind: 'nudge', tone: 'good',
      importance: 74, topic: 'battery', family: 'recovery', today: 'while-true', news: true, advice: 'push', daypart: ['morning'],
      title: "You're fully charged today",
      text: `Your body battery is ${rNow.score} out of 100. ${sentence(listOf(why))}.`,
      action: "If you've been saving a hard workout, today is a good day for it.",
    });
  }

  if (rPrev.score !== null && rNow.confidence !== 'low' && rPrev.confidence !== 'low') {
    const move = rNow.score - rPrev.score;
    if (move >= 8) {
      add({
        id: 'battery-recharge', domain: 'body', page: 'today', kind: 'trend', tone: 'good', direction: 'up',
        importance: 57, topic: 'battery', family: 'recovery', today: 'while-true', news: true,
        title: 'You recharged overnight',
        text: `Your body battery climbed from ${rPrev.score} to ${rNow.score} overnight${topPos && topPos.contribution > 0 ? `, mostly because ${reason(topPos, ctx)}` : ''}.`,
      });
    } else if (move <= -8) {
      add({
        id: 'battery-drain', domain: 'body', page: 'today', kind: 'alert', tone: 'watch', direction: 'down',
        importance: 81, topic: 'battery', family: 'recovery', today: 'while-true', news: true,
        title: 'Your body battery dropped overnight',
        text: `Your body battery went from ${rPrev.score} to ${rNow.score} overnight.${topNeg && topNeg.contribution < 0 ? ` The main reason is that ${reason(topNeg, ctx)}.` : ''}`,
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
  // The first sentence opens with "Last week"; the ones after it don't repeat it.
  const lead = () => (sentences.length ? 'You' : 'Last week you');

  const steps = values(series(week, (d) => d.steps));
  const stepsBefore = values(series(before, (d) => d.steps));
  if (steps.length >= 5) {
    const avg = mean(steps);
    const pct = stepsBefore.length >= 5 ? Math.round((avg / mean(stepsBefore) - 1) * 100) : null;
    sentences.push(`${lead()} averaged ${fmtInt(avg)} steps a day${pct === null ? '' : Math.abs(pct) < 3 ? ', about the same as the week before' : `, ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'fewer'} than the week before`}.`);
  }

  const azm = week.some((d) => d.zoneMinutes);
  const moved = week.filter((d) => (azm ? d.zoneMinutes : d.activeMinutes));
  const nights = week.filter((d) => d.sleep).map((d) => d.sleep!.minutesAsleep);
  const parts: string[] = [];
  if (moved.length >= 5) {
    const total = Math.round(week.reduce((a, d) => a + (azm ? zoneMins(d) : briskMins(d)), 0));
    parts.push(azm ? `earned ${total} active zone minutes` : `did ${total} minutes of brisk activity`);
  }
  if (nights.length >= 5) parts.push(`slept ${hm(mean(nights))} a night on average`);
  if (parts.length) sentences.push(`${lead()} ${listOf(parts)}.`);

  const tail: string[] = [];
  const hrv = values(series(week, (d) => d.hrv));
  const weeksBefore = days.filter((d) => d.date >= addDays(monday, -28) && d.date < monday);
  const usual = stats(values(series(weeksBefore, (d) => d.hrv)));
  if (hrv.length >= 5 && usual && usual.n >= 14) {
    const pct = (mean(hrv) / usual.median - 1) * 100;
    tail.push(`your HRV was ${Math.abs(pct) < 3 ? 'about usual' : `${Math.abs(pct) < 8 ? 'a little ' : ''}${pct > 0 ? 'above' : 'below'} usual`}`);
  }
  const kg = values(series(week, (d) => d.weightKg));
  const kgBefore = values(series(before, (d) => d.weightKg));
  if (kg.length >= 2 && kgBefore.length >= 2) {
    const change = mean(kg) - mean(kgBefore);
    if (Math.abs(change) >= 0.2) tail.push(`your weigh-ins averaged ${Math.abs(change).toFixed(1)} kg ${change < 0 ? 'lower' : 'higher'} than the week before`);
  }
  if (tail.length) sentences.push(`${sentence(listOf(tail))}.`);

  if (sentences.length < 2) return;
  add({
    id: 'weekly-review', domain: 'data', page: 'today', kind: 'review', tone: 'neutral',
    importance: 50, topic: 'weekly-review', family: 'review', today: 'while-true', news: true, daypart: ['morning'],
    title: 'Your week in review',
    text: sentences.join(' '),
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
    bits.push(pct === 0 ? 'you walked about the same' : `you walked ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'}`);
  }
  const rhrA = stats(values(series(lastMonth, (d) => d.restingHr)));
  const rhrB = stats(values(series(priorMonth, (d) => d.restingHr)));
  if (rhrA && rhrB && rhrA.n >= 14 && rhrB.n >= 14) {
    const delta = rhrA.mean - rhrB.mean;
    bits.push(Math.abs(delta) < 0.1
      ? 'your resting heart rate held steady'
      : `your resting heart rate ${delta < 0 ? 'dropped' : 'rose'} by ${Math.abs(delta).toFixed(1)} bpm`);
  }
  const sriA = sleepRegularity(lastMonth);
  const sriB = sleepRegularity(priorMonth);
  if (sriA && sriB) bits.push(`your sleep regularity score went from ${sriB.score} to ${sriA.score}`);

  if (bits.length >= 2) {
    add({
      id: 'monthly-ledger', domain: 'data', page: 'today', kind: 'review', tone: 'neutral',
      importance: 48, topic: 'monthly', family: 'review', today: 'as-news', news: true,
      title: 'How this month compared',
      text: `Compared with the 30 days before, ${listOf(bits)}.`,
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
      title: 'A pattern in your breathing at night',
      text: `On ${sdb.firedCount} of the last 14 nights, your oxygen, breathing rate and time awake were outside their usual range together. A cold, alcohol or a stuffy room can all do this.`,
      action: 'You can see those nights in Labs. If you also snore heavily or feel very sleepy during the day, mention it to a clinician.',
    });
  }

  const ent = entropyShift(days);
  if (ent.status === 'shift' && !ctx.illness) {
    add({
      id: 'labs-entropy-shift', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
      importance: 87, topic: 'labs-entropy', family: 'labs', today: 'as-news',
      news: entered(days, (w) => entropyShift(w).status === 'shift'),
      title: 'Your HRV entropy has shifted',
      text: `A nightly HRV measure from your device has been outside its usual range for ${plural(ent.shiftNights, 'night')} in a row. Last night it was ${ent.lastNight}, and it's usually around ${ent.baselineMedian}. It moves with everyday things like a cold, alcohol, poor sleep or hard training.`,
      action: 'You can see the nights in Labs.',
    });
  }

  if (ctx.intraday) {
    const intraday = ctx.intraday;
    const sick = illnessDates(days);
    const dip = dipping(days, intraday, sick);
    if (dip.status === 'pattern') {
      add({
        id: 'labs-dip-pattern', domain: 'cardio', page: 'today', kind: 'alert', tone: 'watch',
        importance: 91, topic: 'labs-dip', family: 'labs', today: 'as-news',
        news: entered(days, (w: DailyRecord[]) => dipping(w, intraday, sick).status === 'pattern') || monthStart,
        title: "Your heart rate isn't dropping much at night",
        text: `${dip.riser ? 'Your heart rate has been higher at night than during the day. ' : ''}On ${dip.nightsUnder10} of ${dip.measurableNights} measured nights, your heart rate dropped less than 10% from its daytime level.${dip.excludedIllnessNights > 0 ? ' Nights with several signals off were left out.' : ''} Late meals, alcohol, heat and evening exercise can all reduce the drop.`,
        action: 'Labs has the nights. If it lasts for weeks and you have symptoms, you could mention it to a clinician.',
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
        title: 'Your heart rate went above 100 during sleep',
        text: `On ${dayMonth(e.date)}, your heart rate stayed above 100 bpm for ${e.durationMin} minutes during ${e.sessionType === 'nap' ? 'a nap' : 'your night’s sleep'}, peaking at ${e.peakBpm}.${recur ? ` That's ${tachy.events.length} stretches like this in ${tachy.nightsScanned} nights.` : ''} Fever, alcohol, vivid dreams, waking up and moving can all raise your heart rate.`,
        action: recur ? 'Labs lists them. If you notice palpitations, chest pain, dizziness or breathlessness, seek medical care.' : undefined,
      });
    }
  }
}
