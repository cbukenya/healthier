import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import { readiness, sleepDebt, estimatedSleepTarget } from '../derive';
import { insightFeeds, observations } from '../insights';
import { calculateOffSignals, dipping, entropyShift, illnessDates, nocturnalTachycardia, sdbScreen, strainToday, type IntradayDays } from '../labs';
import { emptyRecord } from '../normalize';
import type { DailyRecord, IntradaySample, SleepSession } from '../../types/health';
import { formatCivil } from '../../i18n/format';

/**
 * Labs calculations and sleep debt: each card computes what it says it does,
 * against a baseline that excludes the nights being judged.
 */

const START = '2026-07-01';
const CYC = [1, -0.5, 0, 0.5, -1];

/** n days of steady overnight readings and a 23:00–07:00 night (UTC). */
function nights(n: number): DailyRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const d = emptyRecord(addDays(START, i));
    d.restingHr = 60 + CYC[i % 5];
    d.nonRemHr = 58 + CYC[i % 5];
    d.hrv = 40 + CYC[i % 5] * 3;
    d.respiratoryRate = 14 + CYC[i % 5] * 0.2;
    d.spo2 = { avg: 96 + CYC[i % 5] * 0.2, ciLower: 93, ciUpper: 99, rollingAvgSd: null };
    d.hrvEntropy = 2.8 + CYC[i % 5] * 0.02;
    d.sleep = session(d.date, 23 * 60, 7 * 60, 450, 30);
    return d;
  });
}

function session(date: string, bed: number, wake: number, asleep: number, awake: number, segments: SleepSession['segments'] = []): SleepSession {
  const prev = addDays(date, -1);
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    date, isMainSleep: true, isNap: false, bedtimeMin: bed, wakeMin: wake,
    bedtimeIso: `${bed > wake ? prev : date}T${clock(bed)}:00Z`, wakeIso: `${date}T${clock(wake)}:00Z`,
    minutesAsleep: asleep, onsetLatencyMin: null, minutesAwake: awake, minutesInBed: asleep + awake,
    efficiency: Math.round((asleep / (asleep + awake)) * 100), stages: null, segments, shortAwakeningsMin: [],
  };
}

/** One-minute heart-rate samples, UTC, from `from` for `count` minutes. */
function minutes(date: string, fromMin: number, count: number, bpm: (i: number) => number): IntradaySample[] {
  return Array.from({ length: count }, (_, i) => {
    const t = Date.parse(`${date}T00:00:00Z`) + (fromMin + i) * 60_000;
    const iso = new Date(t).toISOString();
    return { iso, date: iso.slice(0, 10), minutesOfDay: Math.floor((t % 86_400_000) / 60_000), value: bpm(i) };
  });
}

const byDate = (samples: IntradaySample[]): IntradayDays => {
  const out: IntradayDays = {};
  for (const s of samples) (out[s.date] ??= []).push(s);
  return out;
};

describe('day-to-night heart rate', () => {
  /** Twelve hours of daytime heart rate at 70 for each date. */
  const daytime = (days: DailyRecord[]) => byDate(days.flatMap((d) => minutes(d.date, 8 * 60, 12 * 60, () => 70)));

  it('counts only nights whose daytime was measured', () => {
    const days = nights(40);
    const r = dipping(days, {}); // no minute-level data at all
    assert.equal(r.nightsScanned, 0, 'no stand-in daytime figure');
    assert.equal(r.status, 'collecting');
    assert.equal(r.medianDipPct, null);
  });

  it('leaves today out: its daytime is half done', () => {
    const days = nights(20);
    const r = dipping(days, daytime(days));
    assert.ok(!r.nights.some((n) => n.date === days[days.length - 1].date));
    assert.equal(r.nightsScanned, 19);
  });

  it('leaves sick nights out of every figure, card and insight alike', () => {
    const days = nights(20);
    const intraday = daytime(days);
    const riser = days[10].date;
    days[10].nonRemHr = 80; // higher at night than by day
    const r = dipping(days, intraday, new Set([riser]));
    assert.equal(r.excludedIllnessNights, 1);
    assert.ok(!r.nights.some((n) => n.date === riser));
    assert.equal(r.measurableNights, r.nights.length);
    // The default is the shared illness set, so a card calling without one agrees with the insight.
    assert.deepEqual(dipping(days, intraday), dipping(days, intraday, illnessDates(days)));
  });
});

