import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import {
  bucketFor,
  bucketForSeries,
  bucketLabel,
  bucketStart,
  groupDays,
  groupNights,
  groupRange,
  groupSeries,
} from '../aggregate';
import { emptyRecord } from '../normalize';
import type { DailyRecord } from '../../types/health';

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

describe('choosing a bucket', () => {
  it('keeps days up to 120, weeks up to two years, months beyond', () => {
    assert.equal(bucketFor(90), 'day');
    assert.equal(bucketFor(120), 'day');
    assert.equal(bucketFor(365), 'week');
    assert.equal(bucketFor(730), 'week');
    assert.equal(bucketFor(1000), 'month');
  });

  it('leaves sparse series raw however long the span', () => {
    const weighIns = days('2025-10-01', 365).map((date, i) => ({ date, value: i % 7 === 0 ? 80 : null }));
    assert.equal(bucketForSeries(weighIns, 365), 'day', '53 readings fit');
    const steps = days('2025-10-01', 365).map((date) => ({ date, value: 8000 }));
    assert.equal(bucketForSeries(steps, 365), 'week');
  });
});

describe('grouping', () => {
  it('starts weeks on Monday and months on the 1st', () => {
    assert.equal(bucketStart('2026-10-11', 'week'), '2026-10-05'); // a Sunday
    assert.equal(bucketStart('2026-10-05', 'week'), '2026-10-05');
    assert.equal(bucketStart('2026-10-11', 'month'), '2026-10-01');
  });

  it('averages per recorded day, so a partial week is not a drop', () => {
    // Mon–Sun at 10,000 steps, then a Monday and Tuesday at 10,000 with the rest of that week unrecorded.
    const pts = days('2026-09-28', 9).map((date) => ({ date, value: 10_000 }));
    const weeks = groupSeries(pts, 'week');
    assert.deepEqual(weeks, [
      { date: '2026-09-28', value: 10_000 },
      { date: '2026-10-05', value: 10_000 },
    ]);
  });

  it('keeps empty buckets as gaps', () => {
    const pts = [
      { date: '2026-07-15', value: 70 },
      { date: '2026-09-15', value: 72 },
    ];
    assert.deepEqual(groupSeries(pts, 'month'), [
      { date: '2026-07-01', value: 70 },
      { date: '2026-08-01', value: null },
      { date: '2026-09-01', value: 72 },
    ]);
    assert.equal(groupDays(pts, 'week').filter((g) => !g.days.length).length, 8);
  });

  it('keeps the worst night visible in a range', () => {
    const rec = (date: string, avg: number, low: number, high: number) =>
      ({ ...emptyRecord(date), spo2: { avg, ciLower: low, ciUpper: high, rollingAvgSd: null } }) as DailyRecord;
    const week = [rec('2026-10-05', 96, 94, 98), rec('2026-10-06', 95, 88, 97), rec('2026-10-07', 97, 95, 99)];
    const [g] = groupRange(week, 'week', (d) => d.spo2 && { avg: d.spo2.avg, low: d.spo2.ciLower, high: d.spo2.ciUpper });
    assert.deepEqual(g.value, { avg: 96, low: 88, high: 99 });
  });
});

describe('typical night', () => {
  const night = (date: string, bedtimeMin: number, minutesInBed: number) =>
    ({
      ...emptyRecord(date),
      sleep: { bedtimeMin, minutesInBed, minutesAsleep: minutesInBed - 30 } as DailyRecord['sleep'],
    }) as DailyRecord;

  it('takes medians across midnight: 23:30 and 00:30 make midnight, not noon', () => {
    const [g] = groupNights([night('2026-10-05', 23 * 60 + 30, 480), night('2026-10-06', 30, 480)], 'week');
    assert.equal(g.night!.bedtimeMin, 0); // 00:00
    assert.equal(g.night!.wakeMin, 8 * 60); // 08:00
    assert.equal(g.nights, 2);
  });

  it('reports a week without sleep as empty', () => {
    const groups = groupNights([night('2026-09-28', 23 * 60, 450), night('2026-10-12', 23 * 60, 450)], 'week');
    assert.equal(groups[1].night, null);
  });
});

describe('labels', () => {
  it('names weeks and months', () => {
    assert.equal(bucketLabel('2026-10-05', 'week'), '5 Oct');
    assert.equal(bucketLabel('2026-10-05', 'week', 'full'), 'Week of 5 Oct 2026');
    assert.equal(bucketLabel('2026-10-01', 'month'), 'Oct 26');
    assert.equal(bucketLabel('2026-10-01', 'month', 'full'), 'Oct 2026');
  });
});
