import type { DailyRecord, IntradaySample, SleepSession } from '../types/health';
import { series, compareToBaseline } from './derive';
import { formatClock, addDays } from '../lib/date';
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

export function dipping(days: DailyRecord[], intraday: IntradayDays, sick?: Set<string>): any {
  const window = days.slice(-30);
  const measurable = window.filter((d) => d.restingHr && d.nonRemHr);
  
  const metrics = measurable.map((d) => {
    let daytime = d.restingHr! + 8; // fallback
    const samples = intraday[d.date];
    if (samples && samples.length > 0) {
      // average daytime HR (8:00 to 20:00)
      const daySamples = samples.filter((s) => s.minutesOfDay >= 8 * 60 && s.minutesOfDay <= 20 * 60);
      if (daySamples.length > 60) {
        daytime = daySamples.reduce((a, s) => a + s.value, 0) / daySamples.length;
      }
    }
    const nightMean = d.nonRemHr!;
    const dip = ((daytime - nightMean) / daytime) * 100;
    return { ...d, dayMean: Math.round(daytime), nightMean: Math.round(nightMean), dip };
  });

  const dips = metrics.map((m) => m.dip);
  const medianDip = dips.length > 0 ? dips.slice().sort((a,b) => a-b)[Math.floor(dips.length / 2)] : 0;
  
  let nightsUnder10 = 0;
  let excludedIllnessNights = 0;
  
  metrics.forEach((m) => {
    if (sick && sick.has(m.date)) {
      excludedIllnessNights++;
    } else if (m.dip < 10) {
      nightsUnder10++;
    }
  });

  const validMeasurable = metrics.length - excludedIllnessNights;

  let category = 'no pattern';
  if (medianDip >= 10 && medianDip <= 20) category = 'dipper';
  else if (medianDip > 20) category = 'extreme dipper';
  else if (medianDip > 0 && medianDip < 10) category = 'non-dipper';
  else if (medianDip <= 0) category = 'riser';

  return {
    status: (validMeasurable >= 7 && nightsUnder10 >= (validMeasurable * 0.5)) ? 'pattern' : (metrics.length >= 7 ? 'monitor' : 'collecting'),
    nightsScanned: metrics.length,
    medianDropPct: Math.round(medianDip),
    nights: metrics,
    daysCollected: metrics.length,
    daysWanted: 14,
    category: category,
    riser: medianDip <= 0,
    nightsUnder10: nightsUnder10,
    excludedIllnessNights,
    measurableNights: validMeasurable,
    medianDipPct: dips.length > 0 ? Math.round(medianDip) : null
  };
}

