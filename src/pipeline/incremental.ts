import { addDays, dateRange, type CivilDate } from '../lib/date';
import type { DailyRecord, HealthDataset, SleepSession, SourceRef, StreamErrorCode, StreamReport, StreamStatus } from '../types/health';
import { answerQueries, queriesSpan, type HistoryAnswers, type HistoryQueries } from './history';
import { fetchIntradayHeartRate, sampleCount, unpackIntraday, type IntradayDay } from './intraday';
import { emptyRecord, normalize } from './normalize';
import {
  extractProfile,
  INTRADAY_HEART_RATE,
  SLEEP_HR_LOW,
  STREAMS,
  type ProfileFacts,
  type ScopeKey,
  type StreamDescriptor,
} from './registry';
import { pool, type ApiResult, type FetchError, type HealthTransport } from './transport';

/**
 * The sync engine: decides what to fetch, fetches it, and describes what to
 * store — without knowing where it is stored. The server runs it against
 * Postgres, incrementally; the browser's demo mode and the tests run the same
 * code against `MemoryStore`, as one full sync.
 *
 * Storage is one row per (stream, civil day): the fields that stream set on
 * that day. A day is reassembled from its streams on read. Keeping streams apart
 * is what makes partial updates safe: refreshing steps can never touch sleep, and
 * a stream that fails leaves its stored days exactly as they were.
 *
 * Rules that keep incremental results identical to a full sync:
 *   - The last REFETCH_DAYS are fetched again every time: sleep lands the next
 *     morning, watches sync late, and Google revises recent totals.
 *   - Older days are settled, but only after a sync in which that stream fully
 *     succeeded. A failure leaves coverage where it was, so the next sync retries.
 *   - A full sync rebuilds everything weekly, on sign-in, and whenever
 *     PIPELINE_VERSION changes.
 */

/** Days of history the dashboard shows; the insight engine is tuned to exactly this window. */
export const DASHBOARD_WINDOW_DAYS = 62;

/**
 * Bump whenever normalisation (registry.ts, normalize.ts, sleep parsing…) or the
 * stored shapes change. Stored days were produced by the old code, so every user
 * is rebuilt with a full sync before their dashboard is shown again.
 */
export const PIPELINE_VERSION = 2;

/** Trailing days re-fetched on every sync, today included. */
export const REFETCH_DAYS = 3;

/** A full rebuild of the window at least this often, to pick up late corrections. */
export const FULL_RESYNC_DAYS = 7;

/** Default days of daily history kept and backfilled; the server reads HISTORY_DAYS. */
export const DEFAULT_HISTORY_DAYS = 730;

/** Safety cap for list paging; sleep pages hold 25 sessions. */
const MAX_LIST_PAGES = 40;

export interface SyncResult extends HealthDataset {
  profile: ProfileFacts;
  /** Answers to the history queries the app asked with this dataset, from the stored days before the window. */
  answers?: HistoryAnswers;
}

/** A dataset as stored and sent: intraday kept column-wise until the browser unpacks it. */
export type PackedDataset = Omit<SyncResult, 'heartRateSamples'> & { intraday: IntradayDay[] };

/** One stream's contribution to one civil day. */
export interface StreamDay {
  /** Only the DailyRecord fields this stream set. */
  fields: Partial<DailyRecord>;
  present: string[];
  sources: string[];
  sourceByType: Record<string, string>;
}

/** Per-stream bookkeeping carried from one sync to the next. */
export interface StreamState {
  dataType: string;
  /** Every day from `coveredFrom` through `finalThrough` is stored and settled. */
  coveredFrom: CivilDate | null;
  finalThrough: CivilDate | null;
  /** Newest day with an observation, inside the window or not. */
  latestDate: CivilDate | null;
  /** Observations parsed by the last fetch, inside the window or not. */
  parsed: number;
  /** Devices and apps seen in this stream's payloads. */
  sources: SourceRef[];
  /** Outcome of the last fetch. Observation counts are recomputed on read. */
  report: StreamReport;
  /**
   * Why the last history backfill of this stream failed, if it did; cleared on success. Kept the
   * way a report keeps its error: Google's words, or a code and what it needs. States stored
   * before codes hold one English sentence here instead.
   */
  backfillError?: string;
  backfillErrorCode?: StreamErrorCode;
  /** How many of a failed rollup backfill's date chunks failed, of how many. */
  backfillChunks?: { failed: number; total: number };
}

