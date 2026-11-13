---
kind: edge
routes:
  personal: Connected profile
steps:
- text: 'A full sync runs: the weekly one, the first after sign-in, or Full sync from Settings.'
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product starts the sync and asks Google for each stream's whole window, a daily total in date chunks of up to 14 days.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    from: Ready
    to: Running
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: Google answers one chunk of a daily total with an error and the others in full, so the Product stores the days of the complete chunks and leaves the failed chunk's days as they were.
  kind: product
  entities:
  - entity: health-day
    effect: changes
    facts:
    - Movement
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product marks that stream Failed with what Google answered and keeps its coverage where it was.
  kind: product
  entities:
  - entity: data-stream
    effect: changes
    facts:
    - Fetch detail
    from: Current
    to: Failed
  actor: person
  contexts:
    personal:
      place: web::personal::settings
- text: The Product stores the other streams as usual and completes the sync.
  kind: product
  entities:
  - entity: synchronization
    effect: changes
    facts:
    - Progress
    - Last sync
    from: Running
    to: Ready
  actor: person
  contexts:
    personal:
      place: web::personal::settings
references:
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#fetchStreamDays
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#settle
- kind: code
  role: implementation
  target: src/pipeline/transport.ts
- kind: code
  role: implementation
  target: server/repo.ts#writeStreams
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
---

# Keep what arrived when part of a stream fails

## Trigger

Google answers some of a daily total's date chunks with an error while the rest of the sync succeeds. A partial failure needs more than one 14-day chunk, so it mostly happens in a full sync.

## Outcome

Days from the complete chunks show their new readings and days from the failed chunk keep their earlier readings. The full sync still counts as done. The next ordinary sync only re-checks the last three days, so the failed chunk's days wait for the next full sync, usually a week later. The stream's Failed status clears on the next sync that fetches it without an error.

## Edge cases

- If the stream had no coverage yet, as in a first import, the next sync fetches the whole window again.
- A stream read as a list of readings replaces nothing unless its whole fetch succeeds.
- When every stream the sync attempted fails, nothing is stored and the sync reports Google's error instead.
