import { addDays, civilFromInstant, daysBetween, type CivilDate } from '../lib/date';
import { int, num, round } from './coerce';
import { WHO_WEEK } from './goals';
import type { DailyRecord, HeartRateZones, IntradaySample, Workout, WorkoutSplit, ZoneMinutes } from '../types/health';

/**
 * Workouts: what Google Health logs as `exercise`, one point per workout, with its kind, its
 * times and a summary of it (distance, calories, average heart rate, minutes in each heart rate
 * zone, active zone minutes, splits). Healthier reads them into each day's `workouts`, and works
 * out from them:
 *
 *   - the workout level: active zone minutes a week from workouts, over the last 4 weeks, on a
 *     scale of five steps set from the weekly target (WHO_WEEK);
 *   - the workout load: the last 7 days against the 3 weeks before, as the Activity page's ramp
 *     does (loadRatio in derive.ts), with no claim about injury;
 *   - each workout's heart rate, from the minute heart rate the app already keeps, with 5 minutes
 *     after it, to see how fast it comes down.
 *
 * Routes need Google's location scope, which Healthier doesn't ask for, so they aren't read.
 */

// ─────────────────────────────────────────────────────────────── reading

/** Google's durations, such as "1800s" or "93.5s", in seconds. */
export function durationSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)s$/);
  return m ? Number(m[1]) : null;
}

const minutes = (v: unknown) => {
  const s = durationSeconds(v);
  return s === null ? null : s / 60;
};

/** The day a workout belongs to: the day it started, on the clock where it was done. */
export const workoutDate = (c: any): CivilDate | null => civilFromInstant(c?.interval?.startTime, c?.interval?.startUtcOffset)?.date ?? null;

function readZones(z: any): ZoneMinutes | null {
  if (!z || typeof z !== 'object') return null;
  const light = minutes(z.lightTime);
  const moderate = minutes(z.moderateTime);
  const vigorous = minutes(z.vigorousTime);
  const peak = minutes(z.peakTime);
  if (light === null && moderate === null && vigorous === null && peak === null) return null;
  return { light: Math.round(light ?? 0), moderate: Math.round(moderate ?? 0), vigorous: Math.round(vigorous ?? 0), peak: Math.round(peak ?? 0) };
}

function readSplits(list: unknown): WorkoutSplit[] {
  if (!Array.isArray(list)) return [];
  const out: WorkoutSplit[] = [];
  for (const s of list) {
    const mm = num(s?.metricsSummary?.distanceMillimeters);
    const seconds =
      durationSeconds(s?.activeDuration) ??
      (Date.parse(s?.endTime ?? '') - Date.parse(s?.startTime ?? '')) / 1000;
    if (mm === null || mm <= 0 || !Number.isFinite(seconds) || seconds <= 0) continue;
    out.push({ distanceKm: round(mm / 1_000_000, 3)!, seconds: Math.round(seconds), avgHr: int(s?.metricsSummary?.averageHeartRateBeatsPerMinute) });
  }
  return out;
}