export interface DateRange {
  from: CivilDate;
  to: CivilDate;
}

/** Instructions for the store: replace these ranges with these days, then save the state. */
export interface StreamWrite {
  dataType: string;
  /** Delete every stored day first: the scope was withdrawn. */
  purge?: boolean;
  /** Stored days inside these ranges are deleted, then `days` (all inside them) inserted. */
  replace: DateRange[];
  days: Record<CivilDate, StreamDay>;
  state: StreamState;
}

export interface IntradayWrite {
  purge?: boolean;
  replace: DateRange[];
  days: Record<CivilDate, IntradayDay>;
  state: StreamState;
}

export interface SyncRun {
  kind: 'full' | 'incremental';
  startedAt: string;
  finishedAt: string;
  ms: number;
  totalRequests: number;
}

export interface SyncOutput {
  run: SyncRun;
  streams: StreamWrite[];
  intraday: IntradayWrite | null;
  /** Profile facts this sync read, merged over the stored ones key by key; a fact it couldn't read keeps its stored value. */
  profile?: Partial<ProfileFacts>;
  /** Stored daily rows before this date are past the history limit and can be dropped. */
  keepFrom: CivilDate;
  /** Minute-level heart rate is only kept for the dashboard window. */
  keepIntradayFrom: CivilDate;
}

export interface IncrementalOptions {
  transport: HealthTransport;
  /** "Today" in the user's zone; the window ends here. */
  today: CivilDate;
  windowDays: number;
  /** The user's IANA zone, for turning UTC intraday buckets into civil minutes. */
  timeZone: string;
  now: Date;
  /** State saved by the previous sync, keyed by dataType. Empty for a first sync. */
  states: ReadonlyMap<string, StreamState>;
  /** Refetch the whole window regardless of what is settled. */
  full: boolean;
  /**
   * Days of daily history to keep (defaults to the window). Older history is
   * fetched by `backfillStream`, not here; this only bounds what is retained.
   */
  historyDays?: number;
  grantedScopes?: ScopeKey[];
  includeIntraday?: boolean;
  /** After each stream: its English label, for logs, and its dataType, for the app to name it. */
  onProgress?: (done: number, total: number, label: string, dataType: string) => void;
}

// ─────────────────────────────────────────────────────────────── planning

/** First day to fetch for a stream: the whole window, or just what isn't settled yet. */
export function planFrom(prev: StreamState | undefined, today: CivilDate, windowStart: CivilDate, full: boolean): CivilDate {
  if (full || !prev?.coveredFrom || !prev.finalThrough || prev.coveredFrom > windowStart) return windowStart;
  const resume = addDays(prev.finalThrough, 1);
  const tail = addDays(today, -(REFETCH_DAYS - 1));
  const from = resume < tail ? resume : tail;
  return from < windowStart ? windowStart : from;
}

/**
 * Coverage after fetching [from, today]. On success, everything from the window
 * start is covered, plus any older history still joined to it without a gap;
 * on failure nothing changes. Never claims days older than `keepFrom`, since
 * those are dropped.
 */
function settle(
  prev: StreamState | undefined,
  ok: boolean,
  plan: { from: CivilDate; today: CivilDate; windowStart: CivilDate; keepFrom: CivilDate },
) {
  const clamp = (d: CivilDate | null) => (d && d < plan.keepFrom ? plan.keepFrom : d);
  if (!ok) return { coveredFrom: clamp(prev?.coveredFrom ?? null), finalThrough: prev?.finalThrough ?? null };
  const joined = !!(prev?.coveredFrom && prev.finalThrough && addDays(prev.finalThrough, 1) >= plan.from);
  const oldest = joined && prev!.coveredFrom! < plan.windowStart ? prev!.coveredFrom! : plan.windowStart;
  return { coveredFrom: clamp(oldest), finalThrough: addDays(plan.today, -REFETCH_DAYS) };
}

// ──────────────────────────────────────────────────────────────── fetching

