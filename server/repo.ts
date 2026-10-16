import type pg from 'pg';
import type { CivilDate } from '../src/lib/date';
import type { StreamDay, StreamState, StreamWrite, SyncOutput, SyncRun } from '../src/pipeline/incremental';
import type { IntradayDay } from '../src/pipeline/intraday';
import type { Goals } from '../src/pipeline/goals';
import type { SourcePrefs, SourceSeen } from '../src/pipeline/sources';
import { EMPTY_CYCLE_LOG, readCycleLog, type CycleLog } from '../src/pipeline/cycle';
import type { Gender, ProfileFacts } from '../src/pipeline/registry';
import type { ApiUser } from '../src/types/api';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';
import { withTransaction, type Db } from './db';
import type { GoogleIdentity } from './google';

/** Every SQL statement the app runs, so the schema's contract is readable in one place. */

// ───────────────────────────────────────────────────────────────── users

export interface UserRow extends ApiUser {
  timeZone: string;
  gender: Gender | null;
  /** As stored: read it through readGoals, which fills in and bounds what's there. */
  goals: unknown;
  /** As stored: read it through readSourcePrefs. */
  sources: unknown;
}

export async function upsertUser(db: Db, identity: GoogleIdentity): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, picture_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name, picture_url = EXCLUDED.picture_url, updated_at = now()
     RETURNING id`,
    [identity.sub, identity.email ?? null, identity.name ?? null, identity.picture ?? null],
  );
  return rows[0].id;
}

export async function getUser(db: Db, userId: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(
    `SELECT id, email, name, picture_url AS "pictureUrl", time_zone AS "timeZone", gender, goals, sources
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function setTimeZone(db: Db, userId: string, timeZone: string): Promise<void> {
  await db.query('UPDATE users SET time_zone = $2, updated_at = now() WHERE id = $1 AND time_zone <> $2', [userId, timeZone]);
}

export async function setGender(db: Db, userId: string, gender: Gender | null): Promise<void> {
  await db.query('UPDATE users SET gender = $2, updated_at = now() WHERE id = $1', [userId, gender]);
}

export async function setSourcePrefs(db: Db, userId: string, prefs: SourcePrefs): Promise<void> {
  await db.query('UPDATE users SET sources = $2::jsonb, updated_at = now() WHERE id = $1', [userId, JSON.stringify(prefs)]);
}

export async function setGoals(db: Db, userId: string, goals: Goals): Promise<void> {
  await db.query('UPDATE users SET goals = $2::jsonb, updated_at = now() WHERE id = $1', [userId, JSON.stringify(goals)]);
}

/** Cascades to tokens, sessions and data. */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
}

// ──────────────────────────────────────────────────────────── cycle logs

const openCycleLog = (key: Buffer, data: Buffer): CycleLog => readCycleLog(JSON.parse(decrypt(key, data)));

/** The person's cycle settings and log; tracking off and nothing logged until they've set any. */
export async function getCycleLog(db: Db, key: Buffer, userId: string): Promise<CycleLog> {
  const { rows } = await db.query<{ data: Buffer }>('SELECT data FROM cycle_logs WHERE user_id = $1', [userId]);
  return rows[0] ? openCycleLog(key, rows[0].data) : EMPTY_CYCLE_LOG;
}

/**
 * Change the log in one transaction, with its row locked, so two changes at once (two tabs, a
 * quick run of taps) can't overwrite each other.
 */
export async function updateCycleLog(db: Db, key: Buffer, userId: string, change: (log: CycleLog) => CycleLog): Promise<CycleLog> {
  return withTransaction(db, async (client) => {
    await client.query('INSERT INTO cycle_logs (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [
      userId,
      encrypt(key, JSON.stringify(EMPTY_CYCLE_LOG)),
    ]);
    const { rows } = await client.query<{ data: Buffer }>('SELECT data FROM cycle_logs WHERE user_id = $1 FOR UPDATE', [userId]);
    const next = change(openCycleLog(key, rows[0].data));
    await client.query('UPDATE cycle_logs SET data = $2, updated_at = now() WHERE user_id = $1', [userId, encrypt(key, JSON.stringify(next))]);
    return next;
  });
}

/** Forget the settings and every logged day. */
export async function deleteCycleLog(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM cycle_logs WHERE user_id = $1', [userId]);
}

