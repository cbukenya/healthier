import React, { useEffect, useMemo, useState } from 'react';
import { daysBetween } from '../lib/date';
import { bucketFor, type Bucket } from '../pipeline/aggregate';
import type { SyncResult } from '../pipeline/sync';
import { useHistory } from '../hooks/useHistory';
import type { DailyRecord } from '../types/health';

/**
 * The span selector every "over time" section shares, and the days it selects.
 *
 * Spans up to the dashboard window read the window already loaded; longer ones
 * load stored history on first use. Only descriptive charts follow the span —
 * baselines, readiness and insights keep their own fixed recent windows.
 */

export type SpanId = '14' | '30' | '90' | '365' | 'all';

const OPTIONS: { id: SpanId; label: string; days: number }[] = [
  { id: '14', label: '14d', days: 14 },
  { id: '30', label: '30d', days: 30 },
  { id: '90', label: '90d', days: 90 },
  { id: '365', label: '1y', days: 365 },
  { id: 'all', label: 'All', days: Infinity },
];

export interface SpanState {
  span: SpanId;
  setSpan: (s: SpanId) => void;
  /** The selected days, oldest first. */
  days: DailyRecord[];
  /** How charts should group them. */
  bucket: Bucket;
  /** Days of history stored, back from the window's last day. */
  available: number;
  loading: boolean;
}

export function useSpan(data: SyncResult, initial: SpanId = '30'): SpanState {
  const history = useHistory();
  const [span, setSpan] = useState<SpanId>(initial);

  const window = data.days;
  const from = history.info?.from;
  const available = from && window.length ? Math.max(window.length, daysBetween(from, window[window.length - 1].date) + 1) : window.length;
  const wanted = span === 'all' ? available : Number(span);
  const needsHistory = wanted > window.length;

  useEffect(() => {
    if (needsHistory && !history.days && !history.loading) history.request();
  }, [needsHistory, history]);

  const source = needsHistory && history.days ? history.days : window;
  const days = useMemo(() => source.slice(-Math.min(wanted, source.length)), [source, wanted]);

  return {
    span,
    setSpan,
    days,
    bucket: bucketFor(days.length),
    available,
    loading: needsHistory && !history.days,
  };
}

/** 14d · 30d · 90d · 1y · All. Spans longer than the stored history are greyed out. */
export function SpanSelector({ state }: { state: SpanState }) {
  const history = useHistory();
  const importing = history.info && !history.info.complete;
  const note = state.loading ? 'Loading history…' : importing ? 'Importing older history…' : null;

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-[10px] text-zinc-500 animate-pulse">{note}</span>}
      <div className="inline-flex bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5" role="tablist">
        {OPTIONS.map((o, i) => {
          // Enabled once history reaches past the previous option, so it shows something new.
          const enabled = i === 0 || state.available > OPTIONS[i - 1].days;
          const active = state.span === o.id;
          return (
            <button
              key={o.id}
              role="tab"
              aria-selected={active}
              disabled={!enabled}
              title={enabled ? undefined : `Needs more than ${OPTIONS[i - 1].label} of history`}
              onClick={() => state.setSpan(o.id)}
              className={`px-2 py-[3px] text-[10px] rounded-[6px] font-medium transition-colors ${
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : enabled
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-700 cursor-not-allowed'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
