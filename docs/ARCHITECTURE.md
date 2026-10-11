# Architecture

How Healthier works and why, for contributors. What's planned lives in the
[milestones](https://github.com/cbukenya/healthier/milestones), not here.

## Principles

1. **Self-hostable by anyone.** One `docker compose up` runs everything on the operator's machine.
   The only external dependency is Google's API, which holds the data. No managed services, no
   telemetry.
2. **The insight engine is pure.** `src/pipeline/insights.ts` and `derive.ts` are stateless and
   deterministic: rows in, insights out. The server never stores insights, streaks or flags; it
   mirrors data.
3. **Data minimisation.** Google's payloads are normalised into the app's own types
   (`DailyRecord`, `SleepSession`, minute-level heart rate) before anything is stored. Raw API
   JSON is never kept, and only the dashboard's 62-day window is retained.
4. **Settled history.** Older days rarely change, so they are fetched once and kept; only the most
   recent days are polled. "Rarely" isn't "never", so a weekly full rebuild catches late
   corrections.

## Components

```
browser (React)  ──/api──▶  Express server  ──▶  Postgres
                              │
                              └──▶  Google OAuth + Google Health API
```

- **`server/`**: Express app. Google sign-in (`auth.ts`, `google.ts`), sign-up control
  (`access.ts`), the JSON API (`api.ts`), background sync (`sync.ts`), storage (`db.ts`,
  `repo.ts`), configuration (`config.ts`).
- **`src/pipeline/`**: fetching, normalisation, the sync engine (`incremental.ts`), and the
  insight engine. Shared by the server (live data) and the browser (demo mode).
- **`src/`**: the dashboard. It never sees a Google token.

## Identity and secrets

- The server runs Google's authorization-code flow with its own client secret, requesting offline
  access so it holds a refresh token and can sync while no browser is open.
- Signing in creates the account. `ALLOWED_EMAILS` restricts who can, and is re-checked on every
  request, so removing someone takes effect immediately.
- Refresh and access tokens are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) before they reach
  Postgres.
- Sessions are random ids in an httpOnly, SameSite=Lax cookie; only their SHA-256 hash is stored.
- Configuration is environment variables only, validated at boot: the server refuses to start and
  lists what is missing.

## Storage

| Table | Holds |
| --- | --- |
| `users` | Google subject, profile, IANA time zone (decides what "today" means on the server) |
| `google_tokens` | encrypted tokens and granted scopes |
| `sessions` | hashed session ids |
| `stream_days (user_id, data_type, date)` | what one stream (steps, sleep, HRV…) contributed to one civil day: only the `DailyRecord` fields it set, plus provenance |
| `intraday_heart_rate (user_id, date)` | one civil day of minute-level heart rate, column-wise |
| `stream_state (user_id, data_type)` | per-stream coverage and the outcome of its last fetch (shown on the Data tab) |
| `sync_state (user_id)` | pipeline version, last sync and last full sync, profile facts |

Deleting a user cascades to every table.

**Why per stream, not per day:** a stream that fails must not wipe the data other streams stored
for the same day, and refreshing steps must never touch sleep. Each stream writes disjoint fields
of a day (asserted in the tests), so days reassemble exactly.

**Migrations** are embedded in `server/db.ts` and run at boot. They are append-only: never edit
one that has been released.

## Sync engine

`src/pipeline/incremental.ts` decides what to fetch, fetches it, and describes what to store,
without knowing where. The server applies that to Postgres; demo mode and the tests apply it to
`MemoryStore`. The Postgres layer must match `MemoryStore.apply` exactly.

- **First sign-in is a backfill.** The whole 62-day window, including minute-level heart rate, is
  imported before the dashboard opens. The insight engine reads exactly this window (baselines need
  29 days, readiness 39, monthly insights 55+), so a half-filled window would show wrong insights,
  not just fewer.
- **Incremental syncs** refetch the last 3 days (`REFETCH_DAYS`): sleep lands the next morning,
  watches sync late, Google revises recent totals. Older days are settled and kept.
- **Settling is earned.** A stream's days only become settled after a sync in which that stream
  fully succeeded. A failure (429, 5xx, network, a failed rollup chunk) replaces nothing and leaves
  coverage where it was, so the next sync retries the same range.
- **Full rebuilds** run weekly (`FULL_RESYNC_DAYS`), after every sign-in (granted scopes may have
  changed), from "Force full sync" on the Data tab, and whenever `PIPELINE_VERSION` changes.
- **Lists page by date.** List endpoints return newest first; paging stops once a page reaches past
  the requested start.
- **Intraday heart rate uses `rollUp`.** Google rolls raw samples into one-minute averages
  (`windowSize: 60s`, at most 14 days per request), so the whole window costs a handful of
  requests. Minutes are mapped to civil time with the user's zone.
- **Scheduling.** An in-process scheduler syncs each connected user every
  `SYNC_INTERVAL_MINUTES`, one at a time. Jobs live in memory, so one app instance is assumed.
- **Failures are surfaced.** Revoked or expired Google access (`invalid_grant`) asks the user to
  reconnect. A sync in which every request fails (for example, the Google Health API isn't
  enabled) reports Google's error instead of storing an empty dashboard.

### `PIPELINE_VERSION`

Stored rows are *processed* data. When normalisation changes (`registry.ts`, `normalize.ts`, sleep
parsing) or a stored shape changes, bump `PIPELINE_VERSION`: every user is rebuilt with a full
sync, and their dashboard shows onboarding until it completes.

## Guarantees the tests hold

`src/pipeline/__tests__/incremental.test.ts`:

- a full sync followed by an incremental one shows exactly what a single full sync shows;
- a failed stream keeps its data, doesn't advance coverage, and converges on the next sync;
- revisions inside the refetch window are picked up;
- withdrawing a scope deletes that stream's data;
- per-stream storage reassembles exactly what normalising every stream at once produces, and
  survives a JSON round trip (as it must to live in Postgres);
- civil dates and minutes are correct across DST changes.
