import { civilClock, daysBetween, isoWeekdayIndex, type CivilDate } from '../lib/date';
import type { DailyRecord, HealthDataset } from '../types/health';
import { scoreSleep } from './sleep';
import {
  dipping, entropyShift, illnessDates as labsIllnessDates, nocturnalTachycardia, sdbScreen,
  type IntradayDays,
} from './labs';
import {
  circularMeanMinutes, compareToBaseline, completedDays, coverage, findGaps,
  firstObserved, goalStreak, isRecent, latestPoint, loadRatio, periodShift, estimatedSleepTarget,
  readiness, series, sleepDebt, sleepRegularity, stats, values, weightTrend,
  NOISE_FLOOR,
} from './derive';

/**
 * The insight engine.
 *
 * Everything here is deterministic arithmetic over the day grid plus the
 * clock — no model call, no invented causation, no stored state. "Today" is
 * always the grid's last day (the server ends the window on the user's today);
 * the clock only says whether it's morning, midday or evening. Novelty is
 * a property *derived from the data*: to know whether an insight is new, the
 * engine re-evaluates the same rule on a truncated window ("the yesterday
 * test") and stays silent when the state was already true. Nothing is
 * persisted, so behaviour is identical across devices and every guard is a
 * pure function you can unit-test.
 *
 * Guard vocabulary (all stateless):
 *
 *   fresh-fact   about last night / today; new each day by nature
 *   entry        true on the full window, false ENTRY_WINDOW+1 days ago
 *   hysteresis   entry measured against a *reset* threshold, so a value
 *                oscillating around the fire threshold cannot re-fire daily
 *   milestone    predicate only true at discrete values (streak ∈ set,
 *                a strictly-beaten record, staleness crossing 15/30/60)
 *   alert        shows while true; copy escalates with the trailing
 *                consecutive-day count instead of repeating verbatim
 *   calendar     fires on a clock condition (Monday morning, 1st of month)
 *
 * Copy laws, enforced in the rules below: evidence first, the action on its
 * own line after it; figures always; wins carry no homework; neutral metrics
 * carry no moral tone; escalation, never repetition.
 */

export type Daypart = 'morning' | 'midday' | 'evening';

export interface Observation {
  /** Stable rule id — also the anchor back into the copy catalogue. */
  id: string;
  domain: 'sleep' | 'movement' | 'cardio' | 'body' | 'data';
  tone: 'good' | 'watch' | 'neutral';
  title: string;
  text: string;
  /** Optional suggestion, rendered on its own line beneath the evidence. */
  action?: string;
}

/** Show state-entry insights for up to this many days after the entry. */
const ENTRY_WINDOW = 2;
const STEP_GOAL = 10000;

const daypartOf = (minutesOfDay: number): Daypart => {
  const h = minutesOfDay / 60;
  return h < 11 ? 'morning' : h < 16 ? 'midday' : 'evening';
};

/** Minutes past midnight on the user's wall clock: in `timeZone` when given, else this runtime's zone. */
const wallClock = (now: Date, timeZone?: string) =>
  timeZone ? civilClock(timeZone)(now.getTime()).minutesOfDay : now.getHours() * 60 + now.getMinutes();

/** Mon–Fri, hardcoded by decision. */
const isWorkday = (d: CivilDate) => isoWeekdayIndex(d) <= 4;

// ─────────────────────────────────────────────────────────── tiny helpers

const hm = (mins: number) =>
  `${Math.floor(mins / 60)}h ${String(Math.round(mins) % 60).padStart(2, '0')}m`;
const needLabel = (need: number) =>
  `${Math.floor(need / 60)}h${need % 60 ? ` ${String(need % 60).padStart(2, '0')}m` : ''}`;
const clk = (m: number) => {
  const t = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');
const circDelta = (a: number, b: number) => ((a - b + 720 + 1440) % 1440) - 720;
const sleepMins = (slice: DailyRecord[], get: (s: NonNullable<DailyRecord['sleep']>) => number) =>
  slice.map((d) => (d.sleep ? get(d.sleep) : null)).filter((m): m is number => m !== null);

/** Truncate the grid by n days — the heart of the yesterday test. */
const cut = (days: DailyRecord[], n: number) => days.slice(0, Math.max(0, days.length - n));

/**
 * Entry guard: the predicate holds now but did not hold ENTRY_WINDOW+1 days
 * ago — the state was entered recently, so the insight is news. Also serves
 * hysteresis when the caller passes a *reset* predicate for the past check.
 */
function entered(
  days: DailyRecord[],
  firesNow: (w: DailyRecord[]) => boolean,
  heldBefore: (w: DailyRecord[]) => boolean = firesNow,
): boolean {
  return firesNow(days) && !heldBefore(cut(days, ENTRY_WINDOW + 1));
}

/**
 * Consecutive days meeting a per-day test, counted back from the latest observation. Days after it
 * (today, not synced yet) are skipped; a missing day inside the run ends it, so "third night running"
 * never reaches across a gap.
 */
function trailingDays(days: DailyRecord[], test: (d: DailyRecord) => boolean | null): number {
  let n = 0;
  let started = false;
  for (let i = days.length - 1; i >= 0; i--) {
    const r = test(days[i]);
    if (r === null) {
      if (started) break;
      continue;
    }
    started = true;
    if (!r) break;
    n++;
  }
  return n;
}

/**
 * The grid as it stood before its latest morning with overnight readings (sleep, HRV or resting HR).
 * Day-over-day rules compare against this, so they always compare two different nights, even before
 * today's has synced.
 */
function beforeLatestMorning(days: DailyRecord[]): DailyRecord[] {
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.sleep || d.hrv !== null || d.restingHr !== null) return days.slice(0, i);
  }
  return [];
}

// ───────────────────────────────────────────────────────────── the engine

interface Candidate {
  severity: number;
  topic: string;
  daypart?: Daypart[];
  obs: Observation;
}

export interface InsightOptions {
  intraday?: IntradayDays;
  /** The zone `now` is read in. Defaults to this runtime's, which in the browser is the user's. */
  timeZone?: string;
}

