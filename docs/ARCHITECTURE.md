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
6. **One today.** The window ends on the user's today, in their own zone (demo mode: the demo
   person's clock and zone). Every card and insight judges against that day; the device clock only picks
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
| `users` | Google subject, profile, IANA time zone (decides what "today" means on the server), gender (set on the Body page), goals, the choice of devices and the theme (set on the Settings page) |
| `google_tokens` | encrypted tokens and granted scopes |
| `sessions` | hashed session ids |
| `stream_days (user_id, data_type, date)` | what one stream (steps, sleep, HRV…) contributed to one civil day: only the `DailyRecord` fields it set, plus provenance, and each source's own reading when more than one reported the day (see Devices and sources). Kept for `HISTORY_DAYS` |
| `intraday_heart_rate (user_id, date)` | one civil day of minute-level heart rate, column-wise. Kept for the 62-day window |
| `stream_days` with `data_type = 'sleep-heart-rate-floor'` | the night's heart rate floor, derived from the minutes while cycle tracking is on (see Cycles). Kept like any stream |
| `stream_state (user_id, data_type)` | per-stream coverage and the outcome of its last fetch (shown on the Settings page) |
| `sync_state (user_id)` | pipeline version, last sync and last full sync, profile facts (height, age) |
| `cycle_logs (user_id)` | cycle tracking: the settings, the periods and symptoms the person logged, and found starts they said weren't a period. AES-256-GCM ciphertext under `ENCRYPTION_KEY`, read and changed whole, in a transaction |

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
  changed), from "Full sync" on the Settings page, and whenever `PIPELINE_VERSION` changes. They
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
  incremental sync agrees with a full one. Each source's own reading is kept beside them, and the
  one shown is picked when the day is read (see Devices and sources).
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

## Devices and sources

Google Health takes readings from every device and app the person connects, and names where each
list reading came from (`dataSource`: platform, recording method, device, app).
`src/pipeline/sources.ts` decides which one Healthier reads. The Devices and sources card on the
Settings page (`src/views/SourcesCard.tsx`) shows each source and sets the person's choices, which
are kept on `users.sources` (`GET` and `PUT /api/sources`).

- **Every source's reading is kept.** When more than one source reported a list stream on a day
  (sleep, HRV, resting heart rate, breathing rate, skin temperature, blood oxygen, cardio fitness,
  weight, body fat), normalisation also reads each source's points alone. The stored day keeps
  each one's reading (`StreamDay.variants`). A day with a reading that names no source stays
  combined.
- **The reading is picked when the day is read.** For each stream, `assembleDays` takes the
  reading of the first source in that stream's order that has one. A new choice applies at once,
  to the window and to all history, with nothing fetched.
  - The order is one list for every reading: the person's order, then the sources they haven't
    placed, most recent first, then by days reported (`sourceRanking`). A new device leads until
    it's placed.
  - Advanced puts a first choice for one reading ahead of the list (`perReading`).
  - A switched-off source is never read.
  - The server ranks the sources over every stored day (`getSourcesSeen`, which reads provenance
    only), so every span is picked the same way.
- **A fill is judged against its own source.** A reading from a source other than its stream's
  first choice is a fill (`DailyRecord.fills`), such as the night the watch was charging and a ring
  filled in. It's shown, but `series` labels it with its source, and `compareToBaseline` reads it
  only against earlier readings from the same source. So it neither takes a verdict from another
  device's range nor moves that range. Its pill says nothing until that source has 8 readings of
  its own, and the body battery reads last night's HRV the same way.
- **The cycle finder keeps a fill where it can.** A night from another source counts where that
  source gave 20 of the 61 nights around it: a month on an old band stays, a night here and there
  doesn't. Each night is put in spreads from the nights around it from the same kind of source
  (`standardized`), so a change of device isn't read as a change in the body. The history
  queries ask for the two kinds apart (the `own` and `fill` measures).
