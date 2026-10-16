import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, daysBetween, type CivilDate } from '../../lib/date';
import {
  EMPTY_CYCLE_LOG, FIRST_SEEN_NIGHTS, SECOND_HALF_DAYS, WEIGHT_FOUND, WEIGHT_LOGGED, byCycleDay, calibrateOffset, cycleAdjusted,
  findStarts, judgedDays, loggedPeriods, nightsFrom, parseCycleDay, parseCycleSettings, readCycleLog, secondHalf, secondHalfDays,
  summarizeCycles, typicalShifts, weightedMedian, withDay, withRejected,
  type CycleDay, type CycleLog, type Night,
} from '../cycle';
import { SHAPES, SHAPE_FROM, type ShapeMeasure } from '../cycleShapes';
import { answerQuery, parseQueries } from '../history';
import { cycleCards } from '../insights/cards/cycle';
import type { InsightContext } from '../insights/context';
import type { Finding } from '../insights/types';
import { emptyRecord } from '../normalize';
import { formatDayMonthLong } from '../../i18n/format';

/**
 * Cycles found in the nights: starts within a day or two from the nights alone on clear nights,
 * most of them within three days on nights as noisy as mcPHASES's, almost none shown to people
 * without cycles, and a logged start winning and counting double.
 */

/** A small seeded generator, so every run draws the same nights. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START: CivilDate = '2026-01-05';

/** Period starts for cycles of these lengths, from START. */
function startsFor(lengths: number[]): CivilDate[] {
  const out = [START];
  for (const l of lengths) out.push(addDays(out[out.length - 1], l));
  return out;
}

/**
 * Nights with a cycle's rhythm: low until the rise, 11 days before the next start, high until two
 * nights before it, low again from the night before (`fallBefore` moves that).
 */
function cycleNights(
  starts: CivilDate[],
  until: CivilDate,
  { noise = 0.04, gaps = 0, seed = 1, fallBefore = 1, low = -0.15, high = 0.25 } = {},
): Night[] {
  const r = seeded(seed);
  const out: Night[] = [];
  for (let date = addDays(starts[0], -12); date <= until; date = addDays(date, 1)) {
    const i = starts.findIndex((s, k) => s <= date && (starts[k + 1] === undefined || date < starts[k + 1]));
    let up = false;
    if (i >= 0 && starts[i + 1]) {
      const next = starts[i + 1];
      const rise = addDays(next, -11);
      up = date >= rise && date < addDays(next, -fallBefore);
    } else if (i >= 0) {
      // The cycle under way: risen 11 days before it would end at 28 days.
      up = date >= addDays(starts[i], 17);
    }
    const temp = (up ? high : low) + (r() - 0.5) * 2 * noise;
    // Heart rate a few beats up, HRV down and breathing a little quicker after the rise, each with its own wobble.
    const cycling = up && high > low;
    const restingHr = 58 + (cycling ? 2.5 : 0) + (r() - 0.5) * 1.6;
    const sleepHr = 54 + (cycling ? 3 : 0) + (r() - 0.5) * 1.6;
    const hrv = 52 - (cycling ? 5 : 0) + (r() - 0.5) * 6;
    const breath = 14.5 + (cycling ? 0.5 : 0) + (r() - 0.5) * 0.6;
    const missing = r() < gaps;
    out.push({
      date,
      temp: missing ? null : Math.round(temp * 100) / 100,
      restingHr: missing ? null : Math.round(restingHr * 10) / 10,
      hrv: missing ? null : Math.round(hrv * 10) / 10,
      sleepHr: missing ? null : Math.round(sleepHr * 10) / 10,
      breath: missing ? null : Math.round(breath * 10) / 10,
    });
  }
  return out;
}

const log = (patch: Partial<CycleLog> = {}): CycleLog => ({
  ...EMPTY_CYCLE_LOG, settings: { tracking: true, todayCards: true, otherPages: true }, ...patch,
});
const started = (...dates: CivilDate[]): CycleDay[] => dates.map((date) => ({ date, flow: 'unspecified' }));

