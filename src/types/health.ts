import type { CivilDate } from '../lib/date';

/**
 * The canonical schema.
 *
 * Everything upstream of this file deals in Google's payload shapes; everything
 * downstream deals only in these types. The UI never sees `countSum`,
 * `millimetersSum` or a `nextPageToken`.
 *
 * Two rules make this schema trustworthy:
 *
 *   1. **`null` means "not recorded"**, and it is never coerced to 0. The old
 *      pipeline returned 0 for missing days, so a gap in wearable sync looked
 *      identical to a day spent motionless — and it dragged every average down.
 *   2. **Every value carries its provenance.** A weight typed into Fitbit by hand
 *      and one read off a scale are different kinds of fact.
 */

// ─────────────────────────────────────────────────────────────── provenance

export type Platform = 'FITBIT' | 'HEALTH_CONNECT' | 'GOOGLE_FIT' | 'UNKNOWN';
export type RecordingMethod =
  | 'PASSIVELY_MEASURED'
  | 'ACTIVELY_RECORDED'
  | 'DERIVED'
  | 'MANUAL'
  | 'UNKNOWN';

export interface SourceRef {
  /** Stable key we can group by, e.g. "FITBIT:Google Fitbit Air". */
  id: string;
  /** Human label, e.g. "Google Fitbit Air" or "Samsung Health". */
  label: string;
  platform: Platform;
  method: RecordingMethod;
  /** Android package, when the platform reports one. */
  app?: string;
  /** "WATCH" | "RING" | "PHONE" | "SCALE" … when reported. */
  formFactor?: string;
}

/** A single number plus where it came from. */
export interface Measure<T = number> {
  value: T;
  source?: SourceRef;
}

// ─────────────────────────────────────────────────────────── daily records

export interface SleepStageMinutes {
  deep: number;
  light: number;
  rem: number;
  awake: number;
}

export interface SleepStageSegment {
  stage: 'deep' | 'light' | 'rem' | 'awake';
  /** Minutes from the start of the sleep period. */
  offsetMin: number;
  durationMin: number;
  /** Local clock minutes-of-day at segment start, for axis labels. */
  clockMin: number;
}

export interface SleepSession {
  /** The civil date the sleep *ended* — i.e. the morning you woke up. */
  date: CivilDate;
  isMainSleep: boolean;
  isNap: boolean;
  /** Local clock, minutes past midnight. May exceed nothing — always 0..1439. */
  bedtimeMin: number;
  wakeMin: number;
  bedtimeIso: string;
  wakeIso: string;
  minutesAsleep: number;
  /** Sleep-onset latency reported by the device (minutes to fall asleep). */
  onsetLatencyMin: number | null;
  minutesAwake: number;
  minutesInBed: number;
  /** minutesAsleep / minutesInBed, as a percentage. */
  efficiency: number;
  stages: SleepStageMinutes | null;
  /** Full hypnogram, present when the device reported staged sleep. */
  segments: SleepStageSegment[];
  /** Sub-minute wakeups the watch flagged but didn't stage. */
  shortAwakeningsMin: number[];
  source?: SourceRef;
}

/**
 * One row per calendar day. Sparse by design: a field is absent when the day
 * holds no observation for it.
 */
/**
 * Where each heart rate zone starts that day, in bpm, as Google Health sets them from resting
 * heart rate (the Karvonen method). Below Light is rest.
 */
export interface HeartRateZones {
  light: number;
  moderate: number;
  vigorous: number;
  peak: number;
}

export interface DailyRecord {
  date: CivilDate;

  // movement
  steps: number | null;
  distanceKm: number | null;
  floors: number | null;
  activeMinutes: { light: number; moderate: number; vigorous: number } | null;
  /** Fitbit Active Zone Minutes, kept as the raw zone split. */
  zoneMinutes: { fatBurn: number; cardio: number; peak: number } | null;

  // energy
  totalKcal: number | null;
  activeKcal: number | null;
  basalKcal: number | null;

