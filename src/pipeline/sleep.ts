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

  // Stage totals come from stagesSummary, which is authoritative for composition. A
  // night without deep, light or REM wasn't staged (classic logs list only AWAKE and
  // RESTLESS), and reading it as stages would show 0% deep + REM.
  const stages = isStaged(summary) ? stageMinutes(summary.stagesSummary) : null;

  // Same for the hypnogram: awake blocks alone aren't one.
  const parsed = parseSegments(c?.stages, interval);
  const segments = parsed.some((s) => s.stage !== 'awake') ? parsed : [];
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

function stageMinutes(entries: any[]): SleepStageMinutes {
  const acc: SleepStageMinutes = { deep: 0, light: 0, rem: 0, awake: 0 };
  for (const s of entries) {
    const key = STAGE_MAP[String(s?.type ?? '').toUpperCase()];
    const mins = int(s?.minutes);
    if (key && mins !== null) acc[key] += mins;
  }
  return acc;
}

/** Whether a summary carries real staging: some deep, light or REM. */
function isStaged(summary: any): boolean {
  if (!Array.isArray(summary?.stagesSummary)) return false;
  const m = stageMinutes(summary.stagesSummary);
  return m.deep + m.light + m.rem > 0;
}

// ──────────────────────────────────────────── one sleep, one session

/** Pieces of a night closer than this join into one night; further apart, they're separate sleeps. */
export const SPLIT_NIGHT_GAP_MIN = 180;

interface Piece {
  dp: any;
  c: any;
  start: number;
  end: number;
  asleep: number;
  /** From metadata: the device's main sleep, an explicit nap, explicitly not the main sleep, or no word. */
  kind: 'main' | 'nap' | 'secondary' | 'unknown';
  staged: boolean;
  /** Stable tie-break between devices. */
  key: string;
}

/**
 * One sleep, one session. Runs over a fetch's sleep points before they are parsed:
 *
 *   - **Copies of one sleep** from two devices (sessions that overlap) collapse into
 *     the best copy: anything over a nap, then staged over unstaged, then the longer.
 *     Google flags only one copy as the main sleep, and not always the better one, so
 *     the flag carries over to the copy that stays. Otherwise the second copy became a
 *     "nap" and every night-time heart-rate event was counted twice.
 *   - **A night split by a long awakening** (22:00–01:15, then 03:00–07:00) is one
 *     night: pieces join when the break between them lies within 22:00–07:00 and lasts
 *     under three hours, and the break counts as awake. Otherwise only the longer piece
 *     counted, and a seven-hour night read as four. An evening doze or a mid-morning
 *     sleep stays separate.
 *   - **Sessions without `mainSleep`/`nap` metadata** are the night when they are long
 *     or cover the small hours, so a short, bad night isn't filed away as a nap.
 *
 * Each rule looks only at the sessions involved, never at what else happened to be
 * fetched, so an incremental sync and a full rebuild group nights identically.
 * Returns new points; the input is left untouched.
 */
export function combineSleepPoints(points: any[]): any[] {
  const out: any[] = [];
  const pieces: Piece[] = [];
  for (const dp of points) {
    const c = dp?.sleep;
    const start = Date.parse(c?.interval?.startTime ?? '');
    const end = Date.parse(c?.interval?.endTime ?? '');
    const asleep = int(c?.summary?.minutesAsleep);
    if (!c || Number.isNaN(start) || Number.isNaN(end) || end <= start || asleep === null || asleep <= 0) {
      out.push(dp); // unusable either way; the parser rejects it as before
      continue;
    }
    const meta = c.metadata ?? {};
    const kind = meta.nap === true ? 'nap' : meta.mainSleep === true ? 'main' : meta.mainSleep === false ? 'secondary' : 'unknown';
    pieces.push({ dp, c, start, end, asleep, kind, staged: isStaged(c.summary), key: JSON.stringify(dp.dataSource ?? null) });
  }

  // 1. Overlapping sessions are one sleep recorded twice: keep the best copy.
  const isNap = (p: Piece) => (p.kind === 'nap' ? 1 : 0);
  const ranked = [...pieces].sort(
    (a, b) =>
      isNap(a) - isNap(b) ||
      Number(b.staged) - Number(a.staged) ||
      b.asleep - a.asleep ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
      a.start - b.start,
  );
  const kept: Piece[] = [];
  for (const p of ranked) {
    const copyOf = kept.find((k) => p.start < k.end && k.start < p.end);
    if (!copyOf) kept.push(p);
    else if (p.kind === 'main' && copyOf.kind !== 'nap') copyOf.kind = 'main';
  }

  // 2. Everything but an explicit nap can be a piece of a night.
  const chains: Piece[][] = [];
  for (const p of kept.filter((x) => x.kind !== 'nap').sort((a, b) => a.start - b.start)) {
    const chain = chains[chains.length - 1];
    const prev = chain?.[chain.length - 1];
    if (prev && p.start - prev.end <= SPLIT_NIGHT_GAP_MIN * 60_000 && breakInTheNight(prev.c, p.c)) chain.push(p);
    else chains.push([p]);
  }

  for (const p of kept) if (p.kind === 'nap') out.push(asKind(p, false));
  for (const chain of chains) {
    if (!isNight(chain)) for (const p of chain) out.push(asKind(p, false));
    else out.push(chain.length === 1 ? asKind(chain[0], true) : joinNight(chain));
  }
  return out;
}

