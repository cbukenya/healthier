---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: Three days pass since a daily stream's latest day, whether or not a sync runs.
  kind: condition
  entities: []
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The next time the status is read, the Product shows the stream as behind, working it out from today's date and the stream's latest day.
  kind: product
  entities:
  - entity: data-stream
    effect: changes
    facts:
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    from: Current
    to: Behind
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

# Mark a daily stream as behind

## Trigger

A daily stream's latest reading is three or more days old.

## Outcome

The stream reads Nothing since its latest date. Behind isn't set by a sync, so a stream turns Behind as days pass even when no sync runs. Occasional streams such as weight never fall behind with age.
