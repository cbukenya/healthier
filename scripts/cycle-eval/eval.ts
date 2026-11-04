import { addDays, daysBetween, type CivilDate } from '../../src/lib/date.ts';
import { CYCLE_HISTORY_DAYS, standardized, summarizeCycles, type CycleLog, type CycleSummary, type Night } from '../../src/pipeline/cycle.ts';
import { SHAPE_FROM, SHAPES, type ShapeMeasure } from '../../src/pipeline/cycleShapes.ts';
import { DAY_ONE, loadPeople, rounds, type Person, type StudyNight } from './mcphases.ts';

/**
 * Measures how well the cycle finder (src/pipeline/cycle.ts) finds period starts, on mcPHASES.
 * See README.md beside this file.
 *
 *   npm run eval:cycles -- <the mcPHASES folder> [--non-rem] [--rebuild]
 *
 * --non-rem reads Google's non-REM heart rate as the sleeping heart rate instead of the night's
 * floor. --rebuild reads the dataset again instead of the cached nights.
 */

const MEASURES = Object.keys(SHAPES) as ShapeMeasure[];
type Shapes = Record<ShapeMeasure, { size: number; shape: readonly number[] }>;

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? process.env.MCPHASES_DIR;
if (!dir) {
  console.error('Usage: npm run eval:cycles -- <the mcPHASES folder> [--non-rem] [--rebuild]');
  process.exit(1);
}
const sleepHr = args.includes('--non-rem') ? 'nonRem' : 'floor';
const people = await loadPeople(dir, { rebuild: args.includes('--rebuild') });

const dateOf = (day: number): CivilDate => addDays(DAY_ONE, day - 1);
const dayOf = (date: CivilDate) => daysBetween(DAY_ONE, date) + 1;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const read = (n: StudyNight | undefined, m: ShapeMeasure) => (!n ? null : m === 'sleepHr' ? n[sleepHr] : n[m]);
const firstDay = (p: Person) => Math.min(...p.nights.keys());

/** The nights the app would have on `day`: it looks back CYCLE_HISTORY_DAYS, never further. */
function nightsOn(p: Person, day: number): Night[] {
  const out: Night[] = [];
  for (let d = Math.max(day - CYCLE_HISTORY_DAYS, firstDay(p)); d <= day; d++) {
    const n = p.nights.get(d);
    out.push({ date: dateOf(d), temp: read(n, 'temp'), restingHr: read(n, 'restingHr'), hrv: read(n, 'hrv'), sleepHr: read(n, 'sleepHr'), breath: read(n, 'breath') });
  }
  return out;
}

const log = (days: number[] = []): CycleLog => ({
  settings: { tracking: true, todayCards: true, otherPages: true },
  days: days.map((d) => ({ date: dateOf(d), flow: 'medium' })),
  rejected: [],
});
/** A period's days, as someone would log them. */
const periodDays = (p: Person, start: number) => {
  const days: number[] = [];
  for (let d = start; p.phase.get(d) === 'Menstrual'; d++) days.push(d);
  return days;
};
/**
 * The starts the app shows, moved back by the person's offset: the app shows the first day of
 * bleeding, a day after the start the hormone tests mark.
 */
const shownStarts = (sum: CycleSummary, foundOnly = false) =>
  sum.cycles.filter((c) => !foundOnly || c.source === 'found').map((c) => dayOf(c.start) - sum.offset);
const distance = (days: number[], day: number) => Math.min(Infinity, ...days.map((d) => Math.abs(d - day)));

// ───────────────────────────────────────────────────────────────── shapes

/**
 * The shapes the finder looks for, made the way cycleShapes.ts was: each measure in spreads from the
 * 61 nights around (cycle.ts, standardized), averaged around every period start. Each person is
 * tested with shapes made from everyone else, so their own nights never help find their cycles.
 */