  // sleep — the main session for this morning, naps excluded
  sleep: SleepSession | null;
  naps: SleepSession[];

  // cardiovascular & respiratory
  ecg?: string[];
  irn?: number;
  
  
  restingHr: number | null;
  /** The day's heart rate zones. */
  hrZones: HeartRateZones | null;
  /** Overnight average HRV in ms (Google's `averageHeartRateVariabilityMilliseconds`). */
  hrv: number | null;
  /** HRV during deep sleep only (RMSSD), a less noisy signal on some nights. */
  hrvDeepSleep: number | null;
  /** Non-REM heart rate, reported alongside HRV. */
  nonRemHr: number | null;
  /** On-device nonlinear metric over the night's true beat-to-beat intervals. Opaque vendor formula: track shifts only, never interpret levels. */
  hrvEntropy: number | null;
  respiratoryRate: number | null;
  spo2: { avg: number; ciLower: number | null; ciUpper: number | null; rollingAvgSd: number | null } | null;
  vo2Max: number | null;
  /** Variance of the VO₂max estimate — √cov ≈ its own SD. Gates the revision insight. */
  vo2MaxCovariance: number | null;
  cardioFitnessLevel: string | null;

  // temperature — *deviation* from the rolling baseline, which is the useful figure
  skinTempDeviationC: number | null;
  skinTempNightlyC: number | null;

  // body
  weightKg: number | null;
  bodyFatPct: number | null;

  // wellbeing
  hydrationL: number | null;
  bloodGlucoseMgDl: number | null;
  caloriesKcal?: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;

  /** Which dataTypes contributed to this row, for the coverage matrix. */
  present: string[];
  /** Sources that touched this day. */
  sources: string[];
  /**
   * Which source supplied each dataType on this day.
   *
   * `sources` alone is the union across every stream, so reading it to label a
   * single weight reading attributed that reading to whichever devices happened
   * to sync anything that day — a hand-typed weight was credited to the watch.
   */
  sourceByType: Record<string, string>;
}

/** Intraday samples, fetched separately because they're high-volume. */
export interface IntradaySample {
  iso: string;
  date: CivilDate;
  minutesOfDay: number;
  value: number;
}

// ─────────────────────────────────────────────────────── pipeline metadata

export type StreamStatus = 'ok' | 'empty' | 'error' | 'unauthorized' | 'skipped';

/** One row per dataType per sync: what we asked for and what came back. */
export interface StreamReport {
  dataType: string;
  label: string;
  domain: MetricDomain;
  mode: 'rollup' | 'list';
  status: StreamStatus;
  /** Observations that fell inside the requested window (not raw payload items). */
  observations: number;
  /**
   * Parsed fine but dated outside the window. List endpoints ignore date ranges,
   * so this is normal for sparse history like weight — worth showing, not hiding.
   */
  parsedOutsideWindow?: number;
  /** HTTP requests spent, including pagination and date chunking. */
  requests: number;
  pagesFetched: number;
  truncated: boolean;
  ms: number;
  httpStatus?: number;
  error?: string;
  /** Most recent civil date with an observation. */
  latestDate?: CivilDate;
}

export type MetricDomain = 'movement' | 'sleep' | 'cardio' | 'body' | 'wellbeing';

export interface SyncMeta {
  startedAt: string;
  finishedAt: string;
  ms: number;
  /** Civil window the sync covered. */
  from: CivilDate;
  to: CivilDate;
  totalRequests: number;
  streams: StreamReport[];
  /** True when at least one stream returned an observation. */
  hasData: boolean;
  fromCache: boolean;
  cacheAgeMs?: number;
  /** Distinct devices/apps detected across all streams. */
  sources: SourceRef[];
}

export interface HealthDataset {
  meta: SyncMeta;
  /** Ascending by date, one entry per calendar day in the window, gaps included. */
  days: DailyRecord[];
  /** Minute-level heart rate across the window, ascending. */
  heartRateSamples: IntradaySample[];
}
