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
    hrZones: null,
    hrv: null,
    hrvDeepSleep: null,
    nonRemHr: null,
    sleepHrFloor: null,
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

/**
 * A source known only by its id (`platform:label`, as parseSource makes it): one seen in stored
 * history whose full description a later full sync no longer carries.
 */
export function sourceFromId(id: string): SourceRef {
  const at = id.indexOf(':');
  return { id, label: at < 0 ? id : id.slice(at + 1), platform: (at < 0 ? 'UNKNOWN' : id.slice(0, at)) as Platform, method: 'UNKNOWN' };
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
  // Brand names, the same in every language, so they stay here rather than in the language file.
  const known: Record<string, string> = {
    'com.sec.android.app.shealth': 'Samsung Health', // i18n-ignore: a brand name, the same in every language
    'com.ouraring.oura': 'Oura Ring', // i18n-ignore: a brand name, the same in every language
    'com.google.android.apps.fitness': 'Google Fit', // i18n-ignore: a brand name, the same in every language
    'com.google.android.apps.healthdata': 'Health Connect', // i18n-ignore: a brand name, the same in every language
    'com.fitbit.FitbitMobile': 'Fitbit', // i18n-ignore: a brand name, the same in every language
    'com.huawei.health': 'Huawei Health', // i18n-ignore: a brand name, the same in every language
    'com.huawei.iossporthealth': 'Huawei Health', // i18n-ignore: a brand name, the same in every language
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
  /** Days with an observation written, per dataType. */
  counts: Map<string, number>;
  latest: Map<string, CivilDate>;
  sources: Map<string, SourceRef>;
  /**
   * Each source's own reading, by dataType, date and source id, for the days more than one source
   * reported a list stream: the day's reading is picked from these when it's read (sources.ts).
   */
  variants: Map<string, Map<CivilDate, Map<string, DailyRecord>>>;
}

/**
 * Fold every stream into one date-keyed map.
 *
 * A day can hold several readings of one stream: two devices, a partial reading
 * beside a full one, a night and a nap. They are applied best first (the stream's
 * `rank`, then its source), and `apply` only fills what's still empty, so the
 * result never depends on the order the API listed them in, and an incremental
 * sync agrees with a full one.
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

  const variants = new Map<string, Map<CivilDate, Map<string, DailyRecord>>>();

  for (const { stream, points } of inputs) {
    // Each source's own reading, read the same way from its own points alone.
    if (stream.mode === 'list') {
      const bySource = new Map<string, any[]>();
      for (const dp of points ?? []) {
        const id = parseSource(dp?.dataSource)?.id ?? '';
        const own = bySource.get(id);
        if (own) own.push(dp);
        else bySource.set(id, [dp]);
      }
      if (bySource.size > 1) {
        const byDate = new Map<CivilDate, Map<string, DailyRecord>>();
        for (const [id, own] of bySource) {
          for (const [date, row] of normalize([{ stream, points: own }]).days) {
            const forDate = byDate.get(date);
            if (forDate) forDate.set(id, row);
            else byDate.set(date, new Map([[id, row]]));
          }
        }
        // A reading that names no source can't be chosen, so its day keeps the readings combined.
        for (const [date, forDate] of byDate) if (forDate.size < 2 || forDate.has('')) byDate.delete(date);
        if (byDate.size) variants.set(stream.dataType, byDate);
      }
    }

    const parsed: { c: any; dp: any; date: CivilDate; source?: SourceRef; rank: number }[] = [];
    for (const dp of stream.prepare ? stream.prepare(points ?? []) : points ?? []) {
      const container = dp?.[stream.container];
      // Rollup points nest values under the container; some list points are flat.
      const c = container ?? (stream.mode === 'list' ? dp : undefined);
      if (!c) continue;

      const date = stream.dateOf(c, dp);
      if (!date) continue;

      const source = parseSource(dp?.dataSource);
      if (source) sources.set(source.id, source);
      parsed.push({ c, dp, date, source, rank: stream.rank?.(c) ?? 0 });
    }
    // Best reading first; a stable sort keeps the API's order among equals.
    parsed.sort((a, b) => b.rank - a.rank || compareIds(a.source?.id, b.source?.id));

    const written = new Set<CivilDate>();
    for (const { c, dp, date, source } of parsed) {
      const row = rowFor(date);
      if (!stream.apply({ row, source }, c, dp)) continue;
      written.add(date);
      const prev = latest.get(stream.dataType);
      if (!prev || date > prev) latest.set(stream.dataType, date);
    }
    counts.set(stream.dataType, written.size);
  }

  return { days, counts, latest, sources, variants };
}

const compareIds = (a = '', b = '') => (a < b ? -1 : a > b ? 1 : 0);

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