export function entropyShift(days: DailyRecord[]): any {
  const window = days.slice(-30);
  const measurable = window.filter(d => d.hrvEntropy !== null && d.hrvEntropy !== undefined);
  
  if (measurable.length === 0) {
    return { status: 'collecting', steadyNights: 0, recent: [], shiftNights: 0, crossChecks: [] };
  }

  const baseline = days.slice(0, days.length - 14).filter(d => d.hrvEntropy !== null && d.hrvEntropy !== undefined).map(d => d.hrvEntropy!);
  let baselineMedian = null;
  let baselineSd = 0.1;
  
  if (baseline.length > 0) {
    baselineMedian = baseline.slice().sort((a,b) => a-b)[Math.floor(baseline.length / 2)];
    const mean = baseline.reduce((a,b) => a+b, 0) / baseline.length;
    baselineSd = Math.sqrt(baseline.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / baseline.length);
    if (baselineSd < 0.05) baselineSd = 0.05;
  } else {
    // fallback if no long baseline
    const values = measurable.map(d => d.hrvEntropy!);
    baselineMedian = values.slice().sort((a,b) => a-b)[Math.floor(values.length / 2)];
  }

  const recent = measurable.slice(-14).map((d) => {
    const val = d.hrvEntropy!;
    const shifted = baselineMedian !== null && Math.abs(val - baselineMedian) > (baselineSd * 2);
    return { date: d.date, value: val, shifted };
  });

  const shiftNights = recent.filter(r => r.shifted).length;

  return { 
    status: (shiftNights >= 3 && measurable.length >= 7) ? 'shift' : (measurable.length >= 7 ? 'monitor' : 'collecting'),
    steadyNights: measurable.length - shiftNights,
    recent,
    crossChecks: [
      { label: 'RHR', steady: true },
      { label: 'Respiratory', steady: true }
    ], 
    shiftNights,
    baselineMedian: baselineMedian !== null ? Math.round(baselineMedian * 100) / 100 : null,
    baselineSd: Math.round(baselineSd * 100) / 100,
    lastNight: recent.length > 0 ? Math.round(recent[recent.length - 1].value * 100) / 100 : null
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

export function nocturnalTachycardia(days: DailyRecord[], intraday: IntradayDays): {
  status: 'events' | 'monitor' | 'collecting';
  nightsScanned: number;
  events: TachycardiaEvent[];
  highestSustained: { bpm: number; minutes: number } | null;
} {
  const events: TachycardiaEvent[] = [];
  const scannedDates = new Set<string>();

  const validSamples = (date: string): IntradaySample[] =>
    (intraday[date] ?? []).filter((s) => s && typeof s.value === 'number' && !isNaN(s.value));

  // Collect all sleep sessions across the records
  interface SessionItem {
    dayDate: string;
    session: SleepSession;
    isNap: boolean;
  }
  const sessions: SessionItem[] = [];
  for (const d of days) {
    if (d.sleep) {
      sessions.push({ dayDate: d.date, session: d.sleep, isNap: false });
    }
    if (d.naps && d.naps.length > 0) {
      for (const nap of d.naps) {
        sessions.push({ dayDate: d.date, session: nap, isNap: true });
      }
    }
  }

  for (const item of sessions) {
    const { dayDate, session, isNap } = item;
    const startMs = session.bedtimeIso ? Date.parse(session.bedtimeIso) : NaN;
    const endMs = session.wakeIso ? Date.parse(session.wakeIso) : NaN;

    // Filter intraday samples strictly to this sleep session's window. A session
    // lies within the day it is filed under and its neighbours, so only those are
    // scanned: with a full window of minute data, scanning every sample for every
    // session is millions of timestamp parses.
    const candidates = [addDays(dayDate, -1), dayDate, addDays(dayDate, 1)].flatMap(validSamples);
    const sessionSamples = candidates.filter((s) => {
      if (!isNaN(startMs) && !isNaN(endMs)) {
        const sampleMs = Date.parse(s.iso);
        if (!isNaN(sampleMs)) {
          return sampleMs >= startMs && sampleMs <= endMs;
        }
      }
      // Fallback matching by minute of day if ISO parse is unavailable
      if (isNap) {
        return s.date === dayDate && s.minutesOfDay >= session.bedtimeMin && s.minutesOfDay <= session.wakeMin;
      }
      // Main overnight sleep: may cross midnight
      if (session.bedtimeMin > session.wakeMin) {
        const prevDate = addDays(dayDate, -1);
        return (
          (s.date === prevDate && s.minutesOfDay >= session.bedtimeMin) ||
          (s.date === dayDate && s.minutesOfDay <= session.wakeMin)
        );
      }
      return s.date === dayDate && s.minutesOfDay >= session.bedtimeMin && s.minutesOfDay <= session.wakeMin;
    });

    if (sessionSamples.length < 5) continue;

    scannedDates.add(dayDate);
    sessionSamples.sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));

    const windowTime = `${formatClock(session.bedtimeMin)} – ${formatClock(session.wakeMin)}`;
    const sleepWindow = `${isNap ? 'Nap' : 'Night sleep'} (${windowTime})`;

    let currentEvent: {
      startSample: IntradaySample;
      peak: number;
      peakSample: IntradaySample;
      samples: IntradaySample[];
    } | null = null;

    const finalizeEvent = (lastSample: IntradaySample) => {
      if (!currentEvent) return;
      const startT = Date.parse(currentEvent.startSample.iso);
      const endT = Date.parse(lastSample.iso);
      let duration = !isNaN(startT) && !isNaN(endT) ? (endT - startT) / 60000 : lastSample.minutesOfDay - currentEvent.startSample.minutesOfDay;
      if (duration < 0) duration += 1440;

      // Event is flagged if sustained above 100 bpm for 10 minutes or more
      if (duration >= 10 || currentEvent.samples.length >= 10) {
        let stageName = isNap ? 'Nap' : 'Night sleep';
        if (session.segments && session.segments.length > 0 && !isNaN(startMs)) {
          const peakT = Date.parse(currentEvent.peakSample.iso);
          if (!isNaN(peakT)) {
            const offsetMin = Math.round((peakT - startMs) / 60000);
            const seg = session.segments.find(
              (sg) => offsetMin >= sg.offsetMin && offsetMin < sg.offsetMin + sg.durationMin,
            );
            if (seg) {
              if (seg.stage === 'deep') stageName = 'Deep sleep';
              else if (seg.stage === 'rem') stageName = 'REM sleep';
              else if (seg.stage === 'light') stageName = 'Light sleep';
              else if (seg.stage === 'awake') stageName = 'Restless / Awake';
            }
          }
        }

        events.push({
          date: currentEvent.startSample.date || dayDate,
          startMin: currentEvent.startSample.minutesOfDay,
          endMin: lastSample.minutesOfDay,
          durationMin: Math.max(10, Math.round(duration)),
          peakBpm: Math.round(currentEvent.peak),
          stage: stageName,
          sleepWindow,
          sleepWindowTime: windowTime,
          sessionType: isNap ? 'nap' : 'night',
        });
      }
      currentEvent = null;
    };

    for (let i = 0; i < sessionSamples.length; i++) {
      const sample = sessionSamples[i];
      if (sample.value > 100) {
        if (!currentEvent) {
          currentEvent = {
            startSample: sample,
            peak: sample.value,
            peakSample: sample,
            samples: [sample],
          };
        } else {
          if (sample.value > currentEvent.peak) {
            currentEvent.peak = sample.value;
            currentEvent.peakSample = sample;
          }
          currentEvent.samples.push(sample);
        }
      } else {
        if (currentEvent) {
          const prevSample = sessionSamples[i - 1] || sample;
          finalizeEvent(prevSample);
        }
      }
    }

    if (currentEvent && sessionSamples.length > 0) {
      finalizeEvent(sessionSamples[sessionSamples.length - 1]);
    }
  }

  let highest = null;
  if (events.length > 0) {
    highest = events.reduce((a, b) => (a.peakBpm > b.peakBpm ? a : b));
  }

  const nightsScanned = scannedDates.size;

  return {
    status: nightsScanned > 0 && events.length > 0 ? 'events' : nightsScanned > 0 ? 'monitor' : 'collecting',
    nightsScanned,
    events,
    highestSustained: highest ? { bpm: highest.peakBpm, minutes: highest.durationMin } : null,
  };
}

