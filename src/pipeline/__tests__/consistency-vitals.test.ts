import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import { compareVital, pillSide, readiness, type Comparison } from '../derive';
import { insightFeeds } from '../insights';
import { EMPTY_CYCLE_LOG, summarizeCycles } from '../cycle';
import { emptyRecord } from '../normalize';
import { formatRounded } from '../../i18n/format';
import type { DailyRecord } from '../../types/health';

/**
 * The same figure and the same verdict wherever a vital shows: the battery's lines and reasons
 * against the pills beside them, and the all-quiet card against the Vitals tiles.
 */

const START = '2026-07-01';
// The jitter pipeline.test.ts uses: median at zero with a spread, and day 27 lands on the zero.
const CYC = [1, -0.5, 0, 0.5, -1];

/** 28 steady days ending 2026-07-28, the last one changed by `last`. */
function steadyDays(n = 28, last: (d: DailyRecord) => void = () => {}, base: { restingHr?: number } = {}): DailyRecord[] {
  const days: DailyRecord[] = [];
  for (let i = 0; i < n; i++) {
    const d = emptyRecord(addDays(START, i));
    const j = CYC[i % 5];
    d.hrv = 34 + j * 5;
    d.restingHr = (base.restingHr ?? 62) + j * 2;
    d.respiratoryRate = 14 + j * 0.5;
    d.steps = 8000 + CYC[(i + 1) % 5] * 1200;
    d.skinTempDeviationC = j * 0.05;
    const mins = 450 + j * 20;
    d.sleep = {
      date: d.date, isMainSleep: true, isNap: false,
      bedtimeMin: 1380, wakeMin: 420, bedtimeIso: '', wakeIso: '',
      minutesAsleep: mins, onsetLatencyMin: null, minutesAwake: 10, minutesInBed: mins + 10,
      efficiency: 97, stages: null, segments: [], shortAwakeningsMin: [],
    };
    days.push(d);
  }
  last(days[n - 1]);
  return days;
}

const MORNING = new Date('2026-07-28T08:00:00Z');
const tracking = (judged: DailyRecord[]) => {
  const log = { ...EMPTY_CYCLE_LOG, settings: { tracking: true, todayCards: true, otherPages: true } };
  return { summary: summarizeCycles([], log, judged[judged.length - 1].date)!, nights: [], log, judged };
};
const feeds = (days: DailyRecord[], judged: DailyRecord[] | null = null) =>
  insightFeeds({ days } as any, MORNING, { timeZone: 'UTC', cycle: judged ? tracking(judged) : undefined });
const cards = (f: ReturnType<typeof feeds>) => [...f.today, ...Object.values(f.pages).flat()];

/** A value `z` spreads from the usual the last of `days` is judged against. */
const atZ = (days: DailyRecord[], key: 'restingHr' | 'breathing' | 'hrv', z: number) => {
  const c = compareVital(days, key);
  return c.baseline! + z * c.spread!;
};

describe('pillSide: the pill verdict words can share', () => {
  const c = (band: Comparison['band'], over: Partial<Comparison> = {}): Comparison =>
    ({ value: 1, baseline: 1, spread: 1, delta: 0, deltaPct: 0, z: 0, band, n: 28, date: '2026-07-28', ...over });

  it('names the side a reading is off on, either way, and nothing inside the range', () => {
    assert.equal(pillSide(c('typical')), null);
    assert.equal(pillSide(c('above')), 'above');
    assert.equal(pillSide(c('far-above')), 'above');
    assert.equal(pillSide(c('below')), 'below');
    assert.equal(pillSide(c('far-below')), 'below');
    assert.equal(pillSide(c(null, { n: 3 })), null, 'no usual range yet, no verdict');
  });

  it('steps aside when the same night is usual for this part of the cycle, as the pill does', () => {
    assert.equal(pillSide(c('above'), c('typical')), null);
    assert.equal(pillSide(c('above'), c('typical', { date: '2026-07-27' })), 'above', 'another night explains nothing');
    assert.equal(pillSide(c('above'), c('above')), 'above');
  });
});

