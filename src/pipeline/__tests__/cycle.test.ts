import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, daysBetween, type CivilDate } from '../../lib/date';
import {
  EMPTY_CYCLE_LOG, MIN_SHIFT_SD, WEIGHT_FOUND, WEIGHT_LOGGED, byCycleDay, calibrateOffset, findShifts, loggedPeriods,
  nightsFrom, parseCycleDay, parseCycleSettings, readCycleLog, summarizeCycles, weightedMedian, withDay, withRejected,
  type CycleDay, type CycleLog, type Night,
} from '../cycle';
import { answerQuery, parseQueries } from '../history';
import { emptyRecord } from '../normalize';

/**
 * Cycles found in nightly skin temperature: every start within a day from the nights alone, a
 * logged start winning and counting double, and nothing found in a fever or a flat line.
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
 * Nights with a cycle's rhythm: low until the rise, 14 days before the next start, high until two
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
      const rise = addDays(next, -14);
      up = date >= rise && date < addDays(next, -fallBefore);
    } else if (i >= 0) {
      // The cycle under way: risen 14 days before it would end at 28 days.
      up = date >= addDays(starts[i], 14);
    }
    const temp = (up ? high : low) + (r() - 0.5) * 2 * noise;
    // Resting heart rate a few beats up and HRV down after the rise, each with its own wobble.
    const restingHr = 58 + (up && high > low ? 2.5 : 0) + (r() - 0.5) * 1.6;
    const hrv = 52 - (up && high > low ? 5 : 0) + (r() - 0.5) * 6;
    const missing = r() < gaps;
    out.push({
      date,
      temp: missing ? null : Math.round(temp * 100) / 100,
      restingHr: missing ? null : Math.round(restingHr * 10) / 10,
      hrv: missing ? null : Math.round(hrv * 10) / 10,
    });
  }
  return out;
}

const log = (patch: Partial<CycleLog> = {}): CycleLog => ({ ...EMPTY_CYCLE_LOG, settings: { tracking: true, todayCards: true }, ...patch });
const started = (...dates: CivilDate[]): CycleDay[] => dates.map((date) => ({ date, flow: 'unspecified' }));

describe('cycles found in nightly temperature', () => {
  const lengths = [28, 30, 27, 29, 31, 28, 28];
  const starts = startsFor(lengths);
  const today = addDays(starts[starts.length - 1], 17);
  const nights = cycleNights(starts, today);

  it('finds every rise, and the fall that ends it', () => {
    const shifts = findShifts(nights);
    const complete = shifts.filter((s) => s.fall !== null);
    assert.equal(complete.length, lengths.length);
    complete.forEach((s, k) => {
      assert.equal(s.rise, addDays(starts[k + 1], -14), 'rose 14 days before the next start');
      assert.equal(s.fall, addDays(starts[k + 1], -1), 'fell the night before it');
      assert.ok(s.high - s.low >= MIN_SHIFT_SD);
    });
    assert.equal(shifts[shifts.length - 1].fall, null, 'this cycle is still up');
  });

  it('puts each start on the day after the fall, from the nights alone', () => {
    const s = summarizeCycles(nights, log(), today);
    // The first start has no fall before it to find.
    assert.deepEqual(s.cycles.map((c) => c.start), starts.slice(1));
    assert.ok(s.cycles.every((c) => c.source === 'found' && c.weight === WEIGHT_FOUND));
    assert.equal(s.status, 'ready');
    assert.equal(s.current?.day, 18);
    assert.equal(s.current?.phase, 'after-rise');
    assert.equal(s.current?.riseDay, 15);
  });

  it('gives the typical cycle and its range from the last six, and the next period as a range', () => {
    const s = summarizeCycles(nights, log(), today);
    assert.deepEqual(
      { min: s.length?.min, max: s.length?.max, typical: s.length?.typical, count: s.length?.count },
      { min: 27, max: 31, typical: 28, count: 6 },
    );
    // Risen this cycle, and the days from the rise to the start have always been 14: the range narrows to them.
    assert.equal(s.next?.basis, 'rise');
    assert.equal(s.next?.from, addDays(s.current!.rise!, 14));
    assert.equal(s.next?.to, addDays(s.current!.rise!, 14));
  });

  it('keeps the rise right up to the period, and past it while the cycle runs long', () => {
    const latest = starts[starts.length - 1];
    for (let day = 18; day <= 32; day++) {
      const until = addDays(latest, day - 1);
      const s = summarizeCycles(cycleNights(starts, until), log(), until);
      assert.equal(s.current?.rise, addDays(latest, 14), `day ${day}`);
      assert.equal(s.next?.basis, 'rise', `day ${day}`);
    }
  });

  it('keeps going through nights the watch missed', () => {
    const patchy = cycleNights(starts, today, { gaps: 0.15, seed: 7 });
    const s = summarizeCycles(patchy, log(), today);
    const found = s.cycles.map((c) => c.start);
    for (const truth of starts.slice(2)) {
      assert.ok(found.some((f) => Math.abs(daysBetween(f, truth)) <= 1), `a start within a day of ${truth}`);
    }
  });

  it('finds nothing in a fever: a rise that falls back within a week is not a cycle', () => {
    const fever = nights.map((n) => {
      const day = daysBetween(starts[2], n.date);
      return day >= 4 && day < 8 ? { ...n, temp: 0.7 } : n;
    });
    const s = summarizeCycles(fever, log(), today);
    assert.deepEqual(s.cycles.map((c) => c.start), starts.slice(1));
  });

  it('says there is no rhythm in four months of flat nights, and nothing about cycles', () => {
    const flat = cycleNights([START], addDays(START, 130), { high: -0.15 });
    const s = summarizeCycles(flat, log(), addDays(START, 130));
    assert.equal(s.status, 'no-rhythm');
    assert.equal(s.current, null);
    assert.equal(s.next, null);
  });

  it('is collecting, not without rhythm, while there are few nights', () => {
    const few = cycleNights([START], addDays(START, 20), { high: -0.15 });
    assert.equal(summarizeCycles(few, log(), addDays(START, 20)).status, 'collecting');
  });
});

describe('on nights as noisy as a real watch', () => {
  /** A person's nights with a watch's wobble: temperature from night to night, heart rate drifting over days. */
  function noisy(seed: number, cycles: boolean) {
    const r = seeded(seed);
    const gauss = () => (r() + r() + r() + r() + r() + r() - 3) / Math.sqrt(0.5);
    const starts: CivilDate[] = [START];
    for (let k = 0; k < 8; k++) starts.push(addDays(starts[starts.length - 1], 25 + Math.floor(r() * 9)));
    const today = addDays(starts[starts.length - 1], 10);
    const nights: Night[] = [];
    let hr = 0;
    for (let date = addDays(START, -20); date <= today; date = addDays(date, 1)) {
      const k = starts.findIndex((s, j) => s <= date && (starts[j + 1] === undefined || date < starts[j + 1]));
      const next = starts[k + 1];
      const up = cycles && k >= 0 && !!next && date >= addDays(next, -13) && date < addDays(next, -1) ? 1 : 0;
      hr = 0.5 * hr + Math.sqrt(0.75) * gauss() * 1.5;
      const missing = r() < 0.1;
      nights.push({
        date,
        temp: missing ? null : -0.15 + up * 0.35 + gauss() * 0.25,
        restingHr: missing ? null : 58 + up * 2.5 + hr,
        hrv: missing ? null : 50 - up * 4 + gauss() * 6,
      });
    }
    return { starts, today, nights };
  }

  it('finds most starts, within a couple of days', () => {
    let found = 0;
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { starts, today, nights } = noisy(seed, true);
      const s = summarizeCycles(nights, log(), today);
      for (const truth of starts.slice(1)) {
        total++;
        if (s.cycles.some((c) => Math.abs(daysBetween(c.start, truth)) <= 2)) found++;
      }
    }
    assert.ok(found / total >= 0.6, `${found} of ${total}`);
  });

  it('shows almost no one without cycles any cycle at all', () => {
    let shown = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { today, nights } = noisy(seed, false);
      if (summarizeCycles(nights, log(), today).cycles.length) shown++;
    }
    assert.ok(shown <= 1, `${shown} of 20`);
  });
});

