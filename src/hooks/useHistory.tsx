import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { SyncResult } from '../pipeline/sync';
import type { HistoryInfo, HistoryResponse } from '../types/api';
import type { DailyRecord } from '../types/health';

/**
 * Long history for the 90d / 1y / All views.
 *
 * The dashboard loads with just its 62-day window. Older days are fetched from
 * the server the first time a screen asks for a longer span, and kept until the
 * data changes (a new sync, or the background history import moving on).
 */

interface HistoryContextValue {
  info: HistoryInfo | null;
  /** Every stored day, oldest first; null until requested and loaded. */
  days: DailyRecord[] | null;
  loading: boolean;
  /** Load long history if it isn't loaded for the current data. */
  request: () => void;
}

const HistoryContext = createContext<HistoryContextValue>({ info: null, days: null, loading: false, request: () => {} });

export function HistoryProvider({
  data,
  info,
  live,
  children,
}: {
  data: SyncResult | null;
  info: HistoryInfo | null;
  /** False in demo mode, where the fixture window is all there is. */
  live: boolean;
  children: React.ReactNode;
}) {
  const version = `${data?.meta.finishedAt ?? ''}|${info?.from ?? ''}|${info?.complete ?? ''}`;
  const [loaded, setLoaded] = useState<{ version: string; days: DailyRecord[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<string | null>(null);

  const request = useCallback(() => {
    if (!live || loaded?.version === version || inFlight.current === version) return;
    inFlight.current = version;
    setLoading(true);
    api<HistoryResponse>('/api/history')
      .then((res) => setLoaded({ version, days: res.days }))
      .catch((err) => console.error('Failed to load history:', err))
      .finally(() => {
        if (inFlight.current === version) inFlight.current = null;
        setLoading(false);
      });
  }, [live, loaded, version]);

  const value = useMemo<HistoryContextValue>(() => {
    if (!live) {
      const days = data?.days ?? null;
      return { info: days?.length ? { from: days[0].date, complete: true, backfilling: false } : null, days, loading: false, request: () => {} };
    }
    return { info, days: loaded?.version === version ? loaded.days : null, loading, request };
  }, [live, data, info, loaded, version, loading, request]);

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export const useHistory = () => useContext(HistoryContext);