/**
 * One stream's raw points for [from, to]. Rollups take the dates directly; lists
 * arrive newest first, so paging stops once a page reaches back past `from`
 * (with a day's slack, since a night is filed under the morning it ends).
 */
export function fetchStreamPoints(
  transport: HealthTransport,
  stream: StreamDescriptor,
  from: CivilDate,
  to: CivilDate,
): Promise<ApiResult> {
  if (stream.mode === 'rollup') return transport.rollup(stream.dataType, from, to);
  const stopBefore = addDays(from, -1);
  return transport.list(stream.dataType, {
    pageSize: stream.pageSize ?? 100,
    maxPages: MAX_LIST_PAGES,
    stopWhen: (page) =>
      page.some((dp) => {
        const date = dateOfPoint(stream, dp);
        return date !== null && date < stopBefore;
      }),
  });
}

function dateOfPoint(stream: StreamDescriptor, dp: any): CivilDate | null {
  const c = dp?.[stream.container] ?? (stream.mode === 'list' ? dp : undefined);
  return c ? stream.dateOf(c, dp) : null;
}

const EMPTY = emptyRecord('0000-00-00');
const PROVENANCE = new Set<keyof DailyRecord>(['date', 'present', 'sources', 'sourceByType']);

/** A normalised row → just what one stream contributed to it. */
export function toStreamDay(row: DailyRecord): StreamDay {
  const fields: Partial<DailyRecord> = {};
  for (const key of Object.keys(row) as (keyof DailyRecord)[]) {
    if (PROVENANCE.has(key)) continue;
    if (JSON.stringify(row[key]) !== JSON.stringify(EMPTY[key])) (fields as any)[key] = row[key];
  }
  return { fields, present: row.present, sources: row.sources, sourceByType: row.sourceByType };
}

/** Fetch one stream for [from, to] and split it into storable days, by the ranges that fully succeeded. */
async function fetchStreamDays(transport: HealthTransport, stream: StreamDescriptor, from: CivilDate, to: CivilDate) {
  const res = await fetchStreamPoints(transport, stream, from, to);
  const points: any[] = res.body?.rollupDataPoints ?? res.body?.dataPoints ?? [];

  // Only ranges fetched completely may replace stored days.
  const okRanges: DateRange[] =
    stream.mode === 'rollup'
      ? (res.chunks ?? []).filter((c) => c.ok).map((c) => ({ from: c.start, to: c.end }))
      : res.ok
        ? [{ from, to }]
        : [];

  const { days: rows, counts, latest, sources } = normalize([{ stream, points }]);
  const days: Record<CivilDate, StreamDay> = {};
  for (const [date, row] of rows) {
    if (!okRanges.some((r) => date >= r.from && date <= r.to)) continue;
    const part = toStreamDay(row);
    if (part.present.length || Object.keys(part.fields).length) days[date] = part;
  }
  return { res, points, okRanges, days, counts, latest, sources };
}

async function syncStream(
  transport: HealthTransport,
  stream: StreamDescriptor,
  prev: StreamState | undefined,
  plan: { from: CivilDate; to: CivilDate; windowStart: CivilDate; keepFrom: CivilDate; full: boolean },
): Promise<{ write: StreamWrite; points: any[] }> {
  const { res, points, okRanges, days, counts, latest, sources } = await fetchStreamDays(
    transport,
    stream,
    plan.from,
    plan.to,
  );

  const parsed = counts.get(stream.dataType) ?? 0;
  const status: StreamStatus = !res.ok ? httpStatusToStatus(res.status) : parsed ? 'ok' : 'empty';
  // A full sync starts provenance afresh, unless it failed and has nothing better.
  const carry = !(plan.full && res.ok);

  const state: StreamState = {
    dataType: stream.dataType,
    ...settle(prev, res.ok, { from: plan.from, today: plan.to, windowStart: plan.windowStart, keepFrom: plan.keepFrom }),
    latestDate: newer(carry ? prev?.latestDate : null, latest.get(stream.dataType)) ?? null,
    parsed,
    sources: mergeSources(carry ? prev?.sources ?? [] : [], [...sources.values()]),
    report: {
      dataType: stream.dataType,
      label: stream.label,
      domain: stream.domain,
      mode: stream.mode,
      status,
      observations: 0,
      requests: res.requests,
      pagesFetched: res.pages,
      truncated: res.truncated,
      ms: res.ms,
      httpStatus: res.status,
      ...reportError(res.error),
    },
  };
  return { write: { dataType: stream.dataType, replace: okRanges, days, state }, points };
}

