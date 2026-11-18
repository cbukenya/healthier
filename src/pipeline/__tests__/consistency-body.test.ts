import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { emptyRecord, normalize } from '../normalize';
import { STREAMS } from '../registry';
import { rollupPoint } from '../fixtures';
import { shownGrams, shownLitres, waterSpan } from '../eating';
import { groupSeries } from '../aggregate';
import { pageFloor } from '../insights/cards/floors';
import type { InsightContext } from '../insights/context';
import type { CycleSummary } from '../cycle';
import type { DailyRecord } from '../../types/health';

const HYDRATION = STREAMS.find((s) => s.dataType === 'hydration-log')!;
const TODAY: CivilDate = '2026-10-12';

/** `count` finished days before TODAY and TODAY itself, each with the water given (null for none logged). */
function waterDays(litres: (number | null)[]): DailyRecord[] {
  return litres.map((l, i) => ({ ...emptyRecord(addDays(TODAY, i - litres.length + 1)), hydrationL: l }));
}

describe('water, protein and fibre are judged by the figure the page shows', () => {
  it('keeps a logged day to the 10 ml it came in, so 1.95 L stays under a 2.0 L target', () => {
    const { days } = normalize([{
      stream: HYDRATION,
      points: [rollupPoint('2026-10-10', 'hydrationLog', { amountConsumed: { millilitersSum: 1950, userProvidedUnitLast: 'MILLILITER' } })],
    }]);
    const l = days.get('2026-10-10')!.hydrationL!;
    assert.equal(l, 1.95);
    assert.equal(shownLitres(l), 1.95, 'shown as 1.95, not rounded up to 2.0');
    const w = waterSpan(waterDays([1.95, 2.0, 2.05, 0.25]), TODAY, 2.0);
    assert.equal(w.met, 2, '2.0 and 2.05 reach it; 1.95 does not, and today is not judged');
    assert.equal(w.logged, 3);
  });

  it('judges a week of water on the same hundredths its tooltip shows', () => {
    // Three days averaging 1.99666…: shown as 2.0, so it reaches the target, as the shade says.
    const near = waterDays([2.0, 2.0, 1.99, null]).map((d) => ({ date: d.date, value: d.hydrationL }));
    const [week] = groupSeries(near.slice(0, 3), 'week');
    assert.ok(week.value! < 2);
    assert.equal(shownLitres(week.value!), 2);
    // A week averaging 1.97 shows as 1.97 and stays under.
    assert.equal(shownLitres(1.9733333), 1.97);
  });

  it('counts protein and fibre in whole grams, as the chart and its sentence show them', () => {
    assert.equal(shownGrams(112.9), 113, 'a day of 112.9 g reads 113 g and reaches a 113 g target');
    assert.equal(shownGrams(112.4), 112, 'a day of 112.4 g reads 112 g and stays under it');
    assert.equal(shownGrams(29.7), 30);
  });
});

describe('the Cycle page card for a cycle with nothing standing out', () => {
  const summaryWith = (current: Partial<CycleSummary['current']> | null) =>
    ({ current: current && { start: '2026-09-21', next: null, day: 22, ...current } }) as unknown as CycleSummary;
  const titleFor = (current: Partial<CycleSummary['current']> | null) =>
    pageFloor('cycle', { cycle: { summary: summaryWith(current) } } as unknown as InsightContext, []).title;

  it('says "about" the day when the start was found in the nights, as the page does', () => {
    assert.equal(titleFor({ source: 'found' }), 'About day 22 of your cycle');
  });

  it('keeps the day plain when the start was logged', () => {
    assert.equal(titleFor({ source: 'logged' }), 'Day 22 of your cycle');
  });

  it('names no day without a cycle under way', () => {
    assert.equal(titleFor(null), 'Your cycles');
  });
});
