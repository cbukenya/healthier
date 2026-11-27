import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import { emptyRecord } from '../normalize';
import type { DailyRecord } from '../../types/health';
import {
  activityPoints, heartDirection, heartScoreOn, heartScoreTrend, hrvTrendPoints, nextStage, restingHrPoints, stageOf,
  type HeartTrendPoint,
} from '../heartScore';

/**
 * The heart score: each part on its fixed rule, the weighted average over the parts there are,
 * and the pointer to what would help most.
 */

const START = '2026-01-01';
const END = addDays(START, 69);

/** 70 days, each with the same readings, unless `edit` changes a day. */
function days(
  { brisk = 150, rhr = 60, hrv = 50, level = 'GOOD' as string | null }: { brisk?: number | null; rhr?: number | null; hrv?: number | null; level?: string | null } = {},
  edit: (d: DailyRecord, i: number) => void = () => {},
): DailyRecord[] {
  return Array.from({ length: 70 }, (_, i) => {
    const d = emptyRecord(addDays(START, i));
    d.activeMinutes = brisk === null ? null : { light: 100, moderate: brisk / 7, vigorous: 0 };
    d.restingHr = rhr;
    d.hrv = hrv;
    if (level) {
      d.vo2Max = 44;
      d.cardioFitnessLevel = level;
    }
    edit(d, i);
    return d;
  });
}

describe('heart score parts', () => {
  it('scores activity on the Life’s Essential 8 table', () => {
    assert.deepEqual([0, 1, 29, 30, 59, 60, 89, 90, 119, 120, 149, 150, 400].map(activityPoints), [0, 20, 20, 40, 40, 60, 60, 80, 80, 90, 90, 100, 100]);
  });

  it('scores resting heart rate from 60 bpm down, never marking a low one down', () => {
    assert.deepEqual([40, 60, 66, 72, 80, 100, 120].map(restingHrPoints), [100, 100, 85, 70, 50, 0, 0]);
  });

  it('scores the HRV trend around 50 for no change', () => {
    assert.deepEqual([-50, -16, 0, 4, 40].map(hrvTrendPoints), [0, 30, 50, 55, 100]);
  });

  it('names the stages and the one above', () => {
    assert.deepEqual([100, 85, 84, 70, 69, 50, 49, 0].map(stageOf), ['thriving', 'thriving', 'strong', 'strong', 'building', 'building', 'low', 'low']);
    assert.deepEqual(nextStage(66), { id: 'strong', min: 70 });
    assert.equal(nextStage(90), null);
  });
});

describe('heart score', () => {
  it('averages the parts by weight', () => {
    // Activity 100 × 35, fitness Good 75 × 30, resting 100 × 25, HRV steady 50 × 10.
    const s = heartScoreOn(days(), END);
    assert.equal(s.parts.activity?.points, 100);
    assert.equal(s.parts.fitness?.points, 75);
    assert.equal(s.parts.restingHr?.points, 100);
    assert.equal(s.parts.hrv?.points, 50);
    assert.equal(s.score, Math.round(35 + 22.5 + 25 + 5));
    assert.equal(s.stage, 'thriving');
  });

  it('points at the part with the most still to gain', () => {
    // Fitness Fair leaves 30% × 60 = 18; activity at 95 minutes leaves 35% × 20 = 7.
    const s = heartScoreOn(days({ brisk: 95, rhr: 66, level: 'FAIR' }), END);
    assert.equal(s.lever, 'fitness');
    assert.equal(Math.round(s.gains.fitness!), 18);
    assert.equal(s.keep, null);
  });

  it('gives ties to activity, the part that changes fastest', () => {
    // Activity at 95 minutes leaves 35% × 20 = 7; HRV down 16% (30 points) leaves 10% × 70 = 7.
    const s = heartScoreOn(days({ brisk: 95, level: 'EXCELLENT' }, (d, i) => { d.hrv = i >= 42 ? 42 : 50; }), END);
    assert.equal(Math.round(s.gains.activity! * 100), Math.round(s.gains.hrv! * 100));
    assert.equal(s.lever, 'activity');
  });

  it('from Thriving with every part at 70 or more, says what keeps it there instead', () => {
    const s = heartScoreOn(days({ level: 'EXCELLENT' }, (d, i) => { d.hrv = i >= 42 ? 60 : 50; }), END);
    assert.equal(s.stage, 'thriving');
    assert.equal(s.lever, null);
    assert.equal(s.keep, 'activity');
  });

  it('shares a missing part’s weight among the others, and waits for 3 parts', () => {
    const three = heartScoreOn(days({ level: null }), END);
    assert.equal(three.parts.fitness, undefined);
    // Activity 100 × 35, resting 100 × 25, HRV 50 × 10, over 70.
    assert.equal(three.score, Math.round((3500 + 2500 + 500) / 70));
    const two = heartScoreOn(days({ level: null, hrv: null }), END);
    assert.equal(two.score, null);
    assert.equal(two.lever, null);
  });

  it('leaves the day under way out of the activity average', () => {
    const s = heartScoreOn(days({}, (d, i) => { if (i === 69) d.activeMinutes = { light: 0, moderate: 0, vigorous: 0 }; }), END);
    assert.equal(Math.round(s.parts.activity!.perWeek), 150);
  });

  it('counts vigorous minutes double, as the WHO does', () => {
    const s = heartScoreOn(days({}, (d) => { d.activeMinutes = { light: 0, moderate: 0, vigorous: 75 / 7 }; }), END);
    assert.equal(Math.round(s.parts.activity!.perWeek), 150);
  });

  it('reads resting heart rate and HRV from their first-choice source only', () => {
    const s = heartScoreOn(days({}, (d, i) => {
      if (i >= 40) {
        d.restingHr = 90;
        d.fills = { ...d.fills, restingHr: 'another device' } as DailyRecord['fills'];
      }
    }), END);
    assert.equal(s.parts.restingHr?.bpm, 60);
  });

  it('reads the HRV trend as the last 4 weeks against the 4 before', () => {
    const s = heartScoreOn(days({}, (d, i) => { d.hrv = i >= 42 ? 55 : 50; }), END);
    assert.equal(Math.round(s.parts.hrv!.changePct), 10);
    assert.equal(Math.round(s.parts.hrv!.points * 10), 625);
  });
});

describe('heart score trend', () => {
  it('reads a week apart, ending on the day asked', () => {
    const t = heartScoreTrend(days(), END, 4);
    assert.deepEqual(t.map((p) => p.date), [addDays(END, -21), addDays(END, -14), addDays(END, -7), END]);
  });

  it('says rising, steady or falling from about 3 months back', () => {
    const at = (score: number, weeksBack: number): HeartTrendPoint => ({ date: addDays(END, -7 * weeksBack), score });
    assert.equal(heartDirection([at(60, 12), at(62, 6), at(64, 0)])?.direction, 'rising');
    assert.equal(heartDirection([at(64, 12), at(62, 0)])?.direction, 'steady');
    assert.equal(heartDirection([at(70, 13), at(60, 12), at(66, 0)])?.change, 6);
    assert.equal(heartDirection([at(70, 2), at(60, 0)]), null);
  });
});
