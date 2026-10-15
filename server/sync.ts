import { addDays, todayCivilIn } from '../src/lib/date';
import {
  assembleDataset,
  assembleHistory,
  backfillStream,
  DASHBOARD_WINDOW_DAYS,
  FULL_RESYNC_DAYS,
  historyDue,
  historyStart,
  PIPELINE_VERSION,
  syncIncremental,
  type PackedDataset,
  type StreamState,
} from '../src/pipeline/incremental';
import type { DailyRecord, StreamReport } from '../src/types/health';
import { readGoals } from '../src/pipeline/goals';
import { EMPTY_CYCLE_LOG } from '../src/pipeline/cycle';
import { answerQueries, queriesSpan, type HistoryAnswers, type HistoryQueries } from '../src/pipeline/history';
import { SCOPES, type ScopeKey } from '../src/pipeline/registry';
import { HealthTransport } from '../src/pipeline/transport';
import type { HistoryInfo, SyncStatus } from '../src/types/api';
import { isAllowed } from './access';
import { GoogleAuthError, googleClient, refreshAccessToken } from './google';
import type { Deps } from './http';
import {
  applyStreamWrites,
  applySyncOutput,
  deleteExpiredSessions,
  deleteTokens,
  getCycleLog,
  getIntradayDays,
  getOldestStreamDay,
  getStreamDays,
  getStreamStates,
  getSyncState,
  getTokens,
  getUser,
  saveTokens,
  usersDueForSync,
} from './repo';

/**
 * Server-side sync.
 *
 * Runs the incremental engine (src/pipeline/incremental.ts) with tokens only the
 * server holds and stores the result per stream per day. A sync is a background
 * job per user: the browser starts one, polls its progress, then reads the
 * assembled dataset. The scheduler starts them too, so the dashboard opens on
 * recent data.
 *
 * After a sync, older history backfills in the background (up to HISTORY_DAYS),
 * one stream per step. Every write for a user happens under that user's lock,
 * so a sync and a backfill step never interleave and the dashboard's own sync
 * waits behind at most one step.
 *
 * Jobs and locks live in memory, which assumes one app instance. That is the
 * deployment docker-compose.yml describes.
 */

/** Refresh access tokens this long before Google expires them. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const SCHEDULER_TICK_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ReconnectRequired extends Error {
  readonly code = 'reconnect_required';
  constructor() {
    super('Google access has expired or was revoked. Sign in again to reconnect.');
    this.name = 'ReconnectRequired';
  }
}

/**
 * Google refused every request, typically because the Google Health API isn't enabled for the
 * OAuth project. Carries the first stream's report, whose error the browser shows as the detail.
 */
export class GoogleRejected extends Error {
  readonly code = 'google_rejected';
  constructor(readonly report: StreamReport) {
    super(`Google Health rejected every request: ${[report.errorCode, report.error].filter(Boolean).join(' ')}`);
    this.name = 'GoogleRejected';
  }
}

interface Job {
  status: SyncStatus;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();
const backfills = new Map<string, Promise<void>>();
/** Backfills run one user at a time across the server: they're background work, and Google rate-limits per project. */
let backfillQueue: Promise<void> = Promise.resolve();
const locks = new Map<string, Promise<unknown>>();

const IDLE: SyncStatus = { running: false, progress: null, error: null, errorCode: null, finishedAt: null, backfilling: false };

export function syncStatus(userId: string): SyncStatus {
  return { ...(jobs.get(userId)?.status ?? IDLE), backfilling: backfills.has(userId) };
}

/**
 * A failed sync, as its status reports it. The server names what it can with a code and sends
 * the detail the browser's words need: for a rejection, Google's own (or the first stream's code
 * and what it needs); for a token refresh Google gave no reason for, its status. Anything else
 * goes as its own message.
 *
 * `error` is never null on a failure: pages opened before errorCode existed look for it.
 */
export function failedStatus(err: unknown): Pick<SyncStatus, 'error' | 'errorCode' | 'streamErrorCode'> {
  if (err instanceof GoogleRejected) {
    const r = err.report;
    // Google's words when it sent some; else the stream's own code, or the HTTP status it answered with.
    if (r.errorCode) return { error: r.error ?? r.errorCode, errorCode: err.code, streamErrorCode: r.errorCode };
    if (r.error) return { error: r.error, errorCode: err.code };
    return { error: String(r.httpStatus), errorCode: err.code, streamErrorCode: 'http' };
  }
  if (err instanceof ReconnectRequired) return { error: err.code, errorCode: err.code };
  if (err instanceof GoogleAuthError && !err.description) return { error: String(err.status), errorCode: 'token_refresh_failed' };
  return { error: err instanceof Error ? err.message : String(err), errorCode: null };
}

/** Run `fn` once every earlier task for this user has finished. */
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(userId, next);
  void next.catch(() => undefined).finally(() => {
    if (locks.get(userId) === next) locks.delete(userId);
  });
  return next;
}