/**
 * Nights like mcPHASES's, in each measure's own spreads: each measure follows its average shape
 * around a period start (cycleShapes.ts), on top of the noise mcPHASES shows once cycles are taken
 * out. A factor moves heart rate, HRV and breathing together from night to night. Each measure
 * also wanders on its own, nights go missing, and now and then a few nights look like being unwell.
 * Without cycles, it's that noise alone.
 */
function likeMcphases(seed: number, cycles: boolean, nightsLong = 240) {
  const r = seeded(seed);
  const gauss = () => { let t = 0; for (let i = 0; i < 12; i++) t += r(); return t - 6; };
  const load: Record<ShapeMeasure, number> = { sleepHr: 0.93, restingHr: 0.37, hrv: -0.71, temp: 0, breath: 0.26 };
  const stick: Record<ShapeMeasure, number> = { sleepHr: 0.15, restingHr: 0.48, hrv: 0.24, temp: 0.14, breath: 0.08 };
  const unwell: Record<ShapeMeasure, number> = { sleepHr: 1, restingHr: 1, hrv: -1, temp: 0.6, breath: 0.5 };
  const measures = Object.keys(SHAPES) as ShapeMeasure[];
  const starts: CivilDate[] = [START];
  while (daysBetween(START, starts[starts.length - 1]) < nightsLong + 40) starts.push(addDays(starts[starts.length - 1], 25 + Math.floor(r() * 8)));
  // Each measure's average shape, in spreads, by day from a start.
  const shapeAt = (m: ShapeMeasure, day: number) => {
    const k = day - SHAPE_FROM;
    return k >= 0 && k < SHAPES[m].shape.length ? SHAPES[m].shape[k] * SHAPES[m].size : 0;
  };
  const own = Object.fromEntries(measures.map((m) => [m, 0])) as Record<ShapeMeasure, number>;
  let shared = 0;
  let spell = 0;
  let spellSize = 0;
  const nights: Night[] = [];
  const today = addDays(START, 40 + nightsLong);
  for (let date = addDays(START, 40); date <= today; date = addDays(date, 1)) {
    shared = 0.2 * shared + Math.sqrt(1 - 0.04) * gauss();
    if (spell <= 0 && r() < 1 / 45) {
      spell = 2 + Math.floor(r() * 5);
      spellSize = 1 + 1.5 * r();
    }
    const bump = spell-- > 0 ? spellSize : 0;
    // The nearest start before and after: the shape runs from 24 nights before one to 10 after.
    const i = starts.findIndex((st, k) => st <= date && (!starts[k + 1] || date < starts[k + 1]));
    const since = daysBetween(starts[i], date);
    const until = starts[i + 1] ? daysBetween(starts[i + 1], date) : -99;
    const off = r() < 0.05;
    const night: Night = { date, temp: null, restingHr: null, hrv: null, sleepHr: null, breath: null };
    for (const m of measures) {
      own[m] = stick[m] * own[m] + Math.sqrt(1 - stick[m] ** 2) * gauss();
      // Noise in the measure's own spreads; with cycles, the cycle takes some of each spread.
      let v = (cycles ? 0.8 : 1) * (load[m] * shared + Math.sqrt(1 - load[m] ** 2) * own[m]) + bump * unwell[m];
      if (cycles) v += since <= 10 ? shapeAt(m, since) : shapeAt(m, until);
      if (!off && r() >= 0.08) night[m] = v;
    }
    nights.push(night);
  }
  return { starts: starts.filter((st) => st > addDays(START, 64) && st <= addDays(today, -FIRST_SEEN_NIGHTS)), today, nights };
}

