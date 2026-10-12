import type { DailyRecord, IntradaySample, SleepSession } from '../types/health';
import { series, compareToBaseline, stats, values } from './derive';
import { formatCivil, formatClock, addDays } from '../lib/date';
import type { SyncResult } from './sync';

export function calculateOffSignals(days: DailyRecord[], index: number): number {
  const slice = days.slice(0, index + 1);
  const rhr = compareToBaseline(series(slice, d => d.restingHr), 28, 8);
  const resp = compareToBaseline(series(slice, d => d.respiratoryRate));
  const tempDev = slice[slice.length - 1].skinTempDeviationC;
  const hrvSeries = series(slice, (d) => {
    const v = d.hrvDeepSleep ?? d.hrv;
    return v && v > 0 ? Math.log(v) : null;
  });

  let offSignals = 0;
  if (rhr.z !== null && rhr.n >= 8 && rhr.z >= 1.5) offSignals++;
  if (resp.z !== null && resp.n >= 8 && resp.z >= 1.5) offSignals++;
  if (tempDev !== null && tempDev >= 0.5) offSignals++;
  
  const hrvZ = compareToBaseline(hrvSeries, 28, 8);
  if (hrvZ.z !== null && hrvZ.n >= 8 && hrvZ.z <= -1.5) offSignals++;
  
  return offSignals;
}

export function illnessDates(days: DailyRecord[]): Set<string> {
  const dates = new Set<string>();
  for (let i = 28; i < days.length; i++) {
    const offSignals = calculateOffSignals(days, i);
    if (offSignals >= 2) {
      dates.add(days[i].date);
    }
  }
  return dates;
}

export type IntradayDays = Record<string, IntradaySample[]>;

export function completedIntradayDays(intraday: IntradayDays): string[] {
  return Object.keys(intraday).filter((k) => intraday[k] && intraday[k].length > 60); // At least an hour of samples
}

/**
 * Day-to-night heart-rate drop over the last 30 finished days.
 *
 * A night counts only when its daytime side was measured: an hour or more of
 * minute-level heart rate between 08:00 and 20:00. A stand-in daytime figure
 * would be shown as if it had been measured. Today is left out (its daytime is
 * half done), and nights with several signals off at once are left out of every
 * figure, by default here, so the card and the insight agree.
 */
export function dipping(days: DailyRecord[], intraday: IntradayDays, sick: Set<string> = illnessDates(days)) {
  const window = days.slice(0, -1).slice(-30);
  const nights: { date: string; dayMean: number; nightMean: number; dip: number }[] = [];
  let excludedIllnessNights = 0;
  for (const d of window) {
    if (d.nonRemHr === null) continue;
    const daytime = (intraday[d.date] ?? []).filter((s) => s.minutesOfDay >= 8 * 60 && s.minutesOfDay <= 20 * 60);
    if (daytime.length <= 60) continue;
    if (sick.has(d.date)) {
      excludedIllnessNights++;
      continue;
    }
    const dayMean = daytime.reduce((a, s) => a + s.value, 0) / daytime.length;
    nights.push({ date: d.date, dayMean: Math.round(dayMean), nightMean: d.nonRemHr, dip: ((dayMean - d.nonRemHr) / dayMean) * 100 });
  }

  const medianDip = nights.length ? stats(nights.map((n) => n.dip))!.median : null;
  const nightsUnder10 = nights.filter((n) => n.dip < 10).length;
  const category =
    medianDip === null ? 'no pattern'
      : medianDip > 20 ? 'extreme dipper'
        : medianDip >= 10 ? 'dipper'
          : medianDip > 0 ? 'non-dipper'
            : 'riser';
  const WANTED = 7;

  return {
    status: nights.length < WANTED ? 'collecting' : nightsUnder10 >= nights.length * 0.5 ? 'pattern' : 'monitor',
    nightsScanned: nights.length,
    nights,
    daysCollected: nights.length,
    daysWanted: WANTED,
    category,
    riser: medianDip !== null && medianDip <= 0,
    nightsUnder10,
    excludedIllnessNights,
    measurableNights: nights.length,
    medianDipPct: medianDip === null ? null : Math.round(medianDip),
  };
}

/**
 * A sustained change in the device's nightly HRV entropy.
 *
 * The usual range comes from the six weeks before the last two, never from the
 * nights being judged: median ± twice a robust spread (MAD, floored at 0.05). A
 * shift is three or more consecutive recorded nights outside it on the same
 * side, up to the latest; scattered single nights are ordinary noise.
 */
