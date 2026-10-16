import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, ghDateFromCivil, type CivilDate } from '../../lib/date';
import { nightsFrom, standardized } from '../cycle';
import { compareToBaseline, sameDevice, series } from '../derive';
import { assembleDays, type StreamDay } from '../incremental';
import { normalize, parseSource, sourceFromId } from '../normalize';
import { STREAMS_BY_TYPE } from '../registry';
import {
  DATA_SOURCE_FAMILY, DEFAULT_SOURCE_PREFS, fullerRef, ownReading, parseSourcePrefs, readSourcePrefs, sourceOrders, sourceRanking, type SourcePrefs,
} from '../sources';
import { HealthTransport } from '../transport';

/**
 * Devices and sources: every source's reading is kept, the day's reading is picked when it's
 * read, a reading from a source other than the first choice is a fill, and a fill is judged only
 * against its own source's readings.
 */

const HRV = 'daily-heart-rate-variability';
const WATCH = { platform: 'FITBIT', recordingMethod: 'DERIVED', device: { displayName: 'Pixel Watch', formFactor: 'WATCH' } };
const RING = { platform: 'HEALTH_CONNECT', recordingMethod: 'UNKNOWN', device: { formFactor: 'RING' }, application: { packageName: 'com.example.ring' } };
const WATCH_ID = 'FITBIT:Pixel Watch';
const RING_ID = 'HEALTH_CONNECT:Ring';

const hrvPoint = (source: unknown, date: CivilDate, ms: number) => ({
  dataSource: source,
  dailyHeartRateVariability: { date: ghDateFromCivil(date), averageHeartRateVariabilityMilliseconds: ms, nonRemHeartRateBeatsPerMinute: '55' },
});

describe('the choices', () => {
  it('reads what the app sends, strictly, and what was stored, leniently', () => {
    const ok = parseSourcePrefs({ order: [RING_ID, WATCH_ID, RING_ID], off: [], perReading: { sleep: WATCH_ID }, totals: 'worn' });
    assert.deepEqual(ok, { order: [RING_ID, WATCH_ID], off: [], perReading: { sleep: WATCH_ID }, totals: 'worn' }, 'duplicates go');
    assert.equal(parseSourcePrefs({ totals: 'phone' }), null, 'an unknown kind of source');
    assert.equal(parseSourcePrefs({ perReading: { steps: WATCH_ID } }), null, 'steps are a daily total, chosen by kind only');
    assert.equal(parseSourcePrefs({ order: ['x'.repeat(301)] }), null);
    assert.equal(parseSourcePrefs([]), null);
    assert.deepEqual(readSourcePrefs(null), DEFAULT_SOURCE_PREFS);
    assert.deepEqual(readSourcePrefs({ totals: 'phone' }), DEFAULT_SOURCE_PREFS);
    assert.equal(DATA_SOURCE_FAMILY.all, null, 'every source is Google\'s default, so it isn\'t sent');
    assert.equal(DATA_SOURCE_FAMILY.worn, 'users/me/dataSourceFamilies/google-wearables');
  });

  it('tries the reading\'s first choice, then the order, then the rest, most recent first, never one switched off', () => {
    const seen = new Map([
      [HRV, new Map([
        [WATCH_ID, { latest: '2026-08-20', days: 50 }],
        [RING_ID, { latest: '2026-08-20', days: 20 }],
        ['FITBIT:Old Band', { latest: '2026-04-01', days: 200 }],
      ])],
      ['sleep', new Map([[WATCH_ID, { latest: '2026-08-20', days: 50 }], [RING_ID, { latest: '2026-08-19', days: 40 }]])],
      // The ring stopped sending breathing rate in the spring, and still comes first for it, as for the rest.
      ['daily-respiratory-rate', new Map([[RING_ID, { latest: '2026-04-02', days: 30 }], [WATCH_ID, { latest: '2026-08-20', days: 50 }]])],
    ]);
    assert.deepEqual(sourceRanking(seen, DEFAULT_SOURCE_PREFS), [WATCH_ID, RING_ID, 'FITBIT:Old Band'], 'recent first, then more days');
    assert.deepEqual(sourceOrders(seen, DEFAULT_SOURCE_PREFS).get(HRV), [WATCH_ID, RING_ID, 'FITBIT:Old Band']);
    const prefs: SourcePrefs = { order: [RING_ID], off: ['FITBIT:Old Band'], perReading: { sleep: WATCH_ID }, totals: 'all' };
    const orders = sourceOrders(seen, prefs);
    assert.deepEqual(sourceRanking(seen, prefs), [RING_ID, WATCH_ID, 'FITBIT:Old Band'], 'one switched off keeps its place in the list');
    assert.deepEqual(orders.get(HRV), [RING_ID, WATCH_ID]);
    assert.deepEqual(orders.get('sleep'), [WATCH_ID, RING_ID], 'a first choice for the reading leads');
    assert.deepEqual(orders.get('daily-respiratory-rate'), [RING_ID, WATCH_ID], 'one order for every reading');
    assert.deepEqual(sourceOrders(seen, { ...prefs, order: ['FITBIT:Gone', RING_ID] }).get(HRV), [RING_ID, WATCH_ID], 'a source never seen is skipped');
    assert.deepEqual(sourceOrders(seen, { ...prefs, off: [WATCH_ID, RING_ID] }).get('sleep'), [], 'all switched off: nothing is read');
  });

  it('describes a source by its fullest description', () => {
    const typed = { id: RING_ID, label: 'Ring', platform: 'HEALTH_CONNECT', method: 'MANUAL', app: 'com.example.ring' } as const;
    const worn = { ...typed, method: 'PASSIVELY_MEASURED', formFactor: 'RING' } as const;
    assert.equal(fullerRef(fullerRef(undefined, typed), worn), worn);
    assert.equal(fullerRef(worn, typed), worn);
  });

  it('names a source known only by its id, as parseSource made it', () => {
    const ref = parseSource({ platform: 'HEALTH_KIT', recordingMethod: 'UNKNOWN', application: { packageName: 'com.huawei.iossporthealth' } })!;
    assert.equal(ref.label, 'Huawei Health');
    assert.deepEqual(sourceFromId(ref.id), { id: ref.id, label: 'Huawei Health', platform: 'HEALTH_KIT', method: 'UNKNOWN' });
  });
});

