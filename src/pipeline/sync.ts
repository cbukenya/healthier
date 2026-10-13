import { addDays, todayCivil, todayCivilIn, type CivilDate } from '../lib/date';
import type { HistoryQueries } from './history';
import { MemoryStore, syncIncremental, unpackDataset, type SyncResult } from './incremental';
import type { ScopeKey } from './registry';
import { HealthTransport, type FetchLike } from './transport';

/**
 * One complete sync, start to finish, held in memory.
 *
 * This is the incremental engine run once with nothing stored — the same code
 * the server runs, so demo mode and the tests exercise exactly what users get.
 *
 * Design choices worth stating:
 *
 *   - **One window for everything.** The old build asked rollups for 28 days and
 *     list endpoints for "whatever 1,000 rows happen to be", so the steps chart
 *     and the HRV chart silently covered different spans and couldn't be compared.
 *   - **Failure is per-stream.** A 400 on a stream must not blank the
 *     dashboard. Each stream returns a status and the rest carry on.
 *   - **Everything is measured.** Requests, pages, milliseconds and truncation are
 *     recorded per stream, which is what the Data tab renders. If a number on the
 *     dashboard looks wrong, the report says how it was obtained.
 */

export { DASHBOARD_WINDOW_DAYS, type SyncResult } from './incremental';

export interface SyncOptions {
  token: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** Days of history to request. Rollups chunk automatically. */
  windowDays?: number;
  /** Override "now" — used by tests and by the fixture-backed demo. */
  now?: Date;
  /** "Today" as a civil date. Wins over `now` and `timeZone`. */
  today?: CivilDate;
  /** The user's IANA zone: intraday minutes, and "today" when it isn't given. Defaults to this runtime's zone. */
  timeZone?: string;
  /** Skip streams whose scope wasn't granted. */
  grantedScopes?: ScopeKey[];
  /** Fetch minute-level heart rate for the window. */
  includeIntraday?: boolean;
  /** History queries to answer from the stored days before the window. */
  queries?: HistoryQueries;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function syncHealthData(opts: SyncOptions): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const today = opts.today ?? (opts.timeZone ? todayCivilIn(opts.timeZone, now) : todayCivil(now));
  const windowDays = opts.windowDays ?? 90;

  const store = new MemoryStore();
  store.apply(
    await syncIncremental({
      transport: new HealthTransport({
        token: opts.token,
        fetchImpl: opts.fetchImpl,
        baseUrl: opts.baseUrl,
        concurrency: opts.concurrency ?? 4,
        signal: opts.signal,
      }),
      today,
      windowDays,
      timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      now,
      states: new Map(),
      full: true,
      grantedScopes: opts.grantedScopes,
      includeIntraday: opts.includeIntraday ?? false,
      onProgress: opts.onProgress,
    }),
  );
  return unpackDataset(store.assemble(addDays(today, -(windowDays - 1)), today, opts.queries));
}
