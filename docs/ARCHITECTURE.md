# Architecture

How Healthier works and why, for contributors. What's planned lives in the
[milestones](https://github.com/cbukenya/healthier/milestones), not here.

## Principles

1. **Self-hostable by anyone.** One `docker compose up` runs everything on the operator's machine.
   The only external dependency is Google's API, which holds the data. No managed services, no
   telemetry.
2. **The insight engine is pure.** `src/pipeline/insights/` and `derive.ts` are stateless and
   deterministic: rows in, insights out. The server never stores insights, streaks or flags; it
   mirrors data.
3. **Data minimisation.** Google's payloads are normalised into the app's own types
   (`DailyRecord`, `SleepSession`, minute-level heart rate) before anything is stored. Raw API
   JSON is never kept. Daily records are retained for `HISTORY_DAYS` (default two years);
   minute-level heart rate only for the 62-day window.
4. **Settled history.** Older days rarely change, so they are fetched once and kept; only the most
   recent days are polled. "Rarely" isn't "never", so a weekly full rebuild catches late
   corrections.
5. **History is for looking, baselines are for judging.** Long history feeds descriptive views
   (charts over 90 days, a year, all time) and the insights that describe the past (your best
   month, your biggest day yet), which ask for it through history queries. Everything that judges
   today (baselines, readiness, insights, labs) keeps its fixed recent window, so a reading from
   years ago never shifts what "your usual" means now.
6. **One today.** The window ends on the user's today, in their own zone (demo mode: the fixture's
   clock and zone). Every card and insight judges against that day; the device clock only picks
   morning, midday or evening. Only readings from today or yesterday count as "last night", and
   today's movement is still in progress, so whole-day comparisons read finished days.

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
| `users` | Google subject, profile, IANA time zone (decides what "today" means on the server), gender (set on the Body page) |
| `google_tokens` | encrypted tokens and granted scopes |
| `sessions` | hashed session ids |
| `stream_days (user_id, data_type, date)` | what one stream (steps, sleep, HRV…) contributed to one civil day: only the `DailyRecord` fields it set, plus provenance. Kept for `HISTORY_DAYS` |
| `intraday_heart_rate (user_id, date)` | one civil day of minute-level heart rate, column-wise. Kept for the 62-day window |
| `stream_state (user_id, data_type)` | per-stream coverage and the outcome of its last fetch (shown on the Data tab) |
| `sync_state (user_id)` | pipeline version, last sync and last full sync, profile facts (height, age) |

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
  imported before the dashboard opens. Everything that judges today reads exactly this window
  (baselines need 29 days, readiness 39, monthly insights 55+), so a half-filled window would show
  wrong insights, not just fewer.
- **Incremental syncs** refetch the last 3 days (`REFETCH_DAYS`): sleep lands the next morning,
  watches sync late, Google revises recent totals. Older days are settled and kept.
- **Settling is earned.** A stream's days only become settled after a sync in which that stream
  fully succeeded. A failure (429, 5xx, network, a failed rollup chunk) replaces nothing and leaves
  coverage where it was, so the next sync retries the same range.
- **Full rebuilds** run weekly (`FULL_RESYNC_DAYS`), after every sign-in (granted scopes may have
  changed), from "Force full sync" on the Data tab, and whenever `PIPELINE_VERSION` changes. They
  refetch the window; history older than the window is kept, except after a `PIPELINE_VERSION`
  change, when it is dropped and backfilled again by the new code.
- **History backfills in the background.** After a sync stores the window, each stream's coverage
  is extended back to `HISTORY_DAYS`, one stream per step (`backfillStream`). Every write for a
  user, sync or backfill step, runs under that user's lock, so they never interleave and a sync
  waits behind at most one step. A failed step leaves coverage unchanged and retries after the
  next sync. Window sync plus backfill is tested to store exactly what one long full sync would.
- **Lists page by date.** List endpoints return newest first; paging stops once a page reaches past
  the requested start.
- **Several readings, one day.** A day can hold more than one reading of a stream: two devices, or
  a partial reading beside a full one. They apply best first (the stream's `rank`, then the source)
  and only fill what is still empty, so the order the API lists them in never matters and an
  incremental sync agrees with a full one.
- **One sleep, one session.** Sleep points are grouped before parsing (`combineSleepPoints`):
  overlapping sessions are one sleep recorded twice and keep the best copy, and pieces of a night
  less than three hours apart join into one night, with the break counted as awake.
- **Intraday heart rate uses `rollUp`.** Google rolls raw samples into one-minute averages
  (`windowSize: 60s`, at most 14 days per request), so the whole window costs a handful of
  requests. Minutes are mapped to civil time with the user's zone.
- **Scheduling.** An in-process scheduler syncs each connected user every
  `SYNC_INTERVAL_MINUTES`, one at a time. Jobs live in memory, so one app instance is assumed.
- **Failures are surfaced.** Revoked or expired Google access (`invalid_grant`) asks the user to
  reconnect. A sync in which every request fails (for example, the Google Health API isn't
  enabled) reports Google's error instead of storing an empty dashboard.

## Long spans in the UI

`GET /api/history` serves every stored day, trimmed of per-minute sleep detail, and the browser
loads it only when a screen's span selector goes past the window (`src/ui/span.tsx`). Charts over
long spans are grouped (`src/pipeline/aggregate.ts`): daily up to 120 days, weekly up to two
years, monthly beyond, as averages per recorded day. Sparse series such as weigh-ins stay raw
unless they would exceed 120 points. Baseline bands are hidden on grouped charts, because they
describe the last 28 days.

## Type roles

Text is set in named roles from `src/index.css` (`text-caption`, `text-eyebrow`, `text-title`,
`text-number-lg` and so on), not in one-off pixel sizes. Each role carries its size, line height,
tracking and weight; an element's own `leading-*`, `tracking-*` or `font-*` class still wins.
Page titles, verdicts, card titles, big numbers and insights also take `font-display`, so the
face for those is `--font-display` and their roles, in one file. Chart ticks share `TICK` in
`src/charts/index.tsx`, because SVG text can't read the CSS tokens.

## History queries

Insights that describe the past need days older than the window. Each page's rules declare what
they need as queries (`src/pipeline/history.ts`): a measure from a fixed list of daily values, how
to aggregate it (sum, count, mean, min, max, first, last), an optional grouping (month, ISO week,
weekday, year) or rolling mean, and how far back to look (`back`, in days or `'all'`, and
optionally `until`). The browser sends them with `POST /api/dataset`; the server reads the stored
days once for the span they need together and answers each over its own range. Demo mode and the
tests answer the same queries from `MemoryStore`.

- **Answers end before the window.** The window is what the engine cuts back a day at a time for
  the yesterday test. If an answer also covered it, a record set today would already be inside
  "your biggest day this year" and could never be news. So the server answers the older part and
  the engine adds the window's own days, which it can still cut back.
- **Nothing is stored.** Answers are worked out from the stored days on every read, so the same
  days and the same queries always give the same answers.
- **The vocabulary is closed.** A query can only read one person's own daily records through the
  listed measures. Anything malformed is dropped and answered with nothing, and the card that
  asked stays silent.

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

`src/pipeline/__tests__/normalize.test.ts`: a day comes out the same whatever order its readings
arrive in; a partial reading never wipes a complete one; two devices' copies of a night count once;
a night split by a long awakening is one night; a short night without metadata is still the night.