type Sums = Record<ShapeMeasure, { sum: number[]; n: number[] }>;
const sums = new Map<string, Sums>();
for (const p of people) {
  const first = firstDay(p);
  const last = Math.max(...p.nights.keys());
  const starts = rounds(p).flatMap((s) => s.starts);
  const rec = {} as Sums;
  for (const m of MEASURES) {
    const values: (number | null)[] = [];
    for (let d = first; d <= last; d++) values.push(read(p.nights.get(d), m));
    const z = standardized(values);
    const length = SHAPES[m].shape.length;
    rec[m] = { sum: new Array(length).fill(0), n: new Array(length).fill(0) };
    for (const start of starts) {
      for (let k = 0; k < length; k++) {
        const v = z[start + SHAPE_FROM + k - first];
        if (v !== null && v !== undefined) {
          rec[m].sum[k] += v;
          rec[m].n[k]++;
        }
      }
    }
  }
  sums.set(p.id, rec);
}

function shapesWithout(id: string): Shapes {
  const out = {} as Shapes;
  for (const m of MEASURES) {
    const length = SHAPES[m].shape.length;
    const avg = new Array(length).fill(0).map((_, k) => {
      let sum = 0;
      let n = 0;
      for (const [other, rec] of sums) {
        if (other === id) continue;
        sum += rec[m].sum[k];
        n += rec[m].n[k];
      }
      return n ? sum / n : 0;
    });
    const mid = avg.reduce((a, b) => a + b, 0) / length;
    const centred = avg.map((v) => v - mid);
    const size = Math.sqrt(centred.reduce((a, v) => a + v * v, 0));
    out[m] = { size, shape: centred.map((v) => v / size) };
  }
  return out;
}

// The finder reads SHAPES as it runs, so swapping them in place changes what it looks for.
const live = SHAPES as unknown as Shapes;
const shipped = {} as Shapes;
for (const m of MEASURES) shipped[m] = { ...SHAPES[m] };
const useShapes = (shapes: Shapes) => {
  for (const m of MEASURES) Object.assign(live[m], shapes[m]);
};

// ───────────────────────────────────────────────────────────── real people

const t = { rounds: 0, shown: 0, starts: 0, in3: 0, in5: 0, found: 0, real: 0, ended: 0, endedIn3: 0, later: 0, laterIn3: 0, laterIn5: 0, logged: 0, loggedIn3: 0 };
for (const p of people) {
  useShapes(shapesWithout(p.id));
  for (const s of rounds(p)) {
    if (!s.starts.length) continue;
    t.rounds++;
    // Each study round as the app would see it on its last day.
    const nights = nightsOn(p, s.to);
    const today = dateOf(s.to);
    // The second half of each finished cycle, counted back from the next start, against the hormone tests.
    const secondHalves = (sum: CycleSummary) => sum.cycles.filter((c) => c.next && c.rise).map((c) => {
      const tested = s.luteal.filter((d) => d >= dayOf(c.start) - 3 && d <= dayOf(c.next!) + 3);
      return distance(tested, dayOf(c.rise!)) <= 3;
    });

    // Nothing logged.
    const sum = summarizeCycles(nights, log(), today);
    const shown = shownStarts(sum);
    if (shown.length) t.shown++;
    for (const start of s.starts) {
      t.starts++;
      if (distance(shown, start) <= 3) t.in3++;
      if (distance(shown, start) <= 5) t.in5++;
    }
    for (const day of shown) {
      if (day < s.from + 3 || day > s.to - 3) continue;
      t.found++;
      if (distance(s.starts, day) <= 3) t.real++;
    }
    for (const right of secondHalves(sum)) {
      t.ended++;
      if (right) t.endedIn3++;
    }

    // The first period logged: the starts after it, as found in the nights.
    const found = shownStarts(summarizeCycles(nights, log(periodDays(p, s.starts[0])), today), true);
    for (const start of s.starts.slice(1)) {
      t.later++;
      if (distance(found, start) <= 3) t.laterIn3++;
      if (distance(found, start) <= 5) t.laterIn5++;
    }

    // Every period logged.
    for (const right of secondHalves(summarizeCycles(nights, log(s.starts.flatMap((start) => periodDays(p, start))), today))) {
      t.logged++;
      if (right) t.loggedIn3++;
    }
  }
}
useShapes(shipped);

// ──────────────────────────────────────────────────── people without cycles

/**
 * Made-up people without cycles, with the night-to-night noise mcPHASES shows once its cycles are
 * taken out: a pull shared by heart rate, HRV and breathing, each measure's own wander, missed
 * nights, and now and then a few sick or late nights. The bar in cycle.ts was set so at most 1 in
 * 20 of them see a cycle.
 */
