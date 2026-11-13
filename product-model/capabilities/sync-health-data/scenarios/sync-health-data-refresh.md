---
kind: primary
routes:
  personal: Connected profile
steps:
- text: The person opens Healthier, or comes back to its tab more than 15 minutes after the last sync.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::today
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
      place: web::personal::today
- text: The Product fetches each stream's last three days, or from the day after its settled days if those end earlier, stores what arrived and completes the synchronization.
  kind: product
  entities:
  - entity: health-day
    effect: changes
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

# Refresh stored readings

## Trigger

The person opens Healthier, or comes back to its tab, and the last sync was more than 15 minutes ago. Settings has no refresh button; its status card offers Full sync, Retry or Sign in again.

## Outcome

Each stream fetches the last three days, today included, or from the day after its settled days if those end earlier, and the days that arrived replace what was stored. Days before that aren't fetched again until the next full sync.

## Edge cases

- A sync already running is joined rather than duplicated.
- The stored dashboard stays on screen while the sync runs.
- Opening Healthier within 15 minutes of the last sync shows what is stored and fetches nothing.