- **Daily totals can't be split by device.** Steps, distance, energy, active and zone minutes,
  floors and the minute heart rate come from Google already added up. The only filter is the kind
  of source Google adds up (`dataSourceFamily` on each rollup): every source (the default, so it
  isn't sent), Google's own, or what the person wears. A new choice purges those streams, the
  minute heart rate and the floor worked out from it, then runs a full sync with the new filter
  (`refetchTotals`, under the user's lock, after any sync already running). The history backfill
  fetches older days with it too.
- **The floor follows the sleep.** The night's heart rate floor is measured inside the chosen
  sleep's times, so a new choice of device recomputes the window's nights from the stored minutes
  at once. Older nights keep their floor, because their minutes aren't kept. That costs little: on
  mcPHASES, moving a sleep's ends by half an hour either way moved the floor by a beat or less on
  94 to 97% of nights, and by two or less on 98 to 99%.

## Long spans in the UI

`GET /api/history` serves every stored day, trimmed of per-minute sleep detail, and the browser
loads it only when a screen's span selector goes past the window (`src/ui/span.tsx`). Charts over
long spans are grouped (`src/pipeline/aggregate.ts`): daily up to 120 days, weekly up to two
years, monthly beyond, as averages per recorded day. Sparse series such as weigh-ins stay raw
unless they would exceed 120 points. Baseline bands are hidden on grouped charts, because they
describe the last 28 days.

## Insight engine

`src/pipeline/insights/` turns the day grid into the cards on every page. It runs plain arithmetic
over the person's own days, plus the clock. There is no model call and no stored state, so every
device shows the same cards.

- **Cards** are written in `insights/cards/`, one file per page.
  - `today.ts` holds the cards that only make sense on Today: the body battery, the weekly review
    and Labs reminders.
  - Each card adds findings: words from the language file, and the fields that place them.
- **News comes from the data.** To know whether something is new, the engine runs the same card on
  the window cut back a day or more: the yesterday test, in `helpers.ts`. A card is news only when
  it wasn't already true. Nothing is remembered between visits.
- **Conflicts are settled together**, in `conflicts.ts`:
  - illness speaks for recovery;
  - no metric is claimed both ways;
  - no push sits beside rest;
  - good news gives way to a cautious card from its family in the same carousel;
  - one card per topic.
- **Each card shows in one place,** decided in `place.ts`.
  - It shows on Today while it's key: an alert or nudge while it's true, anything else while it's
    news. Otherwise it shows on its own page.
  - A Today with fewer than two cards brings forward what matters most from the pages, cautious
    cards first.
  - A carousel with nothing to say shows a floor card (`cards/floors.ts`).
- **The clock only picks the part of the day.** Today is the window's last day. Whether it's
  morning, midday or evening decides which nudges and day cards fit.

The comment at the top of `insights/engine.ts` has the full vocabulary.

## Labs

Labs are experiments that look for patterns over several weeks. Their arithmetic is in
`src/pipeline/labs.ts`, and their cards are in `src/views/LabsView.tsx`. They look for:
- breathing, oxygen and time awake off together at night;
- strain across four signals: resting heart rate, breathing, HRV and skin temperature;
- heart rate dipping at night;
- shifts in HRV entropy;
- fast heart rate during sleep;
- irregular rhythm notifications, as the device reports them.

Each lab is a pure function from the days, and minute heart rate where it needs it, to a status
and its figures.
- It judges against the person's own usual range, worked out from days before the ones it judges,
  or against a fixed band whose source it names.
- Too few nights reads as collecting, never as nothing found.
- When a pattern appears, and once a month while it lasts, Today shows a plain reminder
  (`cards/today.ts`).
- No lab names a condition. CONTRIBUTING.md has the rules for its words.

## Cycles

Google Health lets apps add periods but not read them back, so cycles are found in the nights
(`src/pipeline/cycle.ts`), and what the person logs makes them certain.

- **Five measures.** Sleeping heart rate, resting heart rate, HRV, skin temperature and breathing
  rate. Each is put in its own standard deviations from its average over the 61 nights around,
  from the same kind of source (see Devices and sources).
  Sleeping heart rate carries the cycle most clearly; resting heart rate and temperature least.
- **Sleeping heart rate is the night's floor:** the tenth percentile of the one-minute heart rate
  during the main sleep (`src/pipeline/sleepHrFloor.ts`). The luteal phase lifts the body's floor,
  and the floor shows it more clearly than Google's non-REM average does: on mcPHASES the finder
  finds 33% of period starts within 3 days with the floor against 24% with the average. The
  server computes it after each sync from the minutes it fetches, for every night with a main
  sleep (the one the person's choice of device reads) and at least half its minutes recorded, and stores it as the stream
  `sleep-heart-rate-floor`, so it outlives the minute data. Older nights are filled in by the history
  backfill, a fortnight of minutes per step, back to the oldest stored sleep; those minutes are not
  kept. All of this only while cycle tracking is on: turning tracking on starts a sync, turning it
  off or deleting the cycle log deletes the stream, and the finder reads the non-REM heart rate
  until the floor covers the nights. The page shows the same figure wherever it shows a heart
  rate, as "Resting heart rate (basal)", so what it draws is what the finder read.
- **The shape around a start.** `cycleShapes.ts` holds how each measure moves from 24 nights before
  a period to 10 after, averaged across the 42 people of mcPHASES (PhysioNet, 2025), whose daily
  hormone tests mark each cycle. Every night is scored by how well the nights around it match
  those shapes. Each measure is matched against its own shape, because each turns at its own
  moment, and the measures that move most count most.
- **One start per cycle.** Through each stretch of nights, the found starts are the chain of nights
  21 to 45 apart with the most score, gaps near the person's usual length preferred. A start in the
  last week shows only once the drop after it has. Found starts are moved by the person's own gap
  between their nights and their period once two starts are confirmed.
- **Only when they stand out.** With nothing logged, found starts are shown only when their mean
  score clears a bar set on simulated people without cycles. The simulation used the noise
  mcPHASES shows once its cycles are taken out, and the bar lets at most 1 in 20 such people see
  a cycle. A period logged within the nights shows there are cycles, and lifts the bar.
- **The second half's start** is counted back 11 days from the next start, the usual length of
  the second half in mcPHASES, which changes little from one cycle to the next. That lands within
  3 days of the hormone-marked day more often than matching the nights' shapes does: in 81% of
  mcPHASES's cycles against 77%, and 88% against 69% for the people held out. In the cycle under
  way, it's counted back from the day the next period is likely, once that day has come.
- **The next period** is a range from the last six cycles' lengths, once there are three. With two,
  it's an early guess: their lengths, two days wider either side.
- **How accurate.** `npm run eval:cycles` measures it on mcPHASES (see `scripts/cycle-eval`).
  With nothing logged, cycles show for 42% of people's three months of nights. 33% of period
  starts are found within 3 days and 36% within 5, and 77% of the starts shown are real. 81% of
  the finished cycles shown have their second half within 3 days of the one the hormone tests mark.
  Once the first period is logged, 68% of the later starts are found within 3 days and 80%
  within 5. With every period logged, 79% of second halves are within 3 days. A strong fever just
  after a period can pull a start a few days early.
- **Logs win.** A logged or confirmed start beats a found one nearby and counts twice as much in the
  typical cycle. Only logged periods have a length.
- **Older nights** come from history queries grouped by day, 240 days back.
- **Private by default.** With tracking off, the log stays on the server and nothing cycle-aware
  runs; the dataset carries only the setting, and whether a log is kept, so it can be deleted.
- **The page** (`src/views/CycleView.tsx`) shows only while tracking is on, which is a switch on
  the Settings page for anyone, whatever gender is set. `useCycle` holds the log for every screen: a
  change shows at once, is saved straight away, and is undone if the save fails.
- **Phases, not just a day.** The page leads with the phase (menstruation, follicular, ovulation,
  early or late luteal) and puts the day under it: "Day 22" when the start was logged, "About day
  22 ±3" with a "likely" tag when it was found. `pipeline/cyclePhases.ts` places each phase by
  cycle day and says how sure it is; `views/cycleColours.ts` draws it.
  - The strip, the bars and the calendar shade each day by its phase, blending over the days a
    boundary could fall on. A logged period's edge is sharp; a found period is a dimmer pink.
  - Ovulation is never measured: it is put the day before the luteal phase, counted back from the
    next period, and drawn as a small amber mark that fades over the days it could be.
  - A length with a found end carries ±3 days, with both ends found ±4.
  - The footer says the phases are estimates, so the page can't tell anyone when they're fertile.
- **Cards** (`insights/cards/cycle.ts`) run only while tracking is on:
  - a period due soon, from the person's own cycles;
  - a new cycle found in the nights (on Today only, for its first days);
  - shorter sleep before a period, the heart in the second half, and regular cycles, once enough
    cycles show them.

  The first two reach Today only when the person allows it on the Settings page.
- **Allowing for the cycle elsewhere**, only while tracking is on and "Allow for your cycle on other
  pages" (`otherPages`, on by default) is too. Turned off, the other pages read the nights as for
  someone who doesn't track cycles, and the Cycle page and its cards stay. `typicalShifts` measures how
  far the person's own temperature, resting heart rate and HRV move in the second half, once three
  cycles show it. `cycleAdjusted` moves each second-half night back by that much, in whole steps,
  into a copy of the days used only for judging. The cycle can explain a reading away, never add an
  alarm:
  - a Vitals card about an unusual night or week shows only if it also shows on the judged days;
  - several signals off (the illness card, the sick nights dipping leaves out) count only when
    they're off on both;
  - the strain radar counts a signal the cycle explains as in, and says so;
  - a pill that would call a reading unusual says "usual for this part of your cycle" instead, when
    the judged reading is usual.

  The body battery's score and every number shown stay the person's own readings.

`cycle.test.ts` holds it to both kinds of error on noisy nights: most starts found in people who
have cycles, and almost no cycle shown to people who don't.

## Goals

The step goal, the daily brisk minutes and the sleep need are the person's own, set on the Settings
page (`PUT /api/goals`) because Google Health doesn't share the goals set in Fitbit. They live in
`src/pipeline/goals.ts`, with the bounds each one is held to and the evidence for them; the server
stores them on `users`, sends them with the dataset, and rejects anything off its steps or out of
bounds. Every ring, goal line, label and insight reads them from there (the screens through
`useGoals`, the engine through `InsightOptions.goals`), so no screen repeats a goal as a literal.
Sleep need stays automatic, the median of your nights held between 7 and 8.5 hours, until it's
set; set, it replaces the estimate everywhere, the body battery included. The WHO's 150 minutes a
week is a guideline rather than a goal, so it's a constant beside them, not a setting.

## Type roles

Text is set in named roles from `src/index.css` (`text-caption`, `text-eyebrow`, `text-title`,
`text-number-lg` and so on), not in one-off pixel sizes. Each role carries its size, line height,
tracking and weight; an element's own `leading-*`, `tracking-*` or `font-*` class still wins.
Running text is DM Sans. Page titles, verdicts, card titles, big numbers and insights also take
`font-display`, which is Fraunces, so the face for those is `--font-display` and their roles, in
one file. The h and m of a big duration are set as units by `withUnits` in
`src/ui/primitives.tsx`. Chart ticks share `TICK` in `src/charts/index.tsx`, because SVG text
can't read the CSS tokens.

Every card's title is one of two kinds, each a single size everywhere. A glanceable card, a tile
read at a glance such as LAST NIGHT SLEEP or HRV, is named by an eyebrow: `card-title-glance`. A
detail card, such as Last 7 nights or Sleep architecture, has a title in the display face:
`card-title-detail`. `CardHead` sets the detail one; a card that draws its own head uses the class
directly. Colour is left to the card.

## Colours and themes

Classes take Tailwind's palette. Anything drawn in code (charts, the battery figure, glows,
inline styles) takes its colour from `src/theme.css` through `var(--name)`: the shades the
charts were drawn in, kept exact, and the grounds of the cards and panels that draw their own.
Greys come from the palette through its variables, such as `var(--color-zinc-400)`. Each page
keeps its colour in `DOMAIN` (`src/ui/primitives.tsx`), for its classes and its charts alike. A
test fails on any hex or `rgb()` written into the code; it names the two files allowed their
own: the Cycle page's phase colours, which are blended in code, and Google's G.

Everything is written for the dark theme, the default. The light one is the same names given
other values, under `:root[data-theme='light']` in `src/theme.css`: the greys flip, so text is
dark, and each colour takes its own family's darker shade, so it reads on white and every page
keeps its colour. The Cycle page's phase colours have a light set of their own in
`src/views/cycleColours.ts`.

Behind every page is a backdrop, slate: a CSS gradient drawn after a photograph, fixed to the
window under a veil in the theme's colour (`body::before`). Cards are glass over it: smoked in
dark, frosted white in light, with panels and rules in them as tints, so it shows through. Words
set straight on the backdrop, such as the date and a section's name, take `text-page-ink`, which
stays readable over it.

The theme is dark, light, or whichever the device is set to (`src/lib/theme.ts`), picked in the
Settings page's Account section. It's kept on the account (`users.theme`, set with
`PUT /api/theme` and sent with `/api/me`), so it follows the person to every device, and on the
device too, so `index.html` opens in it before anything else loads. `useTheme` puts it on the
page as `data-theme` and colours the browser's bar to match. In demo mode a choice lasts as long
as the demo.

## Languages

Every word the app shows comes from `src/locales/<tag>.json`, one file per language, in ICU
MessageFormat (`src/i18n/`). Numbers, dates, durations and lists are formatted by
`src/i18n/format.ts`, from each language's conventions.

- **The server sends codes, never words.** A sync error or a stream's problem reaches the browser
  as a code, and the app words it (`src/i18n/streams.ts`). The server bundle carries no language
  code at all.
- **The tests guard it.** They check that:
  - every message parses;
  - every language has English's keys and arguments;
  - no word on screen is written into the code, by scanning the source in `src/`;
  - every key is used.
- **`?lang=en-XA`** shows every message in brackets, so a word that bypasses the language file
  stands out.

## History queries

Insights that describe the past need days older than the window. Each page's cards declare what
they need as queries (`src/pipeline/history.ts`): a measure from a fixed list of daily values, how
to aggregate it (sum, count, mean, min, max, first, last), an optional grouping (day, month, ISO week,
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

## Demo mode

Demo mode runs the real pipeline in the browser, on a demo person (`src/pipeline/demo.ts`): a year
of made-up data from a watch and a scale.
- **Made up:** a seeded generator invents every number, so the demo is the same on every device.
- **Google-shaped:** its payloads are shaped like Google's, and the fixture server
  (`fixtures.ts`) serves them.
- **The server's steps:** `syncWithHistory` in `sync.ts` runs a first sync of the window, then the
  history backfill, into `MemoryStore`, just as the server does for a new account.
- **A pinned clock:** the clock and zone are pinned to the demo morning, so the cards are the
  same whenever the demo is opened.

`demo.test.ts` checks the demo stays useful: cards on every page, and something on every lab.

An install can hide demo mode with `DEMO_MODE=false`. The sign-in screen asks `GET /api/instance`,
the one API route that needs no session, whether to offer it. With no server behind it, as with
`npm run demo`, it offers it. The same route carries the install's own note for the sign-in
screen (`SIGN_IN_NOTE`), such as how to join. It's the one place an install's own words reach the
screen. The note is shown as text, with its email addresses and links made into links
(`src/lib/linkify.ts`), never as markup.

## Guarantees the tests hold

`src/pipeline/__tests__/incremental.test.ts`:

- a full sync followed by an incremental one shows exactly what a single full sync shows;
- a failed stream keeps its data, doesn't advance coverage, and converges on the next sync;
- revisions inside the refetch window are picked up;
- withdrawing a scope deletes that stream's data;
- per-stream storage reassembles exactly what normalising every stream at once produces, and
  survives a JSON round trip (as it must to live in Postgres);
- civil dates and minutes are correct across DST changes.

`src/pipeline/__tests__/sources.test.ts`:

- a day two sources reported keeps each one's reading, and the day's reading changes with the
  choice at once, with nothing fetched;
- a reading from another source is a fill, labelled with its source, and judged only against
  that source's earlier readings;
- the cycle finder leaves out a night here and there from another device, keeps a stretch on an
  old one, and reads each against its own;
- the kind of source for daily totals goes to Google with every rollup.

`src/pipeline/__tests__/normalize.test.ts`: a day comes out the same whatever order its readings
arrive in; a partial reading never wipes a complete one; two devices' copies of a night count once;
a night split by a long awakening is one night; a short night without metadata is still the night.