describe('cycles found in the nights', () => {
  const lengths = [28, 30, 27, 29, 31, 28, 28];
  const starts = startsFor(lengths);
  const today = addDays(starts[starts.length - 1], 17);
  const nights = cycleNights(starts, today);
  const withinDays = (found: CivilDate[], truth: CivilDate[], days: number) =>
    truth.every((t) => found.some((f) => Math.abs(daysBetween(f, t)) <= days));

  it('finds every start within a day or two, from the nights alone', () => {
    const s = summarizeCycles(nights, log(), today);
    // The first start has no nights before it to show its shape.
    assert.ok(withinDays(s.cycles.map((c) => c.start), starts.slice(1), 2), s.cycles.map((c) => c.start).join(' '));
    assert.equal(s.cycles.length, starts.length - 1, 'one start per cycle, no more');
    assert.ok(s.cycles.every((c) => c.source === 'found' && c.weight === WEIGHT_FOUND));
    assert.equal(s.status, 'ready');
    assert.ok(Math.abs(s.current!.day - 18) <= 2, `day ${s.current?.day}`);
    assert.equal(s.current?.phase, 'after-rise');
  });

  it('counts the second half of each ended cycle back from the next start', () => {
    const s = summarizeCycles(nights, log(), today);
    const ended = s.cycles.filter((c) => c.next !== null);
    assert.ok(ended.length >= 5);
    for (const c of ended) assert.equal(c.rise, addDays(c.next!, -SECOND_HALF_DAYS), c.start);

    // Two periods logged closer than any cycle: no second half between them.
    const close = summarizeCycles(nights, log({ days: [{ date: starts[3], flow: 'medium' }, { date: addDays(starts[3], 12), flow: 'medium' }] }), today);
    assert.equal(close.cycles.find((c) => c.start === starts[3])?.rise, null);
  });

  it('gives the typical cycle and its range from the last six, and the next period as a range', () => {
    const s = summarizeCycles(nights, log(), today);
    assert.equal(s.length?.count, 6);
    assert.ok(Math.abs(s.length!.typical - 28.5) <= 1.5 && s.length!.min >= 26 && s.length!.max <= 32, JSON.stringify(s.length));
    assert.equal(s.next?.basis, 'cycles');
    assert.equal(s.next?.from, addDays(s.current!.start, s.length!.min));
    assert.equal(s.next?.to, addDays(s.current!.start, s.length!.max));
    // The chart's second half runs from the day this one began to the typical cycle's last day.
    assert.deepEqual(secondHalfDays(s), { from: s.current!.riseDay, to: s.length!.typical });
    assert.equal(s.current!.riseDay, s.length!.typical - SECOND_HALF_DAYS + 1);
  });

  it('puts the cycle under way in its second half from the likely next period, counted back, right up to the period', () => {
    const latest = starts[starts.length - 1];
    for (let day = 10; day <= 32; day++) {
      const until = addDays(latest, day - 1);
      const s = summarizeCycles(cycleNights(starts, until), log(), until);
      const c = s.current!;
      const riseDay = daysBetween(c.start, s.next!.likely) - SECOND_HALF_DAYS + 1;
      if (c.day < riseDay) {
        assert.equal(c.phase, 'before-rise', `day ${day}`);
        assert.equal(c.rise, null, `day ${day}`);
      } else {
        assert.equal(c.phase, 'after-rise', `day ${day}`);
        assert.equal(c.riseDay, riseDay, `day ${day}`);
      }
    }
  });

  it('keeps going through nights the watch missed', () => {
    const patchy = cycleNights(starts, today, { gaps: 0.15, seed: 7 });
    const s = summarizeCycles(patchy, log(), today);
    assert.ok(withinDays(s.cycles.map((c) => c.start), starts.slice(1), 2), s.cycles.map((c) => c.start).join(' '));
  });

  it('finds no extra cycle in a few feverish nights, and leaves the other cycles where they were', () => {
    // A strong fever just after a period can pull that one start a few days early: the nights
    // after a start are meant to be low.
    const fever = nights.map((n) => {
      const day = daysBetween(starts[2], n.date);
      return day >= 4 && day < 8 ? { ...n, temp: 0.7, restingHr: 66, sleepHr: 63 } : n;
    });
    const s = summarizeCycles(fever, log(), today);
    assert.equal(s.cycles.length, starts.length - 1, 'no extra cycle');
    assert.ok(withinDays(s.cycles.map((c) => c.start), starts.slice(4), 2), 'the cycles after it are untouched');
  });

  it('says it has found no cycles in four months of flat nights, and nothing about cycles', () => {
    const flat = cycleNights([START], addDays(START, 130), { high: -0.15 });
    const s = summarizeCycles(flat, log(), addDays(START, 130));
    assert.equal(s.status, 'no-rhythm');
    assert.equal(s.current, null);
    assert.equal(s.next, null);
    assert.deepEqual(s.found, []);
  });

  it('is collecting, not without rhythm, while there are few nights', () => {
    const few = cycleNights([START], addDays(START, 20), { high: -0.15 });
    assert.equal(summarizeCycles(few, log(), addDays(START, 20)).status, 'collecting');
  });
});