/** One `exercise` point as a Workout, or null when it has no usable times. */
export function parseWorkout(c: any): Workout | null {
  const start = civilFromInstant(c?.interval?.startTime, c?.interval?.startUtcOffset);
  const startMs = Date.parse(c?.interval?.startTime ?? '');
  const endMs = Date.parse(c?.interval?.endTime ?? '');
  if (!start || Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return null;
  const elapsedMin = Math.round((endMs - startMs) / 60_000);
  const m = c?.metricsSummary ?? {};
  const active = minutes(c?.activeDuration);
  const mm = num(m.distanceMillimeters);
  const climb = num(m.elevationGainMillimeters);
  const splits = readSplits(Array.isArray(c?.splits) && c.splits.length ? c.splits : (c?.splitSummaries ?? []).filter((s: any) => s?.splitType === 'DISTANCE'));
  return {
    type: typeof c?.exerciseType === 'string' ? c.exerciseType : 'OTHER',
    displayName: typeof c?.displayName === 'string' && c.displayName.trim() ? c.displayName.trim() : null,
    startIso: c.interval.startTime,
    endIso: c.interval.endTime,
    startMin: start.minutesOfDay,
    elapsedMin,
    activeMin: Math.round(active !== null && active > 0 ? Math.min(active, elapsedMin) : elapsedMin),
    distanceKm: mm !== null && mm > 0 ? round(mm / 1_000_000, 2) : null,
    kcal: (() => {
      const k = num(m.caloriesKcal);
      return k !== null && k > 0 ? Math.round(k) : null;
    })(),
    steps: (() => {
      const s = int(m.steps);
      return s !== null && s > 0 ? s : null;
    })(),
    avgHr: int(m.averageHeartRateBeatsPerMinute),
    zoneMinutes: int(m.activeZoneMinutes),
    zones: readZones(m.heartRateZoneDurations),
    climbM: climb !== null && climb > 0 ? Math.round(climb / 1000) : null,
    cadence: int(m.mobilityMetrics?.avgCadenceStepsPerMinute),
    swimLengths: int(m.totalSwimLengths),
    splits,
    hasGps: c?.exerciseMetadata?.hasGps === true,
  };
}

/**
 * The registry's `prepare` for workouts: each source's workouts on each day folded into one point,
 * `{ dataSource, exercise: { day, workouts } }`, earliest first, a workout listed twice counted
 * once. A second source's day is then a second reading of the day, picked on read like any other
 * (pipeline/sources.ts), so the same run from a watch and from a phone app isn't counted twice.
 */
export function combineExercisePoints(points: any[]): any[] {
  const groups = new Map<string, { dataSource: unknown; day: CivilDate; workouts: Map<string, Workout> }>();
  for (const dp of points) {
    const c = dp?.exercise;
    const day = workoutDate(c);
    const w = day ? parseWorkout(c) : null;
    if (!day || !w) continue;
    const key = `${day}|${JSON.stringify(dp.dataSource ?? null)}`;
    const group = groups.get(key) ?? { dataSource: dp.dataSource, day, workouts: new Map() };
    groups.set(key, group);
    if (!group.workouts.has(w.startIso)) group.workouts.set(w.startIso, w);
  }
  return [...groups.values()].map((g) => ({
    dataSource: g.dataSource,
    exercise: { day: g.day, workouts: [...g.workouts.values()].sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso)) },
  }));
}

// ─────────────────────────────────────────────────────────────── kinds

/**
 * Families of workout, for what each one's figures and progress show: on foot a distance and pace
 * a kilometre; wheels, boats and skates their speed; in the water pace a hundred metres; and time
 * and effort for the rest.
 */
export type WorkoutFamily = 'foot' | 'speed' | 'water' | 'strength' | 'cardio' | 'mind' | 'other';

/**
 * The kinds of workout, each in its family. A kind sets a workout's icon, colour and figures; its
 * name is its own type's (workouts.types in the language file), so a trail run says so.
 */
export const KINDS = {
  run: 'foot',
  walk: 'foot',
  hike: 'foot',
  ride: 'speed',
  indoorRide: 'speed',
  row: 'speed',
  paddle: 'speed',
  skate: 'speed',
  swim: 'water',
  waterSport: 'cardio',
  winter: 'cardio',
  strength: 'strength',
  climbing: 'strength',
  hiit: 'cardio',
  cardio: 'cardio',
  elliptical: 'cardio',
  stairs: 'cardio',
  dance: 'cardio',
  martialArts: 'cardio',
  sport: 'cardio',
  yoga: 'mind',
  pilates: 'mind',
  mobility: 'mind',
  other: 'other',
} as const satisfies Record<string, WorkoutFamily>;

export type WorkoutKind = keyof typeof KINDS;

/**
 * Every one of Google's exercise types (the v4 Exercise.ExerciseType list, 181 of them), by kind.
 * The test holds this to Google's list, so none is missing or made up. A type Google adds later is
 * `other` until it's placed here.
 */