describe('HRV entropy', () => {
  it('calls a shift only on three consecutive nights on one side', () => {
    const scattered = nights(56);
    for (const i of [43, 47, 51]) scattered[i].hrvEntropy = 3.4;
    assert.equal(entropyShift(scattered).status, 'monitor', 'three scattered nights are noise');

    const sustained = nights(56);
    for (const i of [53, 54, 55]) sustained[i].hrvEntropy = 3.4;
    const r = entropyShift(sustained);
    assert.equal(r.status, 'shift');
    assert.equal(r.shiftNights, 3);
  });

  it('builds its usual range from the weeks before, never the nights it judges', () => {
    const days = nights(56);
    for (let i = 42; i < 56; i++) days[i].hrvEntropy = 3.4; // two weeks shifted
    const r = entropyShift(days);
    assert.equal(r.baselineMedian, 2.8);
    assert.equal(r.status, 'shift');
  });

  it('waits for a baseline instead of judging the recent nights against themselves', () => {
    assert.equal(entropyShift(nights(20)).status, 'collecting');
  });

  it('shows the nights so far while it collects, judging none of them', () => {
    const r = entropyShift(nights(20));
    assert.equal(r.recent.length, 14);
    assert.ok(r.recent.every((p) => !p.shifted));
    assert.equal(r.lastNight, 2.78);
    assert.equal(r.usualLow, null);
  });

  it('gives its usual range as the band it judges by', () => {
    // Baseline 2.8 with a spread under the 0.05 floor: the range is 2.8 ± 0.1.
    const r = entropyShift(nights(56));
    assert.equal(r.status, 'monitor');
    assert.equal(r.usualLow, 2.7);
    assert.equal(r.usualHigh, 2.9);
  });
});

describe('night breathing and oxygen', () => {
  it('judges time awake against your own usual, not a fixed hour', () => {
    // A restless sleeper: 80 minutes awake is an ordinary night for them.
    const days = nights(42);
    days.forEach((d) => { d.sleep!.minutesAwake = 80 + CYC[days.indexOf(d) % 5] * 4; });
    for (const i of [35, 38, 41]) days[i].respiratoryRate = 15.5; // breathing up alone
    const r = sdbScreen(days);
    assert.equal(r.firedCount, 0, 'one signal off is not two');
    assert.equal(r.status, 'monitor');
  });

  it('flags nights against the four weeks before them, with civil dates', () => {
    const days = nights(42);
    for (const i of [33, 36, 40]) {
      days[i].spo2 = { avg: 93.8, ciLower: 90, ciUpper: 97, rollingAvgSd: null };
      days[i].respiratoryRate = 15.6;
    }
    const r = sdbScreen(days);
    assert.equal(r.status, 'pattern');
    assert.deepEqual(r.flags.map((f) => f.label), [33, 36, 40].map((i) => formatCivil(days[i].date)));
  });

  it('collects until it has a usual range to judge by', () => {
    const r = sdbScreen(nights(20));
    assert.equal(r.status, 'collecting');
    assert.equal(r.nightsWanted, 21);
    assert.ok(r.nights.every((n) => !n.oxygen && !n.breathing && !n.awake), 'no night is off without a usual range');
    assert.equal(r.beforeNights + r.testedNights, r.nightsInWindow);
  });

  it('shows each of the last 14 nights signal by signal, agreeing with the nights it flags', () => {
    const days = nights(42);
    for (const i of [33, 36, 40]) {
      days[i].spo2 = { avg: 93.8, ciLower: 90, ciUpper: 97, rollingAvgSd: null };
      days[i].respiratoryRate = 15.6;
    }
    days[38].respiratoryRate = 15.6; // breathing up alone
    const r = sdbScreen(days);
    assert.equal(r.nights.length, 14);
    const off = (n: (typeof r.nights)[number]) => Number(n.oxygen) + Number(n.breathing) + Number(n.awake);
    assert.deepEqual(r.nights.filter((n) => off(n) >= 2).map((n) => formatCivil(n.date)), r.flags.map((f) => f.label));
    const alone = r.nights.find((n) => n.date === days[38].date)!;
    assert.deepEqual([alone.oxygen, alone.breathing, alone.awake], [false, true, false]);
  });
});

