import type { PackedDataset } from '../pipeline/incremental';
import type { Goals } from '../pipeline/goals';
import type { CycleDay, CycleLog, CycleSettings } from '../pipeline/cycle';
import type { Gender } from '../pipeline/registry';
import type { SourcePrefs } from '../pipeline/sources';
import type { CivilDate } from '../lib/date';
import type { DailyRecord, Platform, RecordingMethod, StreamErrorCode } from './health';

/** The JSON contract between server.ts and the browser. */

export interface ApiUser {
  id: string;
  name: string | null;
  email: string | null;
  pictureUrl: string | null;
}

/** What this install offers, before anyone signs in. */
export interface InstanceResponse {
  /** Whether the sign-in screen offers demo mode (DEMO_MODE). */
  demo: boolean;
  /** The install's own note under the sign-in buttons (SIGN_IN_NOTE), in its own words; null for none. */
  note: string | null;
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

/** One device or app the person's readings came from, as the Devices and sources card shows it. */
export interface SourceSummary {
  id: string;
  label: string;
  platform: Platform;
  method: RecordingMethod;
  formFactor?: string;
  app?: string;
  /** The last day anything stored came from it. */
  lastSeen: CivilDate | null;
  /** Each stream it reports: on how many days of the window, and on how many its reading is the one used. */
  readings: { dataType: string; offered: number; used: number }[];
}

/** GET and PUT /api/sources: the person's choices and their sources (pipeline/sources.ts). */
export interface SourcesResponse {
  prefs: SourcePrefs;
  /** Every source's id in the order tried, switched-off ones in their place (sourceRanking). */
  order: string[];
  sources: SourceSummary[];
  /** The days the counts cover, back from today. */
  windowDays: number;
  /** A new choice of what counts in daily totals is being fetched from Google again. */
  refetching: boolean;
}

/** PUT /api/goals, both ways. */
export interface GoalsResponse {
  goals: Goals;
}

/** GET /api/cycle: the whole log, read when tracking is turned back on. */
export interface CycleLogResponse {
  cycle: CycleLog;
}

/** PUT /api/cycle/settings, both ways. */
export interface CycleSettingsResponse {
  settings: CycleSettings;
}

/** PUT /api/cycle/days/:date: the day as kept, or null when nothing is left on it. */
export interface CycleDayResponse {
  day: CycleDay | null;
}

/** PUT /api/cycle/rejected/:date, both ways: whether a found start was not a period. */
export interface CycleRejectedResponse {
  rejected: boolean;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