describe('every source\'s reading, kept', () => {
  it('keeps each source\'s own reading for a day two reported, and none for a day one did', () => {
    const stream = STREAMS_BY_TYPE.get(HRV)!;
    const { days, variants } = normalize([{ stream, points: [hrvPoint(WATCH, '2026-08-10', 40), hrvPoint(RING, '2026-08-10', 52), hrvPoint(WATCH, '2026-08-11', 41)] }]);
    const own = variants.get(HRV)!;
    assert.deepEqual([...own.keys()], ['2026-08-10']);
    assert.equal(own.get('2026-08-10')!.get(WATCH_ID)!.hrv, 40);
    assert.equal(own.get('2026-08-10')!.get(RING_ID)!.hrv, 52);
    assert.equal(days.get('2026-08-11')!.hrv, 41);
  });

  it('keeps a day combined when one of its readings names no source', () => {
    const stream = STREAMS_BY_TYPE.get(HRV)!;
    const { variants } = normalize([{ stream, points: [hrvPoint(WATCH, '2026-08-10', 40), hrvPoint(RING, '2026-08-10', 52), hrvPoint(undefined, '2026-08-10', 47), hrvPoint(WATCH, '2026-08-11', 41), hrvPoint(RING, '2026-08-11', 50)] }]);
    assert.deepEqual([...variants.get(HRV)!.keys()], ['2026-08-11']);
  });
});