/** Fetch whatever the plan says is due and describe what to store. */
export async function syncIncremental(opts: IncrementalOptions): Promise<SyncOutput> {
  const startedAt = new Date();
  const requestsBefore = opts.transport.requestCount;
  const windowStart = addDays(opts.today, -(opts.windowDays - 1));
  const keepFrom = addDays(opts.today, -(Math.max(opts.historyDays ?? opts.windowDays, opts.windowDays) - 1));
  const allowed = (scope: ScopeKey) => !opts.grantedScopes || opts.grantedScopes.includes(scope);

  const planned = STREAMS.filter((s) => allowed(s.scope));
  const intradayAllowed = allowed(INTRADAY_HEART_RATE.scope);
  const withIntraday = (opts.includeIntraday ?? true) && intradayAllowed;
  const total = planned.length + (withIntraday ? 1 : 0);
  let done = 0;

  let profile: Partial<ProfileFacts> | undefined;
  const streams = await pool(planned, opts.transport.concurrency, async (stream) => {
    const prev = opts.states.get(stream.dataType);
    const from = planFrom(prev, opts.today, windowStart, opts.full);
    const { write, points } = await syncStream(opts.transport, stream, prev, {
      from,
      to: opts.today,
      windowStart,
      keepFrom,
      full: opts.full,
    });
    // Lists are newest-first, so even an incremental fetch sees the latest height.
    if (stream.dataType === 'height' && write.state.report.status !== 'error') profile = { ...profile, ...extractProfile(points) };
    opts.onProgress?.(++done, total, stream.label, stream.dataType);
    return write;
  });

  // A withdrawn scope: forget what was stored under it.
  for (const s of STREAMS.filter((s) => !allowed(s.scope))) {
    streams.push({ dataType: s.dataType, purge: true, replace: [], days: {}, state: skippedState(s) });
    if (s.dataType === 'height') profile = { ...profile, ...extractProfile([]) };
  }

  // Age lives on the account's Google Health profile, behind a scope of its own; a failed read keeps the stored age.
  if (allowed('profile')) {
    const age = await opts.transport.profileAge();
    if (age !== undefined) profile = { ...profile, age };
  } else {
    profile = { ...profile, age: null };
  }

  let intraday: IntradayWrite | null = null;
  if (withIntraday) {
    const prev = opts.states.get(INTRADAY_HEART_RATE.dataType);
    const from = planFrom(prev, opts.today, windowStart, opts.full);
    const res = await fetchIntradayHeartRate(opts.transport, {
      from,
      to: opts.today,
      timeZone: opts.timeZone,
      now: opts.now,
    });
    const fetchedDays = [...res.days.values()];
    const samples = sampleCount(fetchedDays);
    const ok = !res.error;
    const carry = !(opts.full && ok);
    intraday = {
      replace: res.okRanges,
      days: Object.fromEntries(res.days),
      state: {
        dataType: INTRADAY_HEART_RATE.dataType,
        ...settle(prev, ok, { from, today: opts.today, windowStart, keepFrom: windowStart }),
        latestDate: newer(carry ? prev?.latestDate : null, fetchedDays.map((d) => d.date).sort().at(-1)) ?? null,
        parsed: samples,
        sources: [],
        report: {
          dataType: INTRADAY_HEART_RATE.dataType,
          label: INTRADAY_HEART_RATE.label,
          domain: INTRADAY_HEART_RATE.domain,
          mode: 'rollup',
          status: !ok ? httpStatusToStatus(res.status) : samples ? 'ok' : 'empty',
          observations: 0,
          requests: res.requests,
          pagesFetched: res.pages,
          truncated: false,
          ms: res.ms,
          httpStatus: res.status,
          ...reportError(res.error),
        },
      },
    };
    opts.onProgress?.(++done, total, INTRADAY_HEART_RATE.label, INTRADAY_HEART_RATE.dataType);
  } else if (!intradayAllowed) {
    intraday = { purge: true, replace: [], days: {}, state: skippedState({ ...INTRADAY_HEART_RATE, mode: 'rollup' }) };
  }

  const finishedAt = new Date();
  return {
    run: {
      kind: opts.full ? 'full' : 'incremental',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      ms: finishedAt.getTime() - startedAt.getTime(),
      totalRequests: opts.transport.requestCount - requestsBefore,
    },
    streams,
    intraday,
    profile,
    keepFrom,
    keepIntradayFrom: windowStart,
  };
}

