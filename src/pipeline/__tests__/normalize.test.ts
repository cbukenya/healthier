import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ghDateFromCivil } from '../../lib/date';
import { buildFixturePayloads } from '../fixtures';
import { normalize } from '../normalize';
import { STREAMS_BY_TYPE } from '../registry';

/**
 * Combining readings: two devices on one night, nights split by a long
 * awakening, sessions without metadata, and several readings of one daily metric.
 * Whatever order the API lists points in, the day must come out the same.
 */

const OFF = '7200s'; // +02:00
const FITBIT = { recordingMethod: 'DERIVED', device: { displayName: 'Fitbit Charge' }, platform: 'FITBIT' };
const OURA = { recordingMethod: 'UNKNOWN', application: { packageName: 'com.ouraring.oura' }, platform: 'HEALTH_CONNECT' };

const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const at = (local: string) => Date.parse(`${local}:00+02:00`);

/** A sleep session between two +02:00 wall-clock times. */
function sleep(
  source: unknown,
  from: string,
  to: string,
  opts: { metadata?: object; staged?: boolean; hypnogram?: boolean; awakeOnlyStages?: boolean } = {},
) {
  const start = at(from);
  const end = at(to);
  const minutes = (end - start) / 60_000;
  const awake = Math.floor(minutes / 10);
  const asleep = minutes - awake;
  const deep = Math.round(asleep * 0.2);
  const rem = Math.round(asleep * 0.2);
  const half = start + (end - start) / 2;
  return {
    dataSource: source,
    sleep: {
      interval: { startTime: iso(start), startUtcOffset: OFF, endTime: iso(end), endUtcOffset: OFF },
      type: 'STAGES',
      metadata: opts.metadata ?? { mainSleep: true },
      summary: {
        minutesInSleepPeriod: String(minutes),
        minutesAsleep: String(asleep),
        minutesAwake: String(awake),
        stagesSummary:
          opts.staged === false
            ? [{ type: 'AWAKE', minutes: String(awake) }, { type: 'RESTLESS', minutes: '6' }]
            : [
                { type: 'DEEP', minutes: String(deep) },
                { type: 'LIGHT', minutes: String(asleep - deep - rem) },
                { type: 'REM', minutes: String(rem) },
                { type: 'AWAKE', minutes: String(awake) },
              ],
      },
      stages: opts.awakeOnlyStages
        ? [{ type: 'AWAKE', startTime: iso(start), endTime: iso(start + 600_000) }]
        : opts.hypnogram
          ? [
              { type: 'LIGHT', startTime: iso(start), endTime: iso(half) },
              { type: 'DEEP', startTime: iso(half), endTime: iso(end) },
            ]
          : [],
      shortAwakenings: [],
    },
  };
}

const days = (dataType: string, points: unknown[]) =>
  normalize([{ stream: STREAMS_BY_TYPE.get(dataType)!, points: points as any[] }]).days;

/** Normalise both ways round and insist the results match. */
function bothOrders(dataType: string, points: unknown[]) {
  const forward = days(dataType, points);
  const backward = days(dataType, [...points].reverse());
  const sorted = (m: typeof forward) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  assert.deepEqual(sorted(backward), sorted(forward), 'the API’s order must not matter');
  return forward;
}