/** Stored days of one stream: each date's readings by source, the way the sync stores them. */
function stored(dataType: string, field: 'hrv' | 'restingHr', byDate: Record<CivilDate, Record<string, number>>) {
  const days = new Map<CivilDate, StreamDay>();
  for (const [date, bySource] of Object.entries(byDate)) {
    const ids = Object.keys(bySource);
    const first = ids[0];
    const part: StreamDay = { fields: { [field]: bySource[first] }, present: [dataType], sources: [first], sourceByType: { [dataType]: first } };
    if (ids.length > 1) part.variants = Object.fromEntries(ids.map((id) => [id, { fields: { [field]: bySource[id] }, present: [dataType] }]));
    days.set(date, part);
  }
  return days;
}
const choose = (rows: Map<string, Map<CivilDate, StreamDay>>, prefs: SourcePrefs) => {
  const seen = new Map<string, Map<string, { latest: CivilDate; days: number }>>();
  for (const [dataType, days] of rows) {
    const s = new Map<string, { latest: CivilDate; days: number }>();
    for (const [date, part] of days) for (const id of part.variants ? Object.keys(part.variants) : [part.sourceByType[dataType]]) {
      const x = s.get(id);
      if (x) { x.days++; if (date > x.latest) x.latest = date; } else s.set(id, { latest: date, days: 1 });
    }
    seen.set(dataType, s);
  }
  return { prefs, orders: sourceOrders(seen, prefs) };
};

describe('the day\'s reading, picked when it\'s read', () => {
  // The watch every night but the 3rd, when it was charging and the ring filled in; both on the 2nd.
  const rows = new Map([[HRV, stored(HRV, 'hrv', {
    '2026-08-01': { [WATCH_ID]: 40 },
    '2026-08-02': { [WATCH_ID]: 42, [RING_ID]: 55 },
    '2026-08-03': { [RING_ID]: 58 },
    '2026-08-04': { [WATCH_ID]: 41 },
  })]]);

  it('takes the first choice that has a reading, and marks a reading from another as a fill, with its source', () => {
    const days = assembleDays(rows, '2026-08-01', '2026-08-04', choose(rows, DEFAULT_SOURCE_PREFS));
    assert.deepEqual(days.map((d) => d.hrv), [40, 42, 58, 41]);
    assert.equal(days[1].fills, undefined, 'the watch\'s night where both reported');
    assert.deepEqual(days[2].fills, { hrv: RING_ID });
    assert.equal(days[2].sourceByType[HRV], RING_ID);
  });

  it('changes with the choice at once, with nothing fetched', () => {
    const ring = choose(rows, { ...DEFAULT_SOURCE_PREFS, order: [RING_ID, WATCH_ID] });
    const days = assembleDays(rows, '2026-08-01', '2026-08-04', ring);
    assert.deepEqual(days.map((d) => d.hrv), [40, 55, 58, 41]);
    assert.deepEqual(days[0].fills, { hrv: WATCH_ID }, 'now the watch fills in');
    const off = assembleDays(rows, '2026-08-01', '2026-08-04', choose(rows, { ...DEFAULT_SOURCE_PREFS, off: [RING_ID] }));
    assert.deepEqual(off.map((d) => d.hrv), [40, 42, null, 41], 'a source switched off is left out');
    const perReading = assembleDays(rows, '2026-08-01', '2026-08-04', choose(rows, { ...DEFAULT_SOURCE_PREFS, perReading: { [HRV]: RING_ID } }));
    assert.equal(perReading[1].hrv, 55);
  });

  it('reads stored days without a choice by the default one over them', () => {
    assert.deepEqual(assembleDays(rows, '2026-08-01', '2026-08-04').map((d) => d.hrv), [40, 42, 58, 41]);
  });
});