// ───────────────────────────────────────────────────────── google tokens

export interface StoredTokens {
  refreshToken: string;
  accessToken: string | null;
  /** Epoch ms; 0 when no access token is cached. */
  accessTokenExpiresAt: number;
  scopes: string[];
}

export async function getTokens(db: Db, key: Buffer, userId: string): Promise<StoredTokens | null> {
  const { rows } = await db.query<{
    refresh_token: Buffer;
    access_token: Buffer | null;
    access_token_expires_at: Date | null;
    scopes: string[];
  }>(
    'SELECT refresh_token, access_token, access_token_expires_at, scopes FROM google_tokens WHERE user_id = $1',
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    refreshToken: decrypt(key, row.refresh_token),
    accessToken: row.access_token ? decrypt(key, row.access_token) : null,
    accessTokenExpiresAt: row.access_token_expires_at?.getTime() ?? 0,
    scopes: row.scopes,
  };
}

export async function hasTokens(db: Db, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM google_tokens WHERE user_id = $1', [userId]);
  return !!rowCount;
}

/**
 * Store a token response. Without a refresh token (a returning user who skipped
 * the consent screen) only the access token is updated and the stored one kept.
 */
export async function saveTokens(
  db: Db,
  key: Buffer,
  userId: string,
  tokens: { refreshToken?: string; accessToken: string; expiresAt: Date; scopes?: string[] },
): Promise<void> {
  const access = encrypt(key, tokens.accessToken);
  if (tokens.refreshToken) {
    await db.query(
      `INSERT INTO google_tokens (user_id, refresh_token, access_token, access_token_expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET refresh_token = EXCLUDED.refresh_token, access_token = EXCLUDED.access_token,
             access_token_expires_at = EXCLUDED.access_token_expires_at, scopes = EXCLUDED.scopes, updated_at = now()`,
      [userId, encrypt(key, tokens.refreshToken), access, tokens.expiresAt, tokens.scopes ?? []],
    );
  } else {
    await db.query(
      `UPDATE google_tokens
       SET access_token = $2, access_token_expires_at = $3, scopes = COALESCE($4, scopes), updated_at = now()
       WHERE user_id = $1`,
      [userId, access, tokens.expiresAt, tokens.scopes ?? null],
    );
  }
}

export async function deleteTokens(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM google_tokens WHERE user_id = $1', [userId]);
}

// ────────────────────────────────────────────────────────────── sessions

/** Returns the raw session token for the cookie; only its hash is stored. */
export async function createSession(db: Db, userId: string, ttlMs: number): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [sha256(token), userId, ttlMs / 1000],
  );
  return token;
}

