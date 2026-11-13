---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The scheduled refresh is due.
  kind: condition
  entities: []
  unattended: true
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
  contexts:
    personal:
      place: web::personal::settings
- text: The Product refreshes stored measurements and completes the synchronization.
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

# Refresh between visits

## Trigger

The host's sync interval (60 minutes by default) has passed since a connected, admitted person's last sync, or they have never synced, or an upgrade changed how stored days are worked out. The server checks every five minutes.

## Outcome

Recent readings are refreshed without a browser being open, one person at a time; the sync is a full one when the last full sync was more than seven days ago. The history import follows it.

## Edge cases

- With an interval of zero, nothing is scheduled; a sync runs only when the person opens Healthier or asks for one.