function withoutCycles(seed: number, length: number): Night[] {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += random();
    return s - 6;
  };
  const measures: ShapeMeasure[] = ['sleepHr', 'restingHr', 'hrv', 'temp', 'breath'];
  const shared: Record<ShapeMeasure, number> = { sleepHr: 0.93, restingHr: 0.37, hrv: -0.71, temp: 0, breath: 0.26 };
  const wander: Record<ShapeMeasure, number> = { sleepHr: 0.15, restingHr: 0.48, hrv: 0.24, temp: 0.14, breath: 0.08 };
  const missed: Record<ShapeMeasure, number> = { sleepHr: 0.05, restingHr: 0.15, hrv: 0.08, temp: 0.08, breath: 0.1 };
  const sick: Record<ShapeMeasure, number> = { sleepHr: 1, restingHr: 1, hrv: -1, temp: 0.6, breath: 0.5 };
  // Everyday units, rounded as the watch reports them.
  const units: Record<ShapeMeasure, [base: number, scale: number, step: number]> = {
    sleepHr: [56, 2.5, 1], restingHr: [60, 2, 1], hrv: [45, 7, 1], temp: [0, 0.15, 0.01], breath: [15, 0.5, 0.1],
  };
  const own: Record<ShapeMeasure, number> = { sleepHr: 0, restingHr: 0, hrv: 0, temp: 0, breath: 0 };
  let common = 0;
  let spell = 0;
  let spellSize = 0;
  const nights: Night[] = [];
  for (let d = 0; d < length; d++) {
    common = 0.2 * common + Math.sqrt(1 - 0.04) * gauss();
    if (spell <= 0 && random() < 1 / 45) {
      spell = 2 + Math.floor(random() * 5);
      spellSize = 1 + 1.5 * random();
    }
    const bump = spell-- > 0 ? spellSize : 0;
    const watchOff = random() < 0.05;
    const night: Night = { date: addDays('2025-01-01', d), temp: null, restingHr: null, hrv: null, sleepHr: null, breath: null };
    for (const m of measures) {
      own[m] = wander[m] * own[m] + Math.sqrt(1 - wander[m] ** 2) * gauss();
      const v = shared[m] * common + Math.sqrt(1 - shared[m] ** 2) * own[m] + bump * sick[m];
      const [base, scale, step] = units[m];
      if (!watchOff && random() >= missed[m]) night[m] = Math.round((base + scale * v) / step) * step;
    }
    nights.push(night);
  }
  return nights;
}

const falseCycles = [90, 150, 240, 365].map((length) => {
  let shown = 0;
  for (let i = 0; i < 300; i++) {
    const nights = withoutCycles(1000 * length + i, length);
    if (summarizeCycles(nights, log(), nights[nights.length - 1].date).cycles.length) shown++;
  }
  return `${pct(shown, 300)} after ${length} nights`;
});

// ───────────────────────────────────────────────────────────────── report

console.log(`mcPHASES: ${people.length} people, ${t.rounds} study rounds of about three months, ${t.starts} period starts.`);
console.log(`Sleeping heart rate: ${sleepHr === 'floor' ? 'the night\'s floor' : 'Google\'s non-REM heart rate'}.\n`);
console.log('Nothing logged');
console.log(`  Cycles shown: ${pct(t.shown, t.rounds)} of rounds`);
console.log(`  Period starts found within 3 days: ${pct(t.in3, t.starts)} (within 5: ${pct(t.in5, t.starts)})`);
console.log(`  Found starts that were real: ${pct(t.real, t.found)} of ${t.found}`);
console.log(`  Second half within 3 days: ${pct(t.endedIn3, t.ended)} of ${t.ended} finished cycles\n`);
console.log('First period logged');
console.log(`  Later period starts found within 3 days: ${pct(t.laterIn3, t.later)} (within 5: ${pct(t.laterIn5, t.later)})\n`);
console.log('Every period logged');
console.log(`  Second half within 3 days: ${pct(t.loggedIn3, t.logged)} of ${t.logged} cycles\n`);
console.log(`Made-up people without cycles who see one anyway: ${falseCycles.join(', ')}. The limit is 5%.`);
