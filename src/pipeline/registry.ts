import { civilFromGH, civilFromInstant, type CivilDate } from '../lib/date';
import { int, num, nullIf, round, sumOf } from './coerce';
import type { DailyRecord, MetricDomain, SourceRef } from '../types/health';
import { combineSleepPoints, parseSleepSession } from './sleep';

/**
 * THE REGISTRY — the one place field names live.
 *
 * The old pipeline scattered path strings across 685 lines and, where it wasn't
 * sure, fell back to a recursive "find me any number in this object" search. That
 * search is why VO₂max read 0 (it found the uncalibrated `vo2Max: 0` first) and
 * why skin temperature read 35.2 °C instead of the +0.34 °C deviation that
 * actually means something.
 *
 * Every stream now declares, in one object:
 *   - the container key its values live under,
 *   - how to derive the civil date it belongs to,
 *   - exactly which fields to read and what units they're in.
 *
 * Adding a metric is one entry. Fixing a renamed field is one line, and the
 * fixture tests fail loudly if a path stops resolving.
 */

export interface StreamContext {
  /** Multiple sessions can land on one day (main sleep + naps), so apply() gets the row. */
  row: DailyRecord;
  source?: SourceRef;
}

export interface StreamDescriptor {
  dataType: string;
  label: string;
  domain: MetricDomain;
  /** `rollup` = POST :dailyRollUp with a date range; `list` = GET dataPoints. */
  mode: 'rollup' | 'list';
  /** Container key inside each datapoint. */
  container: string;
  /** OAuth scope required — used to skip cleanly rather than 403 in a loop. */
  scope: ScopeKey;
  /** Which calendar day does this datapoint belong to? */
  dateOf(c: any, dp: any): CivilDate | null;
  /**
   * Write values onto the row. Return false if the datapoint held nothing usable.
   * A day can hold several readings (two devices, or a partial one beside a full
   * one); they arrive best first, so apply fills what's still empty and never
   * overwrites.
   */
  apply(ctx: StreamContext, c: any, dp: any): boolean;
  /** Which of a day's readings applies first: higher first, ties by source. Defaults to 0. */
  rank?(c: any): number;
  /** Rework a fetch's points before they're applied, for streams whose points only make sense together. */
  prepare?(points: any[]): any[];
  /** List page size. The API caps some types lower (sleep: 25). Lists page newest-first until they pass the requested start date. */
  pageSize?: number;
  /** Documented quirks, surfaced in the Data tab. */
  note?: string;
}

export type ScopeKey = 'activity' | 'sleep' | 'metrics' | 'nutrition' | 'ecg' | 'irn' | 'profile';

export const SCOPES: Record<ScopeKey, string> = {
  activity: 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  sleep: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  metrics: 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  nutrition: 'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  ecg: 'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
  irn: 'https://www.googleapis.com/auth/googlehealth.irn.readonly',
  // Not a stream: the age shown on the Body page.
  profile: 'https://www.googleapis.com/auth/googlehealth.profile.readonly',
};

/** Rollup datapoints carry `civilStartTime.date`. */
const rollupDate = (_c: any, dp: any): CivilDate | null => civilFromGH(dp?.civilStartTime?.date);

/** Most `daily-*` list types carry a bare `date` on the container. */
const containerDate = (c: any): CivilDate | null => civilFromGH(c?.date);

/** Point-in-time measurements carry `sampleTime.civilTime.date`, or an instant + offset. */
const sampleDate = (c: any): CivilDate | null =>
  civilFromGH(c?.sampleTime?.civilTime?.date) ??
  civilFromInstant(c?.sampleTime?.physicalTime, c?.sampleTime?.utcOffset)?.date ??
  null;

const mark = (ctx: StreamContext, dataType: string) => {
  if (!ctx.row.present.includes(dataType)) ctx.row.present.push(dataType);
  if (ctx.source) {
    if (!ctx.row.sources.includes(ctx.source.id)) ctx.row.sources.push(ctx.source.id);
    // The first reading applied is the best one; it names the source.
    ctx.row.sourceByType[dataType] ??= ctx.source.id;
  }
};

