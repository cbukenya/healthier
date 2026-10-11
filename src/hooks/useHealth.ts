import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DASHBOARD_WINDOW_DAYS, syncHealthData, type SyncResult } from '../pipeline/sync';
import { unpackDataset } from '../pipeline/incremental';
import { buildFixturePayloads, createFixtureFetch } from '../pipeline/fixtures';
import { api, ApiError } from '../lib/api';
import type { DatasetResponse, SyncResponse } from '../types/api';

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

export interface HealthState {
  phase: Phase;
  data: SyncResult | null;
  error: string | null;
  progress: { done: number; total: number; label: string } | null;
  isDemo: boolean;
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
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/** Start (or join) a server sync, follow it to completion, then read the assembled dataset. */
async function serverSync(signal: AbortSignal, onProgress: Progress, full: boolean): Promise<SyncResult> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let { sync } = await api<SyncResponse>('/api/sync', { method: 'POST', body: { timeZone, full }, signal });
  while (sync.running) {
    onProgress(sync.progress);
    await wait(POLL_MS, signal);
    ({ sync } = await api<SyncResponse>('/api/sync', { signal }));
  }
  if (sync.error) throw new ApiError(409, sync.errorCode ?? 'sync_failed', sync.error);
  const { dataset } = await api<DatasetResponse>('/api/dataset', { signal });
  if (!dataset) throw new Error('Sync finished but stored no data');
  return unpackDataset(dataset);
}

/** Demo: the real pipeline against fixture payloads, so it exercises the same code as live data. */
function demoSync(signal: AbortSignal, onProgress: Progress): Promise<SyncResult> {
  return syncHealthData({
    token: 'demo-token',
    fetchImpl: createFixtureFetch(buildFixturePayloads(), { latencyMs: 60 }),
    windowDays: DASHBOARD_WINDOW_DAYS,
    // The fixture covers a fixed window, so demo mode pins "today" and the zone to match it.
    now: new Date('2026-08-19T01:39:00+02:00'),
    timeZone: 'Europe/Stockholm',
    includeIntraday: true,
    signal,
    onProgress: (done, total, label) => onProgress({ done, total, label }),
  });
}

export function useHealth({ live, demo = false, onSignInRequired }: UseHealthOptions) {
  const [state, setState] = useState<HealthState>({
    phase: 'idle',
    data: null,
    error: null,
    progress: null,
    isDemo: demo,
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
      error: err instanceof Error ? err.message : 'Sync failed',
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
        const data = demo ? await demoSync(ctl.signal, onProgress) : await serverSync(ctl.signal, onProgress, full);
        if (ctl.signal.aborted) return;
        lastSyncRef.current = Date.now();
        setState((s) => ({ ...s, phase: 'ready', data, progress: null, error: null }));
      } catch (err) {
        if (!ctl.signal.aborted) fail(err);
      }
    },
    [live, demo, fail],
  );

  // Open: paint what the server has, then sync if it is stale. No dataset yet
  // means a first sync (or a rebuild after an upgrade): show onboarding until done.
  useEffect(() => {
    setState({ phase: 'idle', data: null, error: null, progress: null, isDemo: demo });
    if (demo) {
      void run('cold');
      return () => abortRef.current?.abort();
    }
    if (!live) return;

    const ctl = new AbortController();
    abortRef.current = ctl;
    (async () => {
      try {
        const res = await api<DatasetResponse>('/api/dataset', { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        if (!res.dataset) {
          void run('cold');
          return;
        }
        lastSyncRef.current = Date.parse(res.syncedAt!);
        setState((s) => ({ ...s, phase: 'ready', data: unpackDataset(res.dataset!) }));
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

  const refresh = useCallback(() => run(state.data ? 'revalidate' : 'cold'), [run, state.data]);
  /** Refetch the whole window from Google, not just the unsettled tail. */
  const fullSync = useCallback(() => run(state.data ? 'revalidate' : 'cold', true), [run, state.data]);

  return useMemo(() => ({ ...state, refresh, fullSync }), [state, refresh, fullSync]);
}
