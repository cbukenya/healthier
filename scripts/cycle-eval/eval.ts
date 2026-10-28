import { addDays, daysBetween, type CivilDate } from '../../src/lib/date.ts';
import { CYCLE_HISTORY_DAYS, standardized, summarizeCycles, type CycleLog, type CycleSummary, type Night } from '../../src/pipeline/cycle.ts';
import { SHAPE_FROM, SHAPES, type ShapeMeasure } from '../../src/pipeline/cycleShapes.ts';
import { DAY_ONE, loadPeople, stretches, type Person, type StudyNight } from './mcphases.ts';

/**
 * How well the cycle finder (src/pipeline/cycle.ts) does on mcPHASES, measured the same way every
 * time it changes. It runs the app's own code: the finder, the floor (sleepHrFloor.ts) and the bar.
 *
 *   npm run eval:cycles -- <the mcPHASES folder>     (or set MCPHASES_DIR)
 *
 * Add --rebuild to read the dataset again, and --print-shapes for the shapes rebuilt from all 42
 * people, as cycleShapes.ts holds them. It prints totals only: nothing about any one person.
 *
 * - **Leaving each person out.** Each person is scored with shapes made from everyone else's nights,
 *   so no one is judged by a shape their own nights helped make.
 * - **As the app sees it.** Each study stretch is read on its last day, with the nights the app
 *   would have then: CYCLE_HISTORY_DAYS back, nothing after.
 * - **Against the hormone tests.** A period start is the first day mcPHASES's hormone tests mark
 *   menstrual. A found start is right within 3 days of one. The finder's starts are where the
 *   nights' shape puts them, before the person's offset to their first day of bleeding.
 * - **With the sleeping heart rate the app reads:** the night's floor, and beside it Google's non-REM
 *   heart rate, which the finder reads until the floor covers the nights.
 * - **False cycles:** people simulated without cycles, with the noise mcPHASES shows once its cycles
 *   are taken out, as the bar was set (at most 1 in 20 may see one); and the real nights shuffled
 *   a week at a time, which keeps their noise and breaks their monthly rhythm.
 * - **How soon a start shows**, reading each stretch morning by morning, and whether it moves later.
 */

const MEASURES = Object.keys(SHAPES) as ShapeMeasure[];
type Shape = { size: number; shape: readonly number[] };
type Shapes = Record<ShapeMeasure, Shape>;
/** The sleeping heart rate the finder reads: the night's floor, or Google's non-REM heart rate. */
type Input = 'floor' | 'nonRem';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? process.env.MCPHASES_DIR;
if (!dir) {
  console.error('Usage: npm run eval:cycles -- <the mcPHASES folder> [--rebuild] [--print-shapes]');
  process.exit(1);
}
const people = await loadPeople(dir, { rebuild: args.includes('--rebuild') });

const dateOf = (day: number): CivilDate => addDays(DAY_ONE, day - 1);
const dayOf = (date: CivilDate) => daysBetween(DAY_ONE, date) + 1;
const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
/** A rate with its 95% interval (Wilson's), for a sense of how much the people chosen could move it. */
const rate = (a: number, b: number) => {
  if (!b) return '—';
  const z = 1.96;
  const p = a / b;
  const d = 1 + (z * z) / b;
  const centre = (p + (z * z) / (2 * b)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / b + (z * z) / (4 * b * b))) / d;
  return `${pct(a, b)} (${Math.round(100 * (centre - half))}–${Math.round(100 * (centre + half))})`;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const read = (n: StudyNight | undefined, m: ShapeMeasure, input: Input): number | null => (!n ? null : m === 'sleepHr' ? n[input] : n[m]);
const daysOf = (p: Person) => {
  const days = [...p.nights.keys()];
  return { lo: Math.min(...days), hi: Math.max(...days) };
};