export function entropyShift(days: DailyRecord[]) {
  const entropy = (d: DailyRecord) => d.hrvEntropy ?? null;
  const recentDays = days.slice(-14).filter((d) => entropy(d) !== null);
  const baseline = values(series(days.slice(-56, -14), entropy));
  if (baseline.length < 10 || recentDays.length < 7) {
    return { status: 'collecting', steadyNights: 0, recent: [], shiftNights: 0, baselineMedian: null, baselineSd: null, lastNight: null };
  }

  const st = stats(baseline)!;
  const spread = Math.max(st.mad * 1.4826, 0.05);
  const recent = recentDays.map((d) => {
    const value = d.hrvEntropy!;
    const side = value > st.median + 2 * spread ? 1 : value < st.median - 2 * spread ? -1 : 0;
    return { date: d.date, value, side, shifted: side !== 0 };
  });

  let shiftNights = 0;
  let side = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r.side === 0 || (side !== 0 && r.side !== side)) break;
    side = r.side;
    shiftNights++;
  }

  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    status: shiftNights >= 3 ? 'shift' : 'monitor',
    steadyNights: recent.filter((r) => !r.shifted).length,
    recent,
    shiftNights,
    baselineMedian: round2(st.median),
    baselineSd: round2(spread),
    lastNight: round2(recent[recent.length - 1].value),
  };
}

export interface TachycardiaEvent {
  date: string;
  startMin: number;
  endMin: number;
  durationMin: number;
  peakBpm: number;
  stage: string;
  sleepWindow: string;
  sleepWindowTime: string;
  sessionType: 'night' | 'nap';
}

/**
 * Stretches of recorded sleep with heart rate above 100 bpm for ten minutes or
 * more, from one-minute averages.
 *
 *   - A stretch ends at any gap of more than two minutes between readings, so
 *     two readings hours apart never join into one long event.
 *   - Minutes the hypnogram marks awake are left out: getting up raises heart
 *     rate, and that isn't heart rate during sleep.
 *   - A night counts as scanned only when readings cover at least half of it,
 *     so "none found" never rests on a handful of samples.
 */
export function nocturnalTachycardia(days: DailyRecord[], intraday: IntradayDays): {
  status: 'events' | 'monitor' | 'collecting';
  nightsScanned: number;
  events: TachycardiaEvent[];
  highestSustained: { bpm: number; minutes: number } | null;
} {
  const MAX_GAP_MS = 2 * 60_000;
  const events: TachycardiaEvent[] = [];
  const scannedDates = new Set<string>();

  const validSamples = (date: string): IntradaySample[] =>
    (intraday[date] ?? []).filter((s) => s && typeof s.value === 'number' && !isNaN(s.value));

  const sessions: { dayDate: string; session: SleepSession; isNap: boolean }[] = [];
  for (const d of days) {
    if (d.sleep) sessions.push({ dayDate: d.date, session: d.sleep, isNap: false });
    for (const nap of d.naps ?? []) sessions.push({ dayDate: d.date, session: nap, isNap: true });
  }

  for (const { dayDate, session, isNap } of sessions) {
    const startMs = Date.parse(session.bedtimeIso);
    const endMs = Date.parse(session.wakeIso);
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) continue;

    // A session lies within the day it is filed under and its neighbours, so only
    // those are scanned: parsing every sample for every session is needlessly slow.
    const samples = [addDays(dayDate, -1), dayDate, addDays(dayDate, 1)]
      .flatMap(validSamples)
      .map((s) => ({ s, t: Date.parse(s.iso) }))
      .filter(({ t }) => !isNaN(t) && t >= startMs && t <= endMs)
      .sort((a, b) => a.t - b.t);

    const windowMin = (endMs - startMs) / 60_000;
    if (samples.length < windowMin * 0.5) continue;
    scannedDates.add(dayDate);

    const stageAt = (t: number) => {
      const offset = (t - startMs) / 60_000;
      return session.segments.find((sg) => offset >= sg.offsetMin && offset < sg.offsetMin + sg.durationMin)?.stage ?? null;
    };
    const windowTime = `${formatClock(session.bedtimeMin)} – ${formatClock(session.wakeMin)}`;
    const sleepWindow = `${isNap ? 'Nap' : 'Night sleep'} (${windowTime})`;

    let run: { s: IntradaySample; t: number }[] = [];
    const close = () => {
      if (run.length >= 10) {
        const first = run[0];
        const last = run[run.length - 1];
        const peak = run.reduce((a, b) => (b.s.value > a.s.value ? b : a));
        const stage = stageAt(peak.t);
        events.push({
          date: first.s.date || dayDate,
          startMin: first.s.minutesOfDay,
          endMin: last.s.minutesOfDay,
          durationMin: Math.round((last.t - first.t) / 60_000) + 1,
          peakBpm: Math.round(peak.s.value),
          stage: stage === 'deep' ? 'Deep sleep' : stage === 'rem' ? 'REM sleep' : stage === 'light' ? 'Light sleep' : isNap ? 'Nap' : 'Night sleep',
          sleepWindow,
          sleepWindowTime: windowTime,
          sessionType: isNap ? 'nap' : 'night',
        });
      }
      run = [];
    };

    for (const item of samples) {
      const awake = stageAt(item.t) === 'awake';
      const gap = run.length > 0 && item.t - run[run.length - 1].t > MAX_GAP_MS;
      if (gap || awake || item.s.value <= 100) close();
      if (!awake && item.s.value > 100) run.push(item);
    }
    close();
  }

  const highest = events.length ? events.reduce((a, b) => (a.peakBpm > b.peakBpm ? a : b)) : null;
  const nightsScanned = scannedDates.size;
  return {
    status: nightsScanned > 0 && events.length > 0 ? 'events' : nightsScanned > 0 ? 'monitor' : 'collecting',
    nightsScanned,
    events,
    highestSustained: highest ? { bpm: highest.peakBpm, minutes: highest.durationMin } : null,
  };
}