// ─────────────────────────────────────────────────────────────── history

/** The oldest day kept for daily records. */
export const historyStart = (today: CivilDate, historyDays: number, windowDays: number) =>
  addDays(today, -(Math.max(historyDays, windowDays) - 1));

/** Streams whose stored history doesn't yet reach back to `historyStart`. */
export function historyDue(states: ReadonlyMap<string, StreamState>, start: CivilDate): StreamDescriptor[] {
  return STREAMS.filter((s) => {
    const st = states.get(s.dataType);
    return !!st?.coveredFrom && st.report.status !== 'skipped' && st.coveredFrom > start;
  });
}

/**
 * Extend one stream's stored history back to `start`: fetch the days before its
 * current coverage and store them. Runs after the window is in place, in the
 * background, so a long backfill never delays the dashboard. The stream's last
 * report (what the Data tab shows) is left alone; only coverage moves.
 */
export async function backfillStream(
  transport: HealthTransport,
  stream: StreamDescriptor,
  prev: StreamState,
  start: CivilDate,
): Promise<StreamWrite | null> {
  if (!prev.coveredFrom || prev.coveredFrom <= start) return null;
  const to = addDays(prev.coveredFrom, -1);
  const { res, okRanges, days, sources } = await fetchStreamDays(transport, stream, start, to);
  const failed = res.chunks?.filter((c) => !c.ok).length;
  const error: Pick<StreamReport, 'error' | 'errorCode'> = res.ok ? {} : reportError(res.error ?? { code: 'http', status: res.status });
  return {
    dataType: stream.dataType,
    replace: okRanges,
    days,
    state: {
      ...prev,
      coveredFrom: res.ok ? start : prev.coveredFrom,
      sources: mergeSources(prev.sources, [...sources.values()]),
      backfillError: error.error,
      backfillErrorCode: error.errorCode,
      backfillChunks: !res.ok && failed ? { failed, total: res.chunks!.length } : undefined,
    },
  };
}

/**
 * History queries answered from stored rows held in memory (demo mode, one-shot
 * syncs and tests): the same arithmetic the server runs over Postgres rows.
 */
export function answerFromRows(
  rows: ReadonlyMap<string, ReadonlyMap<CivilDate, StreamDay>>,
  queries: HistoryQueries,
  windowFrom: CivilDate,
  today: CivilDate,
): HistoryAnswers {
  let oldest: CivilDate | null = null;
  for (const days of rows.values()) for (const date of days.keys()) if (!oldest || date < oldest) oldest = date;
  const span = queriesSpan(queries, today, windowFrom, oldest);
  return answerQueries(queries, span ? assembleHistory(rows, span.from, span.to) : [], today, windowFrom, oldest);
}

/** Daily records for a long span, without the per-minute detail only "last night" views need. */
export function assembleHistory(
  rows: ReadonlyMap<string, ReadonlyMap<CivilDate, StreamDay>>,
  from: CivilDate,
  to: CivilDate,
): DailyRecord[] {
  const trim = (s: SleepSession): SleepSession => ({ ...s, segments: [], shortAwakeningsMin: [] });
  return assembleDays(rows, from, to).map((d) => ({
    ...d,
    sleep: d.sleep && trim(d.sleep),
    naps: d.naps.map(trim),
  }));
}