/** The nights the app would have on `day`: from CYCLE_HISTORY_DAYS before it, or the first. */
function nightsUpTo(p: Person, input: Input, day: number, from = day - CYCLE_HISTORY_DAYS): Night[] {
  const out: Night[] = [];
  for (let d = Math.max(from, daysOf(p).lo); d <= day; d++) {
    const n = p.nights.get(d);
    out.push({ date: dateOf(d), temp: read(n, 'temp', input), restingHr: read(n, 'restingHr', input), hrv: read(n, 'hrv', input), sleepHr: read(n, 'sleepHr', input), breath: read(n, 'breath', input) });
  }
  return out;
}

const log = (days: number[] = []): CycleLog => ({
  settings: { tracking: true, todayCards: true, otherPages: true },
  days: days.map((d) => ({ date: dateOf(d), flow: 'medium' })),
  rejected: [],
});
/** A period's days as someone would log them: from its first day while the tests mark it menstrual. */
const periodDays = (p: Person, start: number) => {
  const days: number[] = [];
  for (let d = start; p.phase.get(d) === 'Menstrual'; d++) days.push(d);
  return days;
};
/** Where the nights put each start: the shown starts, less the person's offset to bleeding. */
const atNights = (sum: CycleSummary, source?: 'found') => sum.cycles.filter((c) => !source || c.source === source).map((c) => dayOf(c.start) - sum.offset);
const nearest = (days: number[], t: number) => days.reduce((best, x) => Math.min(best, Math.abs(x - t)), Infinity);

// ──────────────────────────────────────────────────────────── shapes

type Profile = { sum: number[]; n: number[] };

/** Each person's nights around their period starts, per measure, in spreads (cycle.ts, standardized). */
function profiles(input: Input): Map<string, Record<ShapeMeasure, Profile>> {
  const length = SHAPES.sleepHr.shape.length;
  const out = new Map<string, Record<ShapeMeasure, Profile>>();
  for (const p of people) {
    const { lo, hi } = daysOf(p);
    const starts = stretches(p).flatMap((s) => s.starts);
    const rec = {} as Record<ShapeMeasure, Profile>;
    for (const m of MEASURES) {
      const x: (number | null)[] = [];
      for (let d = lo; d <= hi; d++) x.push(read(p.nights.get(d), m, input));
      const z = standardized(x);
      const pr: Profile = { sum: new Array(length).fill(0), n: new Array(length).fill(0) };
      for (const st of starts) {
        for (let j = 0; j < length; j++) {
          const v = z[st + SHAPE_FROM + j - lo];
          if (isNum(v)) {
            pr.sum[j] += v;
            pr.n[j]++;
          }
        }
      }
      rec[m] = pr;
    }
    out.set(p.id, rec);
  }
  return out;
}

/** The shapes as cycleShapes.ts makes them, from everyone but `without`: mean zero, length one, and their size. */
function shapesFrom(per: Map<string, Record<ShapeMeasure, Profile>>, without?: string): Shapes {
  const out = {} as Shapes;
  for (const m of MEASURES) {
    const length = SHAPES[m].shape.length;
    const sum = new Array(length).fill(0);
    const n = new Array(length).fill(0);
    for (const [id, rec] of per) {
      if (id === without) continue;
      for (let j = 0; j < length; j++) {
        sum[j] += rec[m].sum[j];
        n[j] += rec[m].n[j];
      }
    }
    const avg = sum.map((v, j) => (n[j] ? v / n[j] : 0));
    const mid = avg.reduce((a, b) => a + b, 0) / length;
    const centred = avg.map((v) => v - mid);
    const size = Math.sqrt(centred.reduce((a, v) => a + v * v, 0));
    out[m] = { size, shape: centred.map((v) => v / size) };
  }
  return out;
}

/** The app's shapes are read where the finder runs; these swap them for a while. */
const live = SHAPES as unknown as Record<ShapeMeasure, { size: number; shape: readonly number[] }>;
const shipped = {} as Shapes;
for (const m of MEASURES) shipped[m] = { size: SHAPES[m].size, shape: SHAPES[m].shape };
function useShapes(shapes: Shapes) {
  for (const m of MEASURES) {
    live[m].size = shapes[m].size;
    live[m].shape = shapes[m].shape;
  }
}

// ──────────────────────────────────────────────────────────── accuracy