/** Set a field unless a better reading already did. Returns whether it was set. */
function fill<K extends keyof DailyRecord>(row: DailyRecord, key: K, value: DailyRecord[K]): boolean {
  if (value === null || value === undefined || (row[key] !== null && row[key] !== undefined)) return false;
  row[key] = value;
  return true;
}

/** Earliest in the day first: the morning weigh-in is the comparable one. */
const earliestFirst = (c: any) => {
  const t = Date.parse(c?.sampleTime?.physicalTime ?? '');
  return Number.isNaN(t) ? -Number.MAX_SAFE_INTEGER : -t;
};

export const STREAMS: StreamDescriptor[] = [
  // ─────────────────────────────────────────────────────────────── movement
  {
    dataType: 'steps',
    label: 'Steps',
    domain: 'movement',
    mode: 'rollup',
    container: 'steps',
    scope: 'activity',
    dateOf: rollupDate,
    apply(ctx, c) {
      const v = int(c?.countSum);
      if (v === null) return false;
      ctx.row.steps = v;
      mark(ctx, 'steps');
      return true;
    },
  },
  {
    dataType: 'distance',
    label: 'Distance',
    domain: 'movement',
    mode: 'rollup',
    container: 'distance',
    scope: 'activity',
    dateOf: rollupDate,
    note: 'Reported in millimetres; converted to km here so the UI never divides twice.',
    apply(ctx, c) {
      const mm = num(c?.millimetersSum);
      if (mm === null) return false;
      ctx.row.distanceKm = round(mm / 1_000_000, 2);
      mark(ctx, 'distance');
      return true;
    },
  },
  {
    dataType: 'floors',
    label: 'Floors climbed',
    domain: 'movement',
    mode: 'rollup',
    container: 'floors',
    scope: 'activity',
    dateOf: rollupDate,
    apply(ctx, c) {
      const v = int(c?.countSum);
      if (v === null) return false;
      ctx.row.floors = v;
      mark(ctx, 'floors');
      return true;
    },
  },
  {
    dataType: 'active-minutes',
    label: 'Active minutes',
    domain: 'movement',
    mode: 'rollup',
    container: 'activeMinutes',
    scope: 'activity',
    dateOf: rollupDate,
    note: 'Split by LIGHT / MODERATE / VIGOROUS. The split is kept, not summed away.',
    apply(ctx, c) {
      const levels = c?.activeMinutesRollupByActivityLevel;
      if (!Array.isArray(levels) || !levels.length) return false;
      const bucket = { light: 0, moderate: 0, vigorous: 0 };
      let any = false;
      for (const l of levels) {
        const mins = int(l?.activeMinutesSum);
        if (mins === null) continue;
        const key = String(l?.activityLevel ?? '').toLowerCase();
        if (key === 'light' || key === 'moderate' || key === 'vigorous') {
          bucket[key] += mins;
          any = true;
        }
      }
      if (!any) return false;
      ctx.row.activeMinutes = bucket;
      mark(ctx, 'active-minutes');
      return true;
    },
  },
  {
    dataType: 'active-zone-minutes',
    label: 'Active Zone Minutes',
    domain: 'movement',
    mode: 'rollup',
    container: 'activeZoneMinutes',
    scope: 'activity',
    dateOf: rollupDate,
    note: 'Zone split preserved. AZM total weights cardio and peak double — derived, not stored.',
    apply(ctx, c) {
      const fatBurn = int(c?.sumInFatBurnHeartZone) ?? 0;
      const cardio = int(c?.sumInCardioHeartZone) ?? 0;
      const peak = int(c?.sumInPeakHeartZone) ?? 0;
      if (fatBurn === 0 && cardio === 0 && peak === 0) {
        // A genuine all-zero day is still an observation — the watch was worn.
        if (c?.sumInFatBurnHeartZone === undefined) return false;
      }
      ctx.row.zoneMinutes = { fatBurn, cardio, peak };
      mark(ctx, 'active-zone-minutes');
      return true;
    },
  },

  // ───────────────────────────────────────────────────────────────── energy
  {
    dataType: 'total-calories',
    label: 'Total energy',
    domain: 'movement',
    mode: 'rollup',
    container: 'totalCalories',
    scope: 'activity',
    dateOf: rollupDate,
    apply(ctx, c) {
      const v = num(c?.kcalSum);
      if (v === null) return false;
      ctx.row.totalKcal = Math.round(v);
      mark(ctx, 'total-calories');
      return true;
    },
  },
  {
    dataType: 'active-energy-burned',
    label: 'Active energy',
    domain: 'movement',
    mode: 'rollup',
    container: 'activeEnergyBurned',
    scope: 'activity',
    dateOf: rollupDate,
    apply(ctx, c) {
      const v = num(c?.kcalSum);
      if (v === null) return false;
      ctx.row.activeKcal = Math.round(v);
      mark(ctx, 'active-energy-burned');
      return true;
    },
  },

  // ────────────────────────────────────────────────────────────────── sleep
  {
    dataType: 'sleep',
    label: 'Sleep sessions',
    domain: 'sleep',
    mode: 'list',
    container: 'sleep',
    scope: 'sleep',
    pageSize: 25,
    note:
      'Sessions are keyed to the morning you woke, from endTime + endUtcOffset. ' +
      'metadata.mainSleep separates the night from naps. Overlapping copies from two devices ' +
      'count once, and a night split by a long awakening is joined into one.',
    prepare: combineSleepPoints,
    rank: (c) => (c?.metadata?.mainSleep === true ? 100_000 : 0) + (int(c?.summary?.minutesAsleep) ?? 0),
    dateOf(c) {
      // A night is filed under the morning you woke. A nap is filed under the day you
      // took it — an evening nap that runs past midnight still belongs to that evening.
      const isNap = c?.metadata?.nap === true;
      const anchor = isNap ? c?.interval?.startTime : c?.interval?.endTime;
      const offset = isNap ? c?.interval?.startUtcOffset : c?.interval?.endUtcOffset;
      return civilFromInstant(anchor, offset)?.date ?? null;
    },
    apply(ctx, c) {
      const session = parseSleepSession(c, ctx.row.date, ctx.source);
      if (!session) return false;
      if (session.isMainSleep) {
        // Two separate sleeps ending on one day: the longer is the night, the other a nap.
        const asNap = (s: typeof session) => ({ ...s, isMainSleep: false, isNap: true });
        if (!ctx.row.sleep || session.minutesAsleep > ctx.row.sleep.minutesAsleep) {
          if (ctx.row.sleep) ctx.row.naps.push(asNap(ctx.row.sleep));
          ctx.row.sleep = session;
        } else {
          ctx.row.naps.push(asNap(session));
        }
      } else {
        ctx.row.naps.push(session);
      }
      mark(ctx, 'sleep');
      return true;
    },
  },

  // ─────────────────────────────────────────────────────── cardio & vitals
  {
    dataType: 'electrocardiogram',
    label: 'ECG',
    domain: 'cardio',
    mode: 'list',
    container: 'electrocardiogram',
    scope: 'ecg',
    note: 'ECG classifications as reported by the recording device; shown as reported, never interpreted.',
    dateOf: sampleDate,
    apply(ctx, c) {
      if (c === null) return false;
      const val = c?.classification ?? 'UNKNOWN';
      if (!ctx.row.ecg) ctx.row.ecg = [];
      ctx.row.ecg.push(val);
      mark(ctx, 'electrocardiogram');
      return true;
    }
  },
  {
    dataType: 'irregular-rhythm-notification',
    label: 'Irregular Rhythm Notification',
    domain: 'cardio',
    mode: 'list',
    container: 'irregularRhythmNotification',
    scope: 'irn',
    note: 'Irregular-rhythm notifications as reported by the device; shown as reported, never interpreted.',
    dateOf: sampleDate,
    apply(ctx, c) {
      if (c === null) return false;
      if (!ctx.row.irn) ctx.row.irn = 0;
      ctx.row.irn += 1;
      mark(ctx, 'irregular-rhythm-notification');
      return true;
    }
  },

  {
    dataType: 'daily-resting-heart-rate',
    label: 'Resting heart rate',
    domain: 'cardio',
    mode: 'list',
    container: 'dailyRestingHeartRate',
    scope: 'metrics',
    note: 'Field is `beatsPerMinute`. The previous build read `heartRateBpm`, which does not exist.',
    dateOf: containerDate,
    apply(ctx, c) {
      if (!fill(ctx.row, 'restingHr', int(c?.beatsPerMinute))) return false;
      mark(ctx, 'daily-resting-heart-rate');
      return true;
    },
  },
  {
    dataType: 'daily-heart-rate-variability',
    label: 'Heart-rate variability',
    domain: 'cardio',
    mode: 'list',
    container: 'dailyHeartRateVariability',
    scope: 'metrics',
    note:
      'Overnight average is `averageHeartRateVariabilityMilliseconds` (not `rmssdMillis`). ' +
      'Deep-sleep RMSSD ships alongside it as a separate, cleaner series.',
    dateOf: containerDate,
    // The most complete reading first; a partial one (deep-sleep RMSSD only) then fills
    // just what that one lacked instead of wiping the overnight average.
    rank: (c) =>
      [
        c?.averageHeartRateVariabilityMilliseconds,
        c?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds,
        c?.nonRemHeartRateBeatsPerMinute,
        c?.entropy,
      ].filter((v) => num(v) !== null).length,
    apply(ctx, c) {
      const avg = num(c?.averageHeartRateVariabilityMilliseconds);
      const deep = num(c?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds);
      if (avg === null && deep === null) return false;
      const filled = [
        fill(ctx.row, 'hrv', round(avg, 1)),
        fill(ctx.row, 'hrvDeepSleep', round(deep, 1)),
        fill(ctx.row, 'nonRemHr', int(c?.nonRemHeartRateBeatsPerMinute)),
        fill(ctx.row, 'hrvEntropy', num(c?.entropy)),
      ];
      if (!filled.some(Boolean)) return false;
      mark(ctx, 'daily-heart-rate-variability');
      return true;
    },
  },
  {
    dataType: 'daily-oxygen-saturation',
    label: 'Blood oxygen',
    domain: 'cardio',
    mode: 'list',
    container: 'dailyOxygenSaturation',
    scope: 'metrics',
    note: 'Average plus the nightly min/max envelope — the spread matters more than the mean.',
    dateOf: containerDate,
    // Two devices can both report a day; the one with a real envelope applies first.
    rank: (c) => {
      const low = num(c?.lowerBoundPercentage);
      const high = num(c?.upperBoundPercentage);
      return low !== null && high !== null && high > low ? 1 : 0;
    },
    apply(ctx, c) {
      const avg = num(c?.averagePercentage);
      if (avg === null || ctx.row.spo2) return false;
      const low = num(c?.lowerBoundPercentage);
      const high = num(c?.upperBoundPercentage);
      ctx.row.spo2 = { avg: round(avg, 1)!, ciLower: round(low, 1), ciUpper: round(high, 1), rollingAvgSd: round(num(c?.standardDeviationPercentage), 2) };
      mark(ctx, 'daily-oxygen-saturation');
      return true;
    },
  },
  {
    dataType: 'daily-respiratory-rate',
    label: 'Breathing rate',
    domain: 'cardio',
    mode: 'list',
    container: 'dailyRespiratoryRate',
    scope: 'metrics',
    dateOf: containerDate,
    apply(ctx, c) {
      if (!fill(ctx.row, 'respiratoryRate', round(num(c?.breathsPerMinute), 1))) return false;
      mark(ctx, 'daily-respiratory-rate');
      return true;
    },
  },
  {
    dataType: 'daily-vo2-max',
    label: 'Cardio fitness (VO₂max)',
    domain: 'cardio',
    mode: 'list',
    container: 'dailyVo2Max',
    scope: 'metrics',
    note:
      'Pre-calibration days report vo2Max: 0. Treated as missing, not as a fitness collapse. ' +
      'The estimate\'s covariance is kept to judge whether a revision is news.',
    dateOf: containerDate,
    rank: (c) => (num(c?.vo2MaxCovariance) !== null ? 1 : 0),
    apply(ctx, c) {
      const v = nullIf(num(c?.vo2Max), 0);
      if (v === null || ctx.row.vo2Max !== null) return false;
      ctx.row.vo2Max = round(v, 1);
      ctx.row.vo2MaxCovariance = num(c?.vo2MaxCovariance);
      ctx.row.cardioFitnessLevel = c?.cardioFitnessLevel ?? null;
      mark(ctx, 'daily-vo2-max');
      return true;
    },
  },
  {
    dataType: 'daily-sleep-temperature-derivations',
    label: 'Skin temperature',
    domain: 'cardio',
    mode: 'list',
    container: 'dailySleepTemperatureDerivations',
    scope: 'metrics',
    note:
      'Absolute skin temp is meaningless without its baseline. We store nightly − baseline; ' +
      'baseline is the string "NaN" until ~30 nights exist, so deviation stays null until then.',
    dateOf: containerDate,
    rank: (c) => (num(c?.baselineTemperatureCelsius) !== null ? 1 : 0),
    apply(ctx, c) {
      const nightly = num(c?.nightlyTemperatureCelsius);
      const baseline = num(c?.baselineTemperatureCelsius);
      if (nightly === null || ctx.row.skinTempNightlyC !== null) return false;
      ctx.row.skinTempNightlyC = round(nightly, 2);
      ctx.row.skinTempDeviationC = baseline === null ? null : round(nightly - baseline, 2);
      mark(ctx, 'daily-sleep-temperature-derivations');
      return true;
    },
  },

  
  
  // ─────────────────────────────────────────────────────────────────── body
  {
    dataType: 'weight',
    label: 'Weight',
    domain: 'body',
    mode: 'list',
    container: 'weight',
    scope: 'metrics',
    note:
      'Grams → kg. Logged by hand, so days between readings stay null rather than flat-filled. ' +
      'Several weigh-ins on one day keep the earliest.',
    dateOf: sampleDate,
    rank: earliestFirst,
    apply(ctx, c) {
      const g = num(c?.weightGrams);
      if (g === null || g <= 0 || ctx.row.weightKg !== null) return false;
      ctx.row.weightKg = round(g / 1000, 1);
      mark(ctx, 'weight');
      return true;
    },
  },
  {
    dataType: 'body-fat',
    label: 'Body fat',
    domain: 'body',
    mode: 'list',
    container: 'bodyFat',
    scope: 'metrics',
    dateOf: sampleDate,
    rank: earliestFirst,
    apply(ctx, c) {
      const v = num(c?.percentage);
      if (v === null || v <= 0 || ctx.row.bodyFatPct !== null) return false;
      ctx.row.bodyFatPct = round(v, 1);
      mark(ctx, 'body-fat');
      return true;
    },
  },
  {
    dataType: 'height',
    label: 'Height',
    domain: 'body',
    mode: 'list',
    container: 'height',
    scope: 'metrics',
    note: 'Static profile value — read once and hoisted out of the daily rows.',
    dateOf: sampleDate,
    apply(ctx, c) {
      const mm = num(c?.heightMillimeters);
      if (mm === null || mm <= 0) return false;
      mark(ctx, 'height');
      return true;
    },
  },

  // ────────────────────────────────────────────────────────────── wellbeing
  
  {
    dataType: 'nutrition-log',
    label: 'Nutrition (Macros)',
    domain: 'wellbeing',
    mode: 'rollup',
    container: 'nutritionLog',
    scope: 'nutrition',
    dateOf: rollupDate,
    apply(ctx, c) {
      const kcal = num(c?.caloriesKcalSum ?? c?.dietaryEnergyKcalSum);
      const protein = num(c?.proteinGramsSum);
      const carbs = num(c?.carbohydratesGramsSum);
      const fat = num(c?.fatGramsSum);
      
      if (kcal === null && protein === null && carbs === null && fat === null) return false;
      
      if (kcal !== null) ctx.row.caloriesKcal = Math.round(kcal);
      if (protein !== null) ctx.row.proteinG = Math.round(protein);
      if (carbs !== null) ctx.row.carbsG = Math.round(carbs);
      if (fat !== null) ctx.row.fatG = Math.round(fat);
      
      mark(ctx, 'nutrition-log');
      return true;
    },
  },
  {
    dataType: 'hydration-log',
    label: 'Hydration',
    domain: 'wellbeing',
    mode: 'rollup',
    container: 'hydrationLog',
    scope: 'nutrition',
    dateOf: rollupDate,
    apply(ctx, c) {
      const ml = num(c?.amountConsumed?.millilitersSum ?? c?.millilitersSum);
      if (ml === null) return false;
      ctx.row.hydrationL = round(ml / 1000, 2);
      mark(ctx, 'hydration-log');
      return true;
    },
  },
  {
    dataType: 'blood-glucose',
    label: 'Blood glucose',
    domain: 'wellbeing',
    mode: 'rollup',
    container: 'bloodGlucose',
    scope: 'metrics',
    dateOf: rollupDate,
    apply(ctx, c) {
      const v = num(
        c?.bloodGlucoseMilligramsPerDeciliterAvg ?? c?.milligramsPerDeciliterAvg,
      );
      if (v === null) return false;
      ctx.row.bloodGlucoseMgDl = round(v, 1);
      mark(ctx, 'blood-glucose');
      return true;
    },
  },

];

