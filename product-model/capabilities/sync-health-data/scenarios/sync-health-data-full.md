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
- text: The Product fetches the whole window for every stream, replaces what was stored for it, and finishes the synchronization.
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

# Fetch the whole window again

## Trigger

The person chooses Full sync on the status card in Settings.

## Outcome

The whole 62-day window is fetched again and replaces what was stored; older history stays.

## Edge cases

- A sync is also full without anyone asking: the first after sign-in, any sync when the last full one was more than seven days ago, and the first after an upgrade that changes how stored days are worked out. That last one also deletes the history before the window, and the history import fetches it again.
- A stream Healthier now fetches another way starts over on its own, history included, while the others sync as usual.
