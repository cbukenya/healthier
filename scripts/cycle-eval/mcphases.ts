import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join } from 'node:path';
import { sleepHrFloor } from '../../src/pipeline/sleepHrFloor.ts';

/**
 * Reads mcPHASES into the nights the cycle finder reads (cycle.ts, Night), and the phases its daily
 * hormone tests mark, to check the finder against.
 *
 * mcPHASES (Lin, Li, Kalani, Truong and Mariakakis; PhysioNet, 2025; doi:10.13026/zx6a-2c81)
 * followed 42 people wearing a Fitbit Sense for about three months, some of them twice, two years
 * apart. It's restricted data: never put it, or anything read from it about one person, in this
 * repo. The nights are cached beside the dataset, not here.
 *
 * Each night is filed under the day it ends on, as the app does. The sleeping heart rate is worked
 * out by the server's own code (sleepHrFloor.ts), from the minute heart rate rounded to whole beats
 * as Google sends it. mcPHASES stamps its heart rate in UTC and its sleep in local time, so each
 * round's minutes are moved by the whole hours that put the lowest heart rate inside the sleeps.
 */

/** Bump when what's read changes, so an older cache is read again. */
const CACHE_VERSION = 1;

/** Study day 1, as a date. mcPHASES gives no calendar dates, only days in the study. */
export const DAY_ONE = '2022-01-01';
const DAY_ONE_EPOCH = Date.UTC(2022, 0, 1) / 1000;

/** One night's measures, each null when the night has none. */
export interface StudyNight {
  temp: number | null;
  restingHr: number | null;
  hrv: number | null;
  breath: number | null;
  /** The night's heart rate floor, as the server computes it. */
  floor: number | null;
  /** The average heart rate over light and deep sleep. */
  nonRem: number | null;
}

export interface Person {
  /** mcPHASES's participant number. Used to leave a person out, never printed. */
  id: string;
  /** Nights by the study day they end on. */
  nights: Map<number, StudyNight>;
  /** The phase the hormone tests mark for each study day: Menstrual, Follicular, Fertility or Luteal. */
  phase: Map<number, string>;
  /** The study round each labelled day belongs to. */
  interval: Map<number, string>;
}

/** One study round and what happened in it, by the hormone tests. */
export interface Round {
  from: number;
  to: number;
  /** First days of each period, after the round's first day. */
  starts: number[];
  /** First days of each second half: the first luteal day after the fertile days. */
  luteal: number[];
}

/** A person's study rounds, and the period and second-half starts the hormone tests mark in each. */
export function rounds(p: Person): Round[] {
  const byInterval = new Map<string, number[]>();
  for (const [day, interval] of p.interval) {
    const days = byInterval.get(interval) ?? [];
    days.push(day);
    byInterval.set(interval, days);
  }
  const menstrual = (d: number) => p.phase.get(d) === 'Menstrual';
  const out: Round[] = [];
  for (const days of byInterval.values()) {
    days.sort((a, b) => a - b);
    const from = days[0];
    const to = days[days.length - 1];
    // A start is a menstrual day after a labelled day that wasn't, with no menstrual day in the ten before.
    const starts = days.filter((d) => d > from && menstrual(d) && !!p.phase.get(d - 1) && !menstrual(d - 1)
      && !Array.from({ length: 10 }, (_, k) => d - 1 - k).some(menstrual));
    const luteal = days.filter((d) => d > from && p.phase.get(d) === 'Luteal' && p.phase.get(d - 1) === 'Fertility');
    out.push({ from, to, starts, luteal });
  }
  return out;
}

// ──────────────────────────────────────────────────────────── reading

const num = (s: string | undefined) => (s === undefined || s === '' || !Number.isFinite(Number(s)) ? null : Number(s));

/** One line of a CSV file, quoted fields included. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Every row of one of the dataset's files, read by column name. */
async function eachRow(dir: string, file: string, row: (get: (column: string) => string) => void) {
  const lines = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
  let index: Map<string, number> | null = null;
  for await (const line of lines) {
    const cells = splitCsv(line);
    if (!index) {
      index = new Map(cells.map((c, i) => [c, i]));
      continue;
    }
    const at = index;
    row((column) => cells[at.get(column) ?? -1] ?? '');
  }
}

/** A clock time's minutes past midnight, from HH:MM or HH:MM:SS. */
const clockMinutes = (ts: string) => Number(ts.slice(0, 2)) * 60 + Number(ts.slice(3, 5));

/** A main sleep, in minutes from the start of the study, in local time. */
interface Sleep {
  start: number;
  end: number;
  /** The study day it ends on. */
  day: number;
  interval: string;
  /** Each minute's sleep stage, by minutes from the start; null when the sleep has no stages. */
  stages: Map<number, string> | null;
}

