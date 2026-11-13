---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The person signs in with Google again without allowing a reading they had shared, and the full sync that follows runs.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product marks the data stream unshared and removes its affected readings.
  kind: product
  entities:
  - entity: data-stream
    effect: changes
    facts:
    - Shared
    - Coverage
    - Fetch detail
    - Latest day
    from: Current
    to: Not shared
  - entity: health-day
    effect: changes
    facts:
    - Movement
    - Vitals
    - Body
    - Logged
    - Notifications
    - Zones
    - Sources
  - entity: sleep-session
    effect: removes
  - entity: heart-rate-day
    effect: removes
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

# Remove readings for a withdrawn category

## Trigger

A new consent result no longer shares a previously read category.

## Outcome

The category reads Not shared, and every stored day of it is removed, history included; other categories remain. Withdrawing heart rate also removes the minute heart rate, and withdrawing the profile or height removes the age or height.