describe('on nights as noisy as mcPHASES', () => {
  it('finds most starts within three days', () => {
    let near = 0;
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { starts, today, nights } = likeMcphases(seed, true);
      const s = summarizeCycles(nights, log(), today);
      for (const truth of starts) {
        total++;
        if (s.cycles.some((c) => Math.abs(daysBetween(c.start, truth)) <= 3)) near++;
      }
    }
    // On mcPHASES itself, with nothing logged: 59% within three days (docs/ARCHITECTURE.md).
    assert.ok(near / total >= 0.55, `${near} of ${total}`);
  });

  it('shows almost no one without cycles any cycle at all', () => {
    let shown = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const { today, nights } = likeMcphases(1000 + seed, false, [90, 150, 240, 300][seed % 4]);
      if (summarizeCycles(nights, log(), today).cycles.length) shown++;
    }
    assert.ok(shown <= 6, `${shown} of 100`);
  });
});

describe('logged and confirmed starts', () => {
  const lengths = [28, 30, 27, 29, 31, 28, 28];
  const starts = startsFor(lengths);
  const today = addDays(starts[starts.length - 1], 17);
  const nights = cycleNights(starts, today);

  it('win over a start found nearby, and count twice as much', () => {
    // Logged a day later than the nights say: the log is what happened.
    const logged = addDays(starts[3], 1);
    const s = summarizeCycles(nights, log({ days: started(logged) }), today);
    const cycle = s.cycles.find((c) => c.start === logged);
    assert.equal(cycle?.source, 'logged');
    assert.ok(!s.cycles.some((c) => c.source === 'found' && Math.abs(daysBetween(c.start, logged)) <= 5), 'the found start gave way');
    const before = s.cycles[s.cycles.indexOf(cycle!) - 1];
    assert.equal(before.weight, WEIGHT_FOUND, 'a cycle is as certain as its least certain end');
    assert.equal(WEIGHT_LOGGED, 2 * WEIGHT_FOUND);
  });

  it("carry the person's own gap between their nights and their period to starts found later", () => {
    // These nights put each start on its day. This person's bleeding comes a day later than the
    // nights say: Healthier learns that from two logged starts.
    const plain = summarizeCycles(nights, log(), today);
    assert.equal(plain.offset, 1);
    assert.ok(plain.cycles.filter((c) => starts.includes(c.start)).length >= plain.cycles.length - 1, 'on their day before any confirmation');
    const s = summarizeCycles(nights, log({ days: started(addDays(starts[1], 1), addDays(starts[2], 1)) }), today);
    assert.equal(s.offset, 2);
    assert.equal(s.offsetLearned, true);
    const found = s.cycles.filter((c) => c.source === 'found').map((c) => c.start);
    assert.ok(found.filter((f) => starts.includes(addDays(f, -1))).length >= found.length - 1, `most now land a day later: ${found.join(' ')}`);
  });

  it('give an early guess at the next period from two cycles, two days wider either side', () => {
    const flat = cycleNights([START], addDays(START, 75), { high: -0.15 });
    const days = started(addDays(START, 2), addDays(START, 30), addDays(START, 59));
    const s = summarizeCycles(flat, log({ days }), addDays(START, 75));
    assert.equal(s.length, null, 'three cycles are needed for the typical cycle');
    assert.deepEqual(s.early && { min: s.early.min, max: s.early.max, count: s.early.count }, { min: 28, max: 29, count: 2 });
    assert.equal(s.next?.basis, 'early');
    assert.equal(s.next?.from, addDays(START, 59 + 28 - 2));
    assert.equal(s.next?.to, addDays(START, 59 + 29 + 2));
    // Day 17: the second half the chart draws is still to come, counted back from the guess.
    assert.equal(s.current?.riseDay, null);
    assert.deepEqual(secondHalfDays(s), { from: 29 - SECOND_HALF_DAYS + 1, to: 29 });
    // Day 22: it has begun, on the day the page says.
    const risen = summarizeCycles(cycleNights([START], addDays(START, 80), { high: -0.15 }), log({ days }), addDays(START, 80));
    assert.equal(risen.current?.riseDay, 29 - SECOND_HALF_DAYS + 1);
    assert.deepEqual(secondHalfDays(risen), { from: risen.current!.riseDay, to: 29 });
    // One cycle: nothing to count back from.
    const one = summarizeCycles(flat, log({ days: started(addDays(START, 2), addDays(START, 30)) }), addDays(START, 40));
    assert.equal(secondHalfDays(one), null);
    // A third cycle and the guess gives way to the typical cycle.
    const later = summarizeCycles(cycleNights([START], addDays(START, 100), { high: -0.15 }), log({ days: [...days, ...started(addDays(START, 87))] }), addDays(START, 100));
    assert.equal(later.next?.basis, 'cycles');
    assert.equal(later.early, null);
  });

  it('count even when the nights show nothing, and are never second-guessed', () => {
    const flat = cycleNights([START], addDays(START, 90), { high: -0.15 });
    const days = started(addDays(START, 2), addDays(START, 30), addDays(START, 59), addDays(START, 87));
    const s = summarizeCycles(flat, log({ days }), addDays(START, 90));
    assert.deepEqual(s.cycles.filter((c) => c.source === 'logged').map((c) => c.start), days.map((d) => d.date));
    assert.equal(s.status, 'ready');
    assert.equal(s.length?.typical, 28);
    assert.equal(s.next?.basis, 'cycles');
  });

  it('show the starts found in faint nights once a period is logged', () => {
    // Someone whose nights show their cycles only faintly: the bar keeps them hidden until a log
    // shows there are cycles to find.
    for (let seed = 1; seed <= 30; seed++) {
      const { starts: truth, today: t, nights: n } = likeMcphases(seed, true);
      if (summarizeCycles(n, log(), t).cycles.length) continue;
      const withLog = summarizeCycles(n, log({ days: started(truth[truth.length - 3]) }), t);
      assert.ok(withLog.cycles.filter((c) => c.source === 'found').length >= 2, `seed ${seed}`);
      return;
    }
  });

  it('drop a found start the person said was not a period', () => {
    const shown = summarizeCycles(nights, log(), today).cycles.map((c) => c.start);
    const third = shown[2];
    const s = summarizeCycles(nights, log({ rejected: [third] }), today);
    assert.ok(!s.cycles.some((c) => c.start === third));
    const merged = s.cycles.find((c) => c.start === shown[1]);
    assert.equal(merged?.length, daysBetween(shown[1], shown[3]));
    assert.equal(s.length?.count, 4, 'a merged cycle is too long to count');
  });

  it('calibrate only from two confirmed starts or more', () => {
    const found = findStarts(cycleNights(starts, today)).starts;
    assert.equal(calibrateOffset(found, [addDays(starts[1], 1)]), 1);
    assert.equal(calibrateOffset(found, [addDays(starts[1], 1), addDays(starts[2], 1)]), 2);
  });
});

