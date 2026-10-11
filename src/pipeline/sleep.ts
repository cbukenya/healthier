import { civilFromInstant, type CivilDate } from '../lib/date';
import { int } from './coerce';
import type {
  SleepSession,
  SleepStageMinutes,
  SleepStageSegment,
  SourceRef,
} from '../types/health';

/**
 * Sleep is the most structured payload the API returns and the easiest to get wrong.
 *
 * Three traps, all of which the previous build fell into:
 *
 *   1. **There is no `civilEndTime` on a sleep interval.** Only `endTime` (UTC) and
 *      `endUtcOffset`. Looking for `interval.civilEndTime.date` silently matched
 *      nothing, which is why the entire sleep trend line was zeros.
 *   2. **Naps are in the same list as nights.** `metadata.mainSleep` and
 *      `metadata.nap` distinguish them. Picking the most recent session without
 *      checking made a 25-minute afternoon nap "last night's sleep".
 *   3. **`summary.minutesAwake` and the AWAKE entry in `stagesSummary` are different
 *      numbers.** The first is time awake inside the sleep period; the second is
 *      only the staged awake blocks. Assigning both to one variable makes
 *      efficiency drift. We keep them separate.
 */

const STAGE_MAP: Record<string, keyof SleepStageMinutes> = {
  DEEP: 'deep',
  LIGHT: 'light',
  REM: 'rem',
  AWAKE: 'awake',
  // Older exports use these names for the same thing.
  SLEEP_STAGE_DEEP: 'deep',
  SLEEP_STAGE_LIGHT: 'light',
  SLEEP_STAGE_REM: 'rem',
  SLEEP_STAGE_AWAKE: 'awake',
  RESTLESS: 'awake',
  OUT_OF_BED: 'awake',
};

export function parseSleepSession(
  c: any,
  fallbackDate: CivilDate,
  source?: SourceRef,
): SleepSession | null {
  const interval = c?.interval;
  const start = civilFromInstant(interval?.startTime, interval?.startUtcOffset);
  const end = civilFromInstant(interval?.endTime, interval?.endUtcOffset);
  const summary = c?.summary;
  if (!summary) return null;

  const minutesAsleep = int(summary.minutesAsleep);
  if (minutesAsleep === null || minutesAsleep <= 0) return null;

  const minutesAwake = int(summary.minutesAwake) ?? 0;
  const period = int(summary.minutesInSleepPeriod) ?? minutesAsleep + minutesAwake;

  // Stage totals come from stagesSummary, which is authoritative for composition.
  let stages: SleepStageMinutes | null = null;
  if (Array.isArray(summary.stagesSummary) && summary.stagesSummary.length) {
    const acc: SleepStageMinutes = { deep: 0, light: 0, rem: 0, awake: 0 };
    let any = false;
    for (const s of summary.stagesSummary) {
      const key = STAGE_MAP[String(s?.type ?? '').toUpperCase()];
      const mins = int(s?.minutes);
      if (!key || mins === null) continue;
      acc[key] += mins;
      any = true;
    }
    if (any) stages = acc;
  }

  const segments = parseSegments(c?.stages, interval);
  const shortAwakeningsMin = parseShortAwakenings(c?.shortAwakenings, interval);

  const isNap = c?.metadata?.nap === true;
  // `mainSleep` is the signal; fall back to a duration heuristic only when absent.
  const isMainSleep =
    c?.metadata?.mainSleep === true || (!isNap && c?.metadata?.mainSleep === undefined && minutesAsleep >= 180);

  return {
    date: (isNap ? start?.date : end?.date) ?? fallbackDate,
    isMainSleep,
    isNap,
    bedtimeMin: start?.minutesOfDay ?? 0,
    wakeMin: end?.minutesOfDay ?? 0,
    bedtimeIso: interval?.startTime ?? '',
    wakeIso: interval?.endTime ?? '',
    minutesAsleep,
    onsetLatencyMin: int(summary.minutesToFallAsleep),
    minutesAwake,
    minutesInBed: period,
    efficiency: period > 0 ? Math.round((minutesAsleep / period) * 100) : 0,
    stages,
    segments,
    shortAwakeningsMin,
    source,
  };
}

