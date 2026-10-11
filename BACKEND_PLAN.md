# Healthier: Backend Architecture & Migration Plan

## 1. Core Architectural Philosophy
1. **Self-hostable by anyone:** One `docker compose up` brings up the whole app on the operator's own machine. The only external dependency is Google's API, which holds the data. No Firebase, no managed database, no platform-specific secrets.
2. **The "Yesterday Test" Remains Supreme:** The insight engine (`insights.ts`) remains 100% stateless, deterministic, and pure. The backend never stores state flags, streaks, or pre-computed insights. It acts strictly as a data mirror.
3. **Strict Data Minimization:** We never store raw, bloated Google API JSON responses. The pipeline parses and transforms Google's payloads into the discrete interfaces it needs (e.g., `DailyRecord`, `SleepSession`, `IntradaySample`) before anything is saved.
4. **Settled History:** Older days rarely change, so they are fetched once and kept; only the most recent days are polled. Because "rarely" is not "never", a weekly full rebuild catches late corrections.

---

## 2. Phase 1: Identity & Infrastructure — done
**Goal:** Secure, persistent sessions on infrastructure the operator owns.
*   **Configuration:** Every setting is an environment variable, validated at boot (`server/config.ts`, documented in `.env.example`). The server refuses to start and lists what is missing.
*   **Google OAuth, server side:** The Express server runs the authorization-code flow with its own client secret (`server/auth.ts`, `server/google.ts`), requesting `access_type=offline` to obtain a long-lived `refresh_token`. Firebase Auth was dropped: its popup flow only ever returned a one-hour access token to the browser, which made background sync impossible.
*   **Secure token storage:** Refresh and access tokens are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) before they reach Postgres, and never leave the server.
*   **Sessions:** A random session id in an httpOnly, SameSite=Lax cookie; only its SHA-256 hash is stored.
*   **Docker:** `docker-compose.yml` runs the app and Postgres. Migrations are embedded and applied at boot.

---

## 3. Phase 2: Database Schema — done
**Goal:** Postgres holding pipeline-ready data. Accounts, sessions and tokens are relational; health data is stored the way the sync engine updates it.

**Tables (`server/db.ts`):**
*   `users` — Google subject, profile, and the user's IANA time zone (decides what "today" means on the server).
*   `google_tokens` — encrypted refresh/access tokens and granted scopes.
*   `sessions` — hashed session ids.
*   `stream_days (user_id, data_type, date)` — what one stream (steps, sleep, HRV…) contributed to one civil day: just the `DailyRecord` fields it set, plus provenance. Days are reassembled from their streams on read.
*   `intraday_heart_rate (user_id, date)` — one civil day of minute-level heart rate, stored column-wise.
*   `stream_state (user_id, data_type)` — per-stream coverage (which days are settled) and the outcome of its last fetch, which the Data tab shows.
*   `sync_state (user_id)` — pipeline version, last sync / last full sync, profile facts.

Only the 62-day dashboard window is kept; older rows are dropped as the window moves. Deleting a user cascades to every table.

**Why per stream, not per day:** a stream that fails must not wipe the good data other streams stored for the same day, and a refresh of steps must never touch sleep. Each stream writes disjoint fields of a day (asserted in the tests), so reassembly is exact.

---

## 4. Phase 3: The Background Synchronization Engine — done
**Goal:** Fetch each day as few times as correctness allows, and never let the incremental path drift from a full sync.

The engine (`src/pipeline/incremental.ts`) is store-agnostic: the server runs it against Postgres; demo mode and the tests run the same code against an in-memory store.

*   **First sign-in = backfill.** The whole 62-day window, including minute-level heart rate, is imported before the dashboard is shown ("Building your health baseline"). The insight engine reads exactly this window (baselines need 29 days, readiness 39, monthly insights 55+), so showing it half-filled would show wrong insights, not just fewer.
*   **Incremental syncs.** Each sync refetches the last 3 days (`REFETCH_DAYS`): sleep lands the next morning, watches sync late, Google revises recent totals. Older days are settled and kept.
*   **Settling is earned.** A stream's days only become settled after a sync in which that stream fully succeeded. A failure (429, 5xx, network, a failed rollup chunk) replaces nothing and leaves coverage where it was, so the next sync retries the same range.
*   **Full rebuilds** run weekly (`FULL_RESYNC_DAYS`), after every sign-in (granted scopes may have changed), from "Force full sync" on the Data tab, and whenever `PIPELINE_VERSION` changes. Stored rows are processed data, so a fix to normalisation must be re-applied to history: bumping the version rebuilds every user, and their dashboard shows onboarding until it is done.
*   **Lists page by date.** List endpoints return newest first; paging stops once a page reaches past the requested start, instead of a fixed page count.
*   **Intraday heart rate via `rollUp`.** Google rolls raw samples into one-minute averages server-side (`windowSize: 60s`, ≤14 days per request), so the full window costs a handful of requests instead of hundreds of pages. Minutes are mapped to civil time with the user's zone.
*   **Scheduler.** An in-process scheduler syncs each connected user every `SYNC_INTERVAL_MINUTES`, one at a time.
*   **Failure modes surfaced.** Expired or revoked Google access (`invalid_grant`) asks the user to reconnect. A sync in which every request fails (e.g. the Google Health API isn't enabled) reports Google's error instead of storing an empty dashboard.
*   **Correctness is tested** (`src/pipeline/__tests__/incremental.test.ts`): a full sync followed by an incremental one produces exactly what a single full sync shows; a failed stream keeps its data and converges on the next sync; revisions inside the refetch window are picked up; the Postgres layer was checked to match the in-memory store row for row.

**Possible later:** list endpoints also accept a date `filter`, which would trim payloads further; paging by date already bounds the work, so it isn't needed yet.

---

## 5. Phase 4: Client Simplification — done
*   All Google REST calls, tokens and the localStorage cache are gone from the browser.
*   The frontend reads `GET /api/dataset`, starts syncs with `POST /api/sync` (`{ full: true }` to rebuild), and follows progress via `GET /api/sync`. It feeds the result directly into the stateless insight algorithms.

---

## 6. Phase 5: Frontend Login Flow & UX — mostly done
*   **Done:** "Connect Google Account" is the single entry point: a full-page redirect through Google's consent screen.
*   **Done:** Returning users skip the consent screen; the server forces it only when it holds no refresh token for them.
*   **Done:** A "Disconnect Google & delete my data" button (Data tab) revokes the token with Google, deletes every row for the user, and signs them out.
*   **Next — OAuth screen customization:** Logo, privacy policy and scope justifications on the consent screen are configured per install in each operator's Google Cloud console; document recommended wording.
*   **Note:** OAuth apps left in "Testing" status get 7-day refresh tokens for these scopes. Operators should publish to "In production" (see README).