describe('the cycle log', () => {
  it('reads a period as a run of bleeding days, spotting aside, a one-day gap allowed', () => {
    const days: CycleDay[] = [
      { date: '2026-03-01', flow: 'spotting' },
      { date: '2026-03-02', flow: 'heavy' },
      { date: '2026-03-03', flow: 'medium' },
      { date: '2026-03-05', flow: 'light' },
      { date: '2026-03-20', flow: 'spotting' },
      { date: '2026-03-29', flow: 'unspecified' },
    ];
    assert.deepEqual(loggedPeriods(days), [
      { start: '2026-03-02', end: '2026-03-05', length: 4 },
      { start: '2026-03-29', end: '2026-03-29', length: null },
    ]);
  });

  it('accepts a day only when everything on it makes sense', () => {
    assert.deepEqual(parseCycleDay('2026-03-02', { flow: 'light', symptoms: ['tired', 'cramps', 'tired'], note: '  ok ' }), {
      date: '2026-03-02', flow: 'light', symptoms: ['cramps', 'tired'], note: 'ok',
    });
    assert.equal(parseCycleDay('2026-02-30', {}), null, 'not a date');
    assert.equal(parseCycleDay('2026-03-02', { flow: 'torrential' }), null);
    assert.equal(parseCycleDay('2026-03-02', { symptoms: ['hiccups'] }), null);
    assert.equal(parseCycleDay('2026-03-02', { note: 'x'.repeat(501) }), null);
    assert.equal(parseCycleSettings({ tracking: 'yes', todayCards: true }), null);
    assert.equal(parseCycleSettings({ tracking: true, todayCards: true, otherPages: 'no' }), null);
    assert.deepEqual(
      parseCycleSettings({ tracking: true, todayCards: false, otherPages: false }),
      { tracking: true, todayCards: false, otherPages: false },
    );
    // A page loaded before the other pages' switch leaves it out: it stays on.
    assert.deepEqual(parseCycleSettings({ tracking: true, todayCards: false }), { tracking: true, todayCards: false, otherPages: true });
  });

  it('reads what it can of a stored log, one day per date, oldest first', () => {
    const read = readCycleLog({
      settings: { tracking: true },
      days: [{ date: '2026-03-05', flow: 'light' }, { date: 'soon', flow: 'light' }, { date: '2026-03-01', symptoms: ['acne'] }, { date: '2026-03-02' }],
      rejected: ['2026-02-01', 'never'],
    });
    assert.deepEqual(read, {
      settings: { tracking: true, todayCards: true, otherPages: true },
      days: [{ date: '2026-03-01', symptoms: ['acne'] }, { date: '2026-03-05', flow: 'light' }],
      rejected: ['2026-02-01'],
    });
    assert.deepEqual(readCycleLog(null), EMPTY_CYCLE_LOG);
  });

  it('replaces a day, removes one left empty, and marks or unmarks a rejected start', () => {
    let l = withDay(log(), { date: '2026-03-02', flow: 'light' });
    l = withDay(l, { date: '2026-03-01', symptoms: ['tired'] });
    assert.deepEqual(l.days.map((d) => d.date), ['2026-03-01', '2026-03-02']);
    l = withDay(l, { date: '2026-03-02' });
    assert.deepEqual(l.days.map((d) => d.date), ['2026-03-01']);
    l = withRejected(l, '2026-04-01', true);
    assert.deepEqual(l.rejected, ['2026-04-01']);
    assert.deepEqual(withRejected(l, '2026-04-01', false).rejected, []);
  });
});

