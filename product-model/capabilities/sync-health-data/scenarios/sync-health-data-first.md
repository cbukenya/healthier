---
kind: primary
routes:
  personal: Connected profile
steps:
- text: The person signs in with Google for the first time.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product creates their profile, with default goals, cycle settings and source settings, and opens the dashboard.
  kind: product
  entities:
  - entity: profile
    effect: creates
    facts:
    - Origin
    - Gender
    - Theme
  - entity: goals
    effect: creates
    with: profile
    facts:
    - Steps
    - Brisk minutes
    - Sleep need
    - Protein
    - Fibre
    - Water
  - entity: cycle-settings
    effect: creates
    with: profile
    facts:
    - Tracking
    - Today cards
    - Other pages
    - Log kept
  - entity: source-settings
    effect: creates
    with: profile
    facts:
    - Order
    - First choices
    - Totals
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product starts a full sync of the 62-day window and shows its progress, stream by stream, in place of the dashboard.
  kind: product
  entities:
  - entity: synchronization
    effect: creates
    facts: &id001
    - Progress
    - Last sync
    - Failure
    - Window
    - History
    to: Running
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product stores the recorded days, the sources it saw, the person's age and height, and each stream's state. A stream for a category the person didn't share starts as Not shared; the others start as Current, or Nothing recorded when the window has no readings of them.
  kind: product
  entities:
  - entity: health-day
    effect: creates
    facts:
    - Date
    - Movement
    - Vitals
    - Body
    - Logged
    - Notifications
    - Zones
    - Sources
    - Sleeping heart rate floor
  - entity: sleep-session
    effect: creates
    facts:
    - Date
    - Kind
    - Timing
    - Duration
    - Stages
    - Efficiency
    - Source
  - entity: heart-rate-day
    effect: creates
    facts:
    - Date
    - Readings
  - entity: data-stream
    effect: creates
    facts:
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    to: Current
  - entity: data-source
    effect: creates
    facts:
    - Name
    - Last seen
    - Readings
    - Included
  - entity: profile
    effect: changes
    facts:
    - Age
    - Height
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product finishes the window and presents Today, then starts importing older history in the background.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts: *id001
    from: Running
    to: Ready
  actor: person
  contexts:
    personal:
      place: web::personal::today
references:
- kind: code
  role: implementation
  target: server/auth.ts#authRoutes
- kind: code
  role: implementation
  target: server/sync.ts#startSync
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
- kind: code
  role: implementation
  target: server/repo.ts#usersDueForSync
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#syncIncremental
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
---

# Import the first recent window

## Trigger

A person signs in with Google for the first time.

## Outcome

The 62-day window is imported in a full sync before the dashboard is shown; older history follows in the background.

## Edge cases

- The import doesn't need the dashboard to stay open. When background sync is on, the schedule picks up a connected person who has never synced, so someone who signs in and closes the tab still gets it.
- Sign-in always asks for a full sync, so signing in again later fetches the whole window again too.
