---
kind: primary
routes:
  personal: Connected profile
steps:
- text: The person opens the connected dashboard.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product creates the connected profile and starts the recent-window import.
  kind: product
  entities:
  - entity: profile
    effect: creates
    facts:
    - Origin
    - Age
    - Height
    - Gender
    - Theme
  - entity: goals
    effect: creates
    with: profile
    facts:
    - Steps
    - Brisk minutes
    - Sleep need
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
  - entity: synchronization
    effect: creates
    with: profile
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
- text: The Product stores recorded days and available source descriptions.
  kind: product
  entities:
  - entity: health-day
    effect: creates
    facts:
    - Date
    - Movement
    - Vitals
    - Body
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
  actor: person
  contexts:
    personal:
      place: web::personal::today
- text: The Product finishes the window and presents Today.
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
  target: server/sync.ts#startSync
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#syncIncremental
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
---

# Import the first recent window

## Trigger

A connected person first opens Healthier.

## Outcome

The recent 62-day import completes before the dashboard is shown; older retained history follows in the background.
