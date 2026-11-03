---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The person syncs again.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: A daily stream still has nothing three days after its latest reading, so the Product marks it behind.
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

# Mark a daily stream as behind

## Trigger

A daily stream's latest reading is three or more days old.

## Outcome

The stream reads Nothing since its latest date; occasional streams such as weight never fall behind with age.
