import pg from 'pg';

/**
 * Postgres access.
 *
 * Accounts, sessions and tokens are relational and want integrity: deleting a
 * user must take their tokens, sessions and data with it, which `ON DELETE
 * CASCADE` makes one statement. Health data is stored the way the sync engine
 * (src/pipeline/incremental.ts) updates it: one JSONB row per stream per civil
 * day, so a sync touches only the days it refetched.
 *
 * Migrations are embedded here and applied at boot, so upgrading a self-hosted
 * install is pulling the new image and restarting. Append new entries; never
 * edit one that has shipped.
 */

export type Db = pg.Pool;

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        google_sub  text NOT NULL UNIQUE,
        email       text,
        name        text,
        picture_url text,
        -- IANA zone reported by the user's browser; decides what "today" means in background syncs.
        time_zone   text NOT NULL DEFAULT 'UTC',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Token columns hold AES-256-GCM ciphertext (see crypto.ts), never plaintext.
      CREATE TABLE google_tokens (
        user_id                 uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        refresh_token           bytea NOT NULL,
        access_token            bytea,
        access_token_expires_at timestamptz,
        scopes                  text[] NOT NULL DEFAULT '{}',
        updated_at              timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE sessions (
        id_hash    bytea PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX sessions_user_id_idx ON sessions (user_id);

      -- One row per user once their first sync has completed.
      CREATE TABLE sync_state (
        user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        -- PIPELINE_VERSION that wrote the stored rows; a mismatch forces a full rebuild.
        pipeline_version  integer NOT NULL,
        last_sync_at      timestamptz NOT NULL,
        -- NULL asks for a full sync next time (set on sign-in).
        last_full_sync_at timestamptz,
        run               jsonb NOT NULL,
        profile           jsonb NOT NULL
      );

      -- Per-stream coverage and the outcome of its last fetch (StreamState).
      CREATE TABLE stream_state (
        user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        data_type text NOT NULL,
        state     jsonb NOT NULL,
        PRIMARY KEY (user_id, data_type)
      );

      -- What one stream contributed to one civil day (StreamDay).
      CREATE TABLE stream_days (
        user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        data_type text NOT NULL,
        date      date NOT NULL,
        value     jsonb NOT NULL,
        PRIMARY KEY (user_id, data_type, date)
      );
      CREATE INDEX stream_days_user_date_idx ON stream_days (user_id, date);

      -- One civil day of minute-level heart rate (IntradayDay).
      CREATE TABLE intraday_heart_rate (
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        date    date NOT NULL,
        value   jsonb NOT NULL,
        PRIMARY KEY (user_id, date)
      );
    `,
  },
  {
    id: 2,
    name: 'user gender',
    sql: `
      -- Set by the person on the Body page; Google Health doesn't provide it.
      ALTER TABLE users ADD COLUMN gender text CHECK (gender IN ('female', 'male', 'other'));
    `,
  },
  {
    id: 3,
    name: 'user goals',
    sql: `
      -- Set by the person on the Data tab (Goals in src/pipeline/goals.ts); NULL until they change one.
      ALTER TABLE users ADD COLUMN goals jsonb;
    `,
  },
  {
    id: 4,
    name: 'cycle logs',
    sql: `
      -- The person's cycle settings and log (CycleLog in src/pipeline/cycle.ts), one row a person.
      -- Periods and symptoms are among the most private things anyone records, so the whole log is
      -- AES-256-GCM ciphertext under ENCRYPTION_KEY, like the Google tokens.
      CREATE TABLE cycle_logs (
        user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        data       bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 5,
    name: 'user sources',
    sql: `
      -- Set by the person on the Data tab (Devices and sources, SourcePrefs in src/pipeline/sources.ts):
      -- which devices count, in what order, and which kinds of source Google adds up. NULL until set.
      ALTER TABLE users ADD COLUMN sources jsonb;
    `,
  },
  {
    id: 6,
    name: 'user theme',
    sql: `
      -- Set by the person on the Data tab (Account, Theme in src/lib/theme.ts): dark, light, or
      -- whichever their device is set to. NULL until they pick one, and the app opens dark.
      ALTER TABLE users ADD COLUMN theme text CHECK (theme IN ('dark', 'light', 'system'));
    `,
  },
];

export function createDb(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` in one transaction: every write of a sync lands, or none does. */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Wait for Postgres to accept connections; it may still be starting alongside us. */
export async function waitForDb(db: Db, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent boots against the same database.
    await client.query('SELECT pg_advisory_xact_lock(726209100)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         integer PRIMARY KEY,
        name       text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
      console.log(`Applied migration ${m.id} (${m.name})`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