describe('the nights', () => {
  it('come from the history answers before the window, and the window itself', () => {
    const q = parseQueries({ t: { measure: 'skinTempDeviationC', aggregate: 'mean', group: 'day', back: 30 } }).t;
    assert.ok(q, 'a query may group by day');
    const older = ['2026-03-01', '2026-03-02', '2026-03-04'].map((date, i) => ({ ...emptyRecord(date), skinTempDeviationC: 0.1 * i }));
    const answer = answerQuery(q, older, { from: '2026-03-01', to: '2026-03-04' });
    assert.deepEqual(answer.rows.map((r) => [r.key, r.mean]), [['2026-03-01', 0], ['2026-03-02', 0.1], ['2026-03-04', 0.2]]);

    const window = [{ ...emptyRecord('2026-03-05'), skinTempDeviationC: 0.3, restingHr: 61 }, emptyRecord('2026-03-06')];
    const nights = nightsFrom(window, { cycleTemp: answer });
    assert.deepEqual(nights.map((n) => [n.date, n.temp]), [
      ['2026-03-01', 0], ['2026-03-02', 0.1], ['2026-03-03', null], ['2026-03-04', 0.2], ['2026-03-05', 0.3], ['2026-03-06', null],
    ]);
    assert.equal(nights[4].restingHr, 61);
  });

  it('line up by cycle day: the middle of past cycles, and this one so far', () => {
    const starts = startsFor([28, 28, 28, 28, 28, 28, 28]);
    const today = addDays(starts[starts.length - 1], 9);
    const nights = cycleNights(starts, today, { noise: 0 });
    const s = summarizeCycles(nights, log(), today);
    const rows = byCycleDay(nights, s, 'temp');
    assert.equal(rows[0].middle, -0.15, 'low at the start of a cycle');
    assert.equal(rows[20].middle, 0.25, 'high after the rise');
    assert.equal(rows[9].mine, -0.15);
    assert.equal(rows[10].mine, null, 'nothing yet past today');
    assert.equal(rows[30].middle, null, 'no past cycle ran 31 days');
  });
});

