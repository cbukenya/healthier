import type { PackedDataset } from '../pipeline/incremental';
import type { Goals } from '../pipeline/goals';
import type { Gender } from '../pipeline/registry';
import type { DailyRecord, StreamErrorCode } from './health';

/** The JSON contract between server.ts and the browser. */

export interface ApiUser {
  id: string;
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
}

export interface MeResponse {
  user: ApiUser;
  /** Google access was revoked or expired; the user must sign in again to resume syncing. */
  needsReconnect: boolean;
}

export interface SyncStatus {
  running: boolean;
  /**
   * The stream just imported, by dataType, for the app to name. `label` is its English name, kept
   * for pages opened before dataType was sent.
   */
  progress: { done: number; total: number; dataType: string; label: string } | null;
  /**
   * Why the sync failed. With an errorCode, the detail its words need: for `google_rejected`, the
   * first stream's error as its report keeps it. Without one, the error's own message, shown as it is.
   */
  error: string | null;
  /** The failure, when the server can name it; the app says it in the person's language. */
  errorCode: SyncErrorCode | null;
  /** With `google_rejected`, when Google gave no words: the first stream's own code (see StreamReport). */
  streamErrorCode?: StreamErrorCode;
  finishedAt: string | null;
  /** Older history is being fetched in the background. */
  backfilling: boolean;
}

/**
 * Failures the server names: `reconnect_required` when the user must sign in again,
 * `google_rejected` when Google refused every request (typically: the Google Health API isn't
 * enabled for the OAuth project), `token_refresh_failed` when Google refused a new access token
 * without saying why (`error` holds its HTTP status).
 */
export type SyncErrorCode = 'reconnect_required' | 'google_rejected' | 'token_refresh_failed';

export interface HistoryInfo {
  /** Oldest day with stored data. */
  from: string | null;
  /** History reaches back as far as the server keeps it (HISTORY_DAYS). */
  complete: boolean;
  backfilling: boolean;
}

export interface HistoryResponse {
  /** Every stored day, oldest first, without per-minute sleep detail. */
  days: DailyRecord[];
}

export interface SyncResponse {
  sync: SyncStatus;
  /** Present on GET; lets the browser follow a background history import. */
  history?: HistoryInfo | null;
}

export interface DatasetResponse {
  /** Null until the first sync completes (or a pipeline upgrade has rebuilt it). */
  dataset: PackedDataset | null;
  syncedAt: string | null;
  history: HistoryInfo | null;
  sync: SyncStatus;
}

/** PUT /api/profile, both ways. */
export interface ProfileResponse {
  gender: Gender | null;
}

/** PUT /api/goals, both ways. */
export interface GoalsResponse {
  goals: Goals;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