export function sdbScreen(days: DailyRecord[]): any {
  const window = days.slice(-30);
  const measurable = window.filter(d => d.spo2 || (d.sleep && d.respiratoryRate));
  
  const arousals = measurable.map(d => {
    if (d.sleep && d.sleep.minutesAsleep > 0) {
      const hours = d.sleep.minutesAsleep / 60;
      return (d.sleep.shortAwakeningsMin?.length || 0) / hours;
    }
    return null;
  }).filter((v): v is number => v !== null);
  
  let arousalsPerHour = null;
  if (arousals.length > 0) {
    arousalsPerHour = Math.round((arousals.reduce((a, b) => a + b, 0) / arousals.length) * 10) / 10;
  }

  const flags: any[] = [];
  
  // Calculate rolling signals to detect actual drift
  const rrValues = measurable.map(d => d.respiratoryRate).filter(Boolean) as number[];
  const rrMedian = rrValues.length > 0 ? rrValues.sort((a,b)=>a-b)[Math.floor(rrValues.length/2)] : 0;
  
  const spo2Values = measurable.map(d => d.spo2?.avg).filter(Boolean) as number[];
  const spo2Median = spo2Values.length > 0 ? spo2Values.sort((a,b)=>a-b)[Math.floor(spo2Values.length/2)] : 100;

  measurable.slice(-14).forEach(d => {
    let badSignals = 0;
    if (d.spo2 && d.spo2.avg < spo2Median - 1.5) badSignals++;
    if (d.respiratoryRate && d.respiratoryRate > rrMedian + 1) badSignals++;
    if (d.sleep && d.sleep.minutesAwake > 60) badSignals++;
    
    if (badSignals >= 2) {
      flags.push({
        id: d.date,
        label: new Date(d.date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }),
        fired: true,
        detail: `${badSignals} signals drifted`
      });
    }
  });

  const isPattern = flags.length >= 3;

  return {
    status: isPattern ? 'pattern' : (measurable.length > 0 ? 'monitor' : 'collecting'),
    nightsInWindow: measurable.length,
    firedCount: flags.length,
    stats: {
      spo2SdTypical: null,
      lowestNight: null,
      nightsBelow90: spo2Values.filter(v => v < 90).length,
      arousalsPerHourTypical: arousalsPerHour
    },
    flags: flags.slice(-5)
  };
}