/** Start a sync for the user, or return the one already running. */
export function startSync(deps: Deps, userId: string, opts: { full?: boolean } = {}): Job {
  const current = jobs.get(userId);
  if (current?.status.running) return current;

  const status: SyncStatus = { ...IDLE, running: true };
  const done = syncUser(deps, userId, status, opts.full ?? false)
    .then(() => {
      // Not awaited: the sync is done once the window is stored; history follows.
      void startBackfill(deps, userId);
    })
    .catch((err) => {
      if (!(err instanceof ReconnectRequired)) console.error(`Sync failed for user ${userId}:`, err);
      Object.assign(status, failedStatus(err));
    })
    .finally(() => {
      status.running = false;
      status.progress = null;
      status.finishedAt = new Date().toISOString();
    });
  const job = { status, done };
  jobs.set(userId, job);
  return job;
}

function syncUser(deps: Deps, userId: string, status: SyncStatus, forceFull: boolean): Promise<void> {
  return withUserLock(userId, () => syncUserLocked(deps, userId, status, forceFull));
}

async function syncUserLocked(deps: Deps, userId: string, status: SyncStatus, forceFull: boolean): Promise<void> {
  const [{ token, scopes }, user, state, streamStates] = await Promise.all([
    accessToken(deps, userId),
    getUser(deps.db, userId),
    getSyncState(deps.db, userId),
    getStreamStates(deps.db, userId),
  ]);
  if (!user) throw new Error('User no longer exists');

  const now = new Date();
  // Stored days were produced by older code: start over, history included (backfill refills it).
  const rebuild = !!state && state.pipelineVersion !== PIPELINE_VERSION;
  const full =
    forceFull ||
    !state ||
    rebuild ||
    !state.lastFullSyncAt ||
    now.getTime() - state.lastFullSyncAt.getTime() > FULL_RESYNC_DAYS * DAY_MS;

  const output = await syncIncremental({
    transport: new HealthTransport({ token }),
    today: todayCivilIn(user.timeZone, now),
    windowDays: DASHBOARD_WINDOW_DAYS,
    historyDays: rebuild ? DASHBOARD_WINDOW_DAYS : deps.config.historyDays,
    timeZone: user.timeZone,
    now,
    states: rebuild ? new Map() : streamStates,
    full,
    grantedScopes: grantedScopeKeys(scopes),
    onProgress: (done, total, label, dataType) => {
      status.progress = { done, total, dataType, label };
    },
  });

  // Nothing worked — typically the Google Health API isn't enabled for the OAuth
  // project. Say so, rather than storing an empty dashboard.
  const reports = [...output.streams, ...(output.intraday ? [output.intraday] : [])]
    .map((w) => w.state.report)
    .filter((r) => r.status !== 'skipped');
  if (reports.length && reports.every((r) => r.status === 'error' || r.status === 'unauthorized')) {
    throw new GoogleRejected(reports[0]);
  }
  await applySyncOutput(deps.db, userId, output, PIPELINE_VERSION);
}

/** Backfill the user's history in the background, or join the backfill already running. */
export function startBackfill(deps: Deps, userId: string): Promise<void> {
  const running = backfills.get(userId);
  if (running) return running;
  const done = backfillQueue
    .then(() => backfillUser(deps, userId))
    .catch((err) => {
      if (!(err instanceof ReconnectRequired)) console.error(`History backfill failed for user ${userId}:`, err);
    })
    .finally(() => backfills.delete(userId));
  backfills.set(userId, done);
  backfillQueue = done;
  return done;
}

