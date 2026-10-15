import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DASHBOARD_WINDOW_DAYS, syncWithHistory, type SyncResult } from '../pipeline/sync';
import { unpackDataset } from '../pipeline/incremental';
import { createFixtureFetch } from '../pipeline/fixtures';
import { DEMO_CLOCK, DEMO_CYCLE_LOG, DEMO_DAYS, buildDemoPayloads } from '../pipeline/demo';
import { HISTORY_QUERIES } from '../pipeline/insights';
import { api, ApiError } from '../lib/api';
import type { DatasetResponse, HistoryInfo, SyncResponse, SyncStatus } from '../types/api';
import type { DailyRecord, StreamReport } from '../types/health';

/**
 * The one place the UI talks to the pipeline.
 *
 * Live data is synced and stored by the server: the dashboard paints whatever
 * the server has assembled, then asks for a fresh sync if that is stale and
 * follows its progress. The server's scheduler keeps it warm between visits, so
 * most opens need no sync at all. Until a first sync has completed there is no
 * dataset, and the UI shows onboarding while the window is backfilled.
 *
 * Demo mode runs the same pipeline in the browser against bundled fixtures.
 */

export type Phase = 'idle' | 'loading' | 'revalidating' | 'ready' | 'error';

/**
 * Why a sync failed, kept as a code and its detail for the app to say in the person's language
 * (app.syncFailed.reasons). A failure nobody can name keeps its own words, shown as they are.
 */
export type SyncFailure =
  // Google refused every request; the first stream's error says how.
  | { code: 'rejected'; detail: Pick<StreamReport, 'error' | 'errorCode'> }
  // Google access lapsed, so the user must sign in again.
  | { code: 'reconnect' }
  // Google refused a new access token without saying why.
  | { code: 'tokenRefresh'; status: string }
  // A request to the server failed, and it said nothing about why.
  | { code: 'request'; status: number }
  // The sync finished, yet nothing was stored.
  | { code: 'noData' }
  // Something other than an error was thrown.
  | { code: 'unknown' }
  // Anything else: the server's own message, or the browser's for a network failure.
  | { code: 'other'; detail: string };

export interface HealthState {
  phase: Phase;
  data: SyncResult | null;
  error: SyncFailure | null;
  progress: { done: number; total: number; dataType: string; label: string } | null;
  isDemo: boolean;
  /** How far back stored history reaches. */
  history: HistoryInfo | null;
  /** Demo mode's history, held in the browser: every day before the window as well as in it. */
  localHistory: DailyRecord[] | null;
}

export interface UseHealthOptions {
  /** Signed in with Google access: read and sync through the server. */
  live: boolean;
  /** Serve the bundled fixture instead of the server. */
  demo?: boolean;
  /** Called when the server says the user must sign in again. */
  onSignInRequired?: () => void;
}

/** How long stored data is shown without asking the server for a fresh sync. */
const FRESH_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

type Progress = (p: HealthState['progress']) => void;

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      // i18n-ignore: an abort, for code; an aborted sync is never shown
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** A sync that failed for a reason the app can name. An ApiError, so a lapsed Google connection asks for sign-in. */
class SyncFailed extends ApiError {
  constructor(readonly failure: SyncFailure, code = 'sync_failed') {
    super(409, code);
  }
}

/** Why the server's sync failed: a failure it named, or its error's own words. */
function serverFailure(sync: SyncStatus): SyncFailure {
  switch (sync.errorCode) {
    case 'reconnect_required':
      return { code: 'reconnect' };
    case 'google_rejected':
      return { code: 'rejected', detail: { error: sync.error ?? undefined, errorCode: sync.streamErrorCode } };
    case 'token_refresh_failed':
      return { code: 'tokenRefresh', status: sync.error ?? '' };
    default:
      return { code: 'other', detail: sync.error ?? '' };
  }
}

/** Why a sync failed, from what was thrown: a failure the app has words for, else the error's own. */
function failure(err: unknown): SyncFailure {
  if (err instanceof SyncFailed) return err.failure;
  if (err instanceof ApiError && err.detail === undefined) return { code: 'request', status: err.status };
  if (err instanceof Error) return { code: 'other', detail: err.message };
  return { code: 'unknown' };
}

/** The assembled dataset, with the insights' history queries answered from the days before it. */
function readDataset(signal: AbortSignal) {
  return api<DatasetResponse>('/api/dataset', { method: 'POST', body: { queries: HISTORY_QUERIES }, signal });
}

/** Start (or join) a server sync, follow it to completion, then read the assembled dataset. */
async function serverSync(
  signal: AbortSignal,
  onProgress: Progress,
  full: boolean,
): Promise<{ data: SyncResult; history: HistoryInfo | null }> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let { sync } = await api<SyncResponse>('/api/sync', { method: 'POST', body: { timeZone, full }, signal });
  while (sync.running) {
    onProgress(sync.progress);
    await wait(POLL_MS, signal);
    ({ sync } = await api<SyncResponse>('/api/sync', { signal }));
  }
  if (sync.error || sync.errorCode) throw new SyncFailed(serverFailure(sync), sync.errorCode ?? undefined);
  const { dataset, history } = await readDataset(signal);
  if (!dataset) throw new SyncFailed({ code: 'noData' });
  return { data: unpackDataset(dataset), history };
}

