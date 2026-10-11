import { dateRange, type CivilDate } from '../lib/date';
import type { DailyRecord, Platform, RecordingMethod, SourceRef } from '../types/health';
import type { StreamDescriptor } from './registry';

/**
 * Normalisation: raw payload arrays → a dense grid of `DailyRecord`s.
 *
 * "Dense" is the important word. The old build looped over the last 28 days and,
 * for each one, ran a linear `.find()` across every payload array — O(days ×
 * points) per metric, and it returned 0 whenever the find missed. Here we invert
 * it: walk each payload once, bucket observations by civil date, then materialise
 * one row per day in the window. Missing stays `null`.
 */

export function emptyRecord(date: CivilDate): DailyRecord {
  return {
    date,
    steps: null,
    distanceKm: null,
    floors: null,
    activeMinutes: null,
    zoneMinutes: null,
    totalKcal: null,
    activeKcal: null,
    basalKcal: null,
    sleep: null,
    naps: [],
    restingHr: null,
    hrv: null,
    hrvDeepSleep: null,
    nonRemHr: null,
    hrvEntropy: null,
    respiratoryRate: null,
    spo2: null,
    vo2Max: null,
    vo2MaxCovariance: null,
    cardioFitnessLevel: null,
    skinTempDeviationC: null,
    skinTempNightlyC: null,
    weightKg: null,
    bodyFatPct: null,
    hydrationL: null,
    bloodGlucoseMgDl: null,
    caloriesKcal: undefined,
    proteinG: undefined,
    carbsG: undefined,
    fatG: undefined,
    present: [],
    sources: [],
    sourceByType: {},
  };
}

/** Google's `dataSource` block → a stable, groupable source reference. */
export function parseSource(dataSource: any): SourceRef | undefined {
  if (!dataSource) return undefined;
  const platform = (String(dataSource.platform ?? 'UNKNOWN').toUpperCase() as Platform) ?? 'UNKNOWN';
  const method = (String(dataSource.recordingMethod ?? 'UNKNOWN').toUpperCase() as RecordingMethod);
  const device = dataSource.device ?? {};
  const app: string | undefined = dataSource.application?.packageName;

  const label =
    device.displayName ||
    (app ? prettifyPackage(app) : undefined) ||
    (device.formFactor ? titleCase(device.formFactor) : undefined) ||
    titleCase(platform);

  return {
    id: `${platform}:${label}`,
    label,
    platform,
    method,
    app,
    formFactor: device.formFactor,
  };
}

function prettifyPackage(pkg: string): string {
  const known: Record<string, string> = {
    'com.sec.android.app.shealth': 'Samsung Health',
    'com.ouraring.oura': 'Oura Ring',
    'com.google.android.apps.fitness': 'Google Fit',
    'com.google.android.apps.healthdata': 'Health Connect',
    'com.fitbit.FitbitMobile': 'Fitbit',
  };
  if (known[pkg]) return known[pkg];
  const tail = pkg.split('.').pop() ?? pkg;
  return titleCase(tail);
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s_])([a-z])/g, (_, p, c) => p + c.toUpperCase()).replace(/_/g, ' ');

export interface NormalizeInput {
  stream: StreamDescriptor;
  /** `rollupDataPoints` or `dataPoints`, already concatenated across pages. */
  points: any[];
}

export interface NormalizeResult {
  days: Map<CivilDate, DailyRecord>;
  /** Observations actually written, per dataType. */
  counts: Map<string, number>;
  latest: Map<string, CivilDate>;
  sources: Map<string, SourceRef>;
}

/**
 * Fold every stream into one date-keyed map.
 *
 * Order matters for two streams: sleep (main session vs naps) and SpO₂ (prefer a reading that carries a min/max envelope). Both are handled inside their descriptors' `apply`, which is why `apply` receives the row rather than returning a patch to be blindly merged.
 */
export function normalize(inputs: NormalizeInput[]): NormalizeResult {
  const days = new Map<CivilDate, DailyRecord>();
  const counts = new Map<string, number>();
  const latest = new Map<string, CivilDate>();
  const sources = new Map<string, SourceRef>();

  const rowFor = (date: CivilDate) => {
    let row = days.get(date);
    if (!row) {
      row = emptyRecord(date);
      days.set(date, row);
    }
    return row;
  };

  for (const { stream, points } of inputs) {
    let written = 0;
    for (const dp of points ?? []) {
      const container = dp?.[stream.container];
      // Rollup points nest values under the container; some list points are flat.
      const c = container ?? (stream.mode === 'list' ? dp : undefined);
      if (!c) continue;

      const date = stream.dateOf(c, dp);
      if (!date) continue;

      const source = parseSource(dp?.dataSource);
      if (source) sources.set(source.id, source);

      const row = rowFor(date);
      const ok = stream.apply({ row, source }, c, dp);
      if (!ok) continue;

      written++;
      const prev = latest.get(stream.dataType);
      if (!prev || date > prev) latest.set(stream.dataType, date);
    }
    counts.set(stream.dataType, written);
  }

  return { days, counts, latest, sources };
}

/**
 * Materialise a contiguous, ascending array of rows covering `from`..`to`.
 * Days with no observation are present but empty, which is what makes the
 * coverage matrix and the gap detection possible.
 */
export function materialise(
  map: Map<CivilDate, DailyRecord>,
  from: CivilDate,
  to: CivilDate,
): DailyRecord[] {
  return dateRange(from, to).map((d) => map.get(d) ?? emptyRecord(d));
}

/** Observed date bounds across all streams, for auto-sizing the window. */
export function observedBounds(map: Map<CivilDate, DailyRecord>): { min: CivilDate; max: CivilDate } | null {
  const keys = [...map.keys()].sort();
  if (!keys.length) return null;
  return { min: keys[0], max: keys[keys.length - 1] };
}