function accuracy(input: Input) {
  const per = profiles(input);
  const t = {
    stretches: 0, shown: 0, starts: 0, within3: 0, within5: 0, found: 0, real: 0, ended: 0, endedRight: 0,
    later: 0, laterWithin3: 0, laterWithin5: 0, loggedEnded: 0, loggedRight: 0,
  };
  for (const p of people) {
    useShapes(shapesFrom(per, p.id));
    for (const s of stretches(p)) {
      if (!s.starts.length) continue;
      t.stretches++;
      const nights = nightsUpTo(p, input, s.to);
      const today = dateOf(s.to);
      // Nothing logged.
      const sum = summarizeCycles(nights, log(), today);
      if (sum.cycles.length) t.shown++;
      const at = atNights(sum);
      for (const st of s.starts) {
        t.starts++;
        const off = nearest(at, st);
        if (off <= 3) t.within3++;
        if (off <= 5) t.within5++;
      }
      for (const x of at) {
        if (x < s.from + 3 || x > s.to - 3) continue;
        t.found++;
        if (nearest(s.starts, x) <= 3) t.real++;
      }
      // The second half of each ended cycle shown, counted back from the next start, against the tests.
      const secondHalf = (summary: CycleSummary, ended: () => void, right: () => void) => {
        for (const c of summary.cycles) {
          if (!c.next || !c.rise) continue;
          ended();
          const near = s.luteal.filter((l) => l >= dayOf(c.start) - 3 && l <= dayOf(c.next!) + 3);
          if (nearest(near, dayOf(c.rise)) <= 3) right();
        }
      };
      secondHalf(sum, () => t.ended++, () => t.endedRight++);
      // The first period logged: the later starts the nights show.
      const withFirst = summarizeCycles(nights, log(periodDays(p, s.starts[0])), today);
      const found = atNights(withFirst, 'found');
      for (const st of s.starts.slice(1)) {
        t.later++;
        const off = nearest(found, st);
        if (off <= 3) t.laterWithin3++;
        if (off <= 5) t.laterWithin5++;
      }
      // Every period logged.
      const withAll = summarizeCycles(nights, log(s.starts.flatMap((st) => periodDays(p, st))), today);
      secondHalf(withAll, () => t.loggedEnded++, () => t.loggedRight++);
    }
  }
  useShapes(shipped);
  return t;
}

/**
 * How soon a start shows, reading each stretch morning by morning, and whether it moves later: with
 * nothing logged, or with the stretch's first period logged (the starts after it).
 */
function timing(input: Input, logged: boolean) {
  const per = profiles(input);
  const t = { judged: 0, days: [] as number[], kept: 0, moved: 0 };
  for (const p of people) {
    useShapes(shapesFrom(per, p.id));
    for (const s of stretches(p)) {
      const first = logged ? periodDays(p, s.starts[0] ?? NaN) : [];
      for (const st of logged ? s.starts.slice(1) : s.starts) {
        // Starts with ten nights before them in the stretch and two weeks after.
        if (st - 10 < s.from || st + 14 > s.to) continue;
        t.judged++;
        const shownOn = (day: number) => {
          const sum = summarizeCycles(nightsUpTo(p, input, day), log(first), dateOf(day));
          return atNights(sum, logged ? 'found' : undefined).filter((x) => Math.abs(x - st) <= 3);
        };
        let seen: { day: number; at: number } | null = null;
        for (let day = st; day <= st + 14 && !seen; day++) {
          const at = shownOn(day);
          if (at.length) seen = { day, at: at.reduce((b, x) => (Math.abs(x - st) < Math.abs(b - st) ? x : b)) };
        }
        if (!seen) continue;
        t.days.push(seen.day - st);
        const end = shownOn(s.to);
        if (!end.length) continue;
        t.kept++;
        if (Math.min(...end.map((x) => Math.abs(x - seen!.at))) >= 1) t.moved++;
      }
    }
  }
  useShapes(shipped);
  return t;
}

// ──────────────────────────────────────────────────────────── false cycles

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
const gauss = (r: () => number) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += r();
  return s - 6;
};

