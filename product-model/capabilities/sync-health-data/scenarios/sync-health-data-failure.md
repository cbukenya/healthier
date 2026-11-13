---
kind: edge
routes:
  personal: Connected profile
steps:
- text: 'A sync runs: the person opens Healthier, comes back to it, chooses Full sync or Retry, or the schedule starts one.'
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product starts the synchronization.
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
- text: The Product reports the failed synchronization and keeps the earlier records.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    - Failure
    from: Running
    to: Failed
  - entity: health-day
    effect: reads
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

# Retain the dashboard after failed refresh

## Trigger

Every attempted request is rejected, or refresh fails before usable results are stored.

## Outcome

Nothing from the failed sync is stored. With a dashboard already stored, it stays on screen, and the Settings status card says when Healthier last synced, with the reason and Retry. Before the first import has finished, the app shows the reason and Retry in place of the dashboard.
