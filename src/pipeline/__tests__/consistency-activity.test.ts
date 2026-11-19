import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import { completedDays, fullDays } from '../derive';
import { DEMO_CLOCK, DEMO_DAYS, buildDemoPayloads } from '../demo';
import { createFixtureFetch } from '../fixtures';
import { DEFAULT_GOALS, WHO_WEEK } from '../goals';
import { HISTORY_QUERIES } from '../insights';
import { evaluate } from '../insights/engine';
import { whoWeek } from '../insights/helpers';
import { monthSummary, weekSummary } from '../insights/summary';
import { emptyRecord } from '../normalize';
import { DASHBOARD_WINDOW_DAYS, syncWithHistory, type SyncResult } from '../sync';
import type { DailyRecord } from '../../types/health';

/**
 * Movement figures that show on more than one page read the same days the same way: Today's week
 * and month, Activity's Last 7 days, its span summary and chart averages, and the activity insights.
 */

/** n days from 1 July 2026 (a Wednesday), 9,000 steps and 20 brisk minutes each unless `fill` says otherwise. */
function grid(n: number, fill: (d: DailyRecord, i: number) => void = () => {}): DailyRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const d = emptyRecord(addDays('2026-07-01', i));
    d.steps = 9000;
    d.activeMinutes = { light: 100, moderate: 20, vigorous: 0 };
    fill(d, i);
    return d;
  });
}

const found = (days: DailyRecord[], id: string) =>
  evaluate({ days } as any, new Date(`${days.at(-1)!.date}T08:00:00`))!.found.find((f) => f.id === id);

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('activity figures on every page', () => {
  it('counts a stretch against the WHO’s 150 one way, leaving out days that recorded nothing', () => {
    const days = grid(7);
    assert.deepEqual(whoWeek(days), { unit: 'brisk', total: 140, days: 7, perWeek: 140 });
    days[2].activeMinutes = null;
    days[3].activeMinutes = null;
    assert.deepEqual(whoWeek(days), { unit: 'brisk', total: 100, days: 5, perWeek: 140 }, 'a blank day is not a zero');
    days[0].zoneMinutes = { fatBurn: 10, cardio: 5, peak: 0 };
    assert.deepEqual(whoWeek(days), { unit: 'azm', total: 20, days: 1, perWeek: 140 });
    assert.equal(whoWeek([emptyRecord('2026-07-01')]), null);
  });

  it('reads "the last n days" as the n full days before today', () => {
    const days = grid(40);
    const today = days.at(-1)!.date;
    const full = fullDays(days, today, 30);
    assert.equal(full.length, 30);
    assert.equal(full[0].date, addDays(today, -30));
    assert.equal(full.at(-1)!.date, addDays(today, -1));
    assert.deepEqual(fullDays(days, today, 7), completedDays(days).slice(-7), 'Activity’s Last 7 days');
  });

  it('gives Activity’s 30-day summary and Today’s month the same days and the same figures', () => {
    const goal = DEFAULT_GOALS.steps;
    const days = grid(40, (d, i) => {
      d.steps = 6000 + ((i * 3779) % 9000);
      d.activeMinutes = { light: 100, moderate: (i * 7) % 40, vigorous: i % 3 === 0 ? 10 : 0 };
    });
    days[39].steps = 30000; // today, still climbing: neither counts it
    days[9].steps = 25000; // 30 full days back: both count it
    const month = monthSummary(days)!;
    const full = fullDays(days, days.at(-1)!.date, 30);
    const steps = full.map((d) => d.steps!);
    assert.equal(month.steps!.avg, mean(steps), 'the steps chart’s average and Today’s month');
    assert.equal(month.steps!.atGoal, steps.filter((s) => s >= goal).length, 'days over the goal');
    assert.equal(month.activeMinutes!.perWeek, whoWeek(full)!.perWeek, 'the average week against the WHO’s 150');
    assert.equal(month.activeMinutes!.total, whoWeek(full)!.total);
  });

  it('averages the month’s weeks over the days that recorded minutes, as every other average does', () => {
    const days = grid(40);
    for (const i of [15, 16, 17, 18, 19, 20]) days[i].activeMinutes = null;
    const month = monthSummary(days)!;
    assert.equal(month.activeMinutes!.perWeek, 140, 'six blank days leave a week of 20 a day at 140, not 112');
    assert.equal(month.activeMinutes!.total, 24 * 20);
    assert.equal(weekSummary(days)!.activeMinutes!.total, 140, 'the week still says what the seven days earned');
  });
});

