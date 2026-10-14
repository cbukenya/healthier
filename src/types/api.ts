import type { PackedDataset } from '../pipeline/incremental';
import type { Goals } from '../pipeline/goals';
import type { Gender } from '../pipeline/registry';
import type { DailyRecord } from './health';

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
  progress: { done: number; total: number; label: string } | null;
  error: string | null;
  /** `reconnect_required` when the failure needs the user to sign in again. */
  errorCode: string | null;
  finishedAt: string | null;
  /** Older history is being fetched in the background. */
  backfilling: boolean;
}

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