/** Intraday heart rate is handled apart from the daily rows — see transport.ts. */
export const INTRADAY_HEART_RATE = {
  dataType: 'heart-rate',
  label: 'Heart rate (intraday)',
  domain: 'cardio' as MetricDomain,
  container: 'heartRate',
  scope: 'metrics' as ScopeKey,
  note:
    'Raw samples arrive every few seconds, so they are never listed. Google rolls them up into ' +
    'one-minute averages server-side (dataPoints:rollUp, 60s windows, ≤14 days per request).',
};

export const STREAMS_BY_TYPE = new Map(STREAMS.map((s) => [s.dataType, s]));

export const DOMAIN_LABELS: Record<MetricDomain, string> = {
  movement: 'Activity & Movement',
  sleep: 'Sleep & Recovery',
  cardio: 'Vitals & Heart',
  body: 'Body',
  wellbeing: 'Wellbeing',
};

export type Gender = 'female' | 'male' | 'other';

/** Static profile facts that don't belong on a daily row. */
export interface ProfileFacts {
  heightCm: number | null;
  heightRecordedOn: CivilDate | null;
  /** Years, from the Google Health profile; null without its scope or a birth date on the account. */
  age?: number | null;
  /** Set by the person in the app: Google Health doesn't provide it. */
  gender?: Gender | null;
}

export function extractProfile(heightPoints: any[]): ProfileFacts {
  let best: { cm: number; date: CivilDate | null } | null = null;
  for (const dp of heightPoints ?? []) {
    const c = dp?.height;
    const mm = num(c?.heightMillimeters);
    if (mm === null || mm <= 0) continue;
    const date = sampleDate(c);
    if (!best || (date && best.date && date > best.date) || !best.date) {
      best = { cm: round(mm / 10, 1)!, date };
    }
  }
  return { heightCm: best?.cm ?? null, heightRecordedOn: best?.date ?? null };
}

export { sumOf };


export const OXYGEN_SATURATION_SAMPLES = {
  dataType: 'oxygen-saturation',
  label: 'Blood Oxygen (raw samples)',
  domain: 'cardio',
  container: 'oxygenSaturation',
  scope: 'metrics',
};


export const DEVICE_CARDIAC_STREAMS = [
  'electrocardiogram',
  'irregular-rhythm-notification'
];