/**
 * One person without cycles, `length` nights long, with the noise mcPHASES shows once its cycles are
 * taken out: a factor shared by heart rate, HRV and breathing, each measure's own pull from one
 * night to the next, missing nights, the watch off now and then, and a few sick or late-night spells.
 */
function withoutCycles(seed: number, length: number): Night[] {
  const r = seeded(seed);
  const load: Record<ShapeMeasure, number> = { sleepHr: 0.93, restingHr: 0.37, hrv: -0.71, temp: 0, breath: 0.26 };
  const stick: Record<ShapeMeasure, number> = { sleepHr: 0.15, restingHr: 0.48, hrv: 0.24, temp: 0.14, breath: 0.08 };
  const miss: Record<ShapeMeasure, number> = { sleepHr: 0.05, restingHr: 0.15, hrv: 0.08, temp: 0.08, breath: 0.1 };
  // In everyday units, rounded as the watch reports them.
  const units: Record<ShapeMeasure, { base: number; scale: number; step: number }> = {
    sleepHr: { base: 56, scale: 2.5, step: 1 }, restingHr: { base: 60, scale: 2, step: 1 }, hrv: { base: 45, scale: 7, step: 1 },
    temp: { base: 0, scale: 0.15, step: 0.01 }, breath: { base: 15, scale: 0.5, step: 0.1 },
  };
  const order: ShapeMeasure[] = ['sleepHr', 'restingHr', 'hrv', 'temp', 'breath'];
  const own: Record<ShapeMeasure, number> = { sleepHr: 0, restingHr: 0, hrv: 0, temp: 0, breath: 0 };
  let shared = 0;
  let spell = 0;
  let spellSize = 0;
  const nights: Night[] = [];
  for (let d = 0; d < length; d++) {
    shared = 0.2 * shared + Math.sqrt(1 - 0.04) * gauss(r);
    if (spell <= 0 && r() < 1 / 45) {
      spell = 2 + Math.floor(r() * 5);
      spellSize = 1 + 1.5 * r();
    }
    const bump = spell-- > 0 ? spellSize : 0;
    const off = r() < 0.05;
    const night: Night = { date: addDays('2025-01-01', d), temp: null, restingHr: null, hrv: null, sleepHr: null, breath: null };
    for (const m of order) {
      own[m] = stick[m] * own[m] + Math.sqrt(1 - stick[m] ** 2) * gauss(r);
      let v = load[m] * shared + Math.sqrt(1 - load[m] ** 2) * own[m];
      v += bump * (m === 'hrv' ? -1 : m === 'temp' ? 0.6 : m === 'breath' ? 0.5 : 1);
      if (!off && r() >= miss[m]) night[m] = Math.round((units[m].base + units[m].scale * v) / units[m].step) * units[m].step;
    }
    nights.push(night);
  }
  return nights;
}

function simulated() {
  return [90, 150, 240, 365].map((length) => {
    let shown = 0;
    for (let i = 0; i < 300; i++) {
      const nights = withoutCycles(1000 * length + i, length);
      if (summarizeCycles(nights, log(), nights[nights.length - 1].date).cycles.length) shown++;
    }
    return { length, shown: shown / 300 };
  });
}

/** The real stretches, their nights shuffled a week at a time (the same order for every measure). */
function shuffled(input: Input) {
  const per = profiles(input);
  const t = { stretches: 0, real: 0, trials: 0, shuffled: 0 };
  let k = 0;
  for (const p of people) {
    useShapes(shapesFrom(per, p.id));
    for (const s of stretches(p)) {
      const n = s.to - s.from + 1;
      if (n < 60 || !s.starts.length) continue;
      t.stretches++;
      k++;
      const nights = nightsUpTo(p, input, s.to, s.from);
      if (summarizeCycles(nights, log(), nights[nights.length - 1].date).cycles.length) t.real++;
      for (let seed = 1; seed <= 3; seed++) {
        const r = seeded(seed * 1000 + k);
        const blocks = Array.from({ length: Math.ceil(nights.length / 7) }, (_, i) => i);
        for (let i = blocks.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
        }
        const order = blocks.flatMap((b) => Array.from({ length: 7 }, (_, i) => b * 7 + i)).filter((i) => i < nights.length);
        const mixed = nights.map((night, i) => ({ ...nights[order[i]], date: night.date }));
        t.trials++;
        if (summarizeCycles(mixed, log(), mixed[mixed.length - 1].date).cycles.length) t.shuffled++;
      }
    }
  }
  useShapes(shipped);
  return t;
}