function skippedState(s: Pick<StreamDescriptor, 'dataType' | 'label' | 'domain' | 'mode' | 'scope'>): StreamState {
  return {
    dataType: s.dataType,
    coveredFrom: null,
    finalThrough: null,
    latestDate: null,
    parsed: 0,
    sources: [],
    report: {
      dataType: s.dataType,
      label: s.label,
      domain: s.domain,
      mode: s.mode,
      status: 'skipped',
      observations: 0,
      requests: 0,
      pagesFetched: 0,
      truncated: false,
      ms: 0,
      errorCode: 'scope',
      error: s.scope,
    },
  };
}

// ──────────────────────────────────────────────────────────────── reading

export interface StoredData {
  rows: ReadonlyMap<string, ReadonlyMap<CivilDate, StreamDay>>;
  intraday: IntradayDay[];
  states: Iterable<StreamState>;
  profile: ProfileFacts;
  run: SyncRun | null;
}

/**
 * Rebuild DailyRecords from per-stream days. Streams merge in registry order,
 * the order normalisation applies them, so the result matches normalising
 * every payload at once (asserted in the tests).
 */
export function assembleDays(
  rows: ReadonlyMap<string, ReadonlyMap<CivilDate, StreamDay>>,
  from: CivilDate,
  to: CivilDate,
): DailyRecord[] {
  return dateRange(from, to).map((date) => {
    const row = emptyRecord(date);
    for (const dataType of [...STREAMS.map((s) => s.dataType), SLEEP_HR_LOW.dataType]) {
      const part = rows.get(dataType)?.get(date);
      if (!part) continue;
      Object.assign(row, part.fields);
      for (const p of part.present) if (!row.present.includes(p)) row.present.push(p);
      for (const s of part.sources) if (!row.sources.includes(s)) row.sources.push(s);
      Object.assign(row.sourceByType, part.sourceByType);
    }
    return row;
  });
}