describe('like with like', () => {
  // 30 nights of the watch around 40, and the ring around 55 on the nights it filled in.
  const start = '2026-07-01';
  const byDate: Record<CivilDate, Record<string, number>> = {};
  for (let i = 0; i < 30; i++) {
    const date = addDays(start, i);
    byDate[date] = i % 6 === 5 ? { [RING_ID]: 55 + (i % 3) } : { [WATCH_ID]: 40 + (i % 3) };
  }
  byDate[addDays(start, 30)] = { [RING_ID]: 57 };
  const rows = new Map([[HRV, stored(HRV, 'hrv', byDate)]]);
  const days = assembleDays(rows, start, addDays(start, 30), choose(rows, { ...DEFAULT_SOURCE_PREFS, order: [WATCH_ID] }));

  it('labels a fill with its source, and leaves the others plain', () => {
    const s = series(days, (d) => d.hrv);
    assert.equal(s[5].source, RING_ID);
    assert.equal(s[4].source, undefined);
  });

  it('judges a night only against earlier nights from its own source', () => {
    // The ring's last night against the ring's own nights: usual for the ring, not far above the watch.
    const ring = compareToBaseline(series(days, (d) => d.hrv), 28, 4);
    assert.equal(ring.source, RING_ID);
    assert.ok(Math.abs(ring.baseline! - 56) <= 1, 'the ring\'s own middle');
    assert.equal(ring.band, 'typical');
    // The watch's nights, judged with the ring's left out: its baseline stays the watch's.
    const watch = compareToBaseline(series(days.slice(0, 29), (d) => d.hrv));
    assert.equal(watch.source, undefined);
    assert.ok(Math.abs(watch.baseline! - 41) <= 1);
    assert.ok(watch.n < 25, 'the ring\'s nights aren\'t in it');
  });

  it('keeps the battery\'s baseline to the first choice, and leaves a night here and there out of the cycle finder', () => {
    const s = sameDevice(days, HRV, (d) => d.hrv);
    assert.equal(s[5].value, 57, 'a fill is still there, with its source');
    assert.equal(s[5].source, RING_ID);
    const nights = nightsFrom(days);
    assert.equal(nights[5].hrv, null, 'too few of the ring\'s nights around to read it against');
    assert.equal(nights[4].hrv, 41);
    assert.equal(ownReading(days[5], 'hrv'), null);
  });
});

describe('a change of device', () => {
  // A band until the 60th night, then the watch, the first choice: HRV around 60 on the band, 40 on the watch.
  const BAND_ID = 'FITBIT:Charge 5';
  const start = '2026-03-01';
  const byDate: Record<CivilDate, Record<string, number>> = {};
  for (let i = 0; i < 120; i++) byDate[addDays(start, i)] = { [i < 60 ? BAND_ID : WATCH_ID]: (i < 60 ? 60 : 40) + (i % 2 ? 1 : -1) };
  const rows = new Map([[HRV, stored(HRV, 'hrv', byDate)]]);
  const days = assembleDays(rows, start, addDays(start, 119), choose(rows, { ...DEFAULT_SOURCE_PREFS, order: [WATCH_ID] }));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  it('keeps the nights from the old one for the cycle finder, each read against its own device\'s', () => {
    const nights = nightsFrom(days);
    assert.equal(nights[10].hrv, 59, 'two months on the band stay');
    assert.equal(nights[10].fill?.hrv, true);
    assert.equal(nights[70].fill, undefined);
    const z = standardized(nights.map((n) => n.hrv), nights.map((n) => !!n.fill?.hrv));
    const around = z.slice(50, 70).filter((v): v is number => v !== null);
    assert.equal(around.length, 20);
    assert.ok(Math.abs(mean(around)) < 0.2, 'no step where the device changed');
    const together = standardized(nights.map((n) => n.hrv)).slice(50, 60) as number[];
    assert.ok(mean(together) > 0.5, 'read together, the band\'s last nights would look high');
  });
});

describe('what counts in daily totals', () => {
  it('goes to Google with each rollup when it isn\'t every source', async () => {
    const bodies: any[] = [];
    const transport = new HealthTransport({
      token: 't', maxRetries: 0,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ rollupDataPoints: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await transport.rollup('steps', '2026-08-01', '2026-08-03', DATA_SOURCE_FAMILY.worn);
    await transport.rollup('steps', '2026-08-01', '2026-08-03', DATA_SOURCE_FAMILY.all);
    await transport.rollUpWindows('heart-rate', { startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-02T00:00:00Z' }, '60s', { dataSourceFamily: DATA_SOURCE_FAMILY.google });
    assert.equal(bodies[0].dataSourceFamily, 'users/me/dataSourceFamilies/google-wearables');
    assert.equal('dataSourceFamily' in bodies[1], false);
    assert.equal(bodies[2].dataSourceFamily, 'users/me/dataSourceFamilies/google-sources');
  });
});

