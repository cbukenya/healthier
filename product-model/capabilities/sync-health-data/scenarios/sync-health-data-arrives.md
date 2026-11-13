---
kind: alternate
routes:
  personal: Connected profile
steps:
- text: 'A sync runs after the device has recorded the stream again: the person opens Healthier, comes back to it, or the schedule starts one.'
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

The status leaves Behind as soon as a sync stores a newer reading. Only the last three days fill in by themselves, because earlier syncs already settled the older days of the gap while they were empty. Those wait for the next full sync, at most a week away, or a Full sync from Settings.