describe('the brisk activity card', () => {
  /** 28 days to Tue 28 July: 14–20 July at `before` minutes a day, 21–27 July at `now`, and today far ahead. */
  const weeks = (before: number, now: number, zone = false) =>
    grid(28, (d, i) => {
      const m = i >= 20 && i < 27 ? now : before;
      d.activeMinutes = { light: 100, moderate: i === 27 ? 500 : m, vigorous: 0 };
      if (zone) d.zoneMinutes = { fatBurn: i === 27 ? 500 : m, cardio: 0, peak: 0 };
    });

  it('says the Last 7 days figure against the week before, in the same count', () => {
    const days = weeks(10, 20);
    const card = found(days, 'mvpa-up')!;
    assert.equal(card.text,
      `You did 140 minutes of brisk activity over the last 7 days, up from 70 the week before, with harder minutes counting double. The WHO recommends ${WHO_WEEK} a week.`);
    assert.equal(whoWeek(completedDays(days).slice(-7))!.total, 140, 'Activity’s Last 7 days');
    assert.equal(weekSummary(days)!.activeMinutes!.total, 140, 'Today’s week');

    const zone = weeks(10, 20, true);
    assert.equal(found(zone, 'mvpa-up')!.text,
      `You earned 140 active zone minutes over the last 7 days, up from 70 the week before. The WHO recommends ${WHO_WEEK} a week.`);
    assert.equal(found(weeks(20, 10, true), 'mvpa-down')!.text,
      'You earned 70 active zone minutes over the last 7 days, down from 140 the week before.');
  });

  it('needs a quarter more or less, a fifth of the WHO’s week, and six days on record in each week', () => {
    assert.ok(found(weeks(10, 15), 'mvpa-up'), '70 to 105: half as much again, 35 more');
    assert.equal(found(weeks(10, 14), 'mvpa-up'), undefined, '70 to 98: 40% more, but 28 minutes is under a fifth of 150');
    assert.equal(found(weeks(30, 36), 'mvpa-up'), undefined, '210 to 252: 42 more, but only a fifth more');
    const gaps = weeks(10, 20);
    gaps[20].activeMinutes = null;
    gaps[21].activeMinutes = null;
    assert.equal(found(gaps, 'mvpa-up'), undefined, 'two blank days would read as a drop or hide a rise');
  });
});

describe('activity cards say which week they mean', () => {
  it('a rolling week is the last 7 days against the week before', () => {
    const days = grid(28, (d, i) => { d.steps = i >= 20 ? 12000 : 8000; });
    assert.match(found(days, 'steps-up')!.text, /^You're averaging 12,000 steps a day over the last 7 days, up from 8,000 the week before\./);
    const down = grid(28, (d, i) => { d.steps = i >= 20 ? 6000 : 9000; });
    assert.match(found(down, 'steps-down')!.text, /^You've averaged 6,000 steps a day over the last 7 days, compared with 9,000 the week before\./);
  });

  it('the WHO’s week and the marathon count from Monday, and say so', () => {
    // Tue 28 July: Monday's 100 and Tuesday's 60 brisk minutes cross the 150.
    const days = grid(28, (d, i) => {
      d.activeMinutes = { light: 100, moderate: i === 26 ? 100 : i === 27 ? 60 : 0, vigorous: 0 };
      d.distanceKm = i >= 26 ? 22 : 1;
    });
    assert.match(found(days, 'who-week')!.text, /^You've done 160 minutes of brisk activity since Monday,/);
    assert.match(found(days, 'activity-distance')!.text, /^You've covered 44\.0 km since Monday\./);
  });
});

describe('the demo, every page on Monday 12 October', () => {
  let data: SyncResult;
  before(async () => {
    ({ data } = await syncWithHistory({
      token: 'demo', fetchImpl: createFixtureFetch(buildDemoPayloads()), windowDays: DASHBOARD_WINDOW_DAYS,
      historyDays: DEMO_DAYS, now: DEMO_CLOCK.now, timeZone: DEMO_CLOCK.timeZone, includeIntraday: false, queries: HISTORY_QUERIES,
    }));
  });

  it('reads 504 active zone minutes for 5–11 October on Today, Activity and the brisk activity card, its workouts included', () => {
    const days = data.days;
    assert.equal(weekSummary(days)!.activeMinutes!.total, 504);
    assert.equal(whoWeek(completedDays(days).slice(-7))!.total, 504);
    const card = evaluate(data, DEMO_CLOCK.now, { timeZone: DEMO_CLOCK.timeZone })!.found.find((f) => f.id === 'mvpa-up')!;
    assert.equal(card.text, 'You earned 504 active zone minutes over the last 7 days, up from 356 the week before. The WHO recommends 150 a week.');
  });

  it('gives Activity’s 30-day summary the figures Today’s month shows', () => {
    const days = data.days;
    const month = monthSummary(days)!;
    const full = fullDays(days, days.at(-1)!.date, 30);
    const steps = full.map((d) => d.steps!).filter((s) => s !== null);
    assert.equal(Math.round(month.steps!.avg), 10971);
    assert.equal(Math.round(mean(steps)), 10971, 'the steps chart’s average, today left out');
    assert.equal(month.steps!.atGoal, 17);
    assert.equal(steps.filter((s) => s >= DEFAULT_GOALS.steps).length, 17, 'days over 10,000');
    assert.equal(Math.round(month.activeMinutes!.perWeek), 341);
    assert.equal(Math.round(whoWeek(full)!.perWeek), 341, 'active zone minutes a week');
  });
});