// ──────────────────────────────────────────────────────────── report

const allStretches = people.flatMap((p) => stretches(p).filter((s) => s.starts.length));
const counted = people.filter((p) => stretches(p).some((s) => s.starts.length)).length;
console.log(`mcPHASES: ${counted} people, ${allStretches.length} study stretches with a period start, ${allStretches.reduce((a, s) => a + s.starts.length, 0)} period starts.`);
console.log('Each person scored with shapes made without their own nights; 95% intervals in brackets.\n');

for (const input of ['floor', 'nonRem'] as const) {
  const t = accuracy(input);
  console.log(input === 'floor'
    ? 'Sleeping heart rate from the night\'s floor, as the app reads it:'
    : 'Sleeping heart rate from Google\'s non-REM heart rate, as the app reads it until the floor covers the nights:');
  console.log(`  cycles shown in ${rate(t.shown, t.stretches)} of ${t.stretches} stretches`);
  console.log(`  nothing logged: starts within 3 days ${rate(t.within3, t.starts)}, within 5 ${pct(t.within5, t.starts)} of ${t.starts}; shown starts real ${rate(t.real, t.found)} of ${t.found}`);
  console.log(`  ended cycles shown: second half within 3 days of the hormone-marked one in ${pct(t.endedRight, t.ended)} of ${t.ended}`);
  console.log(`  first period logged: later starts within 3 days ${rate(t.laterWithin3, t.later)}, within 5 ${pct(t.laterWithin5, t.later)} of ${t.later}`);
  console.log(`  every period logged: second half within 3 days of the hormone-marked one in ${pct(t.loggedRight, t.loggedEnded)} of ${t.loggedEnded}\n`);
}

console.log('How soon a period start shows, read morning by morning (starts with ten nights before them and two weeks after):');
for (const logged of [false, true]) {
  const t = timing('floor', logged);
  const by = (days: number) => pct(t.days.filter((d) => d <= days).length, t.judged);
  console.log(`  ${logged ? 'first period logged, the starts after it' : 'nothing logged'} (${t.judged}): shown within 4 days ${by(4)}, within 7 ${by(7)}, within 14 ${by(14)}; when shown, ${median(t.days)} days after it began (median)`);
  console.log(`    still shown at the stretch's end ${pct(t.kept, t.days.length)}; of those, moved by a day or more since it first showed ${pct(t.moved, t.kept)}`);
}
console.log('');

console.log('False cycles, nothing logged:');
console.log(`  people simulated without cycles shown cycles: ${simulated().map((x) => `${x.length} nights ${pct(x.shown, 1)}`).join(', ')} (the bar lets at most 5% through)`);
const shuf = shuffled('floor');
console.log(`  real stretches of 60 nights or more show cycles in ${pct(shuf.real, shuf.stretches)} of ${shuf.stretches}; shuffled a week at a time, in ${pct(shuf.shuffled, shuf.trials)} of ${shuf.trials}\n`);

const rebuilt = shapesFrom(profiles('floor'));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
console.log(`The shapes rebuilt from all ${people.length} people against the ones the app ships (cycleShapes.ts):`);
console.log(`  ${MEASURES.map((m) => `${m} alike ${dot(rebuilt[m].shape, shipped[m].shape).toFixed(3)}, size ${rebuilt[m].size.toFixed(3)} against ${shipped[m].size}`).join('; ')}`);
if (args.includes('--print-shapes')) {
  for (const m of MEASURES) console.log(JSON.stringify({ [m]: { size: Number(rebuilt[m].size.toFixed(3)), shape: rebuilt[m].shape.map((v) => Number(v.toFixed(3))) } }));
}