describe('the battery says what the pills say', () => {
  it('calls breathing elevated only once its pill is off, and charges for it the same either way', () => {
    const base = steadyDays();
    for (const z of [1.3, 1.45, 1.6, 2.2]) {
      const days = steadyDays(28, (d) => { d.respiratoryRate = atZ(base, 'breathing', z); });
      const pill = compareVital(days, 'breathing');
      const p = readiness(days).parts.find((x) => x.id === 'breathing')!;
      assert.ok(p, `z ${z}: the penalty starts at 1.25 spreads`);
      assert.ok(Math.abs(p.contribution - -Math.min((pill.z! - 1.25) * 4, 8)) < 1e-9, `z ${z}: the penalty is unchanged`);
      assert.equal(/elevated/.test(p.detail), pillSide(pill) === 'above', `z ${z}: "${p.detail}" beside a ${pill.band} pill`);
    }
  });

  it('says a reason is "higher than usual" only beside a pill that says so, and "a little" beside one in range', () => {
    const base = steadyDays();
    const seen = { plain: 0, little: 0 };
    const check = (days: DailyRecord[], judged: DailyRecord[] | null) => {
      const f = feeds(days, judged);
      for (const o of f.today.filter((x) => x.id.startsWith('battery'))) {
        for (const [key, re] of [
          ['restingHr', /resting heart rate is (a little )?(higher|lower) than usual/],
          ['hrv', /HRV (?:is|came in) (a little )?(higher|lower) than usual/],
        ] as const) {
          const m = o.text.match(re);
          if (!m) continue;
          const pill = pillSide(compareVital(days, key), judged && compareVital(judged, key));
          const side = m[2] === 'higher' ? 'above' : 'below';
          if (m[1]) seen.little++; else seen.plain++;
          assert.equal(!m[1], pill === side, `"${o.text}" beside a pill off ${pill ?? 'nowhere'}`);
        }
      }
    };
    // A morning that drops eight points or more names its main reason: resting heart rate here.
    for (const z of [1.4, 1.45, 1.6, 1.8, 2.2]) {
      const days = steadyDays(28, (d) => { d.restingHr = atZ(base, 'restingHr', z); });
      check(days, null);
      // With the cycle explaining part of it, the pill says "usual for this part of your cycle".
      check(days, steadyDays(28, (d) => { d.restingHr = atZ(base, 'restingHr', 1.3); }));
    }
    for (const hrv of [27, 26, 25, 24, 22, 20]) check(steadyDays(28, (d) => { d.hrv = hrv; }), null);
    assert.ok(seen.plain > 0 && seen.little > 0, `both wordings exercised: ${JSON.stringify(seen)}`);
  });

  it('shows HRV and resting heart rate in whole numbers, as the Vitals tiles do', () => {
    // A usual of 62.5 bpm: the battery said "62.5" where Vitals said "63".
    const days = steadyDays(28, () => {}, { restingHr: 62.5 });
    const rhr = compareVital(days, 'restingHr');
    assert.equal(rhr.baseline, 62.5);
    const r = readiness(days);
    assert.equal(r.parts.find((p) => p.id === 'restingHr')!.detail,
      `${formatRounded(rhr.value!, 0)} bpm vs ${formatRounded(rhr.baseline!, 0)} bpm typical`);
    assert.match(r.parts.find((p) => p.id === 'hrv')!.detail, /^\d+ ms last night · 7-day \d+ vs \d+ ms typical$/);
    days.forEach((d, i) => { d.hrvDeepSleep = 33.5 + CYC[i % 5] * 4; });
    assert.match(readiness(days).parts.find((p) => p.id === 'hrv')!.detail, /^In deep sleep: \d+ ms last night · 7-day \d+ vs \d+ ms typical$/,
      'the qualifier covers all three figures');
  });
});

describe('the all-quiet card and the Vitals tiles', () => {
  const quiet = (days: DailyRecord[], judged: DailyRecord[] | null = null) =>
    cards(feeds(days, judged)).find((o) => o.id === 'vitals-all-quiet');

  it('waits while a tile shows last night outside its usual range', () => {
    const base = steadyDays();
    assert.ok(quiet(base), 'a steady month');
    for (const [key, set] of [
      ['breathing', (d: DailyRecord, v: number) => { d.respiratoryRate = v; }],
      ['restingHr', (d: DailyRecord, v: number) => { d.restingHr = v; }],
      ['hrv', (d: DailyRecord, v: number) => { d.hrv = v; }],
    ] as const) {
      for (const z of [1.7, -1.7]) {
        const days = steadyDays(28, (d) => set(d, atZ(base, key, z)));
        assert.notEqual(compareVital(days, key).band, 'typical', `${key} at ${z} spreads is off its pill`);
        assert.equal(quiet(days), undefined, `${key} at ${z} spreads: no "Everything looks steady" beside it`);
      }
    }
  });

  it('keeps two spreads for the nights before last night', () => {
    const base = steadyDays();
    const days = steadyDays();
    days[25].respiratoryRate = atZ(base.slice(0, 26), 'breathing', 1.7);
    assert.notEqual(compareVital(days.slice(0, 26), 'breathing').band, 'typical');
    assert.ok(quiet(days), 'an older night just outside the band is ordinary');
  });

  it('shows beside a reading the pill calls usual for this part of the cycle', () => {
    const base = steadyDays();
    const days = steadyDays(28, (d) => { d.restingHr = atZ(base, 'restingHr', 1.7); });
    assert.equal(quiet(days), undefined);
    assert.ok(quiet(days, base), 'the cycle explains it, as the pill says');
  });
});
