---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: Older history is due after the recent window completes.
  kind: condition
  entities: []
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The Product imports older recorded days and sleep sessions and updates synchronization history progress.
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
  - entity: synchronization
    effect: changes
    facts:
    - History
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

# Extend older history after the window

## Trigger

A successful recent-window sync has left older history to import.

## Outcome

Older daily readings extend toward the configured retention date; a failed stream extension waits for the next sync to retry.