const TYPES: Record<WorkoutKind, string[]> = {
  run: ['RUNNING', 'TRAIL_RUN', 'TREADMILL', 'INCLINE_RUN'],
  walk: [
    'WALKING', 'POWER_WALKING', 'NORDIC_WALKING', 'TREADMILL_WALK', 'INCLINE_WALK', 'STROLLER_WALK',
    'WALK_WITH_WEIGHTS', 'RUCKING', 'WHEELCHAIR',
  ],
  hike: ['HIKING', 'BACKPACKING', 'ORIENTEERING', 'SNOWSHOEING'],
  ride: ['BIKING', 'OUTDOOR_BIKE', 'MOUNTAIN_BIKE', 'ELECTRIC_BIKE', 'HAND_CYCLING', 'UNICYCLING'],
  indoorRide: ['STATIONARY_BIKE', 'SPINNING', 'ASSAULT_BIKE'],
  row: ['ROWING', 'ROWING_MACHINE'],
  paddle: ['KAYAKING', 'CANOEING', 'PADDLEBOARDING'],
  skate: [
    'ROLLERBLADING', 'ROLLER_SKATING', 'ICE_SKATING', 'SPEED_SKATING', 'SKATING', 'SKATEBOARDING',
    'SCOOTERING', 'ELECTRIC_SCOOTER',
  ],
  swim: ['SWIMMING', 'SWIMMING_POOL', 'SWIMMING_OPEN_WATER', 'SYNCHRONIZED_SWIMMING'],
  waterSport: [
    'SURFING', 'KITESURFING', 'WINDSURFING', 'WAKEBOARDING', 'WATER_SKIING', 'FOILING', 'DIVING',
    'SCUBA_DIVING', 'SNORKELING', 'SAILING', 'WATER_SPORT',
  ],
  winter: ['SKIING', 'CROSS_COUNTRY_SKI', 'SNOWBOARDING', 'SNOW_SPORT'],
  strength: [
    'WEIGHTLIFTING', 'WEIGHTS', 'STRENGTH_TRAINING', 'FUNCTIONAL_STRENGTH_TRAINING', 'FREE_WEIGHTS',
    'WEIGHT_MACHINES', 'BODY_WEIGHT', 'CALISTHENICS', 'CORE_TRAINING', 'POWERLIFTING',
    'RESISTANCE_BANDS', 'TRX',
  ],
  climbing: ['CLIMBING', 'ROCK_CLIMBING', 'INDOOR_CLIMBING'],
  hiit: ['HIIT', 'INTERVAL_WORKOUT', 'TABATA_WORKOUT', 'CIRCUIT_TRAINING', 'CROSSFIT', 'BOOTCAMP'],
  cardio: [
    'AEROBIC_WORKOUT', 'CARDIO_WORKOUT', 'CARDIO_SCULPT', 'CROSS_TRAINING', 'STEP_TRAINING',
    'OUTDOOR_WORKOUT', 'EXERCISE_CLASS', 'WATER_AEROBICS', 'WATER_JOGGING', 'JUMPING_ROPE',
    'TRAMPOLINE', 'FITNESS_GAMING', 'PARKOUR', 'GYMNASTICS', 'MULTISPORT', 'WORKOUT',
  ],
  elliptical: ['ELLIPTICAL'],
  stairs: ['STAIRCLIMBER'],
  dance: [
    'DANCING', 'BALLROOM_DANCE', 'JAZZ_DANCE', 'MODERN_DANCE', 'BALLET', 'BREAKDANCING', 'HIP_HOP',
    'TANGO', 'ZUMBA', 'CHEERLEADING',
  ],
  martialArts: [
    'BOXING', 'KICKBOXING', 'MARTIAL_ARTS', 'KARATE', 'JIU_JITSU', 'MUAY_THAI', 'TAEKWONDO',
    'WRESTLING', 'FENCING',
  ],
  sport: [
    'TENNIS', 'TABLE_TENNIS', 'BADMINTON', 'SQUASH', 'PADEL', 'PICKELBALL', 'RACQUETBALL',
    'RACKET_SPORTS', 'SOCCER', 'BASKETBALL', 'VOLLEYBALL', 'VOLLEYBALL_BEACH', 'HANDBALL', 'HOCKEY',
    'FIELD_HOCKEY', 'LACROSSE', 'RUGBY', 'FOOTBALL_AMERICAN', 'FOOTBALL_AUSTRALIAN', 'CRICKET',
    'BASEBALL', 'SOFTBALL', 'ULTIMATE_FRISBEE', 'FRISBEE_PLAYING_GENERAL', 'WATER_POLO',
    'WATER_VOLLEYBALL', 'POLO', 'GOLF', 'TRACK_AND_FIELD', 'SPORT', 'CURLING', 'CROQUET', 'BOWLING',
    'BILLIARDS', 'ARCHERY', 'SHOOTING', 'EQUESTRIAN_SPORTS',
  ],
  yoga: ['YOGA', 'YOGA_BIKRAM', 'YOGA_HATHA', 'YOGA_POWER', 'YOGA_VINYASA'],
  pilates: ['PILATES', 'BARRE_CLASS'],
  mobility: ['STRETCHING', 'TAI_CHI', 'MEDITATE'],
  other: [
    'OTHER', 'CLEANING', 'GARDENING', 'HOEING', 'HOUSEHOLD_CHORES', 'MOWING_LAWN', 'SHOVELING',
    'WEEDING', 'CARPENTRY', 'PAINTING', 'MUSICAL_PERFORMANCE', 'FISHING', 'HUNTING', 'MOTOCROSS',
    'MOTORCYCLE', 'SNOWMOBILING', 'PARAGLIDING', 'SKYDIVING',
  ],
};

