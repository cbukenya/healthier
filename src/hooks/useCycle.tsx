import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CivilDate } from '../lib/date';
import { api } from '../lib/api';
import {
  EMPTY_CYCLE_LOG, nightsFrom, readCycleLog, summarizeCycles, withDay, withRejected,
  type CycleDay, type CycleLog, type CycleSettings, type CycleSummary, type Night,
} from '../pipeline/cycle';
import type { SyncResult } from '../pipeline/sync';
import type { CycleDayResponse, CycleLogResponse, CycleRejectedResponse, CycleSettingsResponse } from '../types/api';

/**
 * Cycle tracking for every screen: the person's log, and the cycles found in their nights.
 *
 * A change shows at once and is saved straight away, one request a change. If a save fails, the
 * log goes back to how it was before that change and the screens say so. With tracking off there
 * is no summary, so nothing cycle-aware runs anywhere.
 */

interface CycleContextValue {
  log: CycleLog;
  /** Null with tracking off. */
  summary: CycleSummary | null;
  nights: Night[];
  today: CivilDate | null;
  setSettings: (settings: CycleSettings) => void;
  setDay: (day: CycleDay) => void;
  setRejected: (date: CivilDate, rejected: boolean) => void;
  /** Forget the settings and every logged day. */
  forget: () => Promise<void>;
  /** The last change couldn't be saved, so it was undone. */
  failed: boolean;
}

const CycleContext = createContext<CycleContextValue>({
  log: EMPTY_CYCLE_LOG,
  summary: null,
  nights: [],
  today: null,
  setSettings: () => {},
  setDay: () => {},
  setRejected: () => {},
  forget: async () => {},
  failed: false,
});

export function CycleProvider({
  data,
  live,
  children,
}: {
  data: SyncResult;
  /** False in demo mode, where changes last as long as the page. */
  live: boolean;
  children: React.ReactNode;
}) {
  const saved = useMemo(() => readCycleLog(data.profile?.cycle ?? EMPTY_CYCLE_LOG), [data]);
  // The log as changed since the dataset arrived; until then, what the dataset carried.
  const [changed, setChanged] = useState<CycleLog | null>(null);
  const [failed, setFailed] = useState(false);
  const log = changed ?? saved;
  const current = useRef(log);
  current.current = log;

  // A new dataset brings the log as the server holds it, every saved change included.
  useEffect(() => setChanged(null), [saved]);

  /** Apply a change now, save it, and undo it if the save fails. */
  const change = useCallback(
    (next: (log: CycleLog) => CycleLog, save: () => Promise<unknown>) => {
      const before = current.current;
      setChanged(next(before));
      setFailed(false);
      if (!live) return;
      save().catch((err) => {
        console.error('Failed to save cycle log:', err);
        setChanged(before);
        setFailed(true);
      });
    },
    [live],
  );

  const setSettings = useCallback(
    (settings: CycleSettings) => {
      const turningOn = settings.tracking && !current.current.settings.tracking;
      change(
        (l) => ({ ...l, settings }),
        async () => {
          await api<CycleSettingsResponse>('/api/cycle/settings', { method: 'PUT', body: { settings } });
          // With tracking off the dataset carried no log: fetch what's kept, now it's on.
          if (turningOn) {
            const { cycle } = await api<CycleLogResponse>('/api/cycle');
            setChanged((l) => ({ ...readCycleLog(cycle), settings: l?.settings ?? settings }));
          }
        },
      );
    },
    [change],
  );

  const setDay = useCallback(
    (day: CycleDay) =>
      change(
        (l) => withDay(l, day),
        () => api<CycleDayResponse>(`/api/cycle/days/${day.date}`, { method: 'PUT', body: { day } }),
      ),
    [change],
  );

  const setRejected = useCallback(
    (date: CivilDate, rejected: boolean) =>
      change(
        (l) => withRejected(l, date, rejected),
        () => api<CycleRejectedResponse>(`/api/cycle/rejected/${date}`, { method: 'PUT', body: { rejected } }),
      ),
    [change],
  );

  const forget = useCallback(async () => {
    if (live) await api('/api/cycle', { method: 'DELETE' });
    setChanged(EMPTY_CYCLE_LOG);
    setFailed(false);
  }, [live]);

  const today = data.days.at(-1)?.date ?? null;
  const nights = useMemo(() => nightsFrom(data.days, data.answers), [data]);
  const summary = useMemo(
    () => (log.settings.tracking && today ? summarizeCycles(nights, log, today) : null),
    [log, nights, today],
  );

  const value = useMemo(
    () => ({ log, summary, nights, today, setSettings, setDay, setRejected, forget, failed }),
    [log, summary, nights, today, setSettings, setDay, setRejected, forget, failed],
  );
  return <CycleContext.Provider value={value}>{children}</CycleContext.Provider>;
}

/** Cycle tracking, its log and what was found. */
export const useCycle = () => useContext(CycleContext);

/** Whether cycle tracking is on: the Cycle page and everything cycle-aware depend on it. */
export const useCycleTracking = () => useContext(CycleContext).log.settings.tracking;
