import { addDays, todayCivilIn } from '../src/lib/date';
import {
  assembleDataset,
  DASHBOARD_WINDOW_DAYS,
  FULL_RESYNC_DAYS,
  PIPELINE_VERSION,
  syncIncremental,
  type PackedDataset,
} from '../src/pipeline/incremental';
import { SCOPES, type ScopeKey } from '../src/pipeline/registry';
import { HealthTransport } from '../src/pipeline/transport';
import type { SyncStatus } from '../src/types/api';
import { isAllowed } from './access';
import { GoogleAuthError, googleClient, refreshAccessToken } from './google';
import type { Deps } from './http';
import {
  applySyncOutput,
  deleteExpiredSessions,
  deleteTokens,
  getIntradayDays,
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
 * Jobs live in memory, which assumes one app instance. That is the deployment
 * docker-compose.yml describes.
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

interface Job {
  status: SyncStatus;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();

const IDLE: SyncStatus = { running: false, progress: null, error: null, errorCode: null, finishedAt: null };

export function syncStatus(userId: string): SyncStatus {
  return jobs.get(userId)?.status ?? IDLE;
}

/** Start a sync for the user, or return the one already running. */
export function startSync(deps: Deps, userId: string, opts: { full?: boolean } = {}): Job {
  const current = jobs.get(userId);
  if (current?.status.running) return current;

  const status: SyncStatus = { ...IDLE, running: true };
  const done = syncUser(deps, userId, status, opts.full ?? false)
    .catch((err) => {
      if (!(err instanceof ReconnectRequired)) console.error(`Sync failed for user ${userId}:`, err);
      status.error = err instanceof Error ? err.message : String(err);
      status.errorCode = err instanceof ReconnectRequired ? err.code : null;
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

async function syncUser(deps: Deps, userId: string, status: SyncStatus, forceFull: boolean): Promise<void> {
  const [{ token, scopes }, user, state, streamStates] = await Promise.all([
    accessToken(deps, userId),
    getUser(deps.db, userId),
    getSyncState(deps.db, userId),
    getStreamStates(deps.db, userId),
  ]);
  if (!user) throw new Error('User no longer exists');

  const now = new Date();
  const full =
    forceFull ||
    !state ||
    state.pipelineVersion !== PIPELINE_VERSION ||
    !state.lastFullSyncAt ||
    now.getTime() - state.lastFullSyncAt.getTime() > FULL_RESYNC_DAYS * DAY_MS;

  const output = await syncIncremental({
    transport: new HealthTransport({ token }),
    today: todayCivilIn(user.timeZone, now),
    windowDays: DASHBOARD_WINDOW_DAYS,
    timeZone: user.timeZone,
    now,
    states: streamStates,
    full,
    grantedScopes: grantedScopeKeys(scopes),
    onProgress: (done, total, label) => {
      status.progress = { done, total, label };
    },
  });

  // Nothing worked — typically the Google Health API isn't enabled for the OAuth
  // project. Say so, rather than storing an empty dashboard.
  const reports = [...output.streams, ...(output.intraday ? [output.intraday] : [])]
    .map((w) => w.state.report)
    .filter((r) => r.status !== 'skipped');
  if (reports.length && reports.every((r) => r.status === 'error' || r.status === 'unauthorized')) {
    throw new Error(`Google Health rejected every request: ${reports[0].error ?? `HTTP ${reports[0].httpStatus}`}`);
  }
  await applySyncOutput(deps.db, userId, output, PIPELINE_VERSION);
}

/**
 * The dashboard's dataset: the window ending today in the user's zone, assembled
 * from stored rows. Null until a sync by the current pipeline version has
 * completed, so the browser shows onboarding (or a rebuild) instead of data
 * produced by older code.
 */
export async function loadDataset(deps: Deps, userId: string): Promise<{ dataset: PackedDataset; syncedAt: Date } | null> {
  const [state, user] = await Promise.all([getSyncState(deps.db, userId), getUser(deps.db, userId)]);
  if (!state || !user || state.pipelineVersion !== PIPELINE_VERSION) return null;

  const to = todayCivilIn(user.timeZone);
  const from = addDays(to, -(DASHBOARD_WINDOW_DAYS - 1));
  const [rows, intraday, states] = await Promise.all([
    getStreamDays(deps.db, userId, from, to),
    getIntradayDays(deps.db, userId, from, to),
    getStreamStates(deps.db, userId),
  ]);
  const dataset = assembleDataset(
    { rows, intraday, states: states.values(), profile: state.profile, run: state.run },
    from,
    to,
  );
  dataset.meta.fromCache = true;
  dataset.meta.cacheAgeMs = Date.now() - state.lastSyncAt.getTime();
  return { dataset, syncedAt: state.lastSyncAt };
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