/**
 * Kinds that gather different sports: How you work out keeps their types apart (tennis and
 * football aren't one thing), where a run on a trail and on a treadmill are both runs.
 */
const UMBRELLA: ReadonlySet<WorkoutKind> = new Set(['paddle', 'skate', 'waterSport', 'winter', 'cardio', 'dance', 'martialArts', 'sport', 'mobility', 'other']);
export const isUmbrella = (kind: WorkoutKind) => UMBRELLA.has(kind);

const KIND_OF_TYPE = new Map<string, WorkoutKind>(
  (Object.entries(TYPES) as [WorkoutKind, string[]][]).flatMap(([kind, types]) => types.map((type) => [type, kind] as const)),
);

/** Every type placed here. */
export const KNOWN_TYPES: ReadonlySet<string> = new Set(KIND_OF_TYPE.keys());

export const kindOf = (w: Pick<Workout, 'type'>): WorkoutKind => KIND_OF_TYPE.get(w.type) ?? 'other';
export const familyOf = (w: Pick<Workout, 'type'>): WorkoutFamily => KINDS[kindOf(w)];

/** Whether a workout's big figure is its distance: on foot, on wheels, boats and skates, in the water. */
export const goesADistance = (w: Pick<Workout, 'type' | 'distanceKm'>) =>
  w.distanceKm !== null && ['foot', 'speed', 'water'].includes(familyOf(w));

/**
 * The pace or speed a family is timed in: minutes a kilometre on foot, kilometres an hour on a
 * bike, a boat or skates, minutes a hundred metres in the water. Null for the others, or without a distance.
 */
