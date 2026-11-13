---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: A sync stores its results, and the history setting's oldest day has moved on.
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
- text: The Product removes stored days older than the history setting, and minute heart rate older than the window.
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

A sync stores its results.

## Outcome

Daily data older than the history setting (730 days by default) and minute heart rate older than the 62-day window are removed.

## Edge cases

- The first sync after an upgrade that changes how stored days are worked out removes everything older than the 62-day window. The history import brings the older days back afterwards.