describe('high heart rate during sleep', () => {
  const night = (date: string, samples: IntradaySample[], segments: SleepSession['segments'] = []) => {
    const d = emptyRecord(date);
    d.sleep = session(date, 23 * 60, 7 * 60, 450, 30, segments);
    return { days: [d], intraday: byDate(samples) };
  };
  const date = '2026-07-15';
  const prev = addDays(date, -1);

  it('finds a real stretch with its true length', () => {
    const samples = minutes(prev, 23 * 60, 480, (i) => (i >= 120 && i < 132 ? 112 : 60));
    const r = nocturnalTachycardia(night(date, samples).days, night(date, samples).intraday);
    assert.equal(r.events.length, 1);
    assert.equal(r.events[0].durationMin, 12);
  });

  it('never joins readings across a gap', () => {
    // Five minutes high at 01:00, three hours with no readings, five minutes high at 04:00.
    const samples = minutes(prev, 23 * 60, 480, (i) => (i < 125 || i >= 300 ? (i >= 120 && i < 125) || (i >= 300 && i < 305) ? 110 : 60 : NaN))
      .filter((s) => !Number.isNaN(s.value));
    const { days, intraday } = night(date, samples);
    const r = nocturnalTachycardia(days, intraday);
    assert.equal(r.nightsScanned, 1);
    assert.equal(r.events.length, 0, 'two short stretches hours apart are not one long one');
  });

  it('leaves out minutes the hypnogram marks awake', () => {
    const samples = minutes(prev, 23 * 60, 480, (i) => (i >= 240 && i < 260 ? 115 : 60));
    const segments = [
      { stage: 'light' as const, offsetMin: 0, durationMin: 240, clockMin: 23 * 60 },
      { stage: 'awake' as const, offsetMin: 240, durationMin: 20, clockMin: 3 * 60 },
      { stage: 'light' as const, offsetMin: 260, durationMin: 220, clockMin: 3 * 60 + 20 },
    ];
    const { days, intraday } = night(date, samples, segments);
    assert.equal(nocturnalTachycardia(days, intraday).events.length, 0);
  });

  it("doesn't call a night scanned from a handful of readings", () => {
    const { days, intraday } = night(date, minutes(prev, 23 * 60, 30, () => 60));
    const r = nocturnalTachycardia(days, intraday);
    assert.equal(r.nightsScanned, 0);
    assert.equal(r.status, 'collecting');
    assert.equal(r.trace, null);
  });

  it('draws the night with the stretch, minute by minute', () => {
    const samples = minutes(prev, 23 * 60, 480, (i) => (i >= 120 && i < 132 ? 112 : 60));
    const { days, intraday } = night(date, samples);
    const trace = nocturnalTachycardia(days, intraday).trace!;
    assert.equal(trace.date, date);
    assert.equal(trace.points.length, 480);
    assert.deepEqual(trace.stretches, [{ from: 120, to: 131 }]);
  });

  it('draws the latest night when none has a stretch', () => {
    const later = addDays(date, 1);
    const a = emptyRecord(date);
    a.sleep = session(date, 23 * 60, 7 * 60, 450, 30);
    const b = emptyRecord(later);
    b.sleep = session(later, 23 * 60, 7 * 60, 450, 30);
    const samples = [...minutes(prev, 23 * 60, 480, () => 60), ...minutes(date, 23 * 60, 480, () => 62)];
    const r = nocturnalTachycardia([a, b], byDate(samples));
    assert.equal(r.status, 'monitor');
    assert.equal(r.trace!.date, later);
    assert.deepEqual(r.trace!.stretches, []);
  });
});

describe('system strain', () => {
  it('counts what the shared off-signal test counts when every reading is in', () => {
    const days = nights(40);
    const last = days[days.length - 1];
    last.restingHr = 70;
    last.respiratoryRate = 17;
    last.hrv = 40;
    const r = strainToday(days);
    assert.equal(r.status, 'ready');
    assert.equal(r.off, calculateOffSignals(days, days.length - 1));
    assert.equal(r.level, 'elevated');
    assert.deepEqual(r.signals.filter((s) => s.status === 'off').map((s) => s.key), ['restingHr', 'breathing']);
    assert.equal(r.signals.find((s) => s.key === 'skinTemp')!.status, 'none', 'no reading is no data, not normal');
  });

  it("waits for today's readings instead of judging yesterday's", () => {
    const days = nights(40);
    const last = days[days.length - 1];
    last.restingHr = null;
    last.respiratoryRate = null;
    last.hrv = null;
    const r = strainToday(days);
    assert.equal(r.status, 'waiting');
    assert.equal(r.arrived, 0);
    assert.ok(r.signals.every((s) => s.status === 'none'));
    assert.equal(r.level, null);
  });

  it('collects until it has usual ranges', () => {
    assert.equal(strainToday(nights(20)).status, 'collecting');
  });
});

describe('sleep debt', () => {
  /** 28 nights alternating 90 minutes either side of 7h30. */
  const steady = () => {
    const days = nights(28);
    days.forEach((d, i) => { d.sleep!.minutesAsleep = i % 2 ? 390 : 510; });
    return days;
  };

  it("doesn't read a steady sleeper's ordinary variation as debt", () => {
    const days = steady();
    const debt = sleepDebt(days, estimatedSleepTarget(days))!;
    assert.ok(Math.abs(debt.netMin) <= 120, `net ${debt.netMin}`);
    const ids = observations({ days } as any, new Date(`${days[27].date}T09:00:00`)).map((o) => o.id);
    assert.ok(!ids.includes('sleep-debt'), ids.join(' | '));
  });

  it('gives the battery and the insight one figure', () => {
    const days = nights(28);
    for (let i = 20; i < 27; i++) days[i].sleep!.minutesAsleep = 330; // a short week
    const need = estimatedSleepTarget(days);
    const debt = sleepDebt(days, need)!;
    const part = readiness(days).parts.find((p) => p.label === 'Recent sleep debt')!;
    assert.match(part.detail, new RegExp(`^${(debt.netMin / 60).toFixed(1)}h short`));
    // A week into the debt it waits on the Sleep page, so look everywhere.
    const feeds = insightFeeds({ days } as any, new Date(`${days[27].date}T09:00:00`));
    const card = [...feeds.today, ...Object.values(feeds.pages).flat()].find((o) => o.id === 'sleep-debt')!;
    assert.ok(card);
    assert.match(card.text, new RegExp(`${(debt.netMin / 60).toFixed(1)} hours less than you need`));
  });
});
