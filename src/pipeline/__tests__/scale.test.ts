import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { niceScale } from '../../lib/scale';

describe('chart axis scale', () => {
  it('rounds a breathing-rate range to whole breaths', () => {
    assert.deepEqual(niceScale(11.8, 14.8), [11, 12, 13, 14, 15]);
  });

  it('steps in tens across a wide HRV range', () => {
    assert.deepEqual(niceScale(17.4, 55.2), [10, 20, 30, 40, 50, 60]);
  });

  it('covers both ends, so a usual band reaching past the readings still fits', () => {
    const t = niceScale(73, 76.64);
    assert.ok(t[0] <= 73 && t.at(-1)! >= 76.64, t.join(', '));
  });

  it('gives a flat series room above and below', () => {
    const t = niceScale(40.1, 40.1);
    assert.ok(t.length >= 3 && t[0] < 40.1 && t.at(-1)! > 40.1, t.join(', '));
  });
});