export function paceOf(w: Pick<Workout, 'type' | 'distanceKm' | 'activeMin'>): { measure: 'pace' | 'speed' | 'swimPace'; value: number } | null {
  if (!w.distanceKm || w.activeMin <= 0) return null;
  switch (familyOf(w)) {
    case 'foot':
      return { measure: 'pace', value: (w.activeMin * 60) / w.distanceKm };
    case 'speed':
      return { measure: 'speed', value: w.distanceKm / (w.activeMin / 60) };
    case 'water':
      return { measure: 'swimPace', value: (w.activeMin * 60) / (w.distanceKm * 10) };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────── effort

/**
 * The active zone minutes a workout earned: Google's count, else worked out from its minutes in
 * each zone the way active zone minutes count them (moderate once, vigorous and peak twice).
 */
export function zoneMinutesOf(w: Pick<Workout, 'zoneMinutes' | 'zones'>): number {
  if (w.zoneMinutes !== null) return w.zoneMinutes;
  return w.zones ? w.zones.moderate + 2 * (w.zones.vigorous + w.zones.peak) : 0;
}

/** A day's longest workout of one kind, in km, or null without one that went a distance. */
export function longestOfKind(d: Pick<DailyRecord, 'workouts'>, kind: WorkoutKind): number | null {
  let best: number | null = null;
  for (const w of d.workouts ?? []) if (kindOf(w) === kind && w.distanceKm !== null && (best === null || w.distanceKm > best)) best = w.distanceKm;
  return best;
}

/**
 * A run's fastest stretch of `km` whole kilometres in a row, from its splits: the seconds, and the
 * kilometre it starts at (1 for the first). Null without that many splits of about a kilometre.
 */
export function fastestStretch(w: Pick<Workout, 'splits'>, km: number): { seconds: number; from: number } | null {
  const splits = w.splits;
  let best: { seconds: number; from: number } | null = null;
  for (let i = 0; i + km <= splits.length; i++) {
    const run = splits.slice(i, i + km);
    // Kilometre splits only: a mile's or a lap's would add up to something else.
    if (!run.every((s) => Math.abs(s.distanceKm - 1) <= 0.05)) continue;
    const seconds = run.reduce((a, s) => a + s.seconds, 0);
    if (!best || seconds < best.seconds) best = { seconds, from: i + 1 };
  }
  return best;
}

/** A day's fastest 5 km on a run, in seconds, or null. */
export function fastest5k(d: Pick<DailyRecord, 'workouts'>): number | null {
  let best: number | null = null;
  for (const w of d.workouts ?? []) {
    if (kindOf(w) !== 'run') continue;
    const s = fastestStretch(w, 5);
    if (s && (best === null || s.seconds < best)) best = s.seconds;
  }
  return best;
}

/** Vigorous and peak minutes: how hard an interval session or a game was. */
export const hardMinutesOf = (w: Pick<Workout, 'zones'>) => (w.zones ? w.zones.vigorous + w.zones.peak : null);

/** A workout with the day it's filed under, and an id for the address. */
export interface DatedWorkout {
  id: string;
  date: CivilDate;
  workout: Workout;
}

/** Every workout in the days, newest first. */
export function workoutsIn(days: DailyRecord[]): DatedWorkout[] {
  const out: DatedWorkout[] = [];
  for (const d of days) for (const w of d.workouts ?? []) out.push({ id: w.startIso, date: d.date, workout: w });
  return out.sort((a, b) => Date.parse(b.workout.startIso) - Date.parse(a.workout.startIso));
}

/** Zone minutes from workouts on each day, by date. */
const zoneMinutesByDate = (days: DailyRecord[]) =>
  new Map(days.map((d) => [d.date, (d.workouts ?? []).reduce((a, w) => a + zoneMinutesOf(w), 0)]));

// ─────────────────────────────────────────────────────────────── the level

/**
 * The workout level's five steps, by zone minutes a week from workouts. Each step is set from the
 * weekly target, WHO_WEEK (150): a fifth of it, half, all of it, and twice it, where the WHO puts
 * further benefit. A step's name and lines are in the language file, under workouts.level.
 */
export const LEVELS = ['embers', 'spark', 'flame', 'blaze', 'wildfire'] as const;
export type LevelId = (typeof LEVELS)[number];

/** Where each step starts, in zone minutes a week. */
export const levelStarts = (): Record<LevelId, number> => ({
  embers: 0,
  spark: WHO_WEEK / 5,
  flame: WHO_WEEK / 2,
  blaze: WHO_WEEK,
  wildfire: WHO_WEEK * 2,
});

/** The step a week's zone minutes reach, as its index in LEVELS. */
export function levelIndex(perWeek: number): number {
  const starts = levelStarts();
  let i = 0;
  LEVELS.forEach((id, k) => {
    if (perWeek >= starts[id]) i = k;
  });
  return i;
}

/** Days the level averages over. */
export const LEVEL_DAYS = 28;

/**
 * Zone minutes a week from workouts over the LEVEL_DAYS ending on `end`: their total over the
 * days there are, as a week's worth. Null with fewer than a week of days to go on.
 */
export function weeklyZoneMinutes(days: DailyRecord[], end: CivilDate, span = LEVEL_DAYS): number | null {
  const from = addDays(end, -(span - 1));
  const within = days.filter((d) => d.date >= from && d.date <= end);
  if (within.length < 7) return null;
  const total = within.reduce((a, d) => a + (d.workouts ?? []).reduce((x, w) => x + zoneMinutesOf(w), 0), 0);
  return (total / within.length) * 7;
}

export interface WorkoutLevel {
  /** Zone minutes a week over the last 4 weeks. */
  perWeek: number;
  index: number;
  /** The level 4 weeks before, to say whether it has moved. */
  before: number | null;
  /** Zone minutes a week more that reach the next step, or null at the top. */
  toNext: number | null;
  /** Where the marker sits on the five equal steps of the scale, 0 to 1. */
  position: number;
}

/** The workout level on the days' last day, or null without a week of days. */
export function workoutLevel(days: DailyRecord[]): WorkoutLevel | null {
  const end = days.at(-1)?.date;
  if (!end) return null;
  const perWeek = weeklyZoneMinutes(days, end);
  if (perWeek === null) return null;
  const index = levelIndex(perWeek);
  const earlier = weeklyZoneMinutes(days, addDays(end, -LEVEL_DAYS));
  const starts = Object.values(levelStarts());
  const next = starts[index + 1] ?? null;
  // The top step runs to twice where it starts, on the scale.
  const top = next ?? starts[index] * 2;
  const within = Math.min(1, Math.max(0, (perWeek - starts[index]) / (top - starts[index])));
  return {
    perWeek,
    index,
    before: earlier === null ? null : levelIndex(earlier),
    toNext: next === null ? null : Math.max(1, Math.ceil(next - perWeek)),
    position: (index + within) / LEVELS.length,
  };
}

/** One bar of the level's history: a week, or the average week of a month. */
export interface LevelPeriod {
  /** Its first day. */
  date: CivilDate;
  /** Zone minutes from workouts that week, or in the average week of that month. */
  bar: number;
  /** The 4-week average at its end, which sets the level; null without 4 weeks before it. */
  line: number | null;
  /** Still under way: the week or month today is in, its bar only what's done so far. */
  partial: boolean;
}

/**
 * How the level has moved: a period at a time from `from`, each with its zone minutes and the
 * 4-week average at its end. `days` reach back before `from` where they can, so the first
 * periods' averages have their 4 weeks. Weeks run Monday to Sunday; the last one or month may
 * still be under way, and its average is taken on the last day.
 */
export function levelHistory(days: DailyRecord[], from: CivilDate, by: 'week' | 'month'): LevelPeriod[] {
  const last = days.at(-1)?.date;
  const first = days[0]?.date;
  if (!last || !first) return [];
  const byDate = zoneMinutesByDate(days);
  const sum = (a: CivilDate, b: CivilDate) => {
    let total = 0;
    for (let d = a; d <= b; d = addDays(d, 1)) total += byDate.get(d) ?? 0;
    return total;
  };
  const lineAt = (end: CivilDate) => (daysBetween(first, end) + 1 >= LEVEL_DAYS ? weeklyZoneMinutes(days, end) : null);
  const out: LevelPeriod[] = [];
  if (by === 'week') {
    // Back to the Monday on or before `from`.
    const weekday = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7;
    for (let start = addDays(from, -weekday); start <= last; start = addDays(start, 7)) {
      const end = addDays(start, 6) < last ? addDays(start, 6) : last;
      const a = start < first ? first : start;
      out.push({ date: start, bar: sum(a, end), line: lineAt(end), partial: addDays(start, 6) > last });
    }
  } else {
    for (let month = from.slice(0, 7); `${month}-01` <= last; ) {
      const start = `${month}-01` as CivilDate;
      const [y, m] = month.split('-').map(Number);
      const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const monthEnd = addDays(`${nextMonth}-01`, -1);
      const end = monthEnd < last ? monthEnd : last;
      const a = start < first ? first : start;
      if (a <= end) out.push({ date: start, bar: (sum(a, end) / (daysBetween(a, end) + 1)) * 7, line: lineAt(end), partial: monthEnd > last });
      month = nextMonth;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── the load

export interface WorkoutLoad {
  /** Zone minutes from workouts over the last 7 days, today included. */
  week: number;
  /** A week's worth over the 21 days before them, or null without them. */
  usual: number | null;
  /**
   * What the week is set against: the usual week, or the weekly target (WHO_WEEK) while the usual
   * week is below it. Null without a usual week to go on.
   */
  base: 'usual' | 'target' | null;
  /** The week against its base, or null without a usual week to go on. */
  ratio: number | null;
}

/**
 * The last 7 days of workouts against the 3 weeks before, with no overlap, as loadRatio in
 * derive.ts compares steps, and in the level's unit. Today's workouts count: a hard session this
 * morning is part of the load now.
 *
 * The usual week counts for no less than the weekly target. A ratio of small numbers swings: from
 * a usual week of 20 zone minutes, a week of 50 is 2.5×, and someone building up from little was
 * told to recover for a week still under half the target. The 1.5× line comes from people who
 * already train a lot (Gabbett 2016), and the ratio is known to mislead on small loads
 * (Impellizzeri et al. 2020). On mcPHASES workouts (62 rounds, 4,025 days), this took "Time to
 * recover" from 41% to 3% of days for usual weeks under 75 zone minutes and from 23% to 6% for 75
 * to 149, and left usual weeks of 150 or more exactly as they were.
 */
export function workoutLoad(days: DailyRecord[]): WorkoutLoad | null {
  const end = days.at(-1)?.date;
  if (!end) return null;
  const byDate = zoneMinutesByDate(days);
  const total = (from: number, to: number) => {
    let t = 0;
    for (let k = from; k <= to; k++) t += byDate.get(addDays(end, -k)) ?? 0;
    return t;
  };
  const week = total(0, 6);
  const haveUsual = days.length >= 28 && days[0].date <= addDays(end, -27);
  if (!haveUsual) return { week, usual: null, base: null, ratio: null };
  const usual = total(7, 27) / 3;
  return { week, usual, base: usual >= WHO_WEEK ? 'usual' : 'target', ratio: week / Math.max(usual, WHO_WEEK) };
}

/** Where the load stands: 'easing' under 0.8 of the usual week, 'steady' to 1.5, 'building' past it. */
export type LoadStretch = 'easing' | 'steady' | 'building';
export const loadStretch = (ratio: number): LoadStretch => (ratio > 1.5 ? 'building' : ratio < 0.8 ? 'easing' : 'steady');

/**
 * What to do with the load and today's body battery together. Building past 1.5× the usual week
 * says recover, whatever the battery; otherwise a low or drained battery says take today easy;
 * then room to push under 0.8×, and keep it going between.
 */
export type LoadAdvice = 'push' | 'keep' | 'easy' | 'recover';
export function loadAdvice(ratio: number, batteryLow: boolean): LoadAdvice {
  if (ratio > 1.5) return 'recover';
  if (batteryLow) return 'easy';
  return ratio < 0.8 ? 'push' : 'keep';
}

// ─────────────────────────────────────────────────────────────── heart rate

/** Minutes after a workout's end its heart rate is shown for: how fast it comes down. */
export const COOL_DOWN_MIN = 5;

export interface WorkoutHeart {
  /** Minutes from the start, and bpm; those past `end` are the cool-down. */
  points: { at: number; bpm: number }[];
  /** Minutes from start to end. */
  end: number;
  low: { at: number; bpm: number };
  peak: { at: number; bpm: number };
  /**
   * How far heart rate fell in the first minute after the end: the last minute's average less the
   * next one's. Null when the workout ended at an easy effort, below the moderate zone, where the
   * drop says little.
   */
  recovery: number | null;
}

/**
 * A workout's heart rate from the minute heart rate, with COOL_DOWN_MIN after it. Null without
 * enough readings: the minute heart rate covers the dashboard's window only.
 */
export function workoutHeart(w: Workout, date: CivilDate, intraday: Record<string, IntradaySample[]> | undefined, zones: HeartRateZones | null): WorkoutHeart | null {
  if (!intraday) return null;
  const start = Date.parse(w.startIso);
  const end = w.elapsedMin;
  const points: { at: number; bpm: number }[] = [];
  for (const d of [date, addDays(date, 1)]) {
    for (const s of intraday[d] ?? []) {
      const at = (Date.parse(s.iso) - start) / 60_000;
      if (at >= 0 && at < end + COOL_DOWN_MIN) points.push({ at, bpm: s.value });
    }
  }
  points.sort((a, b) => a.at - b.at);
  const during = points.filter((p) => p.at < end);
  if (during.length < Math.min(5, Math.max(2, end / 2))) return null;
  const low = during.reduce((a, p) => (p.bpm < a.bpm ? p : a));
  const peak = during.reduce((a, p) => (p.bpm > a.bpm ? p : a));
  const last = during.at(-1)!;
  const after = points.find((p) => p.at >= end && p.at < end + 1.5);
  const recovery = zones && after && last.at >= end - 1.5 && last.bpm >= zones.moderate ? Math.max(0, last.bpm - after.bpm) : null;
  return { points, end, low, peak, recovery };
}

// ─────────────────────────────────────────────────────────────── calories

/**
 * What the body burns at rest, a minute, for a workout's day: the day's total less its active
 * burn, over the day. Today's totals are still coming in, so today takes the latest full day's.
 */
export function restingKcalPerMinute(days: DailyRecord[], date: CivilDate): number | null {
  const last = days.at(-1)?.date;
  const i = days.findIndex((d) => d.date === date);
  for (let k = i < 0 ? days.length - 1 : i; k >= 0 && k >= i - 7; k--) {
    const d = days[k];
    if (d.date === last) continue;
    if (d.basalKcal !== null && d.basalKcal > 0) return d.basalKcal / 1440;
    if (d.totalKcal !== null && d.activeKcal !== null && d.totalKcal > d.activeKcal) return (d.totalKcal - d.activeKcal) / 1440;
  }
  return null;
}

/**
 * A workout's calorie burn: Google's calories for it less the resting burn for its length, so it
 * reads as burn above resting, like the day's calorie burn, and is part of it.
 */
export function calorieBurn(w: Workout, restingPerMinute: number | null): number | null {
  if (w.kcal === null) return null;
  if (restingPerMinute === null) return null;
  return Math.max(0, Math.round(w.kcal - restingPerMinute * w.elapsedMin));
}

// ─────────────────────────────────────────────────────────────── progress

export interface Progress {
  /** What each session's figure is. */
  measure: 'pace' | 'speed' | 'swimPace' | 'zoneMinutes';
  /** Each session counted, oldest first, with its average heart rate. */
  points: { date: CivilDate; value: number; avgHr: number | null }[];
  /** The band of average heart rate the sessions were kept within, for a pace or speed. */
  band: [number, number] | null;
  /** A straight line through them, at the first session and the last. */
  trend: [number, number] | null;
}

/** Sessions kept for a pace at much the same heart rate: within this many bpm of their median. */
const SAME_HEART_RATE = 6;

/**
 * How one kind of workout is going, oldest session first. Kinds with a distance show their pace
 * (or a bike's speed) at much the same heart rate, so an easy day and a race don't pass for
 * progress; the others show active zone minutes a session.
 */
export function progressOf(sessions: DatedWorkout[]): Progress | null {
  const oldestFirst = [...sessions].reverse();
  const paced = oldestFirst.flatMap((s) => {
    const p = paceOf(s.workout);
    return p ? [{ s, p }] : [];
  });
  let measure: Progress['measure'] = 'zoneMinutes';
  let points: Progress['points'];
  let band: [number, number] | null = null;
  if (paced.length >= Math.max(2, oldestFirst.length / 2)) {
    measure = paced[0].p.measure;
    const hrs = paced.map(({ s }) => s.workout.avgHr).filter((v): v is number => v !== null).sort((a, b) => a - b);
    let kept = paced;
    if (hrs.length >= 4) {
      const median = hrs[Math.floor(hrs.length / 2)];
      const near = paced.filter(({ s }) => s.workout.avgHr !== null && Math.abs(s.workout.avgHr - median) <= SAME_HEART_RATE);
      if (near.length >= 3) {
        kept = near;
        band = [median - SAME_HEART_RATE, median + SAME_HEART_RATE];
      }
    }
    points = kept.map(({ s, p }) => ({ date: s.date, value: p.value, avgHr: s.workout.avgHr }));
  } else {
    points = oldestFirst.map((s) => ({ date: s.date, value: zoneMinutesOf(s.workout), avgHr: s.workout.avgHr }));
  }
  if (!points.length) return null;
  return { measure, points, band, trend: fitLine(points) };
}

/** The least-squares line through dated values, at the first date and the last. */
function fitLine(points: { date: CivilDate; value: number }[]): [number, number] | null {
  if (points.length < 3) return null;
  const x = points.map((p) => daysBetween(points[0].date, p.date));
  const n = points.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, p) => a + p.value, 0) / n;
  let sxy = 0;
  let sxx = 0;
  points.forEach((p, i) => {
    sxy += (x[i] - mx) * (p.value - my);
    sxx += (x[i] - mx) ** 2;
  });
  if (!sxx) return null;
  const slope = sxy / sxx;
  return [my + slope * (x[0] - mx), my + slope * (x[n - 1] - mx)];
}

/** The share of the zone minutes the kinds listed must make up between them: the rest are left out. */
export const MAIN_SHARE = 0.95;
/** And never more kinds than this, for the rare person who does a bit of everything. */
export const MAIN_MAX = 4;

/**
 * The kinds that make up most of the workouts: biggest share first, until they come to MAIN_SHARE
 * of the zone minutes (of the time, when none earned any), so a walk now and then doesn't make
 * the list. At least one, at most MAIN_MAX.
 */
export function mainKinds(workouts: DatedWorkout[]): ReturnType<typeof kindsIn> {
  const kinds = kindsIn(workouts);
  const zone = kinds.reduce((a, k) => a + k.zoneMinutes, 0);
  const of = (k: (typeof kinds)[number]) => (zone ? k.zoneMinutes : k.minutes);
  const total = zone || kinds.reduce((a, k) => a + k.minutes, 0);
  const out: typeof kinds = [];
  let sum = 0;
  for (const k of [...kinds].sort((a, b) => of(b) - of(a))) {
    if (out.length && (sum >= MAIN_SHARE * total || out.length >= MAIN_MAX)) break;
    out.push(k);
    sum += of(k);
  }
  return out;
}

/** Each kind's share of the zone minutes from workouts, biggest first, with its sessions newest first. */
export function kindsIn(workouts: DatedWorkout[]): { kind: WorkoutKind; type: string | null; sessions: DatedWorkout[]; zoneMinutes: number; minutes: number }[] {
  const by = new Map<string, { kind: WorkoutKind; type: string | null; sessions: DatedWorkout[]; zoneMinutes: number; minutes: number }>();
  for (const s of workouts) {
    const kind = kindOf(s.workout);
    // A kind is one thing, except the ones that gather different sports: those go by type.
    const type = UMBRELLA.has(kind) ? s.workout.type : null;
    const key = `${kind}|${type ?? ''}`;
    const entry = by.get(key) ?? { kind, type, sessions: [], zoneMinutes: 0, minutes: 0 };
    by.set(key, entry);
    entry.sessions.push(s);
    entry.zoneMinutes += zoneMinutesOf(s.workout);
    entry.minutes += s.workout.activeMin;
  }
  return [...by.values()].sort((a, b) => b.zoneMinutes - a.zoneMinutes || b.sessions.length - a.sessions.length);
}