/**
 * One stream per step, each under the user's lock. A stream that fails is tried
 * once per run; the next sync starts another run, so failures retry hourly
 * rather than in a tight loop.
 */
async function backfillUser(deps: Deps, userId: string): Promise<void> {
  const attempted = new Set<string>();
  for (;;) {
    const progressed = await withUserLock(userId, async () => {
      const [user, state, states] = await Promise.all([
        getUser(deps.db, userId),
        getSyncState(deps.db, userId),
        getStreamStates(deps.db, userId),
      ]);
      if (!user || !state || state.pipelineVersion !== PIPELINE_VERSION) return false;
      const start = historyStart(todayCivilIn(user.timeZone), deps.config.historyDays, DASHBOARD_WINDOW_DAYS);
      const stream = historyDue(states, start).find((s) => !attempted.has(s.dataType));
      if (!stream) return false;
      attempted.add(stream.dataType);

      const { token } = await accessToken(deps, userId);
      const write = await backfillStream(new HealthTransport({ token }), stream, states.get(stream.dataType)!, start);
      if (write) await applyStreamWrites(deps.db, userId, [write]);
      const failure = write && backfillFailure(write.state);
      if (failure) {
        console.warn(`History backfill of ${stream.dataType} for user ${userId} failed, retrying after the next sync: ${failure}`);
      }
      return true;
    });
    if (!progressed) return;
  }
}

/** Why a backfill step failed, for the log: the date chunks that failed, then Google's words or the error's code. */
function backfillFailure(state: StreamState): string | null {
  const why = [state.backfillErrorCode, state.backfillError].filter(Boolean).join(' ');
  if (!why) return null;
  const chunks = state.backfillChunks;
  return chunks ? `${chunks.failed} of ${chunks.total} date chunks failed: ${why}` : why;
}

/**
 * The dashboard's dataset: the window ending today in the user's zone, assembled
 * from stored rows. Null until a sync by the current pipeline version has
 * completed, so the browser shows onboarding (or a rebuild) instead of data
 * produced by older code.
 */
export async function loadDataset(
  deps: Deps,
  userId: string,
  queries: HistoryQueries = {},
): Promise<{ dataset: PackedDataset; syncedAt: Date; history: HistoryInfo } | null> {
  const [state, user] = await Promise.all([getSyncState(deps.db, userId), getUser(deps.db, userId)]);
  if (!state || !user || state.pipelineVersion !== PIPELINE_VERSION) return null;

  const to = todayCivilIn(user.timeZone);
  const from = addDays(to, -(DASHBOARD_WINDOW_DAYS - 1));
  const [rows, intraday, states, cycleLog] = await Promise.all([
    getStreamDays(deps.db, userId, from, to),
    getIntradayDays(deps.db, userId, from, to),
    getStreamStates(deps.db, userId),
    getCycleLog(deps.db, deps.config.encryptionKey, userId),
  ]);
  // With tracking off, the log stays on the server: only the setting goes out.
  const cycle = cycleLog.settings.tracking ? cycleLog : { ...EMPTY_CYCLE_LOG, settings: cycleLog.settings };
  const dataset = assembleDataset(
    // Gender, goals and the cycle log are the person's own, kept on their account rather than read from Google.
    {
      rows, intraday, states: states.values(),
      profile: {
        ...state.profile, gender: user.gender, goals: readGoals(user.goals), cycle,
        cycleKept: cycleLog.days.length > 0 || cycleLog.rejected.length > 0,
      },
      run: state.run,
    },
    from,
    to,
  );
  dataset.meta.fromCache = true;
  dataset.meta.cacheAgeMs = Date.now() - state.lastSyncAt.getTime();
  if (Object.keys(queries).length) dataset.answers = await answerHistory(deps, userId, queries, from, to);
  return { dataset, syncedAt: state.lastSyncAt, history: await describeHistory(deps, userId, to, states) };
}

/**
 * The app's history queries, answered from the stored days before the window:
 * one read for the span they need together, then each over its own range.
 * Worked out on every read and never stored.
 */