describe('one sleep, one session', () => {
  it('counts a night recorded by two devices once, keeping the staged copy', () => {
    const fitbit = sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T07:00', { hypnogram: true });
    const oura = sleep(OURA, '2026-08-17T22:50', '2026-08-18T07:20', { staged: false }); // longer, unstaged
    const d = bothOrders('sleep', [fitbit, oura]).get('2026-08-18')!;
    assert.equal(d.sleep!.source!.label, 'Fitbit Charge');
    assert.equal(d.naps.length, 0, 'the second copy is not a nap');
  });

  it('keeps the longer of two staged copies, and the main-sleep flag the other one carried', () => {
    // Google flags only one copy as the main sleep. Here it's the shorter one, on an
    // afternoon sleep that without the flag would read as a nap.
    const flagged = sleep(OURA, '2026-08-18T14:00', '2026-08-18T16:30');
    const longer = sleep(FITBIT, '2026-08-18T13:55', '2026-08-18T16:40', { metadata: {} });
    const d = bothOrders('sleep', [flagged, longer]).get('2026-08-18')!;
    assert.equal(d.sleep!.source!.label, 'Fitbit Charge');
    assert.equal(d.naps.length, 0);
  });

  it('joins a night split by a long awakening, counting the break as awake', () => {
    const first = sleep(FITBIT, '2026-08-17T22:00', '2026-08-18T01:15', { metadata: { mainSleep: false }, hypnogram: true });
    const second = sleep(FITBIT, '2026-08-18T03:00', '2026-08-18T07:00', { hypnogram: true });
    const d = bothOrders('sleep', [first, second]).get('2026-08-18')!;
    const night = d.sleep!;
    assert.equal(night.bedtimeMin, 22 * 60);
    assert.equal(night.wakeMin, 7 * 60);
    assert.equal(night.minutesAsleep, 176 + 216, 'both pieces count');
    assert.equal(night.minutesInBed, 195 + 105 + 240, 'the 1h45 break sits inside the night');
    assert.equal(night.minutesAwake, 19 + 105 + 24);
    assert.equal(night.stages!.awake, 19 + 105 + 24);
    const gap = night.segments.find((s) => s.stage === 'awake' && s.durationMin === 105);
    assert.ok(gap, 'the hypnogram shows the break as awake');
    assert.equal(gap!.offsetMin, 195);
    assert.equal(d.naps.length, 0);
  });

  it('joins a first piece that ended before midnight onto the night it belongs to', () => {
    const evening = sleep(FITBIT, '2026-08-17T21:30', '2026-08-17T23:50', { metadata: { mainSleep: false } });
    const rest = sleep(FITBIT, '2026-08-18T01:00', '2026-08-18T07:00');
    const out = bothOrders('sleep', [evening, rest]);
    assert.equal(out.get('2026-08-18')!.sleep!.bedtimeMin, 21 * 60 + 30);
    assert.equal(out.get('2026-08-17')?.sleep ?? null, null);
    assert.equal(out.get('2026-08-17')?.naps.length ?? 0, 0);
  });

  it('keeps a sleep resumed mid-morning separate from the night', () => {
    const night = sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T05:50');
    const later = sleep(FITBIT, '2026-08-18T08:30', '2026-08-18T10:30', { metadata: {} });
    const d = bothOrders('sleep', [night, later]).get('2026-08-18')!;
    assert.equal(d.sleep!.wakeMin, 5 * 60 + 50);
    assert.equal(d.naps.length, 1);
  });

  it('keeps an evening doze separate from the night', () => {
    const doze = sleep(FITBIT, '2026-08-17T19:00', '2026-08-17T20:30', { metadata: {} });
    const night = sleep(FITBIT, '2026-08-17T22:30', '2026-08-18T06:30');
    const out = bothOrders('sleep', [doze, night]);
    assert.equal(out.get('2026-08-18')!.sleep!.bedtimeMin, 22 * 60 + 30);
    assert.equal(out.get('2026-08-17')!.naps.length, 1);
  });

  it('keeps a morning nap after getting up separate from the night', () => {
    const night = sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T07:00');
    const nap = sleep(FITBIT, '2026-08-18T09:00', '2026-08-18T10:00', { metadata: {} });
    const d = bothOrders('sleep', [night, nap]).get('2026-08-18')!;
    assert.equal(d.sleep!.wakeMin, 7 * 60);
    assert.equal(d.naps.length, 1);
    assert.equal(d.naps[0].isNap, true);
  });

  it('leaves an explicit nap before bed alone', () => {
    const nap = sleep(FITBIT, '2026-08-17T20:30', '2026-08-17T21:10', { metadata: { nap: true } });
    const night = sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T07:00');
    const out = bothOrders('sleep', [nap, night]);
    assert.equal(out.get('2026-08-17')!.naps.length, 1);
    assert.equal(out.get('2026-08-18')!.sleep!.bedtimeMin, 23 * 60);
  });

  it('treats a short night without metadata as the night, not a nap', () => {
    const shortNight = sleep(FITBIT, '2026-08-18T00:30', '2026-08-18T03:10', { metadata: {} });
    const afternoon = sleep(FITBIT, '2026-08-18T14:00', '2026-08-18T15:00', { metadata: {} });
    const d = bothOrders('sleep', [shortNight, afternoon]).get('2026-08-18')!;
    assert.ok(d.sleep, 'the worst nights must not disappear');
    assert.equal(d.sleep!.minutesAsleep, 144);
    assert.equal(d.naps.length, 1);
    assert.equal(d.naps[0].bedtimeMin, 14 * 60);
  });

  it('gives an unstaged night no stages and no hypnogram', () => {
    const classic = sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T07:00', { staged: false, awakeOnlyStages: true });
    const night = days('sleep', [classic]).get('2026-08-18')!.sleep!;
    assert.equal(night.stages, null, 'AWAKE and RESTLESS alone are not staging: no "0% deep + REM"');
    assert.deepEqual(night.segments, []);
  });

  it('counts a night and a nap on one day as one day observed', () => {
    const res = normalize([{
      stream: STREAMS_BY_TYPE.get('sleep')!,
      points: [
        sleep(FITBIT, '2026-08-17T23:00', '2026-08-18T07:00'),
        sleep(FITBIT, '2026-08-18T14:00', '2026-08-18T14:40', { metadata: { nap: true } }),
      ],
    }]);
    assert.equal(res.counts.get('sleep'), 1);
  });
});

