import type { PackedDataset } from '../pipeline/incremental';

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
}

export interface SyncResponse {
  sync: SyncStatus;
}

export interface DatasetResponse {
  /** Null until the first sync completes (or a pipeline upgrade has rebuilt it). */
  dataset: PackedDataset | null;
  syncedAt: string | null;
  sync: SyncStatus;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
