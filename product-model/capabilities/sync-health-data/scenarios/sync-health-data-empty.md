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
- text: A full sync succeeds for a stream and finds no readings in the window, so the Product marks it as having nothing recorded.
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
    to: Nothing recorded
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

# Mark a stream with nothing recorded

## Trigger

Google has no readings of a stream in the window.

## Outcome

The stream reads Nothing recorded: none of the person's devices record it, or nothing has been logged.