describe('allowing for the cycle elsewhere', () => {
  const starts = startsFor([28, 30, 27, 29, 31, 28, 28]);
  const today = addDays(starts[starts.length - 1], 17);
  const nights = cycleNights(starts, today);
  const s = summarizeCycles(nights, log(), today);
  /** The window's days, carrying the nights' readings. */
  const days = nights.slice(-60).map((n) => ({ ...emptyRecord(n.date), skinTempDeviationC: n.temp, restingHr: n.restingHr, hrv: n.hrv }));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  it("finds the person's own second-half shift in each measure, once three cycles show it", () => {
    const shifts = typicalShifts(nights, s);
    assert.ok(Math.abs(shifts.temp! - 0.4) < 0.05, `temperature ${shifts.temp}`);
    assert.ok(Math.abs(shifts.restingHr! - 2.5) < 0.6, `resting heart rate ${shifts.restingHr}`);
    assert.ok(Math.abs(shifts.hrv! + 5) < 1.5, `HRV ${shifts.hrv}`);

    // Two complete cycles aren't enough to say, so nothing is judged differently.
    const early = startsFor([28, 30]);
    const until = addDays(early[early.length - 1], 17);
    const few = cycleNights(early, until);
    const summary = summarizeCycles(few, log(), until);
    assert.deepEqual(typicalShifts(few, summary), { temp: null, restingHr: null, hrv: null });
    assert.equal(judgedDays(days, few, summary, until), null);
  });

  it('moves only second-half nights, by whole steps, and leaves the rest as they were', () => {
    const shifts = typicalShifts(nights, s);
    const judged = cycleAdjusted(days, s, shifts, today);
    const half = secondHalf(s, today);
    assert.ok(half.has(today), 'this cycle has risen: today is in its second half');
    assert.ok(!half.has(starts[starts.length - 1]), 'a period is in the first half');
    days.forEach((d, i) => {
      const j = judged[i];
      if (!half.has(d.date)) return assert.deepEqual(j, d);
      assert.ok(near(d.restingHr! - j.restingHr!, Math.round(shifts.restingHr!)), d.date);
      assert.ok(near(j.hrv! - d.hrv!, -Math.round(shifts.hrv!)), d.date);
      assert.ok(near(d.skinTempDeviationC! - j.skinTempDeviationC!, Math.round(shifts.temp! * 100) / 100), d.date);
    });
  });
});

