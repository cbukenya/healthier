import React, { useEffect, useMemo, useState } from 'react';
import { daysBetween } from '../lib/date';
import { t, type MessageKey } from '../i18n';
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

export const SPANS: { id: SpanId; days: number }[] = [
  { id: '14', days: 14 },
  { id: '30', days: 30 },
  { id: '90', days: 90 },
  { id: '365', days: 365 },
  { id: 'all', days: Infinity },
];

const SPAN_LABELS = {
  '14': 'ui.span.chips.twoWeeks',
  '30': 'ui.span.chips.month',
  '90': 'ui.span.chips.quarter',
  '365': 'ui.span.chips.year',
  all: 'ui.span.chips.all',
} as const satisfies Record<SpanId, MessageKey>;

/** A span's button: "14d", "1y", "All". */
export const spanLabel = (id: SpanId) => t(SPAN_LABELS[id]);

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

/**
 * The summary card's title for the selected span: "30-day summary", "1-year summary" or "All-time
 * summary". While stored history is shorter than the span, it names the days actually shown.
 */
export function spanSummaryTitle({ span, days }: SpanState): string {
  if (span === 'all') return t('ui.span.summary', { span: 'all' });
  if (days.length < Number(span)) return t('ui.span.summary', { span: 'days', days: days.length });
  return t('ui.span.summary', span === '365' ? { span: 'year' } : { span: 'days', days: Number(span) });
}

/** 14d · 30d · 90d · 1y · All. Spans longer than the stored history are greyed out. */
export function SpanSelector({ state }: { state: SpanState }) {
  const history = useHistory();
  const importing = history.info && !history.info.complete;
  const note = state.loading ? t('ui.span.loading') : importing ? t('ui.span.importing') : null;

  return (
    <div className="flex items-center gap-2">
      {note && <span className="text-note text-zinc-500 animate-pulse">{note}</span>}
      <div className="inline-flex bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5" role="tablist">
        {SPANS.map((o, i) => {
          // Enabled once history reaches past the previous option, so it shows something new.
          const enabled = i === 0 || state.available > SPANS[i - 1].days;
          const active = state.span === o.id;
          return (
            <button
              key={o.id}
              role="tab"
              aria-selected={active}
              disabled={!enabled}
              title={enabled ? undefined : t('ui.span.needsMore', { span: spanLabel(SPANS[i - 1].id) })}
              onClick={() => state.setSpan(o.id)}
              className={`px-2 py-[3px] text-note rounded-[6px] font-medium transition-colors ${
                active
                  ? 'bg-zinc-800 text-zinc-100'
                  : enabled
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-700 cursor-not-allowed'
              }`}
            >
              {spanLabel(o.id)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