/**
 * Nights when oxygen, breathing rate and time awake were off together.
 *
 * Each of the last 14 nights is judged against the four weeks before them, never
 * against a range that includes the nights being judged. Oxygen counts 1.5 points
 * below its usual median, breathing one breath a minute above, and time awake
 * when it runs past your own usual by twice its spread (at least 20 minutes):
 * a fixed hour would flag a restless sleeper every night and a sound one never.
 */
export function sdbScreen(days: DailyRecord[]) {
  const measurable = (d: DailyRecord) => d.spo2 !== null || (d.sleep !== null && d.respiratoryRate !== null);
  const tested = days.slice(-14).filter(measurable);
  const before = days.slice(-42, -14).filter(measurable);
  const BEFORE_WANTED = 14;
  const TESTED_WANTED = 7;
  const enough = before.length >= BEFORE_WANTED && tested.length >= TESTED_WANTED;

  const spo2 = stats(values(series(before, (d) => d.spo2?.avg ?? null)));
  const rr = stats(values(series(before, (d) => d.respiratoryRate)));
  const awake = stats(values(series(before, (d) => d.sleep?.minutesAwake ?? null)));

  const flags: { id: string; label: string; fired: true; detail: string }[] = [];
  if (enough) {
    for (const d of tested) {
      const off = [
        spo2 !== null && d.spo2 !== null && d.spo2.avg < spo2.median - 1.5,
        rr !== null && d.respiratoryRate !== null && d.respiratoryRate > rr.median + 1,
        awake !== null && d.sleep !== null && d.sleep.minutesAwake > awake.median + Math.max(2 * 1.4826 * awake.mad, 20),
      ].filter(Boolean).length;
      if (off >= 2) flags.push({ id: d.date, label: formatCivil(d.date), fired: true, detail: `${off} signals off` });
    }
  }

  // Arousals per hour on usual nights, for context.
  const arousals = before
    .map((d) => (d.sleep && d.sleep.minutesAsleep > 0 ? (d.sleep.shortAwakeningsMin?.length ?? 0) / (d.sleep.minutesAsleep / 60) : null))
    .filter((v): v is number => v !== null);

  return {
    status: !enough ? 'collecting' : flags.length >= 3 ? 'pattern' : 'monitor',
    nightsInWindow: before.length + tested.length,
    nightsWanted: BEFORE_WANTED + TESTED_WANTED,
    firedCount: flags.length,
    stats: {
      arousalsPerHourTypical: arousals.length ? Math.round((arousals.reduce((a, b) => a + b, 0) / arousals.length) * 10) / 10 : null,
    },
    flags: flags.slice(-5),
  };
}