/** A sleep's stages, minute by minute, from its `levels` column (a Python literal, not JSON). */
function stagesOf(levels: string): Map<number, string> | null {
  let parsed: { data?: { dateTime: string; level: string; seconds: number }[]; shortData?: { dateTime: string; seconds: number }[] };
  try {
    parsed = JSON.parse(levels.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'));
  } catch {
    return null;
  }
  const data = parsed.data ?? [];
  if (!data.length) return null;
  const seconds = (dateTime: string) => Number(dateTime.slice(11, 13)) * 3600 + Number(dateTime.slice(14, 16)) * 60 + Number(dateTime.slice(17, 19));
  const base = seconds(data[0].dateTime);
  const stages = new Map<number, string>();
  const mark = (entries: { dateTime: string; seconds: number; level?: string }[], level?: string) => {
    for (const e of entries) {
      let at = seconds(e.dateTime) - base;
      if (at < -12 * 3600) at += 86400;
      for (let m = Math.floor(at / 60); m < Math.floor((at + e.seconds) / 60); m++) stages.set(m, level ?? e.level ?? '');
    }
  };
  mark(data);
  // Short wakes, under three minutes, sit apart from the stages they interrupt.
  mark(parsed.shortData ?? [], 'wake');
  return stages;
}

const EMPTY_NIGHT = (): StudyNight => ({ temp: null, restingHr: null, hrv: null, breath: null, floor: null, nonRem: null });

/**
 * The floor and the light-and-deep average of each main sleep, from one person's minute heart rate
 * (study minute, in UTC → the minute's average). Where two main sleeps end on the same day, the
 * longer one's.
 */
function sleepingHeartRate(minutes: Map<number, number>, sleeps: Sleep[]): Map<number, { floor: number | null; nonRem: number | null; length: number }> {
  const shift = new Map<string, number>();
  for (const interval of new Set(sleeps.map((s) => s.interval))) {
    let best: number | null = null;
    let lowest = Infinity;
    for (let hours = -12; hours <= 12; hours++) {
      const k = hours * 60;
      let total = 0;
      let n = 0;
      for (const s of sleeps) {
        if (s.interval !== interval) continue;
        for (let m = s.start; m <= s.end; m += 5) {
          const v = minutes.get(m + k);
          if (v !== undefined) {
            total += v;
            n++;
          }
        }
      }
      if (n > 500 && total / n < lowest) {
        lowest = total / n;
        best = k;
      }
    }
    if (best !== null) shift.set(interval, best);
  }

  const out = new Map<number, { floor: number | null; nonRem: number | null; length: number }>();
  for (const s of sleeps) {
    const k = shift.get(s.interval);
    if (k === undefined) continue;
    const t: number[] = [];
    const v: number[] = [];
    const nonRem: number[] = [];
    for (let m = s.start; m < s.end; m++) {
      const bpm = minutes.get(m + k);
      if (bpm === undefined) continue;
      t.push(DAY_ONE_EPOCH + m * 60);
      v.push(Math.round(bpm));
      const stage = s.stages?.get(m - s.start);
      if (stage === 'light' || stage === 'deep') nonRem.push(bpm);
    }
    const iso = (m: number) => new Date((DAY_ONE_EPOCH + m * 60) * 1000).toISOString();
    const floor = sleepHrFloor({ bedtimeIso: iso(s.start), wakeIso: iso(s.end) }, [{ date: '', t, m: [], v }]);
    const length = s.end - s.start;
    const prev = out.get(s.day);
    if (prev && prev.length >= length) continue;
    out.set(s.day, { floor, nonRem: nonRem.length >= 30 ? nonRem.reduce((a, b) => a + b, 0) / nonRem.length : null, length });
  }
  return out;
}

async function read(dir: string): Promise<Person[]> {
  const people = new Map<string, Person>();
  const person = (id: string) => {
    let p = people.get(id);
    if (!p) people.set(id, (p = { id, nights: new Map(), phase: new Map(), interval: new Map() }));
    return p;
  };
  const night = (id: string, day: number) => {
    const nights = person(id).nights;
    let n = nights.get(day);
    if (!n) nights.set(day, (n = EMPTY_NIGHT()));
    return n;
  };

  const samples = new Map<string, number>();
  await eachRow(dir, 'computed_temperature.csv', (get) => {
    const day = num(get('sleep_end_day_in_study'));
    const n = num(get('temperature_samples'));
    const sum = num(get('baseline_relative_sample_sum'));
    if (day === null || !n || sum === null) return;
    const key = `${get('id')}:${day}`;
    if ((samples.get(key) ?? 0) >= n) return;
    samples.set(key, n);
    night(get('id'), day).temp = sum / n;
  });
  await eachRow(dir, 'resting_heart_rate.csv', (get) => {
    const day = num(get('day_in_study'));
    const v = num(get('value'));
    if (day !== null && v) night(get('id'), day).restingHr = v;
  });
  await eachRow(dir, 'respiratory_rate_summary.csv', (get) => {
    const day = num(get('day_in_study'));
    const v = num(get('full_sleep_breathing_rate'));
    if (day !== null && v) night(get('id'), day).breath = v;
  });
  const hrv = new Map<string, { sum: number; n: number }>();
  await eachRow(dir, 'heart_rate_variability_details.csv', (get) => {
    const day = num(get('day_in_study'));
    const v = num(get('rmssd'));
    if (day === null || !v) return;
    // Readings from the afternoon on belong to the night that ends the next morning.
    const key = `${get('id')}:${Number(get('timestamp').slice(0, 2)) >= 15 ? day + 1 : day}`;
    const h = hrv.get(key) ?? { sum: 0, n: 0 };
    h.sum += v;
    h.n++;
    hrv.set(key, h);
  });
  for (const [key, h] of hrv) {
    const [id, day] = key.split(':');
    if (h.n >= 6) night(id, Number(day)).hrv = h.sum / h.n;
  }
  await eachRow(dir, 'hormones_and_selfreport.csv', (get) => {
    const day = num(get('day_in_study'));
    if (day === null) return;
    const p = person(get('id'));
    p.phase.set(day, get('phase'));
    p.interval.set(day, get('study_interval'));
  });

  const sleeps = new Map<string, Sleep[]>();
  await eachRow(dir, 'sleep.csv', (get) => {
    if (get('mainsleep') !== 'True') return;
    const startDay = num(get('sleep_start_day_in_study'));
    const endDay = num(get('sleep_end_day_in_study'));
    if (startDay === null || endDay === null) return;
    const start = (startDay - 1) * 1440 + clockMinutes(get('sleep_start_timestamp'));
    const end = (endDay - 1) * 1440 + clockMinutes(get('sleep_end_timestamp'));
    if (end <= start) return;
    const list = sleeps.get(get('id')) ?? [];
    list.push({ start, end, day: endDay, interval: get('study_interval'), stages: get('type') === 'stages' ? stagesOf(get('levels')) : null });
    sleeps.set(get('id'), list);
  });

  // The minute heart rate: a reading every few seconds, 63 million rows, one person after another.
  // Read without the general CSV reader, for speed; this file has no quoted fields.
  let id: string | null = null;
  let minutes = new Map<number, number>();
  let minute = -1;
  let total = 0;
  let count = 0;
  const closeMinute = () => {
    if (count) minutes.set(minute, total / count);
    total = 0;
    count = 0;
  };
  const closePerson = () => {
    closeMinute();
    if (id === null) return;
    for (const [day, hr] of sleepingHeartRate(minutes, sleeps.get(id) ?? [])) {
      const n = night(id, day);
      n.floor = hr.floor;
      n.nonRem = hr.nonRem;
    }
    minutes = new Map();
  };
  const lines = createInterface({ input: createReadStream(join(dir, 'heart_rate.csv')), crlfDelay: Infinity });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    // id,study_interval,is_weekend,day_in_study,timestamp,bpm,confidence
    const c1 = line.indexOf(',');
    const c2 = line.indexOf(',', c1 + 1);
    const c3 = line.indexOf(',', c2 + 1);
    const c4 = line.indexOf(',', c3 + 1);
    const c5 = line.indexOf(',', c4 + 1);
    const c6 = line.indexOf(',', c5 + 1);
    const bpm = Number(line.slice(c5 + 1, c6 < 0 ? undefined : c6));
    if (!(bpm > 30 && bpm < 230)) continue;
    const who = line.slice(0, c1);
    if (who !== id) {
      closePerson();
      id = who;
      minute = -1;
    }
    const ts = line.slice(c4 + 1, c5);
    const m = (Number(line.slice(c3 + 1, c4)) - 1) * 1440 + clockMinutes(ts);
    if (m !== minute) {
      closeMinute();
      minute = m;
    }
    total += bpm;
    count++;
  }
  closePerson();
  return [...people.values()];
}

/**
 * The people of the dataset in `dir`, read once and then kept beside it (never in the repo): reading
 * the minute heart rate takes a few minutes, and the cache a second.
 */
export async function loadPeople(dir: string, opts: { rebuild?: boolean } = {}): Promise<Person[]> {
  const cache = join(dirname(dir), `${basename(dir)}.healthier-nights.json`);
  if (!opts.rebuild && existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.version === CACHE_VERSION) {
      return saved.people.map((p: { id: string; nights: [number, StudyNight][]; phase: [number, string][]; interval: [number, string][] }) => ({
        id: p.id,
        nights: new Map(p.nights),
        phase: new Map(p.phase),
        interval: new Map(p.interval),
      }));
    }
  }
  process.stderr.write('Reading mcPHASES, the minute heart rate included. This takes a few minutes, once.\n');
  const people = await read(dir);
  writeFileSync(cache, JSON.stringify({
    version: CACHE_VERSION,
    people: people.map((p) => ({ id: p.id, nights: [...p.nights], phase: [...p.phase], interval: [...p.interval] })),
  }));
  return people;
}