/**
 * Demo: the real pipeline against the demo person's payloads, so it exercises the same code as live
 * data. It keeps the whole demo year, for the long views.
 */
async function demoSync(signal: AbortSignal, onProgress: Progress): Promise<{ data: SyncResult; history: DailyRecord[] }> {
  return syncWithHistory({
    token: 'demo-token',
    fetchImpl: createFixtureFetch(buildDemoPayloads(), { latencyMs: 15 }),
    windowDays: DASHBOARD_WINDOW_DAYS,
    historyDays: DEMO_DAYS,
    // The demo covers a fixed year, so demo mode pins the clock and the zone (and so "today") to match it.
    now: DEMO_CLOCK.now,
    timeZone: DEMO_CLOCK.timeZone,
    includeIntraday: true,
    queries: HISTORY_QUERIES,
    signal,
    onProgress: (done, total, label, dataType) => onProgress({ done, total, dataType, label }),
  });
}

/** The demo, with its history as the Data tab and the long views read it, and the cycle log it keeps. */
async function demoResult(signal: AbortSignal, onProgress: Progress) {
  const { data, history } = await demoSync(signal, onProgress);
  data.profile = { ...data.profile, cycle: DEMO_CYCLE_LOG, cycleKept: true };
  return { data, history: { from: history[0]?.date ?? null, complete: true, backfilling: false }, localHistory: history };
}

export function useHealth({ live, demo = false, onSignInRequired }: UseHealthOptions) {
  const [state, setState] = useState<HealthState>({
    phase: 'idle',
    data: null,
    error: null,
    progress: null,
    isDemo: demo,
    history: null,
    localHistory: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const lastSyncRef = useRef(0);
  const signInRef = useRef(onSignInRequired);
  signInRef.current = onSignInRequired;

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.needsSignIn) signInRef.current?.();
    setState((s) => ({
      ...s,
      // A failed revalidation must not wipe good stored data off the screen.
      phase: s.data ? 'ready' : 'error',
      error: failure(err),
      progress: null,
    }));
  }, []);

  const run = useCallback(
    async (mode: 'cold' | 'revalidate', full = false) => {
      if (!demo && !live) return;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      setState((s) => ({ ...s, phase: mode === 'cold' ? 'loading' : 'revalidating', error: null, isDemo: demo }));

      try {
        const onProgress: Progress = (progress) => setState((s) => ({ ...s, progress }));
        const result = demo ? await demoResult(ctl.signal, onProgress) : { ...(await serverSync(ctl.signal, onProgress, full)), localHistory: null };
        if (ctl.signal.aborted) return;
        lastSyncRef.current = Date.now();
        setState((s) => ({
          ...s, phase: 'ready', data: result.data, history: result.history, localHistory: result.localHistory, progress: null, error: null,
        }));
      } catch (err) {
        if (!ctl.signal.aborted) fail(err);
      }
    },
    [live, demo, fail],
  );

  // Open: paint what the server has, then sync if it is stale. No dataset yet
  // means a first sync (or a rebuild after an upgrade): show onboarding until done.
  useEffect(() => {
    setState({ phase: 'idle', data: null, error: null, progress: null, isDemo: demo, history: null, localHistory: null });
    if (demo) {
      void run('cold');
      return () => abortRef.current?.abort();
    }
    if (!live) return;

    const ctl = new AbortController();
    abortRef.current = ctl;
    (async () => {
      try {
        const res = await readDataset(ctl.signal);
        if (ctl.signal.aborted) return;
        if (!res.dataset) {
          void run('cold');
          return;
        }
        lastSyncRef.current = Date.parse(res.syncedAt!);
        setState((s) => ({ ...s, phase: 'ready', data: unpackDataset(res.dataset!), history: res.history }));
        if (res.sync.running || Date.now() - lastSyncRef.current > FRESH_MS) void run('revalidate');
      } catch (err) {
        if (!ctl.signal.aborted) fail(err);
      }
    })();
    return () => abortRef.current?.abort();
  }, [live, demo, run, fail]);

  // Refresh on return to the tab, but only if the data has actually aged.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!lastSyncRef.current || Date.now() - lastSyncRef.current < FRESH_MS) return;
      void run('revalidate');
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run]);

  // While older history imports in the background, follow it so longer spans unlock as it lands.
  const backfilling = !demo && live && !!state.history?.backfilling;
  useEffect(() => {
    if (!backfilling) return;
    const timer = setInterval(async () => {
      try {
        const { history } = await api<SyncResponse>('/api/sync');
        if (history) setState((s) => ({ ...s, history }));
      } catch {
        /* the next tick retries */
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [backfilling]);

  const refresh = useCallback(() => run(state.data ? 'revalidate' : 'cold'), [run, state.data]);
  /** Refetch the whole window from Google, not just the unsettled tail. */
  const fullSync = useCallback(() => run(state.data ? 'revalidate' : 'cold', true), [run, state.data]);

  return useMemo(() => ({ ...state, refresh, fullSync }), [state, refresh, fullSync]);
}
