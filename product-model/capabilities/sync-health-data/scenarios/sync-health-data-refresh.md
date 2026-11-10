---
kind: primary
routes:
  personal: Connected profile
steps:
- text: The person requests a refresh.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product starts or joins the running synchronization.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    - Failure
    from: Ready
    to: Running
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product stores the successfully fetched observations and completes the synchronization.
  kind: product
  entities:
  - entity: health-day
    effect: changes
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
    effect: changes
    facts:
    - Date
    - Kind
    - Timing
    - Duration
    - Stages
    - Efficiency
    - Source
  - entity: heart-rate-day
    effect: changes
    facts:
    - Date
    - Readings
  - entity: data-stream
    effect: changes
    facts:
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    from: Current
    to: Current
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    - Last sync
    - Failure
    - Window
    - History
    from: Running
    to: Ready
  actor: person
  contexts:
    personal:
      place: web::personal::settings
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

# Refresh stored readings

## Trigger

The person requests refresh or returns to data older than 15 minutes.

## Outcome

Successful date ranges replace their corresponding readings; the latest three days are normally re-fetched.

## Edge cases

- A refresh already running is joined rather than duplicated.
- A stale visit shows the existing dataset while refresh runs.
