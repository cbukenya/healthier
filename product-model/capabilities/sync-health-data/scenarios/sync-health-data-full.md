---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The person chooses Full sync.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product starts a full synchronization.
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
- text: The Product refreshes the recent records and finishes the synchronization.
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

# Rebuild the recent window

## Trigger

The person chooses Full sync.

## Outcome

The whole 62-day window is re-fetched. Older history stays unless a changed processing version requires rebuilding it too.
