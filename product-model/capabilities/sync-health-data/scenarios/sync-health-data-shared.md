---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: The person syncs after allowing the reading on Google’s consent screen.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product fetches the newly allowed reading and shows its latest day.
  kind: product
  entities:
  - entity: data-stream
    effect: changes
    facts:
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
    from: Not shared
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

# Start reading a newly shared stream

## Trigger

A reading Healthier was not given access to is allowed on a later sign-in.

## Outcome

The stream is read on every sync from then on and shows its readings.
