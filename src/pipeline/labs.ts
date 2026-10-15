import type { DailyRecord, IntradaySample, SleepSession } from '../types/health';
import { BASELINE_DAYS, BASELINE_MIN_READINGS, series, compareToBaseline, stats, values } from './derive';
import { addDays } from '../lib/date';
import { formatCivil, formatClock } from '../i18n/format';
import type { SyncResult } from './sync';

export function calculateOffSignals(days: DailyRecord[], index: number): number {
  const slice = days.slice(0, index + 1);
  const rhr = compareToBaseline(series(slice, d => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS);
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
  
  const hrvZ = compareToBaseline(hrvSeries, BASELINE_DAYS, BASELINE_MIN_READINGS);
  if (hrvZ.z !== null && hrvZ.n >= 8 && hrvZ.z <= -1.5) offSignals++;
  
  return offSignals;
}

export type StrainKey = 'restingHr' | 'breathing' | 'hrv' | 'skinTemp';

export interface StrainSignal {
  key: StrainKey;
  /** 'none' when the latest day has no reading, or too little history to judge it. */
  status: 'none' | 'in' | 'off';
}

export interface StrainToday {
  status: 'collecting' | 'waiting' | 'ready';
  signals: StrainSignal[];
  /** How many of the four have a reading on the latest day. */
  arrived: number;
  off: number;
  level: 'baseline' | 'elevated' | 'high' | null;
}

const STRAIN_INPUTS: { key: StrainKey; get: (d: DailyRecord) => number | null }[] = [
  { key: 'restingHr', get: (d) => d.restingHr },
  { key: 'breathing', get: (d) => d.respiratoryRate },
  { key: 'hrv', get: (d) => d.hrvDeepSleep ?? d.hrv },
  { key: 'skinTemp', get: (d) => d.skinTempDeviationC },
];

/**
 * The System Strain Radar's four signals on the latest day, by the same tests
 * as calculateOffSignals, except that each is judged only on a reading from
 * that day: one that hasn't arrived yet shows as no data, never as yesterday's.
 * It compares once two of them have a usual range (8 readings in the four
 * weeks before) and a reading today.
 */
export function strainToday(days: DailyRecord[]): StrainToday {
  const latest = days[days.length - 1];
  const prior = days.slice(-29, -1);
  const ranged = (get: (d: DailyRecord) => number | null) => prior.filter((d) => get(d) !== null).length >= 8;
  const today = (get: (d: DailyRecord) => number | null) => !!latest && get(latest) !== null;
  const logHrv = (d: DailyRecord) => {
    const v = d.hrvDeepSleep ?? d.hrv;
    return v && v > 0 ? Math.log(v) : null;
  };

  const judge = (key: StrainKey): StrainSignal['status'] => {
    switch (key) {
      case 'restingHr': {
        const c = compareToBaseline(series(days, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS);
        return c.z === null || c.n < 8 ? 'none' : c.z >= 1.5 ? 'off' : 'in';
      }
      case 'breathing': {
        const c = compareToBaseline(series(days, (d) => d.respiratoryRate));
        return c.z === null || c.n < 8 ? 'none' : c.z >= 1.5 ? 'off' : 'in';
      }
      case 'hrv': {
        if (logHrv(latest) === null) return 'none';
        const c = compareToBaseline(series(days, logHrv), BASELINE_DAYS, BASELINE_MIN_READINGS);
        return c.z === null || c.n < 8 ? 'none' : c.z <= -1.5 ? 'off' : 'in';
      }
      case 'skinTemp':
        return latest.skinTempDeviationC! >= 0.5 ? 'off' : 'in';
    }
  };

  const signals = STRAIN_INPUTS.map(({ key, get }): StrainSignal => ({ key, status: today(get) ? judge(key) : 'none' }));
  const usable = STRAIN_INPUTS.filter(({ get }) => today(get) && ranged(get)).length;
  const rangesReady = days.length > 28 && STRAIN_INPUTS.filter(({ get }) => ranged(get)).length >= 2;
  const status = !rangesReady ? 'collecting' : usable < 2 ? 'waiting' : 'ready';
  const off = signals.filter((s) => s.status === 'off').length;
  return {
    status,
    signals,
    arrived: STRAIN_INPUTS.filter(({ get }) => today(get)).length,
    off,
    level: status !== 'ready' ? null : off >= 3 ? 'high' : off === 2 ? 'elevated' : 'baseline',
  };
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
export interface EntropyNight {
  date: string;
  value: number;
  /** 1 above the usual range, −1 below it, 0 inside (or not judged yet). */
  side: number;
  shifted: boolean;
}

export interface EntropyShift {
  status: 'collecting' | 'monitor' | 'shift';
  steadyNights: number;
  /** The last two weeks' recorded nights, judged once there is a usual range. */
  recent: EntropyNight[];
  shiftNights: number;
  baselineMedian: number | null;
  baselineSd: number | null;
  /** The usual range itself: median ± twice the spread. */
  usualLow: number | null;
  usualHigh: number | null;
  lastNight: number | null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function entropyShift(days: DailyRecord[]): EntropyShift {
  const entropy = (d: DailyRecord) => d.hrvEntropy ?? null;
  const recentDays = days.slice(-14).filter((d) => entropy(d) !== null);
  const baseline = values(series(days.slice(-56, -14), entropy));
  if (baseline.length < 10 || recentDays.length < 7) {
    // The nights so far, unjudged: there is no usual range to hold them against yet.
    const recent = recentDays.map((d) => ({ date: d.date, value: d.hrvEntropy!, side: 0, shifted: false }));
    return {
      status: 'collecting', steadyNights: 0, recent, shiftNights: 0, baselineMedian: null, baselineSd: null,
      usualLow: null, usualHigh: null, lastNight: recent.length ? round2(recent[recent.length - 1].value) : null,
    };
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

  return {
    status: shiftNights >= 3 ? 'shift' : 'monitor',
    steadyNights: recent.filter((r) => !r.shifted).length,
    recent,
    shiftNights,
    baselineMedian: round2(st.median),
    baselineSd: round2(spread),
    usualLow: round2(st.median - 2 * spread),
    usualHigh: round2(st.median + 2 * spread),
    lastNight: round2(recent[recent.length - 1].value),
  };
}

/** One session's minute-level heart rate, in minutes since bedtime, with its stretches above 100 bpm. */
export interface NightTrace {
  /** The day the session is filed under. */
  date: string;
  isNap: boolean;
  bedtimeMin: number;
  wakeMin: number;
  durationMin: number;
  points: { min: number; bpm: number }[];
  stretches: { from: number; to: number }[];
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
  /** One scanned session to draw: the latest with a stretch, else the latest night. */
  trace: NightTrace | null;
} {
  const MAX_GAP_MS = 2 * 60_000;
  const events: TachycardiaEvent[] = [];
  const scannedDates = new Set<string>();
  type Scanned = { dayDate: string; session: SleepSession; isNap: boolean; startMs: number; endMs: number; samples: { s: IntradaySample; t: number }[]; stretches: { from: number; to: number }[] };
  let latestWithStretch: Scanned | null = null;
  let latestNight: Scanned | null = null;
  let latestAny: Scanned | null = null;

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
    const stretches: { from: number; to: number }[] = [];

    let run: { s: IntradaySample; t: number }[] = [];
    const close = () => {
      if (run.length >= 10) {
        const first = run[0];
        const last = run[run.length - 1];
        const peak = run.reduce((a, b) => (b.s.value > a.s.value ? b : a));
        const stage = stageAt(peak.t);
        stretches.push({ from: (first.t - startMs) / 60_000, to: (last.t - startMs) / 60_000 });
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

    // Sessions run in date order, so the last one seen of each kind is the latest.
    const scanned: Scanned = { dayDate, session, isNap, startMs, endMs, samples, stretches };
    latestAny = scanned;
    if (!isNap) latestNight = scanned;
    if (stretches.length) latestWithStretch = scanned;
  }

  const highest = events.length ? events.reduce((a, b) => (a.peakBpm > b.peakBpm ? a : b)) : null;
  const nightsScanned = scannedDates.size;
  const drawn: Scanned | null = latestWithStretch ?? latestNight ?? latestAny;
  const trace: NightTrace | null = drawn && {
    date: drawn.dayDate,
    isNap: drawn.isNap,
    bedtimeMin: drawn.session.bedtimeMin,
    wakeMin: drawn.session.wakeMin,
    durationMin: (drawn.endMs - drawn.startMs) / 60_000,
    points: drawn.samples.map(({ s, t }) => ({ min: (t - drawn.startMs) / 60_000, bpm: s.value })),
    stretches: drawn.stretches,
  };
  return {
    trace,
    status: nightsScanned > 0 && events.length > 0 ? 'events' : nightsScanned > 0 ? 'monitor' : 'collecting',
    nightsScanned,
    events,
    highestSustained: highest ? { bpm: highest.peakBpm, minutes: highest.durationMin } : null,
  };
}

export interface SdbNight {
  date: string;
  /** Oxygen, or breathing rate on a recorded night: something to judge. */
  measured: boolean;
  oxygen: boolean;
  breathing: boolean;
  awake: boolean;
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

  // Each of the last 14 nights, signal by signal. Nothing counts as off until there is a usual range.
  const nights: SdbNight[] = days.slice(-14).map((d) => {
    const judged = enough && measurable(d);
    return {
      date: d.date,
      measured: measurable(d),
      oxygen: judged && spo2 !== null && d.spo2 !== null && d.spo2.avg < spo2.median - 1.5,
      breathing: judged && rr !== null && d.respiratoryRate !== null && d.respiratoryRate > rr.median + 1,
      awake: judged && awake !== null && d.sleep !== null && d.sleep.minutesAwake > awake.median + Math.max(2 * 1.4826 * awake.mad, 20),
    };
  });
  const flags = nights
    .map((n) => ({ n, off: Number(n.oxygen) + Number(n.breathing) + Number(n.awake) }))
    .filter(({ off }) => off >= 2)
    .map(({ n, off }) => ({ id: n.date, label: formatCivil(n.date), fired: true as const, detail: `${off} signals off` }));

  // Arousals per hour on usual nights, for context.
  const arousals = before
    .map((d) => (d.sleep && d.sleep.minutesAsleep > 0 ? (d.sleep.shortAwakeningsMin?.length ?? 0) / (d.sleep.minutesAsleep / 60) : null))
    .filter((v): v is number => v !== null);

  return {
    status: !enough ? 'collecting' : flags.length >= 3 ? 'pattern' : 'monitor',
    nightsInWindow: before.length + tested.length,
    nightsWanted: BEFORE_WANTED + TESTED_WANTED,
    /** Nights in the four weeks that set the usual range, and in the two weeks judged against it. */
    beforeNights: before.length,
    beforeWanted: BEFORE_WANTED,
    testedNights: tested.length,
    testedWanted: TESTED_WANTED,
    nights,
    firedCount: flags.length,
    stats: {
      arousalsPerHourTypical: arousals.length ? Math.round((arousals.reduce((a, b) => a + b, 0) / arousals.length) * 10) / 10 : null,
    },
    flags: flags.slice(-5),
  };
}
