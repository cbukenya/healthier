---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The person chooses Retry.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product retries the synchronization.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    from: Failed
    to: Running
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product stores successful observations and completes the synchronization.
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
  - entity: data-stream
    effect: changes
    facts:
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    from: Failed
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

# Retry a failed synchronization

## Trigger

The person chooses Retry.

## Outcome

The failure remains visible while retry runs and is cleared when the import succeeds.
