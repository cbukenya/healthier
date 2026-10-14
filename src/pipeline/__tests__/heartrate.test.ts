import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, HOUR, MINUTE, byDay, hourly, lowerBound, tickStep, visibleRuns, wallClock, wallDate, wallTime, wallTimes, zoneOf,
  zoneStops,
} from '../../charts/heartRate';

// As Google sends them: Light from a floor of 30 bpm, so it's everything below Moderate.
const zones = { light: 30, moderate: 106, vigorous: 131, peak: 161 };
const COLORS = ['light', 'moderate', 'vigorous', 'peak'];

describe('heart rate chart', () => {
  it('reads time off the wall clock, with midnight on whole days', () => {
    const t = wallTime({ date: '2026-10-14', minutesOfDay: 23 * 60 + 46 });
    assert.equal(wallDate(t), '2026-10-14');
    assert.equal(wallClock(t), '23:46');
    assert.equal(wallTime({ date: '2026-10-15', minutesOfDay: 0 }) % DAY, 0);
    const samples = [
      { date: '2026-10-14', minutesOfDay: 1439 },
      { date: '2026-10-15', minutesOfDay: 0 },
      { date: '2026-10-15', minutesOfDay: 1 },
    ];
    assert.deepEqual([...wallTimes(samples)], samples.map(wallTime), 'each date parsed once gives the same times');
  });

  it('puts a reading in its zone: light below moderate, sleep included', () => {
    assert.equal(zoneOf(48, zones), 0, 'a sleeping heart is in Light');
    assert.equal(zoneOf(105, zones), 0);
    assert.equal(zoneOf(106, zones), 1, 'a zone starts at its own minimum');
    assert.equal(zoneOf(130, zones), 1);
    assert.equal(zoneOf(131, zones), 2);
    assert.equal(zoneOf(175, zones), 3);
  });

  it('colours the line by zone from the top of the scale down, easing over each boundary', () => {
    const stops = zoneStops(zones, 40, 180, COLORS, 'plain');
    assert.equal(stops[0].color, 'peak', '180 bpm is peak');
    assert.equal(stops.at(-1)!.color, 'light', '40 bpm is light');
    assert.ok(stops.every((s, i) => i === 0 || s.offset >= stops[i - 1].offset), 'offsets climb');
    // Vigorous starts at 131 bpm, (180 − 131) / 140 of the way down: vigorous above, moderate below.
    const below = stops.findIndex((s) => s.color === 'moderate');
    assert.equal(stops[below - 1].color, 'vigorous');
    assert.ok(Math.abs(stops[below - 1].offset - ((180 - 131) / 140 - 0.016)) < 1e-9);
    assert.ok(Math.abs(stops[below].offset - ((180 - 131) / 140 + 0.016)) < 1e-9);
    assert.deepEqual(zoneStops(null, 40, 180, COLORS, 'plain').map((s) => s.color), ['plain', 'plain']);
    // A boundary off the scale draws no blend.
    assert.equal(zoneStops(zones, 40, 120, COLORS, 'plain').filter((s) => s.color === 'peak').length, 0);
  });

  it('finds where a time falls in sorted readings', () => {
    const ts = [10, 20, 30];
    assert.equal(lowerBound(ts, 5), 0);
    assert.equal(lowerBound(ts, 20), 1);
    assert.equal(lowerBound(ts, 25), 2);
    assert.equal(lowerBound(ts, 99), 3);
  });

  it('spaces the hour labels so they never crowd', () => {
    assert.equal(tickStep(DAY, 700), 4 * HOUR);
    assert.equal(tickStep(30 * MINUTE, 700), 5 * MINUTE);
    assert.equal(tickStep(3 * DAY, 300), DAY);
  });

  it('breaks the line where the watch was off, and keeps peaks when there are more readings than pixels', () => {
    const ts: number[] = [];
    const vs: number[] = [];
    for (let m = 0; m < 600; m++) {
      if (m >= 200 && m < 230) continue; // half an hour on the charger
      ts.push(m * MINUTE);
      vs.push(m === 400 ? 170 : 60);
    }
    const runs = visibleRuns(ts, vs, 0, 600 * MINUTE, 1000);
    assert.equal(runs.length, 2, 'two runs around the gap');
    const thin = visibleRuns(ts, vs, 0, 600 * MINUTE, 50);
    assert.ok(thin.flat().length <= 2 * 50 + 4, 'at most two readings a pixel');
    assert.ok(thin.flat().some((p) => p.v === 170), 'the one-minute peak survives');
  });

  it('cuts a run at midnight without breaking the line', () => {
    const t0 = wallTime({ date: '2026-10-13', minutesOfDay: 23 * 60 + 58 });
    const run = [0, 1, 2, 3].map((k) => ({ t: t0 + k * MINUTE, v: 60 + k }));
    const days = byDay([run]);
    assert.deepEqual(days.map((d) => d.date), ['2026-10-13', '2026-10-14']);
    assert.equal(days[0].points.at(-1)!.t, days[1].points[0].t, 'the first reading after midnight ends the day before');
  });

  it('averages each hour for the strip of every day', () => {
    const ts = [0, 30, 59, 60, 61].map((m) => m * MINUTE);
    const pts = hourly(ts, [60, 70, 80, 100, 120]);
    assert.deepEqual(pts.map((p) => p.v), [70, 110]);
  });
});