export async function findSessionUser(db: Db, token: string): Promise<{ userId: string; email: string | null } | null> {
  const { rows } = await db.query<{ userId: string; email: string | null }>(
    `SELECT s.user_id AS "userId", u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id_hash = $1', [sha256(token)]);
}

export async function deleteExpiredSessions(db: Db): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at <= now()');
}

// ──────────────────────────────────────────────────────────── health data

export interface SyncStateRow {
  pipelineVersion: number;
  lastSyncAt: Date;
  lastFullSyncAt: Date | null;
  run: SyncRun;
  profile: ProfileFacts;
}

export async function getSyncState(db: Db, userId: string): Promise<SyncStateRow | null> {
  const { rows } = await db.query<SyncStateRow>(
    `SELECT pipeline_version AS "pipelineVersion", last_sync_at AS "lastSyncAt",
            last_full_sync_at AS "lastFullSyncAt", run, profile
     FROM sync_state WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

/** Make the user's next sync a full one, e.g. after sign-in, when granted scopes may have changed. */
export async function requestFullSync(db: Db, userId: string): Promise<void> {
  await db.query('UPDATE sync_state SET last_full_sync_at = NULL WHERE user_id = $1', [userId]);
}

export async function getStreamStates(db: Db, userId: string): Promise<Map<string, StreamState>> {
  const { rows } = await db.query<{ data_type: string; state: StreamState }>(
    'SELECT data_type, state FROM stream_state WHERE user_id = $1',
    [userId],
  );
  return new Map(rows.map((r) => [r.data_type, r.state]));
}

export async function getStreamDays(
  db: Db,
  userId: string,
  from: CivilDate,
  to: CivilDate,
): Promise<Map<string, Map<CivilDate, StreamDay>>> {
  // Dates come back as text: pg would otherwise build JS Dates in the server's zone.
  const { rows } = await db.query<{ data_type: string; date: CivilDate; value: StreamDay }>(
    `SELECT data_type, to_char(date, 'YYYY-MM-DD') AS date, value
     FROM stream_days WHERE user_id = $1 AND date BETWEEN $2 AND $3`,
    [userId, from, to],
  );
  const out = new Map<string, Map<CivilDate, StreamDay>>();
  for (const r of rows) {
    let days = out.get(r.data_type);
    if (!days) out.set(r.data_type, (days = new Map()));
    days.set(r.date, r.value);
  }
  return out;
}

export async function getIntradayDays(db: Db, userId: string, from: CivilDate, to: CivilDate): Promise<IntradayDay[]> {
  const { rows } = await db.query<{ value: IntradayDay }>(
    'SELECT value FROM intraday_heart_rate WHERE user_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date',
    [userId, from, to],
  );
  return rows.map((r) => r.value);
}

/**
 * Store a sync, atomically. Mirrors MemoryStore.apply in src/pipeline/incremental.ts,
 * whose tests define the semantics: purge, delete each replaced range, insert the
 * new days, save state, drop days past the retention limits.
 */
export async function applySyncOutput(db: Db, userId: string, out: SyncOutput, pipelineVersion: number): Promise<void> {
  await withTransaction(db, async (tx) => {
    await writeStreams(tx, userId, out.streams);

    if (out.intraday) {
      const w = out.intraday;
      if (w.purge) await tx.query('DELETE FROM intraday_heart_rate WHERE user_id = $1', [userId]);
      for (const r of w.replace) {
        await tx.query('DELETE FROM intraday_heart_rate WHERE user_id = $1 AND date BETWEEN $2 AND $3', [userId, r.from, r.to]);
      }
      if (Object.keys(w.days).length) {
        await tx.query(
          `INSERT INTO intraday_heart_rate (user_id, date, value)
           SELECT $1, e.key::date, e.value FROM jsonb_each($2::jsonb) AS e
           ON CONFLICT (user_id, date) DO UPDATE SET value = EXCLUDED.value`,
          [userId, JSON.stringify(w.days)],
        );
      }
      await saveStreamState(tx, userId, w.state);
    }

    await tx.query('DELETE FROM stream_days WHERE user_id = $1 AND date < $2', [userId, out.keepFrom]);
    await tx.query('DELETE FROM intraday_heart_rate WHERE user_id = $1 AND date < $2', [userId, out.keepIntradayFrom]);

    await tx.query(
      `INSERT INTO sync_state (user_id, pipeline_version, last_sync_at, last_full_sync_at, run, profile)
       VALUES ($1, $2, now(), CASE WHEN $3 THEN now() END, $4::jsonb, $6::jsonb || COALESCE($5::jsonb, '{}'::jsonb))
       ON CONFLICT (user_id) DO UPDATE SET
         pipeline_version = EXCLUDED.pipeline_version,
         last_sync_at = EXCLUDED.last_sync_at,
         last_full_sync_at = CASE WHEN $3 THEN now() ELSE sync_state.last_full_sync_at END,
         run = EXCLUDED.run,
         profile = sync_state.profile || COALESCE($5::jsonb, '{}'::jsonb)`,
      [
        userId,
        pipelineVersion,
        out.run.kind === 'full',
        JSON.stringify(out.run),
        out.profile ? JSON.stringify(out.profile) : null,
        JSON.stringify({ heightCm: null, heightRecordedOn: null }),
      ],
    );
  });
}

/** Forget one stream: its days and its state. The next sync starts it over, if it's still read. */
export async function purgeStream(db: Db, userId: string, dataType: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query('DELETE FROM stream_days WHERE user_id = $1 AND data_type = $2', [userId, dataType]);
    await tx.query('DELETE FROM stream_state WHERE user_id = $1 AND data_type = $2', [userId, dataType]);
  });
}

/**
 * Each stream's sources, with the last day each reported it and on how many days, across all
 * stored history: what a day's reading is picked by (pipeline/sources.ts). Read from the stored
 * days' provenance alone, never their readings.
 */
