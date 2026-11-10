---
kind: edge
routes:
  personal: Connected profile
  public: Demo mode
steps:
- text: The person opens the list of streams in Settings.
  kind: actor
  entities: []
  actor: person
  contexts:
    personal:
      place: web::personal::data-streams
    public:
      place: web::public::data-streams
- text: The Product marks a stream with nothing recorded, one Healthier was not given access to, and one whose last fetch failed, each with what to do next.
  kind: product
  entities:
  - entity: data-stream
    effect: reads
    facts:
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
  - entity: heart-rate-day
    effect: reads
    facts:
    - Date
    - Readings
  actor: person
  contexts:
    personal:
      place: web::personal::data-streams
    public:
      place: web::public::data-streams
references:
- kind: code
  role: implementation
  target: src/views/DataStreams.tsx#DataStreams
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#streamKind
---

# Tell nothing recorded from not shared and failed

## Trigger

Some streams have no readings.

## Outcome

Nothing recorded, Not shared and Failed are told apart, so a reading the person chose not to share is never shown as a failure.
