import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import type { Cycle, CycleSummary } from '../cycle';
import {
  BOTH_FOUND_DAYS, FOUND_START_DAYS, currentShape, cycleShape, dayPlusMinus, lengthPlusMinus, ovulationOn,
  ovulationWindow, phaseMix, phaseOn,
} from '../cyclePhases';

/**
 * The Cycle page's phases: named crisply for words, blended for drawing over the days each
 * boundary could fall on, and with a ± for every day or length that rests on a found start.
 */

const start = '2026-08-23';
const cycle = (over: Partial<Cycle> = {}): Cycle => ({
  start, source: 'logged', next: addDays(start, 29), length: 29, rise: addDays(start, 18), periodDays: 5, weight: 1, ...over,
});
const summary = (over: Partial<CycleSummary> = {}) => ({
  length: { min: 26, max: 31, typical: 29, count: 6, logged: 2, found: 4 },
  early: null,
  period: { min: 4, max: 5, typical: 5, count: 3 },
  current: null,
  ...over,
}) as unknown as CycleSummary;

describe('the phases of a cycle', () => {
  const logged = cycle();
  const next = cycle({ start: addDays(start, 29) });
  const shape = cycleShape(logged, next, summary());

  it('names each day: the period, the follicular phase, ovulation the day before the luteal phase, early and late luteal', () => {
    const names = Array.from({ length: 29 }, (_, i) => phaseOn(i + 1, shape));
    assert.deepEqual(names.slice(0, 5), Array(5).fill('menstrual'));
    assert.deepEqual(names.slice(5, 16), Array(11).fill('follicular'));
    assert.deepEqual(names.slice(16, 19), ['ovulation', 'ovulation', 'ovulation'], 'days 17 to 19, around day 18');
    assert.deepEqual(names.slice(19, 24), Array(5).fill('earlyLuteal'));
    assert.deepEqual(names.slice(24), Array(5).fill('lateLuteal'), 'the last five days');
    assert.equal(phaseOn(33, shape), 'lateLuteal', 'a cycle running long stays late luteal');
  });

  it('blends each boundary over the days it could fall on, sharp where the period was logged', () => {
    for (let d = 1; d <= 35; d++) {
      const mix = phaseMix(d, shape);
      assert.ok(Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) < 1e-9, `day ${d} adds to 1`);
    }
    assert.equal(phaseMix(5, shape).menstrual, 1, 'a logged period is sharp');
    assert.equal(phaseMix(6, shape).follicular, 1);
    const found = cycleShape(cycle({ source: 'found', periodDays: null }), next, summary());
    assert.ok(phaseMix(5, found).menstrual < 1 && phaseMix(6, found).menstrual > 0, 'a found period blends');
    const toLuteal = [17, 18, 19, 20, 21].map((d) => phaseMix(d, shape).earlyLuteal);
    assert.ok(toLuteal.every((v, i) => i === 0 || v >= toLuteal[i - 1]), 'the luteal phase rises through its blend');
    assert.ok(toLuteal[0] > 0 && toLuteal[4] === 1);
  });

  it('puts ovulation the day before the luteal phase, fading over the days it could be', () => {
    assert.deepEqual(ovulationWindow(shape), { day: 18, spread: 3 });
    assert.equal(ovulationOn(18, shape), 1);
    assert.ok(ovulationOn(16, shape) > 0 && ovulationOn(16, shape) < ovulationOn(17, shape));
    assert.equal(ovulationOn(10, shape), 0);
    assert.equal(ovulationOn(25, shape), 0);
  });

  it('is surer of a luteal phase counted back from a logged period than from a found one', () => {
    const fromFound = cycleShape(logged, cycle({ start: addDays(start, 29), source: 'found' }), summary());
    assert.ok(fromFound.lutealBlend > shape.lutealBlend);
    assert.ok(ovulationOn(15, fromFound) > ovulationOn(15, shape), 'a wider fade');
  });

  it('draws the cycle under way ahead of today, from the typical cycle, before its luteal phase has come', () => {
    const now = cycle({ next: null, length: null, rise: null });
    const s = summary({ current: { ...now, day: 12, riseDay: null, phase: 'before-rise' } });
    const ahead = currentShape(s)!;
    assert.equal(ahead.luteal, 29 - 11 + 1);
    assert.equal(ahead.length, 29);
    assert.equal(phaseOn(12, ahead), 'follicular');
    assert.equal(phaseOn(22, ahead), 'earlyLuteal');
    // With no typical cycle and no early guess, nothing past the period can be placed.
    const blank = currentShape(summary({ length: null, current: { ...now, day: 12, riseDay: null, phase: 'before-rise' } }))!;
    assert.equal(blank.luteal, null);
    assert.equal(phaseOn(20, blank), 'follicular');
    assert.equal(ovulationOn(15, blank), 0);
  });

  it('gives a found period the usual logged length, or five days', () => {
    assert.equal(cycleShape(cycle({ source: 'found', periodDays: null }), next, summary()).periodDays, 5);
    assert.equal(cycleShape(cycle({ source: 'found', periodDays: null }), next, summary({ period: { min: 3, max: 4, typical: 4, count: 3 } })).periodDays, 4);
    assert.equal(cycleShape(cycle({ source: 'found', periodDays: null }), next, summary({ period: null })).periodDays, 5);
  });

  it('says how far a day or a length may be off: nothing when logged, more for each found end', () => {
    assert.equal(dayPlusMinus(logged), 0);
    assert.equal(dayPlusMinus(cycle({ source: 'found' })), FOUND_START_DAYS);
    assert.equal(lengthPlusMinus(logged, next), 0);
    assert.equal(lengthPlusMinus(cycle({ source: 'found' }), next), FOUND_START_DAYS);
    assert.equal(lengthPlusMinus(logged, cycle({ source: 'found' })), FOUND_START_DAYS);
    assert.equal(lengthPlusMinus(cycle({ source: 'found' }), cycle({ source: 'found' })), BOTH_FOUND_DAYS);
  });
});
