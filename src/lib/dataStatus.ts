import { daysBetween, type CivilDate } from './date';
import { INTRADAY_HEART_RATE, STREAMS, STREAMS_BY_TYPE } from '../pipeline/registry';
import type { SyncFailure } from '../hooks/useHealth';
import type { HistoryInfo } from '../types/api';
import type { MetricDomain, StreamReport } from '../types/health';

/**
 * Where the person's data stands, for the Data page's status card: the first thing worth saying,
 * from a sync that can't run at all down to everything being in. Words are the view's; this only
 * decides which state it is.
 */

/** A stream's state on its last fetch, as the Data streams list shows it. */
export type StreamKind = 'ok' | 'behind' | 'empty' | 'unshared' | 'failed';

/** A daily stream whose latest reading is this many days old has stopped arriving. */
export const BEHIND_AFTER = 3;

export function streamKind(r: StreamReport, today: CivilDate): StreamKind {
  if (r.status === 'skipped') return 'unshared';
  if (r.status === 'error' || r.status === 'unauthorized') return 'failed';
  if (!r.latestDate) return 'empty';
  const occasional = STREAMS_BY_TYPE.get(r.dataType)?.occasional ?? false;
  return !occasional && daysBetween(r.latestDate, today) >= BEHIND_AFTER ? 'behind' : 'ok';
}

/** The order the Data streams list groups streams in, like the app's pages. */
export const STREAM_DOMAINS: MetricDomain[] = ['movement', 'sleep', 'cardio', 'body', 'wellbeing'];

/** Registry order within a group, minute-level heart rate leading the vitals. */
export const streamOrder = (dataType: string) =>
  dataType === INTRADAY_HEART_RATE.dataType ? -1 : STREAMS.findIndex((s) => s.dataType === dataType);

/** Reports in the list's order: by group, then by registry order within it. */
const byListOrder = (a: StreamReport, b: StreamReport) =>
  STREAM_DOMAINS.indexOf(a.domain) - STREAM_DOMAINS.indexOf(b.domain) || streamOrder(a.dataType) - streamOrder(b.dataType);

export type DataStatus =
  /** Google access lapsed: nothing syncs until the person signs in again. */
  | { kind: 'expired' }
  /** The last sync failed as a whole. */
  | { kind: 'failing'; failure: SyncFailure }
  /** Older history is still being fetched in the background. */
  | { kind: 'importing' }
  /** Google answered some streams' last fetch with an error. */
  | { kind: 'failed'; streams: string[] }
  /** Some daily streams have had nothing for days while the rest arrive; `since` is true of all of them. */
  | { kind: 'behind'; streams: string[]; since: CivilDate }
  | { kind: 'current' };

export function dataStatus({ failure, history, streams, today }: {
  failure: SyncFailure | null;
  history: HistoryInfo | null;
  streams: StreamReport[];
  today: CivilDate;
}): DataStatus {
  if (failure?.code === 'reconnect') return { kind: 'expired' };
  if (failure) return { kind: 'failing', failure };
  if (history?.backfilling) return { kind: 'importing' };
  const ordered = [...streams].sort(byListOrder);
  const failed = ordered.filter((r) => streamKind(r, today) === 'failed');
  if (failed.length) return { kind: 'failed', streams: failed.map((r) => r.dataType) };
  const behind = ordered.filter((r) => streamKind(r, today) === 'behind');
  if (behind.length) {
    // The newest of their last readings: none of them has had anything since.
    const since = behind.map((r) => r.latestDate!).reduce((a, b) => (b > a ? b : a));
    return { kind: 'behind', streams: behind.map((r) => r.dataType), since };
  }
  return { kind: 'current' };
}