/**
 * Rebuild the hypnogram. Stage entries are absolute UTC instants; the chart needs
 * offsets from lights-out plus the local clock time for axis labels.
 */
function parseSegments(raw: any, interval: any): SleepStageSegment[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  const t0 = Date.parse(interval?.startTime ?? '');
  const base = civilFromInstant(interval?.startTime, interval?.startUtcOffset);
  if (Number.isNaN(t0) || !base) return [];

  const out: SleepStageSegment[] = [];
  for (const seg of raw) {
    const stage = STAGE_MAP[String(seg?.type ?? '').toUpperCase()];
    const s = Date.parse(seg?.startTime ?? '');
    const e = Date.parse(seg?.endTime ?? '');
    if (!stage || Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    const offsetMin = (s - t0) / 60000;
    out.push({
      stage,
      offsetMin,
      durationMin: (e - s) / 60000,
      clockMin: base.minutesOfDay + offsetMin,
    });
  }
  return out.sort((a, b) => a.offsetMin - b.offsetMin);
}

function parseShortAwakenings(raw: any, interval: any): number[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  const t0 = Date.parse(interval?.startTime ?? '');
  if (Number.isNaN(t0)) return [];
  return raw
    .map((a) => (Date.parse(a?.startTime ?? '') - t0) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
}

/**
 * Sleep score, stated openly so nobody mistakes it for a vendor number.
 *
 * Duration 50 / restoration 25 / efficiency 25. Deliberately transparent: the
 * breakdown is returned alongside the total so the UI can show *why* a night
 * scored what it did rather than presenting an unexplained 84.
 */
export interface SleepScore {
  total: number;
  duration: number;
  restoration: number;
  efficiency: number;
  /** Deep + REM as a share of time asleep. */
  restorativePct: number | null;
}

export function scoreSleep(s: SleepSession): SleepScore {
  const mins = s.minutesAsleep;

  /**
   * Duration: full marks for 7–9 h, scaling to zero at 4 h rather than at 0 h.
   *
   * Anchoring the taper at zero minutes made the curve far too forgiving — a
   * 5h32m night scored 40/50, and with efficiency and restoration near their
   * ceilings the total came out at 90, which is nonsense for five and a half
   * hours. Anchoring at 4 h means the points you lose reflect the sleep you
   * actually missed.
   */
  let duration: number;
  if (mins >= 420 && mins <= 540) duration = 50;
  else if (mins < 420) duration = Math.max(0, Math.round(((mins - 240) / 180) * 50));
  else duration = Math.max(30, Math.round(50 - ((mins - 540) / 60) * 5));

  let restoration = 0;
  let restorativePct: number | null = null;
  if (s.stages) {
    restorativePct = (s.stages.deep + s.stages.rem) / mins;
    // 45% deep+REM is treated as the ceiling.
    restoration = Math.min(25, Math.round((restorativePct / 0.45) * 25));
  } else {
    // No staging: award the midpoint rather than a zero the user can't act on.
    restoration = 13;
  }

  /**
   * Efficiency over the 85–100% range, not 0–100%. Almost nobody scores below
   * 85% time-asleep-in-bed, so the old mapping handed out 21+ points of the 25
   * unconditionally and the component carried no information.
   */
  const efficiency = Math.min(25, Math.max(0, Math.round(((s.efficiency - 85) / 15) * 25)));

  return {
    total: Math.min(100, Math.max(1, duration + restoration + efficiency)),
    duration,
    restoration,
    efficiency,
    restorativePct: restorativePct === null ? null : Math.round(restorativePct * 100),
  };
}
