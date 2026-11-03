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
- text: New readings arrive for a daily stream that was behind, and the Product shows its latest day again.
  kind: product
  entities:
  - entity: data-stream
    effect: changes
    facts:
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    from: Behind
    to: Current
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

# A stream that was behind catches up

## Trigger

A daily stream had nothing for three days or more, and the device records it again.

## Outcome

Its status returns from Behind; Healthier asks for it on every sync, so it fills in with no action needed.