describe('several readings of one daily metric', () => {
  const hrv = (source: unknown, fields: object) => ({
    dataSource: source,
    dailyHeartRateVariability: { date: ghDateFromCivil('2026-08-18'), ...fields },
  });
  const full = hrv(FITBIT, {
    averageHeartRateVariabilityMilliseconds: 41.2,
    deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 39.8,
    nonRemHeartRateBeatsPerMinute: '58',
    entropy: 2.8,
  });

  it('never lets a partial reading wipe a complete one', () => {
    const partial = hrv(OURA, { deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 45 });
    const d = bothOrders('daily-heart-rate-variability', [full, partial]).get('2026-08-18')!;
    assert.equal(d.hrv, 41.2);
    assert.equal(d.hrvDeepSleep, 39.8);
    assert.equal(d.sourceByType['daily-heart-rate-variability'], 'FITBIT:Fitbit Charge');
  });

  it('fills what the better reading lacks', () => {
    const noDeep = hrv(FITBIT, { averageHeartRateVariabilityMilliseconds: 41.2, nonRemHeartRateBeatsPerMinute: '58' });
    const deepOnly = hrv(OURA, { deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 45 });
    const d = bothOrders('daily-heart-rate-variability', [noDeep, deepOnly]).get('2026-08-18')!;
    assert.equal(d.hrv, 41.2);
    assert.equal(d.hrvDeepSleep, 45);
  });

  it('picks the same of two complete readings whichever comes first', () => {
    const other = hrv(OURA, {
      averageHeartRateVariabilityMilliseconds: 52,
      deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 50,
      nonRemHeartRateBeatsPerMinute: '55',
      entropy: 2.6,
    });
    bothOrders('daily-heart-rate-variability', [full, other]);
  });

  it('keeps the earliest weigh-in of the day', () => {
    const weigh = (time: string, grams: number) => ({
      dataSource: FITBIT,
      weight: { sampleTime: { physicalTime: time, utcOffset: OFF }, weightGrams: grams },
    });
    const d = bothOrders('weight', [weigh('2026-08-18T05:10:00Z', 80400), weigh('2026-08-18T19:30:00Z', 81600)]);
    assert.equal(d.get('2026-08-18')!.weightKg, 80.4);
  });

  it('reads the VO₂max covariance', () => {
    const points = buildFixturePayloads()['daily-vo2-max'].dataPoints as unknown[];
    assert.equal(days('daily-vo2-max', points).get('2026-08-18')!.vo2MaxCovariance, 2.46);
  });
});