async function answerHistory(deps: Deps, userId: string, queries: HistoryQueries, from: string, to: string): Promise<HistoryAnswers> {
  const limit = historyStart(to, deps.config.historyDays, DASHBOARD_WINDOW_DAYS);
  const stored = await getOldestStreamDay(deps.db, userId);
  const oldest = stored && stored > limit ? stored : limit;
  const span = queriesSpan(queries, to, from, oldest);
  const days = span ? assembleHistory(await getStreamDays(deps.db, userId, span.from, span.to), span.from, span.to) : [];
  return answerQueries(queries, days, to, from, oldest);
}

/** How far back stored history reaches, and whether the backfill is done. */
export async function historyInfo(deps: Deps, userId: string): Promise<HistoryInfo | null> {
  const user = await getUser(deps.db, userId);
  if (!user) return null;
  return describeHistory(deps, userId, todayCivilIn(user.timeZone), await getStreamStates(deps.db, userId));
}

async function describeHistory(
  deps: Deps,
  userId: string,
  today: string,
  states: Awaited<ReturnType<typeof getStreamStates>>,
): Promise<HistoryInfo> {
  const start = historyStart(today, deps.config.historyDays, DASHBOARD_WINDOW_DAYS);
  return {
    from: await getOldestStreamDay(deps.db, userId),
    complete: historyDue(states, start).length === 0,
    backfilling: backfills.has(userId),
  };
}

/** Every stored day, oldest first, trimmed for long-span charts. Null before a first sync. */
export async function loadHistory(deps: Deps, userId: string): Promise<DailyRecord[] | null> {
  const [state, user] = await Promise.all([getSyncState(deps.db, userId), getUser(deps.db, userId)]);
  if (!state || !user || state.pipelineVersion !== PIPELINE_VERSION) return null;
  const to = todayCivilIn(user.timeZone);
  const limit = historyStart(to, deps.config.historyDays, DASHBOARD_WINDOW_DAYS);
  const oldest = await getOldestStreamDay(deps.db, userId);
  const from = oldest && oldest > limit ? oldest : limit;
  return assembleHistory(await getStreamDays(deps.db, userId, from, to), from, to);
}

/** A usable access token, refreshed and persisted when the cached one is near expiry. */
async function accessToken(deps: Deps, userId: string): Promise<{ token: string; scopes: string[] }> {
  const key = deps.config.encryptionKey;
  const stored = await getTokens(deps.db, key, userId);
  if (!stored) throw new ReconnectRequired();
  if (stored.accessToken && stored.accessTokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
    return { token: stored.accessToken, scopes: stored.scopes };
  }

  try {
    const fresh = await refreshAccessToken(googleClient(deps.config), stored.refreshToken);
    const scopes = fresh.scope?.split(' ') ?? stored.scopes;
    await saveTokens(deps.db, key, userId, {
      accessToken: fresh.access_token,
      expiresAt: new Date(Date.now() + fresh.expires_in * 1000),
      scopes,
    });
    return { token: fresh.access_token, scopes };
  } catch (err) {
    // Revoked, or expired: an OAuth app in "Testing" status gets 7-day refresh tokens.
    if (err instanceof GoogleAuthError && err.code === 'invalid_grant') {
      await deleteTokens(deps.db, userId);
      throw new ReconnectRequired();
    }
    throw err;
  }
}

/** Map granted scope URLs back to the registry's keys, so ungranted streams are skipped, not failed. */
function grantedScopeKeys(scopes: string[]): ScopeKey[] | undefined {
  if (!scopes.length) return undefined;
  return (Object.entries(SCOPES) as [ScopeKey, string][])
    .filter(([, url]) => scopes.includes(url))
    .map(([key]) => key);
}

/**
 * Background sync: every few minutes, sync each connected user who is due (see
 * usersDueForSync), one at a time to stay clear of rate limits.
 */
export function startScheduler(deps: Deps): () => void {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await deleteExpiredSessions(deps.db);
      // With background sync off, a visit still syncs (and rebuilds after an upgrade).
      if (!deps.config.syncIntervalMinutes) return;
      for (const due of await usersDueForSync(deps.db, deps.config.syncIntervalMinutes, PIPELINE_VERSION)) {
        if (!isAllowed(deps.config.allowedEmails, due.email)) continue;
        await startSync(deps, due.userId).done;
      }
    } catch (err) {
      console.error('Scheduled sync failed:', err);
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
  void tick();
  return () => clearInterval(timer);
}