/** The night if the device says so; with no word from it, if it's long or covers the small hours. */
function isNight(chain: Piece[]): boolean {
  if (chain.some((p) => p.kind === 'main')) return true;
  if (!chain.some((p) => p.kind === 'unknown')) return false;
  const asleep = chain.reduce((a, p) => a + p.asleep, 0);
  return asleep >= 180 || (asleep >= 60 && chain.some((p) => coversSmallHours(p.c)));
}

/** Crosses local midnight, or starts before 05:00. */
function coversSmallHours(c: any): boolean {
  const s = civilFromInstant(c.interval.startTime, c.interval.startUtcOffset);
  const e = civilFromInstant(c.interval.endTime, c.interval.endUtcOffset);
  return !!s && !!e && (s.date !== e.date || s.minutesOfDay < 5 * 60);
}

/** Woke and fell asleep again between 22:00 and 07:00 local: a break in the night, not a separate sleep. */
function breakInTheNight(before: any, after: any): boolean {
  const woke = civilFromInstant(before.interval.endTime, before.interval.endUtcOffset);
  const slept = civilFromInstant(after.interval.startTime, after.interval.startUtcOffset);
  const night = (m: number) => m >= 22 * 60 || m < 7 * 60;
  return !!woke && !!slept && night(woke.minutesOfDay) && night(slept.minutesOfDay);
}

/** The point with its classification written into metadata, where the parser and the date key read it. */
function asKind(p: Piece, night: boolean): any {
  return { ...p.dp, sleep: { ...p.c, metadata: { ...p.c.metadata, mainSleep: night, nap: !night } } };
}

/** Pieces of one night as one session; the time between them counts as awake. */
function joinNight(chain: Piece[]): any {
  const first = chain[0].c;
  const last = chain[chain.length - 1].c;
  const lead = chain.reduce((a, b) => (b.asleep > a.asleep ? b : a));
  const gapMin = Math.round(chain.slice(1).reduce((a, p, i) => a + (p.start - chain[i].end) / 60_000, 0));
  const total = (get: (c: any) => number) => chain.reduce((a, p) => a + get(p.c), 0);
  const asleep = (c: any) => int(c.summary.minutesAsleep) ?? 0;
  const awake = (c: any) => int(c.summary.minutesAwake) ?? 0;
  const period = (c: any) => int(c.summary.minutesInSleepPeriod) ?? asleep(c) + awake(c);

  // Staging and the hypnogram only when every piece has them; half a night's stages would skew the shares.
  const staged = chain.every((p) => p.staged);
  const segmented = staged && chain.every((p) => Array.isArray(p.c.stages) && p.c.stages.length > 0);
  const breaks = chain.slice(1).map((p, i) => ({
    type: 'AWAKE',
    startTime: chain[i].c.interval.endTime,
    endTime: p.c.interval.startTime,
  }));
  let stagesSummary: any[] = [];
  if (staged) {
    const m = stageMinutes(chain.flatMap((p) => p.c.summary.stagesSummary));
    stagesSummary = [
      { type: 'DEEP', minutes: String(m.deep) },
      { type: 'LIGHT', minutes: String(m.light) },
      { type: 'REM', minutes: String(m.rem) },
      { type: 'AWAKE', minutes: String(m.awake + gapMin) },
    ];
  }

  return {
    ...lead.dp,
    sleep: {
      ...first,
      interval: {
        startTime: first.interval.startTime,
        startUtcOffset: first.interval.startUtcOffset,
        endTime: last.interval.endTime,
        endUtcOffset: last.interval.endUtcOffset,
      },
      metadata: { ...lead.c.metadata, mainSleep: true, nap: false },
      summary: {
        minutesAsleep: String(total(asleep)),
        minutesAwake: String(total(awake) + gapMin),
        minutesInSleepPeriod: String(total(period) + gapMin),
        minutesToFallAsleep: first.summary.minutesToFallAsleep,
        minutesAfterWakeUp: last.summary.minutesAfterWakeUp,
        stagesSummary,
      },
      stages: segmented ? [...chain.flatMap((p) => p.c.stages), ...breaks] : [],
      shortAwakenings: chain.flatMap((p) => p.c.shortAwakenings ?? []),
    },
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
