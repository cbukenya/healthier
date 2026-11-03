---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: Successful synchronization advances the retention boundary.
  kind: condition
  entities:
  - entity: synchronization
    effect: reads
    facts:
    - Progress
    - Last sync
    - Failure
    - Window
    - History
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The Product removes expired observations.
  kind: product
  entities:
  - entity: health-day
    effect: removes
  - entity: sleep-session
    effect: removes
  - entity: heart-rate-day
    effect: removes
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

# Remove data beyond retention

## Trigger

A successful sync advances the retained date range.

## Outcome

Daily data older than the configured history span and minute heart rate older than 62 days are removed.