export async function getSourcesSeen(db: Db, userId: string): Promise<Map<string, Map<string, SourceSeen>>> {
  const { rows } = await db.query<{ data_type: string; id: string; latest: CivilDate; days: number }>(
    `SELECT d.data_type, s.id, to_char(max(d.date), 'YYYY-MM-DD') AS latest, count(*)::int AS days
     FROM stream_days d
     CROSS JOIN LATERAL (
       SELECT jsonb_object_keys(d.value->'variants') AS id
       UNION
       SELECT d.value->'sourceByType'->>d.data_type
     ) s
     WHERE d.user_id = $1 AND s.id IS NOT NULL
     GROUP BY d.data_type, s.id`,
    [userId],
  );
  const out = new Map<string, Map<string, SourceSeen>>();
  for (const r of rows) {
    let seen = out.get(r.data_type);
    if (!seen) out.set(r.data_type, (seen = new Map()));
    seen.set(r.id, { latest: r.latest, days: r.days });
  }
  return out;
}

/** Forget the minute heart rate and its state: the next sync fetches the window again. */
export async function purgeIntraday(db: Db, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query('DELETE FROM intraday_heart_rate WHERE user_id = $1', [userId]);
    await tx.query(`DELETE FROM stream_state WHERE user_id = $1 AND data_type = 'heart-rate'`, [userId]);
  });
}

/** Store backfilled history: stream writes only, without touching the sync run or retention. */
export async function applyStreamWrites(db: Db, userId: string, writes: StreamWrite[]): Promise<void> {
  await withTransaction(db, (tx) => writeStreams(tx, userId, writes));
}

async function writeStreams(tx: pg.PoolClient, userId: string, writes: StreamWrite[]): Promise<void> {
  for (const w of writes) {
    if (w.purge) await tx.query('DELETE FROM stream_days WHERE user_id = $1 AND data_type = $2', [userId, w.dataType]);
    for (const r of w.replace) {
      await tx.query(
        'DELETE FROM stream_days WHERE user_id = $1 AND data_type = $2 AND date BETWEEN $3 AND $4',
        [userId, w.dataType, r.from, r.to],
      );
    }
    if (Object.keys(w.days).length) {
      await tx.query(
        `INSERT INTO stream_days (user_id, data_type, date, value)
         SELECT $1, $2, e.key::date, e.value FROM jsonb_each($3::jsonb) AS e
         ON CONFLICT (user_id, data_type, date) DO UPDATE SET value = EXCLUDED.value`,
        [userId, w.dataType, JSON.stringify(w.days)],
      );
    }
    await saveStreamState(tx, userId, w.state);
  }
}

/** The oldest day with any stored data, or null. */
export async function getOldestStreamDay(db: Db, userId: string): Promise<CivilDate | null> {
  const { rows } = await db.query<{ oldest: CivilDate | null }>(
    `SELECT to_char(min(date), 'YYYY-MM-DD') AS oldest FROM stream_days WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.oldest ?? null;
}

async function saveStreamState(tx: pg.PoolClient, userId: string, state: StreamState): Promise<void> {
  await tx.query(
    `INSERT INTO stream_state (user_id, data_type, state) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (user_id, data_type) DO UPDATE SET state = EXCLUDED.state`,
    [userId, state.dataType, JSON.stringify(state)],
  );
}

/**
 * Connected users due a sync: never synced, older than the interval, or stored
 * by a different pipeline version (an upgrade rebuilds everyone). Stalest first.
 */
export async function usersDueForSync(
  db: Db,
  intervalMinutes: number,
  pipelineVersion: number,
): Promise<{ userId: string; email: string | null }[]> {
  const { rows } = await db.query<{ userId: string; email: string | null }>(
    `SELECT t.user_id AS "userId", u.email FROM google_tokens t
     JOIN users u ON u.id = t.user_id
     LEFT JOIN sync_state s ON s.user_id = t.user_id
     WHERE s.user_id IS NULL
        OR s.pipeline_version <> $2
        OR s.last_sync_at < now() - make_interval(mins => $1)
     ORDER BY s.last_sync_at NULLS FIRST`,
    [intervalMinutes, pipelineVersion],
  );
  return rows;
}