/** The dashboard's dataset for [from, to], built entirely from stored rows and states. */
export function assembleDataset(stored: StoredData, from: CivilDate, to: CivilDate): PackedDataset {
  const days = assembleDays(stored.rows, from, to);
  const intraday = stored.intraday
    .filter((d) => d.date >= from && d.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const observed = new Map<string, { count: number; latest: CivilDate }>();
  for (const d of days) {
    for (const dt of d.present) observed.set(dt, { count: (observed.get(dt)?.count ?? 0) + 1, latest: d.date });
  }

  const known = new Set([...STREAMS.map((s) => s.dataType), INTRADAY_HEART_RATE.dataType, SLEEP_HR_LOW.dataType]);
  const reports: StreamReport[] = [];
  const sources: SourceRef[] = [];
  for (const st of stored.states) {
    if (!known.has(st.dataType)) continue;
    const isIntraday = st.dataType === INTRADAY_HEART_RATE.dataType;
    const observations = isIntraday ? sampleCount(intraday) : observed.get(st.dataType)?.count ?? 0;
    const inWindow = isIntraday ? intraday.at(-1)?.date : observed.get(st.dataType)?.latest;
    const report: StreamReport = { ...st.report, observations, latestDate: newer(st.latestDate, inWindow) };
    // An incremental fetch of quiet days returns nothing; the window may still hold data.
    if (report.status === 'empty' && observations > 0) report.status = 'ok';
    if (!isIntraday && report.status !== 'skipped') report.parsedOutsideWindow = Math.max(0, st.parsed - observations);
    reports.push(report);
    sources.push(...st.sources);
  }
  reports.sort((a, b) => a.domain.localeCompare(b.domain) || a.label.localeCompare(b.label));

  const run = stored.run;
  return {
    meta: {
      startedAt: run?.startedAt ?? '',
      finishedAt: run?.finishedAt ?? '',
      ms: run?.ms ?? 0,
      from,
      to,
      totalRequests: run?.totalRequests ?? 0,
      streams: reports,
      hasData: reports.some((r) => r.observations > 0),
      fromCache: false,
      sources: dedupeSources(sources),
    },
    days,
    intraday,
    profile: stored.profile,
  };
}

export function unpackDataset(packed: PackedDataset): SyncResult {
  const { intraday, ...rest } = packed;
  return { ...rest, heartRateSamples: unpackIntraday(intraday) };
}

// ───────────────────────────────────────────────────────── in-memory store

/**
 * The store semantics, in memory: what the server's Postgres layer must do too.
 * Used for demo mode, for one-shot syncs, and to test incremental behaviour.
 */
export class MemoryStore implements StoredData {
  readonly rows = new Map<string, Map<CivilDate, StreamDay>>();
  readonly intradayDays = new Map<CivilDate, IntradayDay>();
  readonly stateMap = new Map<string, StreamState>();
  profile: ProfileFacts = { heightCm: null, heightRecordedOn: null };
  run: SyncRun | null = null;

  get intraday(): IntradayDay[] {
    return [...this.intradayDays.values()];
  }

  get states(): Iterable<StreamState> {
    return this.stateMap.values();
  }

  apply(out: SyncOutput): void {
    this.applyWrites(out.streams);
    if (out.intraday) {
      replaceRows(this.intradayDays, out.intraday);
      this.stateMap.set(out.intraday.state.dataType, out.intraday.state);
    }
    for (const rows of this.rows.values()) {
      for (const date of [...rows.keys()]) if (date < out.keepFrom) rows.delete(date);
    }
    for (const date of [...this.intradayDays.keys()]) if (date < out.keepIntradayFrom) this.intradayDays.delete(date);
    if (out.profile) this.profile = { ...this.profile, ...out.profile };
    this.run = out.run;
  }

  /** Stream writes alone, as a backfill step produces them. */
  applyWrites(writes: StreamWrite[]): void {
    for (const w of writes) {
      let rows = this.rows.get(w.dataType);
      if (!rows) this.rows.set(w.dataType, (rows = new Map()));
      replaceRows(rows, w);
      this.stateMap.set(w.dataType, w.state);
    }
  }

  assemble(from: CivilDate, to: CivilDate, queries?: HistoryQueries): PackedDataset {
    const dataset = assembleDataset(this, from, to);
    return queries ? { ...dataset, answers: answerFromRows(this.rows, queries, from, to) } : dataset;
  }
}

function replaceRows<T>(rows: Map<CivilDate, T>, w: { purge?: boolean; replace: DateRange[]; days: Record<CivilDate, T> }) {
  if (w.purge) rows.clear();
  for (const date of [...rows.keys()]) {
    if (w.replace.some((r) => date >= r.from && date <= r.to)) rows.delete(date);
  }
  for (const [date, day] of Object.entries(w.days)) rows.set(date, day);
}

// ──────────────────────────────────────────────────────────────── helpers

function newer(a: CivilDate | null | undefined, b: CivilDate | null | undefined): CivilDate | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const byId = new Map<string, SourceRef>();
  for (const s of [...a, ...b]) byId.set(s.id, s);
  return [...byId.values()];
}

function httpStatusToStatus(status: number): StreamStatus {
  if (status === 401 || status === 403) return 'unauthorized';
  return 'error';
}

/**
 * A failed fetch's error as its report keeps it: Google's words (or the network's), shortened, or
 * a code and what it needs, for the app to say in the person's language.
 */
export function reportError(e: FetchError | { code: 'truncated' } | undefined): Pick<StreamReport, 'error' | 'errorCode'> {
  if (!e) return {};
  if ('text' in e) return { error: summariseError(e.text) };
  return e.code === 'http' ? { errorCode: 'http', error: String(e.status) } : { errorCode: e.code };
}

/** Google's errors are verbose JSON; keep the one sentence that helps. */
function summariseError(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const e = parsed?.error;
    if (e?.message) {
      const reason = e.details?.[0]?.reason ? ` (${e.details[0].reason})` : '';
      return `${e.code ?? ''} ${e.status ?? ''}: ${e.message}${reason}`.trim();
    }
  } catch {
    /* not JSON */
  }
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}

/** Merge duplicate labels reported under slightly different dataSource blocks. */
function dedupeSources(list: SourceRef[]): SourceRef[] {
  const byLabel = new Map<string, SourceRef>();
  for (const s of list) {
    const existing = byLabel.get(s.label);
    // Prefer the entry that names a device over a bare platform fallback.
    if (!existing || (existing.platform === 'UNKNOWN' && s.platform !== 'UNKNOWN')) {
      byLabel.set(s.label, s);
    }
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}