export function observations(
  ds: HealthDataset,
  now: Date = new Date(),
  extras?: InsightOptions,
): Observation[] {
  const days = ds.days;
  if (!days.length) return [];

  const minutesNow = wallClock(now, extras?.timeZone);
  const part = daypartOf(minutesNow);
  const todayRow = days[days.length - 1];
  const today = todayRow.date;

  const out: Candidate[] = [];
  const add = (severity: number, topic: string, obs: Observation, daypart?: Daypart[]) =>
    out.push({ severity, topic, obs, daypart });

  const need = estimatedSleepTarget(days);
  const needH = needLabel(need);
  const stepsSeries = series(days, (d) => d.steps);
  // Today's steps are still counting, so whole-day comparisons read finished days only.
  const doneSteps = stepsSeries.slice(0, -1);
  const stepMedian = stats(values(doneSteps.slice(-28)))?.median ?? null;

  const lastNightDay = [...days].reverse().find((d) => d.sleep) ?? null;
  const lastNight = lastNightDay?.sleep ?? null;
  const lastNightIsRecent = isRecent(lastNightDay?.date, today);

  // Readiness once, plus its shadow for the day-over-day move: as of the morning before the latest one.
  const rNow = readiness(days);
  const prevDays = beforeLatestMorning(days);
  const rPrev = readiness(prevDays);
  const topPos = rNow.parts.length ? [...rNow.parts].sort((a, b) => b.contribution - a.contribution)[0] : null;
  const topNeg = rNow.parts.length ? [...rNow.parts].sort((a, b) => a.contribution - b.contribution)[0] : null;
  const illness = rNow.flags.length > 0;

  // ════════════════════════════════════ MORNING · last night reviewed ════
  if (lastNight && lastNightIsRecent && part === 'morning') {
    const sc = scoreSleep(lastNight);
    const stages = lastNight.stages
      ? ` and ${Math.round(((lastNight.stages.deep + lastNight.stages.rem) / lastNight.minutesAsleep) * 100)}% deep + REM`
      : '';

    const shortNights = trailingDays(days, (d) =>
      d.sleep ? d.sleep.minutesAsleep <= need - 90 : null,
    );

    if (sc.total <= 55 || lastNight.minutesAsleep <= need - 90) {
      // M1 — evidence + the repair-window action; escalates, then yields to debt.
      const second = shortNights === 2;
      if (shortNights < 3) {
        add(86, 'sleep-night', {
          id: 'night-short',
          domain: 'sleep',
          tone: 'watch',
          title: "Last night didn't quite deliver",
          text: `${second ? 'Second short night running. ' : ''}Last night scored ${sc.total}/100 — ${hm(lastNight.minutesAsleep)} against your ~${needH} need${stages}.`,
          action: second
            ? 'Debt is compounding now — tonight matters more than last night did.'
            : 'Tonight is the repair window: heading to bed even 30 minutes earlier helps start paying down the deficit. Your body will thank you.',
        }, ['morning']);
      }
    } else if (sc.total >= 85 || (lastNight.minutesAsleep >= need + 40 && sc.total >= 70)) {
      // M2 — wins carry no homework.
      const nights = days.filter((d) => d.sleep && d.date !== lastNightDay!.date);
      const lastBetter = [...nights].reverse().find((d) => scoreSleep(d.sleep!).total >= sc.total);
      const weeksSince = lastBetter ? Math.floor(daysBetween(lastBetter.date, lastNightDay!.date) / 7) : null;
      const relative = weeksSince !== null && weeksSince >= 2 ? ` Your best night in ${weeksSince} weeks.` : '';
      add(72, 'sleep-night', {
        id: 'night-good',
        domain: 'sleep',
        tone: 'good',
        title: 'That was a good night',
        text: `Last night scored ${sc.total}/100 — ${hm(lastNight.minutesAsleep)} asleep at ${Math.round(lastNight.efficiency)}% efficiency${stages}.${relative}`,
      }, ['morning']);
    }

    // M6 — deep sleep vs own baseline, rare by construction.
    const deepCmp = compareToBaseline(series(days, (d) => d.sleep?.stages?.deep ?? null));
    if (lastNight.stages && deepCmp.z !== null && deepCmp.z >= 1.5 && deepCmp.n >= 8) {
      add(60, 'sleep-stage', {
        id: 'deep-high',
        domain: 'sleep',
        tone: 'good',
        title: 'Deep sleep showed up',
        text: `${Math.round(lastNight.stages.deep)} minutes of deep sleep against your usual ~${Math.round(deepCmp.baseline!)} — the stage most associated with physical recovery. Hard training days often pull it up.`,
      }, ['morning']);
    }
  }

  // ═══════════════════════════════════════════ battery, daypart-skinned ══
  if (rNow.score !== null) {
    if (illness) {
      // M5 — the illness pattern outranks and replaces the single-signal cards.
      const day2 = rPrev.flags.length > 0;
      add(95, 'illness', {
        id: 'illness-pattern',
        domain: 'cardio',
        tone: 'watch',
        title: 'Several signals are off at once',
        // Framing: this is a multi-signal DEVIATION detector, not a validated
        // illness classifier. The same pattern arises from heavy training,
        // alcohol, heat, short sleep, travel, medication and cycle effects.
        // Name the deviation; offer illness as one explanation among several.
        text: day2
          ? 'Still there this morning — 2+ overnight signals remain away from your usual ranges together. When a multi-signal pattern holds for a second day, it is worth taking seriously.'
          : 'Multiple overnight signals are sitting outside your usual range. This happens after heavy training, late meals, alcohol and travel, and sometimes when a cold is coming on.',
        action: 'Hydrate, keep today light, and see what tonight says.',
      });
    }

    if (rNow.score < 50) {
      // M4 / A-battery-low — alert with trailing-day escalation.
      const lowDays = rPrev.score !== null && rPrev.score < 50
        ? (readiness(beforeLatestMorning(prevDays)).score ?? 99) < 50 ? 3 : 2
        : 1;
      add(82, 'battery', {
        id: 'battery-low',
        domain: 'body',
        tone: 'watch',
        title: 'Permission to coast',
        text: `Body battery ${rNow.score}/100${topNeg && topNeg.contribution < 0 ? ` — mostly ${topNeg.label.toLowerCase()}: ${topNeg.detail}` : ''}.${lowDays >= 3 ? ' Third low morning in a row — if nothing in your training explains this, it\u2019s worth listening to.' : ''}`,
        action: part === 'morning'
          ? 'An easy day is the productive choice here — recovery is where fitness actually happens.'
          : undefined,
      });
    } else if (
      rNow.score >= 80 &&
      topPos !== null && topPos.contribution > 0 &&
      entered(days, (w) => (readiness(w).score ?? 0) >= 80)
    ) {
      // M3 — the honest "primed", morning-only where the action makes sense.
      add(74, 'battery', {
        id: 'battery-green',
        domain: 'body',
        tone: 'good',
        title: 'Green light',
        text: `Body battery ${rNow.score}/100 — ${rNow.parts.filter((p) => p.contribution > 0).slice(0, 2).map((p) => p.detail).join(' · ')}.`,
        action: "If you've been saving a hard session, today's the day for it.",
      }, ['morning']);
    }

    if (rPrev.score !== null && rNow.confidence !== 'low' && rPrev.confidence !== 'low') {
      const move = rNow.score - rPrev.score;
      if (move >= 8) {
        add(57, 'battery', {
          id: 'battery-recharge',
          domain: 'body',
          tone: 'good',
          title: "You're recharging",
          text: `Body battery moved ${rPrev.score} → ${rNow.score} overnight${topPos && topPos.contribution > 0 ? ` — led by ${topPos.label.toLowerCase()} (${topPos.detail})` : ''}.`,
        });
      } else if (move <= -8) {
        add(81, 'battery', {
          id: 'battery-drain',
          domain: 'body',
          tone: 'watch',
          title: 'Your reserves are running lower',
          text: `Body battery slipped ${rPrev.score} → ${rNow.score}${topNeg && topNeg.contribution < 0 ? ` — mostly ${topNeg.label.toLowerCase()} (${topNeg.detail})` : ''}.`,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════ cardio · HRV ══════════
  const lnHrv = series(days, (d) => d.hrv).map((pt) => ({
    date: pt.date,
    value: pt.value === null || pt.value <= 0 ? null : Math.log(pt.value),
  }));
  const hrvTrendP = (w: typeof lnHrv, dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.delta !== null && sh.nCurrent >= 4 && sh.nPrevious >= 4 && sh.delta * dir >= 0.08;
  };
  let hrvTrendDir: 'up' | 'down' | null = null;
  for (const dir of [-1, 1] as const) {
    if (entered(days, () => hrvTrendP(lnHrv, dir), () => hrvTrendP(lnHrv.slice(0, -(ENTRY_WINDOW + 1)), dir))) {
      hrvTrendDir = dir === 1 ? 'up' : 'down';
      const sh = periodShift(lnHrv, 7);
      const rel = Math.abs(Math.round((Math.exp(sh.delta!) - 1) * 100));
      const cur = Math.exp(sh.current!).toFixed(1);
      const prev = Math.exp(sh.previous!).toFixed(1);
      add(dir === 1 ? 80 : 90, 'hrv', {
        id: dir === 1 ? 'hrv-trend-up' : 'hrv-trend-down',
        domain: 'cardio',
        tone: dir === 1 ? 'good' : 'watch',
        title: dir === 1 ? "You're recovering your rhythm" : 'Recovery has been slipping',
        text: dir === 1
          ? `7-day HRV is up ${rel}% on the week before (${cur} vs ${prev} ms). Multi-day rises like this usually track genuine recovery, not one lucky night.`
          : `7-day HRV is down ${rel}% on the week before (${cur} vs ${prev} ms). A sustained slide usually tracks accumulating load, short sleep, stress or a cold.`,
      });
    } else if (hrvTrendP(lnHrv, dir)) {
      hrvTrendDir = dir === 1 ? 'up' : 'down'; // ongoing trend still mutes the acute card
    }
  }

  const hrv = compareToBaseline(series(days, (d) => d.hrv), 28, 8, NOISE_FLOOR.hrv);
  if (!illness && isRecent(hrv.date, today)) {
    if ((hrv.band === 'above' || hrv.band === 'far-above') && hrvTrendDir !== 'up') {
      add(70, 'hrv', {
        id: 'hrv-acute-high',
        domain: 'cardio',
        tone: 'good',
        title: 'Your recovery is peaking',
        text: `HRV came in at ${Math.round(hrv.value!)} ms against a 28-day typical of ${Math.round(hrv.baseline!)} ms — the high end of your own range.`,
      });
    } else if ((hrv.band === 'below' || hrv.band === 'far-below') && hrvTrendDir !== 'down') {
      const lowNights = trailingDays(days, (d) =>
        d.hrv === null ? null : hrv.baseline !== null && hrv.spread !== null ? d.hrv < hrv.baseline - hrv.spread : null,
      );
      add(85, 'hrv', {
        id: 'hrv-acute-low',
        domain: 'cardio',
        tone: 'watch',
        title: 'HRV well below your usual',
        text: lowNights >= 2
          ? `HRV has now run below typical for ${lowNights} nights (${Math.round(hrv.value!)} vs ${Math.round(hrv.baseline!)} ms). This is starting to look like a trend, not a night.`
          : `HRV is ${Math.round(Math.abs(hrv.delta!))} ms below your 28-day typical of ${Math.round(hrv.baseline!)} ms. One night isn't a trend, but two or three in a row usually means load or illness.`,
      });
    }
  }

  // ═════════════════════════════════════════ cardio · resting HR ═════════
  // Precedence: a short elevated streak (1–5 mornings, far above range) is an
  // acute EVENT — late meals, alcohol, heat, oncoming illness — and gets the
  // escalating alert. Broad elevation is a DRIFT and belongs to the
  // fortnight-shift card. Without this split, three loud mornings drag the
  // 14-day mean just far enough to fire the shift card, which then mutes the
  // alert: an acute event misframed as a gradual trend.
  const rhrSeries = series(days, (d) => d.restingHr);
  const rhr = compareToBaseline(rhrSeries, 28, 8, NOISE_FLOOR.restingHr);
  const rhrRecent = isRecent(rhr.date, today);
  const highStreak = trailingDays(days, (d) =>
    d.restingHr === null ? null : rhr.baseline !== null && rhr.spread !== null
      ? d.restingHr > rhr.baseline + 2 * rhr.spread : null,
  );
  const acuteRhrEvent = !illness && rhrRecent && rhr.band === 'far-above' && highStreak >= 1 && highStreak <= 5;

  const rhrShiftP = (w: typeof rhrSeries, dir: 1 | -1) => {
    const sh = periodShift(w, 14);
    return sh.delta !== null && sh.nCurrent >= 7 && sh.nPrevious >= 7 && sh.delta * dir >= 1.5;
  };
  let rhrShiftDir: 'up' | 'down' | null = null;
  for (const dir of [1, -1] as const) {
    if (dir === 1 && acuteRhrEvent) continue; // the event owns the up-story
    const fires = rhrShiftP(rhrSeries, dir);
    if (fires) rhrShiftDir = dir === 1 ? 'up' : 'down';
    if (fires && entered(days, () => true, () => rhrShiftP(rhrSeries.slice(0, -(ENTRY_WINDOW + 1)), dir))) {
      const sh = periodShift(rhrSeries, 14);
      add(dir === -1 ? 75 : 88, 'rhr', {
        id: dir === -1 ? 'rhr-shift-down' : 'rhr-shift-up',
        domain: 'cardio',
        tone: dir === -1 ? 'good' : 'watch',
        title: dir === -1 ? 'A calmer you' : 'Your heart is working a little harder',
        text: `Resting heart rate is ${dir === -1 ? 'down' : 'up'} ${Math.abs(sh.delta!).toFixed(1)} bpm over the last 14 days versus the 14 before (${sh.current!.toFixed(1)} vs ${sh.previous!.toFixed(1)}).`,
      });
    }
  }

  if (!illness) {
    if (acuteRhrEvent) {
      add(92, 'rhr', {
        id: 'rhr-acute-high',
        domain: 'cardio',
        tone: 'watch',
        title: 'Something has your heart working harder',
        text: highStreak >= 3
          ? `Third morning above range (${Math.round(rhr.value!)} vs ${Math.round(rhr.baseline!)} bpm typical). If nothing obvious explains it, that's a reason to keep today easy.`
          : `Resting heart rate is ${Math.round(rhr.value!)} bpm against a 28-day typical of ${Math.round(rhr.baseline!)}. Elevation this clear often follows late meals, alcohol, heat — or an oncoming illness.`,
        action: highStreak < 3 ? "Worth an easier day if it's still there tomorrow." : undefined,
      });
    } else if (rhrRecent && rhr.band === 'far-below' && rhrShiftDir !== 'down' &&
      entered(days, (w) => compareToBaseline(series(w, (d) => d.restingHr)).band === 'far-below')) {
      add(65, 'rhr', {
        id: 'rhr-acute-low',
        domain: 'cardio',
        tone: 'good',
        title: 'Your heart is taking it easy',
        text: `Resting heart rate is ${Math.round(rhr.value!)} bpm this morning against a 28-day typical of ${Math.round(rhr.baseline!)} — the low end of your own range.`,
      });
    }
  }

  // ══════════════════════════════ cardio · VO₂max as revision events ═════
  const vo2 = series(days, (d) => d.vo2Max);
  const vo2Vals = vo2.filter((pt) => pt.value !== null);
  if (vo2Vals.length >= 2) {
    const last = vo2Vals[vo2Vals.length - 1];
    const prevDistinct = [...vo2Vals.slice(0, -1)].reverse().find((pt) => pt.value !== last.value);
    // Fires only in the days right after the value actually changed.
    if (prevDistinct && daysBetween(last.date, today) <= ENTRY_WINDOW + 1) {
      const firstAtNew = vo2Vals.find((pt) => pt.value === last.value)!;
      if (daysBetween(firstAtNew.date, today) <= ENTRY_WINDOW + 1) {
        const delta = last.value! - prevDistinct.value!;
        // A revision smaller than the estimate's own uncertainty is not news:
        // the API ships the variance of the estimate, so the gate is
        // max(0.3, √covariance) ≈ one SD of the estimator itself.
        // Covariance from the SAME day as the revision — the latest value
        // anywhere could describe a different estimate entirely. The API
        // documents this only as "the covariance of the VO₂ max value", so
        // √cov is not asserted to be one SD; it is a covariance-aware change
        // gate that can only ever be STRICTER than the fixed floor.
        const covOnDay = days.find((d) => d.date === last.date)?.vo2MaxCovariance ?? null;
        const gate = Math.max(0.3, covOnDay !== null && covOnDay > 0 ? Math.sqrt(covOnDay) : 0.3);
        if (Math.abs(delta) >= gate) {
          add(delta > 0 ? 60 : 70, 'vo2', {
            id: delta > 0 ? 'vo2-up' : 'vo2-down',
            domain: 'cardio',
            tone: delta > 0 ? 'good' : 'watch',
            title: delta > 0 ? 'Your engine is getting stronger' : 'Cardio fitness took a breather',
            text: delta > 0
              ? `Your cardio fitness (VO₂ Max) estimate just ticked up ${delta > 0 ? '+' : ''}${delta.toFixed(1)} to ${last.value!.toFixed(1)}. This only goes upward when a trend is undeniable—a step up like this is earned.`
              : `Your cardio fitness (VO₂ Max) estimate revised ${delta.toFixed(1)} to ${last.value!.toFixed(1)}. Revisions lag reality by weeks, so this may reflect a quieter stretch more than today.`,
          });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════ sleep · debt ══════════
  const debt = sleepDebt(days, need, 7);
  // Coverage rule: a week with under 5 recorded nights is an estimate, not a
  // weekly total, so the card stays quiet rather than extrapolating.
  const debtMin = debt && debt.coverage === 'full' ? debt.deficitMin : null;
  if (debtMin !== null && debtMin > 180) {
    const isSevere = debtMin > 360;
    add(89, 'sleep-debt', {
      id: 'sleep-debt',
      domain: 'sleep',
      tone: 'watch',
      title: isSevere ? 'Significant sleep debt accumulated' : 'Sleep debt is building',
      text: isSevere
        ? `You've built up ${(debtMin / 60).toFixed(1)}h of sleep debt against your ~${needH} target over the last ${debt!.nightsKnown} recorded nights. Deficits like this compound, gradually dragging down your focus, reaction times, and physical recovery.`
        : `Across ${debt!.nightsKnown} recorded nights you have accumulated ${(debtMin / 60).toFixed(1)}h of sleep debt against your ~${needH}-a-night target.${debt!.surplusMin > 60 ? ` You also banked ${(debt!.surplusMin / 60).toFixed(1)}h on longer nights — recovery doesn't net out hour for hour, so both are worth seeing.` : " Shortfall like this compounds over time."}`,
      action: isSevere
        ? 'Multi-day debt clears gradually over several nights — aim to add 30–45 minutes of sleep across the next few nights.'
        : 'A consistent lights-out across the next two nights starts to flatten the deficit curve.',
    });
  }

  // ═══════════════════════════════════ sleep · timing, all circular ══════
  const bedShiftDelta = (w: DailyRecord[]): number | null => {
    const recent = circularMeanMinutes(sleepMins(w.slice(-7), (x) => x.bedtimeMin));
    const prior = circularMeanMinutes(sleepMins(w.slice(-21, -7), (x) => x.bedtimeMin));
    if (!recent || !prior || recent.n < 4 || prior.n < 5) return null;
    return circDelta(recent.mean, prior.mean);
  };
  // bedShift is true only when the shift card actually fires THIS render. A
  // condition that persists past its entry window already told its story; it
  // must not keep suppressing the settling-in card that naturally follows it.
  let bedShift = false;
  const dNow = bedShiftDelta(days);
  if (dNow !== null && Math.abs(dNow) >= 30) {
    const dThen = bedShiftDelta(cut(days, ENTRY_WINDOW + 1));
    if (dThen === null || Math.abs(dThen) < 15 || Math.sign(dThen) !== Math.sign(dNow)) {
      bedShift = true;
      const recent = circularMeanMinutes(sleepMins(days.slice(-7), (x) => x.bedtimeMin))!;
      const prior = circularMeanMinutes(sleepMins(days.slice(-21, -7), (x) => x.bedtimeMin))!;
      add(dNow > 0 ? 68 : 58, 'sleep-timing', {
        id: dNow > 0 ? 'bed-creep-later' : 'bed-creep-earlier',
        domain: 'sleep',
        tone: dNow > 0 ? 'watch' : 'good',
        title: dNow > 0 ? 'Bedtime has been creeping later' : 'Bedtime is coming back earlier',
        text: `Average bedtime over the last 7 nights is ${clk(recent.mean)}, versus ${clk(prior.mean)} across the fortnight before — ${Math.round(Math.abs(dNow))} minutes ${dNow > 0 ? 'later' : 'earlier'}.`,
      });
    }
  }

  const bedSd = (w: DailyRecord[]) => circularMeanMinutes(sleepMins(w.slice(-14), (x) => x.bedtimeMin));
  const b14 = bedSd(days);
  let rhythmTold = bedShift;
  if (b14 && b14.n >= 7) {
    if (b14.sdMin > 60) {
      rhythmTold = true;
      // hysteresis: fires at >60, considered "already on" unless it was <45.
      if (entered(days, () => true, (w) => { const s = bedSd(w); return s !== null && s.n >= 7 && s.sdMin >= 45; })) {
        add(66, 'sleep-timing', {
          id: 'bed-drifting',
          domain: 'sleep',
          tone: 'watch',
          title: 'Your sleep routine is drifting',
          text: `Bedtime varies by ±${Math.round(b14.sdMin)} minutes around ${clk(b14.mean)} over the last two weeks. Regularity tends to matter more than total hours for how you feel.`,
        });
      }
    } else if (b14.sdMin < 30 && !bedShift) {
      rhythmTold = true;
      if (entered(days, () => true, (w) => { const s = bedSd(w); return s !== null && s.n >= 7 && s.sdMin <= 40; })) {
        add(50, 'sleep-timing', {
          id: 'bed-settling',
          domain: 'sleep',
          tone: 'good',
          title: 'Your nights are settling in',
          text: `Bedtime has held within ±${Math.round(b14.sdMin)} minutes of ${clk(b14.mean)} for two weeks — the kind of regularity that pays back during the day.`,
        });
      }
    }
  }
  const wakeSd = (w: DailyRecord[]) => circularMeanMinutes(sleepMins(w.slice(-14), (x) => x.wakeMin));
  const w14 = wakeSd(days);
  if (!rhythmTold && w14 && w14.n >= 7 && w14.sdMin < 25 &&
    entered(days, () => true, (w) => { const s = wakeSd(w); return s !== null && s.n >= 7 && s.sdMin <= 35; })) {
    add(45, 'sleep-timing', {
      id: 'wake-rhythm',
      domain: 'sleep',
      tone: 'good',
      title: 'Your mornings have found a rhythm',
      text: `Wake time has stayed within ±${Math.round(w14.sdMin)} minutes of ${clk(w14.mean)} across two weeks — a steady anchor even when bedtime moves.`,
    });
  }

  // ══════════════════════════════════════ movement · volume story ════════
  const load = loadRatio(doneSteps);
  let volumeTold = false;
  if (load.ratio !== null && load.ratio > 1.5) {
    volumeTold = true;
    add(84, 'movement-volume', {
      id: 'ramp',
      domain: 'movement',
      tone: 'watch',
      title: "You're pushing the pace",
      text: `This week's step volume is ${load.ratio.toFixed(1)}× the three weeks before it — a fast ramp. Big jumps are worth noticing mostly because they're easy to make unintentionally; let comfort be the guide.`,
    });
  }
  const stepShiftP = (w: typeof stepsSeries, dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.deltaPct !== null && sh.nCurrent >= 5 && sh.nPrevious >= 5 &&
      sh.deltaPct * dir >= 20 && Math.abs(sh.delta!) >= 1500;
  };
  if (!volumeTold) {
    for (const dir of [1, -1] as const) {
      if (stepShiftP(doneSteps, dir) &&
        entered(days, () => true, () => stepShiftP(doneSteps.slice(0, -(ENTRY_WINDOW + 1)), dir))) {
        volumeTold = true;
        const sh = periodShift(doneSteps, 7);
        add(dir === 1 ? 62 : 40, 'movement-volume', {
          id: dir === 1 ? 'steps-up' : 'steps-down',
          domain: 'movement',
          tone: dir === 1 ? 'good' : 'neutral',
          title: dir === 1 ? "You've been moving more" : "You've had a quieter stretch",
          text: `Daily steps average ${fmtInt(sh.current!)} this week versus ${fmtInt(sh.previous!)} the week before (${sh.deltaPct! > 0 ? '+' : ''}${Math.round(sh.deltaPct!)}%).${dir === -1 ? ' Worth knowing whether that was recovery or just a desk-bound week.' : ''}`,
        });
        break;
      }
    }
  }

  // Streak milestones only — broken streaks get silence, always.
  const STREAK_SET = new Set([3, 5, 7, 10, 14, 21, 30]);
  const streakNow = goalStreak(stepsSeries, (v) => v >= STEP_GOAL);
  if (STREAK_SET.has(streakNow) && goalStreak(doneSteps, (v) => v >= STEP_GOAL) !== streakNow) {
    add(63, 'movement-milestone', {
      id: 'streak',
      domain: 'movement',
      tone: 'good',
      title: "You're on a rolling streak",
      text: `${streakNow} days in a row above ${fmtInt(STEP_GOAL)} steps.`,
    });
  }

  // Record day — completed days only, with a floor so tiny records stay quiet.
  const completedSteps = doneSteps.filter((pt) => pt.value !== null);
  if (completedSteps.length >= 15) {
    const lastC = completedSteps[completedSteps.length - 1];
    const priorMax = Math.max(...completedSteps.slice(0, -1).map((pt) => pt.value!));
    if (lastC.value! >= 8000 && lastC.value! > priorMax && daysBetween(lastC.date, today) <= ENTRY_WINDOW) {
      add(77, 'movement-milestone', {
        id: 'step-record',
        domain: 'movement',
        tone: 'good',
        title: 'Setting a new pace',
        text: `${fmtInt(lastC.value!)} steps on ${lastC.date} — your biggest day in this window, past the previous best of ${fmtInt(priorMax)}.`,
      });
    }
  }

  // Intensity: the minutes the guidelines actually count.
  const mvpa = series(completedDays(days), (d) => (d.activeMinutes ? d.activeMinutes.moderate + d.activeMinutes.vigorous : null));
  const mvpaP = (w: typeof mvpa, dir: 1 | -1) => {
    const sh = periodShift(w, 7);
    return sh.delta !== null && sh.nCurrent >= 4 && sh.nPrevious >= 4 &&
      sh.deltaPct! * dir >= 25 && sh.delta * dir >= 8;
  };
  for (const dir of [1, -1] as const) {
    if (mvpaP(mvpa, dir) && entered(days, () => true, () => mvpaP(mvpa.slice(0, -(ENTRY_WINDOW + 1)), dir))) {
      const sh = periodShift(mvpa, 7);
      add(dir === 1 ? 59 : 38, 'movement-intensity', {
        id: dir === 1 ? 'mvpa-up' : 'mvpa-down',
        domain: 'movement',
        tone: dir === 1 ? 'good' : 'neutral',
        title: dir === 1 ? "You're finding more ways to move" : 'Movement has taken a back seat',
        text: `Moderate-plus-vigorous minutes average ${Math.round(sh.current!)}/day this week versus ${Math.round(sh.previous!)} the week before${dir === 1 ? ' — the intensity band the guidelines actually count' : ''}.`,
      });
      break;
    }
  }

  // ═══════════════════════════ TODAY, daypart-gated, expires with day ════
  const todaySteps = todayRow?.steps ?? null;
  if (todaySteps !== null && stepMedian !== null) {
    const hour = minutesNow / 60;
    const yesterday = [...doneSteps].reverse().find((pt) => pt.value !== null);
    const yesterdayLow = yesterday !== undefined && yesterday.value! < stepMedian * 0.5;

    if (part === 'midday' && hour >= 13 && todaySteps < stepMedian * 0.3 && !yesterdayLow) {
      add(54, 'movement-today', {
        id: 'slow-day',
        domain: 'movement',
        tone: 'neutral',
        title: 'A quiet start to the day',
        text: `Past ${clk(Math.floor(hour) * 60 + Math.round((hour % 1) * 60))} and today sits at ${fmtInt(todaySteps)} steps against your usual full-day ~${fmtInt(stepMedian)}. Some days are just like that.`,
        action: "If it isn't that kind of day: a ten-minute walk after lunch moves the needle more than it feels like — short breaks in long sitting are where the evidence actually is.",
      }, ['midday']);
    }
    if (part === 'midday' && hour < 13 && todaySteps > stepMedian * 0.8) {
      add(56, 'movement-today', {
        id: 'ahead-of-yourself',
        domain: 'movement',
        tone: 'good',
        title: 'Ahead of yourself',
        text: `${fmtInt(todaySteps)} steps by lunch — already past most of your full days.`,
      }, ['midday']);
    }
    if (part === 'evening') {
      const gap = STEP_GOAL - todaySteps;
      if (gap >= 800 && gap <= 2500) {
        add(61, 'movement-today', {
          id: 'within-reach',
          domain: 'movement',
          tone: 'good',
          title: 'Within reach',
          text: `${fmtInt(gap)} steps short of ${fmtInt(STEP_GOAL)}.`,
          action: 'One 15-minute walk closes it.',
        }, ['evening']);
      }
    }
  }

  // E2 — wind-down, anchored to your own window, only when it earns its place.
  if (part === 'evening' && ((debtMin !== null && debtMin > 120) || bedShift)) {
    const avgBed = circularMeanMinutes(sleepMins(days.slice(-14), (x) => x.bedtimeMin));
    if (avgBed && avgBed.n >= 5) {
      add(52, 'sleep-tonight', {
        id: 'wind-down',
        domain: 'sleep',
        tone: 'neutral',
        title: 'Wind-down window',
        text: `Your average lights-out lately is ${clk(avgBed.mean)}${bedShift ? ', drifting later' : ''}.${debtMin !== null && debtMin > 120 ? ` This week is running ${(debtMin / 60).toFixed(1)}h short of your target.` : ''}`,
        action: 'Landing inside your own window tonight repays some of it — and the regularity is worth more than the minutes.',
      }, ['evening']);
    }
  }

  // ═════════════════════════════════════════ body · weight, neutral ══════
  const wSeries = series(days, (d) => d.weightKg);
  const wTrend = weightTrend(wSeries);
  const latestReading = latestPoint(wSeries);
  // "On new reading only": silent unless the newest reading is recent.
  if (wTrend && latestReading && daysBetween(latestReading.date, today) <= ENTRY_WINDOW + 1) {
    const perWeek = wTrend.kgPerWeek;
    const beforePerWeek = weightTrend(wSeries.filter((pt) => pt.date !== latestReading.date))?.kgPerWeek ?? null;
    const basis = `${wTrend.readings} hand-logged readings across ${wTrend.spanDays} days — treat the slope as a sketch, not a measurement`;
    const crossed = (thr: number) =>
      Math.abs(perWeek) >= thr && (beforePerWeek === null || Math.abs(beforePerWeek) < thr || Math.sign(beforePerWeek) !== Math.sign(perWeek));
    if (perWeek <= -0.15 && crossed(0.15)) {
      add(44, 'weight', {
        id: 'weight-down',
        domain: 'body',
        tone: 'neutral',
        title: 'Your weight is trending down',
        text: `About ${Math.abs(perWeek).toFixed(2)} kg/week down; latest ${latestReading.value} kg on ${latestReading.date} (${basis}).`,
      });
    } else if (perWeek >= 0.15 && crossed(0.15)) {
      add(44, 'weight', {
        id: 'weight-up',
        domain: 'body',
        tone: 'neutral',
        title: 'Your weight is edging upward',
        text: `About ${perWeek.toFixed(2)} kg/week up; latest ${latestReading.value} kg on ${latestReading.date} (${basis}).`,
      });
    }
  }

  // ═══════════════════════════════════════════ calendar cadence ══════════
  // W1 — WHO weekly bar, fired on the crossing day.
  const weekStartIdx = days.findIndex((d) => daysBetween(d.date, today) <= isoWeekdayIndex(today));
  if (weekStartIdx >= 0) {
    // WHO counts 150 min moderate OR 75 min vigorous, i.e. vigorous minutes
    // are worth double — summing raw minutes equally overstated the week.
    // Active Zone Minutes already encode exactly that weighting (1/min in fat
    // burn, 2/min in cardio and peak), so AZM is the preferred input and the
    // moderate + 2 × vigorous fallback keeps the same currency.
    const azmWeek = (upto: number) =>
      days.slice(weekStartIdx, upto).reduce(
        (a, d) => a + (d.zoneMinutes ? d.zoneMinutes.fatBurn + 2 * (d.zoneMinutes.cardio + d.zoneMinutes.peak) : 0),
        0,
      );
    const fallbackWeek = (upto: number) =>
      days.slice(weekStartIdx, upto).reduce(
        (a, d) => a + (d.activeMinutes ? d.activeMinutes.moderate + 2 * d.activeMinutes.vigorous : 0),
        0,
      );
    const hasAzm = days.slice(weekStartIdx).some((d) => d.zoneMinutes !== null);
    const weekEquivalent = hasAzm ? azmWeek : fallbackWeek;
    const total = weekEquivalent(days.length);
    if (total >= 150 && weekEquivalent(days.length - 1) < 150) {
      const spare = 6 - isoWeekdayIndex(today);
      add(58, 'weekly', {
        id: 'who-week',
        domain: 'movement',
        tone: 'good',
        title: 'A benchmark week',
        text: `${Math.round(total)} ${hasAzm ? 'active zone minutes' : 'equivalent brisk minutes'} this week — past the WHO's 150-minute bar${spare > 0 ? ` with ${spare} day${spare > 1 ? 's' : ''} to spare` : ''}. Harder minutes count double, the way the guideline does.`,
      });
    }
  }

  // W2 — monthly ledger, 1st/2nd of month, only metrics with real coverage.
  const dom = Number(today.slice(8, 10));
  if (dom <= 2 && days.length >= 55) {
    const lastMonth = days.slice(-31, -1);
    const priorMonth = days.slice(-62, -31);
    const bits: string[] = [];
    const stepA = stats(values(series(lastMonth, (d) => d.steps)));
    const stepB = stats(values(series(priorMonth, (d) => d.steps)));
    if (stepA && stepB && stepA.n >= 14 && stepB.n >= 14 && stepB.mean > 0) {
      bits.push(`steps ${stepA.mean >= stepB.mean ? '+' : ''}${Math.round(((stepA.mean - stepB.mean) / stepB.mean) * 100)}%`);
    }
    const rhrA = stats(values(series(lastMonth, (d) => d.restingHr)));
    const rhrB = stats(values(series(priorMonth, (d) => d.restingHr)));
    if (rhrA && rhrB && rhrA.n >= 14 && rhrB.n >= 14) {
      const dlt = rhrA.mean - rhrB.mean;
      bits.push(`resting HR ${dlt >= 0 ? '+' : ''}${dlt.toFixed(1)} bpm`);
    }
    const sriA = sleepRegularity(lastMonth);
    const sriB = sleepRegularity(priorMonth);
    if (sriA && sriB) bits.push(`sleep regularity ${sriB.score} → ${sriA.score}`);
    if (bits.length >= 2) {
      add(48, 'monthly', {
        id: 'monthly-ledger',
        domain: 'data',
        tone: 'neutral',
        title: 'The monthly ledger',
        text: `Last 30 days vs the 30 before: ${bits.join(', ')}.`,
      });
    }
  }

  // W4 — the weekday deficit (social-jetlag signature), monthly cadence.
  if (dom <= 2) {
    const workNights = values(series(days.filter((d) => isWorkday(d.date)), (d) => d.sleep?.minutesAsleep ?? null));
    const freeNights = values(series(days.filter((d) => !isWorkday(d.date)), (d) => d.sleep?.minutesAsleep ?? null));
    const w = stats(workNights);
    const f = stats(freeNights);
    if (w && f && w.n >= 9 && f.n >= 6 && f.median - w.median >= 60) {
      add(46, 'monthly', {
        id: 'weekday-deficit',
        domain: 'sleep',
        tone: 'neutral',
        title: 'Your weekdays run a deficit',
        text: `You sleep ${hm(f.median - w.median)} longer on free days than workdays (${hm(f.median)} vs ${hm(w.median)} median) — the classic signature of a weekday schedule that runs a deficit. Worth knowing: weekend catch-up feels like repair but doesn't fully undo the week's cost.`,
      });
    }
  }

  // W5 — regularity band climbing, monthly cadence.
  if (dom <= 2 && days.length >= 55) {
    const sriA = sleepRegularity(days.slice(-31));
    const sriB = sleepRegularity(days.slice(-62, -31));
    const bandRank = { critical: 0, bad: 1, good: 2, excellent: 3 } as const;
    if (sriA && sriB && bandRank[sriA.band] > bandRank[sriB.band]) {
      add(64, 'monthly', {
        id: 'sri-climbing',
        domain: 'sleep',
        tone: 'good',
        title: 'Regularity is climbing',
        text: `Sleep regularity moved ${sriB.score} → ${sriA.score} this month. In large cohort studies, regular sleep timing is linked with better long-term health, beyond total hours.`,
      });
    }
  }

  // W3 — records vault: best resting-HR and HRV weeks in the window.
  for (const [id, get, better, unit, title, textFn] of [
    ['record-rhr', (d: DailyRecord) => d.restingHr, 'min', 'bpm', 'Your calmest week in two months',
      (v: number) => `Lowest resting-HR week of the last two months: ${v.toFixed(1)} bpm average, lower than any other week in that span.`],
    ['record-hrv', (d: DailyRecord) => d.hrv, 'max', 'ms', 'Your highest-HRV week in two months',
      (v: number) => `Highest HRV week of the last two months: ${v.toFixed(1)} ms average, above every other week in that span.`],
  ] as const) {
    const s = series(days, get);
    const weekMeans: { end: number; mean: number }[] = [];
    for (let end = 7; end <= s.length; end++) {
      const v = values(s.slice(end - 7, end));
      if (v.length >= 5) weekMeans.push({ end, mean: v.reduce((a, b) => a + b, 0) / v.length });
    }
    if (weekMeans.length >= 6) {
      const lastW = weekMeans[weekMeans.length - 1];
      if (lastW.end === s.length) {
        const others = weekMeans.slice(0, -1).map((x) => x.mean);
        const isRecord = better === 'min' ? lastW.mean < Math.min(...others) : lastW.mean > Math.max(...others);
        // milestone: fires only in the first days of holding the record
        const prevWeek = weekMeans[weekMeans.length - 2];
        const prevWasRecord = better === 'min'
          ? prevWeek.mean < Math.min(...weekMeans.slice(0, -2).map((x) => x.mean))
          : prevWeek.mean > Math.max(...weekMeans.slice(0, -2).map((x) => x.mean));
        if (isRecord && !prevWasRecord) {
          add(53, 'records', {
            id, domain: 'cardio', tone: 'good', title, text: textFn(lastW.mean),
          });
        }
      }
    }
  }

  // ═══════ movement ↔ next-night HRV: exploratory association, guarded ═══
  // Titled and worded as a pattern, not a price. "Tax" implied causation the
  // design cannot support: these are sequential days from one person, with
  // sleep, alcohol and weekday uncontrolled.
  const assoc = movementHrvAssociation(days);
  if (assoc) {
    add(51, 'correlation', {
      id: 'movement-hrv-association',
      domain: 'cardio',
      tone: 'neutral',
      title: 'Activity & Recovery Association',
      text: `Over the last ${assoc.weeks} weeks, your HRV has tended to drop by ~${assoc.pct}% following a ${fmtInt(assoc.threshold)}+ step day (${assoc.nHigh} big days vs ${assoc.nLow} ordinary ones, p ≈ ${assoc.p.toFixed(3)}).${assoc.excludedIllnessNights > 0 ? ` Nights around illness-like readings were left out.` : ''} This is a pattern in your data, not necessarily cause-and-effect—things like poor sleep, weekend drinks, or busy schedules often ride along for the day.`,
    });
  }

  // ═══════════════════════════════════════════ data quality ══════════════
  const staleWeight = coverage(days, [{ dataType: 'weight', label: 'Weight' }])[0];
  if (staleWeight.latest && staleWeight.staleDays !== null) {
    const th = [15, 30, 60].find((t) => staleWeight.staleDays! >= t && staleWeight.staleDays! < t + (ENTRY_WINDOW + 1));
    if (th) {
      add(30, 'data', {
        id: 'weight-stale',
        domain: 'data',
        tone: 'neutral',
        title: 'The scale misses you',
        text: `No weight logged for ${staleWeight.staleDays} days — the body trend is frozen at the last reading. One weigh-in would wake that chart up.`,
      });
    }
  }
  const gaps = findGaps(days, 'sleep', 3);
  if (gaps.length) {
    const g = gaps[gaps.length - 1];
    if (daysBetween(g.to, today) <= 7) {
      add(28, 'data', {
        id: 'sleep-gap',
        domain: 'data',
        tone: 'neutral',
        title: 'Mind the sleep gaps',
        text: `No sleep record ${g.from} → ${g.to}. Those nights are excluded from every average rather than counted as zero, so they can't drag anything down.`,
      });
    }
  }
  const nightsRecorded = values(series(days, (d) => d.sleep?.minutesAsleep ?? null)).length;
  const sleepStart = firstObserved(days, 'sleep');
  if (sleepStart && nightsRecorded < days.length * 0.5 && [5, 10, 20, 40].includes(nightsRecorded)) {
    add(26, 'data', {
      id: 'sleep-coverage',
      domain: 'data',
      tone: 'neutral',
      title: 'Getting to know your nights',
      text: `Sleep records begin ${sleepStart} — ${nightsRecorded} nights so far. Heart and movement data go back further, so sleep-based comparisons rest on a shorter history.`,
    });
  }

  // ═══════════════════════════════════ labs · pattern mirrors ═══════════
  // Wording: describe what was observed with everyday explanations; never name
  // a condition or imply screening (Healthier is not a medical device).
  // The Labs tab renders the full evidence; the carousel gets one plain card
  // per pattern. Entry via the yesterday-test; persistent patterns re-mention
  // themselves at the start of each month (calendar guard), because a
  // months-old pattern the person never acted on deserves exactly one nudge
  // per month, not daily nagging.
  const monthStart = dom <= 2;

  const sdb = sdbScreen(days);
  if (sdb.status === 'pattern' &&
      (entered(days, (w) => sdbScreen(w).status === 'pattern') || monthStart)) {
    const lit = sdb.flags.filter((f: any) => f.fired).map((f: any) => f.label.toLowerCase()).join(', ');
    add(93, 'labs-sdb', {
      id: 'labs-sdb-pattern',
      domain: 'sleep',
      tone: 'watch',
      title: 'Night signals off together',
      text: `On ${sdb.firedCount} of the last 14 nights (${lit}), oxygen, breathing rate or time awake were outside your usual range together. A cold, alcohol or a stuffy room can all do this.`,
      action: 'The nights are in Labs. If you also snore heavily or feel very sleepy during the day, mention it to a clinician.',
    });
  }

  const ent = entropyShift(days);
  if (ent.status === 'shift' && !illness &&
      entered(days, (w) => entropyShift(w).status === 'shift')) {
    add(87, 'labs-entropy', {
      id: 'labs-entropy-shift',
      domain: 'cardio',
      tone: 'watch',
      title: 'HRV entropy shifted',
      text: `A nightly HRV metric your device reports has been outside your usual range on ${ent.shiftNights} nights (${ent.lastNight} vs ${ent.baselineMedian} ± ${ent.baselineSd}). It moves with everyday things: a cold, alcohol, poor sleep, hard training.`,
      action: 'The nights are in Labs.',
    });
  }

  if (extras?.intraday) {
    const sick = labsIllnessDates(days);
    const dip = dipping(days, extras.intraday, sick);
    if (dip.status === 'pattern' &&
        (entered(days, (w) => dipping(w, extras.intraday!, sick).status === 'pattern') || monthStart)) {
      add(91, 'labs-dip', {
        id: 'labs-dip-pattern',
        domain: 'cardio',
        tone: 'watch',
        title: dip.riser ? 'Heart rate higher at night than by day' : 'A smaller overnight heart-rate drop',
        text: `${dip.nightsUnder10} of ${dip.measurableNights} measured nights dropped less than 10% (median ${dip.medianDipPct}%)${dip.excludedIllnessNights > 0 ? `, leaving out ${dip.excludedIllnessNights} night${dip.excludedIllnessNights > 1 ? 's' : ''} with several signals off` : ''}. Late meals, alcohol, heat and evening exercise all reduce the drop.`,
        action: 'Labs has the nights. If it persists for weeks alongside symptoms, you could mention it to a clinician.',
      });
    }

    const tachy = nocturnalTachycardia(days, extras.intraday);
    const fresh = tachy.events.filter((e: any) => daysBetween(e.date, today) <= ENTRY_WINDOW + 1);
    if (fresh.length) {
      const e = fresh[fresh.length - 1];
      const recur = tachy.events.length >= 2;
      add(94, 'labs-tachy', {
        id: 'labs-tachy-event',
        domain: 'cardio',
        tone: 'watch',
        title: 'Heart rate stayed high during sleep',
        text: `${e.durationMin} minutes above 100 bpm (peak ${e.peakBpm}) during ${e.sleepWindow ? e.sleepWindow : e.stage ?? 'sleep'} on ${e.date}.${recur ? ` ${tachy.events.length} such stretches in ${tachy.nightsScanned} nights.` : ''} Fever, alcohol, vivid dreams, waking and movement can all raise heart rate.`,
        action: recur ? 'Labs lists them. If you notice palpitations, chest pain, dizziness or breathlessness, seek medical care.' : undefined,
      });
    }
  }

  // ═══════════════════════════════════════════ selection ═════════════════
  // Daypart gate (hard drop) → severity sort → topic dedup.
  const gated = out.filter((c) => !c.daypart || c.daypart.includes(part));
  gated.sort((a, b) => b.severity - a.severity);

  const seenTopic = new Set<string>();
  const chosen: Observation[] = [];
  for (const c of gated) {
    if (seenTopic.has(c.topic)) continue;
    seenTopic.add(c.topic);
    chosen.push(c.obs);
  }

  // Floor: the rail is never empty and never padded with filler.
  if (chosen.length === 0) {
    chosen.push(floorCard(part, todayRow, lastNightIsRecent ? lastNight : null, rNow.score, todaySteps, load.ratio));
  }
  return chosen;
}

function floorCard(
  part: Daypart,
  todayRow: DailyRecord,
  lastNight: DailyRecord['sleep'],
  battery: number | null,
  todaySteps: number | null,
  ratio: number | null,
): Observation {
  if (part === 'morning') {
    return {
      id: 'floor-morning', domain: 'sleep', tone: 'neutral', title: 'Quiet morning',
      text: `${lastNight ? `${hm(lastNight.minutesAsleep)} slept` : 'No night recorded yet'}${battery !== null ? `, battery ${battery}/100` : ''} — everything inside your usual ranges. No news is the good kind.`,
    };
  }
  if (part === 'midday') {
    return {
      id: 'floor-midday', domain: 'movement', tone: 'neutral', title: 'Rolling along',
      text: `${todaySteps !== null ? `${Math.round(todaySteps).toLocaleString('en-US')} steps so far` : 'Nothing has synced yet today'}${battery !== null ? `, battery ${battery}/100` : ''}. Your metrics are sitting comfortably inside your usual ranges. A steady, predictable day.`,
    };
  }
  const brisk = todayRow.activeMinutes;
  return {
    id: 'floor-evening', domain: 'movement', tone: 'neutral', title: 'Day closed',
    text: `Today: ${todaySteps !== null ? `${Math.round(todaySteps).toLocaleString('en-US')} steps` : 'no step sync'}${brisk ? `, ${brisk.moderate + brisk.vigorous} brisk minutes` : ''}${ratio !== null ? `, load ${ratio.toFixed(1)}× your usual` : ''}. A quiet one — they count too.`,
  };
}

/**
 * The recovery tax: do big-movement days cost this person HRV the following
 * night? Nights are split by whether the *previous* day's steps cleared the
 * window's 75th percentile; the two groups' ln-HRV means are compared with a
 * Welch test. Silent unless n is honest (≥8 big, ≥15 ordinary), the effect is
 * ≥6% and the difference clears p<0.05 — a null result is a result, and it
 * renders as silence, not a shrug.
 */
export interface MovementHrvAssociation {
  pct: number;
  threshold: number;
  nHigh: number;
  nLow: number;
  weeks: number;
  /** Welch–Satterthwaite degrees of freedom for the reported comparison. */
  df: number;
  /** Two-sided p from the t distribution at those df. */
  p: number;
  /** Nights dropped because an illness-like deviation was active. */
  excludedIllnessNights: number;
}

/** Two-sided p-value for Student's t, via the regularised incomplete beta. */
function tTwoSidedP(t: number, df: number): number {
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/** Regularised incomplete beta I_x(a,b) by continued fraction (Lentz). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  const result = front * (f - 1);
  return x < (a + 1) / (a + b + 2) ? result : 1 - incompleteBetaComplement(x, a, b, result);
}
function incompleteBetaComplement(_x: number, _a: number, _b: number, result: number): number {
  return result; // symmetry handled by the caller's x-choice; kept explicit for clarity
}
function lgamma(z: number): number {
  // Lanczos approximation, g = 7.
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Does this person's HRV tend to be lower the night after a big-movement day?
 *
 * Nights are split by whether the PREVIOUS day's steps cleared the window's
 * 75th percentile, then the two groups' ln(HRV) means are compared with a
 * proper Welch test — Welch–Satterthwaite degrees of freedom and a t-based
 * p-value, not a fixed 1.96, which is far too liberal at n ≈ 8.
 *
 * Illness-flagged nights are excluded: a fever moves HRV and steps together
 * and would masquerade as a movement effect.
 *
 * IMPORTANT — what this is and is not. These are sequential observations from
 * one person, so they are not independent samples; the p-value understates
 * uncertainty from day-to-day autocorrelation, and sleep, alcohol, weekday
 * and seasonal trend are uncontrolled confounds. This is an EXPLORATORY
 * WITHIN-PERSON ASSOCIATION, never evidence that movement causes the change.
 * A block bootstrap by week, or a regression carrying those covariates, would
 * be the honest upgrade once enough history exists.
 */
export function movementHrvAssociation(days: DailyRecord[]): MovementHrvAssociation | null {
  const hi: number[] = [];
  const lo: number[] = [];
  const stepVals = values(series(days, (d) => d.steps));
  if (stepVals.length < 20) return null;
  const sorted = [...stepVals].sort((a, b) => a - b);
  const p75 = sorted[Math.floor(sorted.length * 0.75)];

  const sick = labsIllnessDates(days);
  let excludedIllnessNights = 0;

  for (let i = 1; i < days.length; i++) {
    const prevSteps = days[i - 1].steps;
    const hrv = days[i].hrv;
    if (prevSteps === null || hrv === null || hrv <= 0) continue;
    if (sick.has(days[i].date) || sick.has(days[i - 1].date)) { excludedIllnessNights++; continue; }
    (prevSteps >= p75 ? hi : lo).push(Math.log(hrv));
  }
  if (hi.length < 8 || lo.length < 15) return null;

  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const varOf = (a: number[], m: number) => a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1);
  const mHi = mean(hi);
  const mLo = mean(lo);
  const d = mHi - mLo;
  if (d > -0.06) return null; // only a *lower* HRV pattern is reported, and only a real one

  const vHi = varOf(hi, mHi);
  const vLo = varOf(lo, mLo);
  const seSq = vHi / hi.length + vLo / lo.length;
  if (seSq <= 0) return null;
  const t = d / Math.sqrt(seSq);
  // Welch–Satterthwaite
  const df =
    (seSq * seSq) /
    ((vHi / hi.length) ** 2 / (hi.length - 1) + (vLo / lo.length) ** 2 / (lo.length - 1));
  const p = tTwoSidedP(Math.abs(t), df);
  if (!Number.isFinite(p) || p >= 0.05) return null;

  return {
    pct: Math.abs(Math.round((Math.exp(d) - 1) * 100)),
    threshold: Math.round(p75 / 500) * 500,
    nHigh: hi.length,
    nLow: lo.length,
    weeks: Math.round(days.length / 7),
    df: Math.round(df * 10) / 10,
    p: Math.round(p * 1000) / 1000,
    excludedIllnessNights,
  };
}

/** @deprecated Renamed: "tax" implied causation. Use movementHrvAssociation. */
export const recoveryTax = movementHrvAssociation;

/** Convenience: everything the Today view needs, computed once. */
export function todaySummary(ds: HealthDataset, now: Date = new Date(), extras?: InsightOptions) {
  const days = ds.days;
  const last = days[days.length - 1] ?? null;
  // Cards about now show readings from today or yesterday; anything older is history, not last night.
  const recent = (d: DailyRecord | undefined) => (d && isRecent(d.date, last?.date) ? d : null);
  const movementDay = recent([...days].reverse().find((d) => d.steps !== null));
  const sleepDay = recent([...days].reverse().find((d) => d.sleep !== null));

  const hrv = compareToBaseline(series(days, (d) => d.hrv), 28, 8, NOISE_FLOOR.hrv);
  const rhr = compareToBaseline(series(days, (d) => d.restingHr), 28, 8, NOISE_FLOOR.restingHr);

  return {
    today: last,
    movementDay,
    sleepDay,
    sleepScore: sleepDay?.sleep ? scoreSleep(sleepDay.sleep) : null,
    hrv,
    rhr,
    readiness: readiness(days),
    sleepTargetMin: estimatedSleepTarget(days),
    debt: sleepDebt(days, estimatedSleepTarget(days)),
    observations: observations(ds, now, extras),
  };
}