describe('logged and confirmed starts', () => {
  const lengths = [28, 30, 27, 29, 31, 28, 28];
  const starts = startsFor(lengths);
  const today = addDays(starts[starts.length - 1], 17);
  const nights = cycleNights(starts, today);

  it('win over a start found nearby, and count twice as much', () => {
    // Logged a day later than the temperature says: the log is what happened.
    const logged = addDays(starts[3], 1);
    const s = summarizeCycles(nights, log({ days: started(logged) }), today);
    const cycle = s.cycles.find((c) => c.start === logged);
    assert.equal(cycle?.source, 'logged');
    assert.ok(!s.cycles.some((c) => c.start === starts[3]), 'the found start gave way');
    const before = s.cycles[s.cycles.indexOf(cycle!) - 1];
    assert.equal(before.weight, WEIGHT_FOUND, 'a cycle is as certain as its least certain end');
    assert.equal(WEIGHT_LOGGED, 2 * WEIGHT_FOUND);
  });

  it("carry the person's own gap between the fall and the period to starts found later", () => {
    // This person's temperature falls two nights before the period, not one.
    const early = cycleNights(starts, today, { fallBefore: 2 });
    const plain = summarizeCycles(early, log(), today);
    assert.equal(plain.offset, 1);
    assert.equal(plain.cycles[1].start, addDays(starts[2], -1), 'a day early, before any confirmation');
    const s = summarizeCycles(early, log({ days: started(starts[1], starts[2]) }), today);
    assert.equal(s.offset, 2);
    assert.deepEqual(s.cycles.map((c) => c.start), starts.slice(1), 'every found start now lands on its day');
  });

  it('count even when the nights show nothing, and are never second-guessed', () => {
    const flat = cycleNights([START], addDays(START, 90), { high: -0.15 });
    const days = started(addDays(START, 2), addDays(START, 30), addDays(START, 59), addDays(START, 87));
    const s = summarizeCycles(flat, log({ days }), addDays(START, 90));
    assert.deepEqual(s.cycles.map((c) => c.start), days.map((d) => d.date));
    assert.equal(s.status, 'ready');
    assert.equal(s.length?.typical, 28);
    assert.equal(s.next?.basis, 'cycles');
  });

  it('drop a found start the person said was not a period', () => {
    const s = summarizeCycles(nights, log({ rejected: [starts[3]] }), today);
    assert.ok(!s.cycles.some((c) => c.start === starts[3]));
    const merged = s.cycles.find((c) => c.start === starts[2]);
    assert.equal(merged?.length, lengths[2] + lengths[3]);
    assert.equal(s.length?.count, 4, 'a merged cycle is too long to count');
  });

  it('calibrate only from two confirmed starts or more', () => {
    const shifts = findShifts(cycleNights(starts, today, { fallBefore: 3 }));
    assert.equal(calibrateOffset(shifts, [starts[1]]), 1);
    assert.equal(calibrateOffset(shifts, [starts[1], starts[2]]), 3);
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
    assert.deepEqual(parseCycleSettings({ tracking: true, todayCards: false }), { tracking: true, todayCards: false });
  });

  it('reads what it can of a stored log, one day per date, oldest first', () => {
    const read = readCycleLog({
      settings: { tracking: true },
      days: [{ date: '2026-03-05', flow: 'light' }, { date: 'soon', flow: 'light' }, { date: '2026-03-01', symptoms: ['acne'] }, { date: '2026-03-02' }],
      rejected: ['2026-02-01', 'never'],
    });
    assert.deepEqual(read, {
      settings: { tracking: true, todayCards: true },
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

describe('weighted middle', () => {
  it('reaches half the weight', () => {
    assert.equal(weightedMedian([{ value: 26, weight: 1 }, { value: 30, weight: 0.5 }, { value: 31, weight: 0.5 }]), 26);
    assert.equal(weightedMedian([{ value: 26, weight: 0.5 }, { value: 30, weight: 1 }, { value: 31, weight: 0.5 }]), 30);
  });
});
