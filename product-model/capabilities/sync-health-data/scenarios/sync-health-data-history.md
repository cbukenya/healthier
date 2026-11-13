---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: A sync has stored the window, and some streams' stored history doesn't yet reach back as far as the host's history setting.
  kind: condition
  entities: []
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The Product imports older days one stream at a time, back to the history setting, and shows the import as running in Settings.
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

A sync has stored the window and some streams' history doesn't yet reach back to the history setting (730 days by default). It follows every such sync, whether a visit or the schedule started it, and keeps running on the server after the tab is closed.

## Outcome

Older days are imported back to the history setting, and Settings shows the history as complete. A stream whose import failed waits until after the next sync to try again, and Settings says the history is incomplete and retrying.

## Edge cases

- A stream read as a list, such as sleep or the food log, stops after 40 pages: 1,000 sleep sessions, or 4,000 entries of other lists. If it stops there, the import still counts as complete, and older entries of that stream are never imported.
- While cycle tracking is on, the import also works out each night's sleeping heart rate floor, back to the oldest stored sleep, a fortnight at a time.
- Imports run one person at a time across the server.