describe('cycle cards', () => {
  const starts = startsFor([28, 30, 27, 29, 31, 28, 28]);
  const latest = starts[starts.length - 1];
  const quiet = log({ settings: { tracking: true, todayCards: false, otherPages: true } });
  /** The cards on a morning, from the nights up to it. */
  const cardsOn = (today: CivilDate, l = log(), tweak: (n: Night) => Night = (n) => n) => {
    const nights = cycleNights(starts, today).map(tweak);
    const summary = summarizeCycles(nights, l, today);
    const cards: Finding[] = [];
    cycleCards({ today, cycle: { summary, nights, log: l, judged: null } } as unknown as InsightContext, (f) => cards.push(f));
    return { summary, card: (id: string) => cards.find((f) => f.id === id) };
  };

  it('says a period is due from two days before it is likely until the range ends, on Today only if allowed', () => {
    // Each morning against that morning's range: the found start, and so the range, can move a day.
    let soon = 0;
    let due = 0;
    for (let day = 17; day <= 34; day++) {
      const morning = addDays(latest, day - 1);
      const { summary, card } = cardsOn(morning);
      const next = summary.next;
      const c = card('cycle-due');
      const inWindow = !!next && summary.current!.day >= 18 && morning >= addDays(next.from, -2) && morning <= next.to;
      assert.equal(!!c, inWindow, `${morning}`);
      if (!c) continue;
      assert.equal(c.today, 'while-true');
      assert.ok(c.text.includes(formatDayMonthLong(next!.from)), c.text);
      if (morning < next!.from) {
        soon++;
        assert.equal(c.title, 'Your period is likely in the next few days');
        assert.match(c.text, /^Your last 6 cycles ran \d+ to \d+ days, so your next period is likely between /);
      } else {
        due++;
        assert.equal(c.title, 'Your period could start any day now');
        assert.match(c.text, /If it has started, you can log it on the Cycle page\. If you don't, Healthier will find it in your nights a few days later\./);
        assert.equal(cardsOn(morning, quiet).card('cycle-due')!.today, 'never', 'on the Cycle page instead');
      }
    }
    assert.ok(soon >= 1 && due >= 1, `${soon} soon, ${due} due`);
  });

  it('tells Today about a new cycle in its first week, once it can be found, and only if allowed', () => {
    // A start can be found once FIRST_SEEN_NIGHTS nights from it are in.
    const shown: CivilDate[] = [];
    for (let k = 0; k <= 12; k++) {
      const morning = addDays(latest, k);
      const { summary, card } = cardsOn(morning);
      const c = card('cycle-new');
      if (!c) continue;
      shown.push(morning);
      assert.equal(c.kind, 'nudge', 'a nudge: on Today, never on the Cycle page, which has its own');
      assert.ok(summary.current!.day <= FIRST_SEEN_NIGHTS + 4, `${morning}: day ${summary.current!.day}`);
    }
    assert.ok(shown.length >= 3, shown.join(' '));
    assert.ok(shown.every((d) => d <= addDays(latest, 7)), 'not past the first week');
    const first = shown[0];
    assert.match(
      cardsOn(first).card('cycle-new')!.text,
      /^Your heart rate, HRV and temperature changed the way they do when a period starts, so day 1 of a new cycle was about .+, give or take a few days\. If that's right, there's nothing to do\./,
    );
    assert.equal(cardsOn(first, quiet).card('cycle-new'), undefined);
    assert.equal(cardsOn(first, log({ days: started(latest) })).card('cycle-new'), undefined, 'a logged start needs no card');
  });

  it('notices what repeats: shorter sleep before a period, the heart in the second half, regular cycles', () => {
    const today = addDays(latest, 17);
    const shorter = (n: Night): Night => ({ ...n, asleep: starts.some((st) => n.date < st && n.date >= addDays(st, -4)) ? 380 : 430 });
    const { card } = cardsOn(today, log(), shorter);
    assert.match(card('cycle-sleep-before')!.text, /^Over your last 6 cycles, you slept 6h \d+m on average in the three nights before your period, \d+ minutes less/);
    assert.match(card('cycle-heart-follows')!.text, /^Over your last 6 cycles, your basal resting heart rate ran about \d\.\d bpm higher in the luteal phase than in the follicular phase/);
    assert.equal(
      card('cycle-steady')!.text,
      'Your last 6 cycles all ran between 27 and 31 days. Regular cycles make your next period easier to see coming.',
    );
    assert.equal(cardsOn(today, log(), (n) => ({ ...n, asleep: 430 })).card('cycle-sleep-before'), undefined, 'no difference, no card');
  });
});

describe('weighted middle', () => {
  it('reaches half the weight', () => {
    assert.equal(weightedMedian([{ value: 26, weight: 1 }, { value: 30, weight: 0.5 }, { value: 31, weight: 0.5 }]), 26);
    assert.equal(weightedMedian([{ value: 26, weight: 0.5 }, { value: 30, weight: 1 }, { value: 31, weight: 0.5 }]), 30);
  });
});
