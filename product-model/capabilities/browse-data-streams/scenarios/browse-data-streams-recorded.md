---
kind: primary
routes:
  personal: Connected profile
  public: Demo mode
steps:
- text: The person opens the list of streams in Settings and picks a span.
  kind: actor
  entities:
  - entity: data-stream
    effect: reads
    facts: &id001
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
  - entity: heart-rate-day
    effect: reads
    facts: &id002
    - Date
    - Readings
  actor: person
  contexts:
    personal:
      place: web::personal::data-streams
    public:
      place: web::public::data-streams
- text: The Product shows each stream as a block a day, week or month, with its latest day, its sources and the requests and result of its last fetch; minute heart rate also shows its coverage hour by hour.
  kind: product
  entities:
  - entity: data-stream
    effect: reads
    facts: *id001
  - entity: heart-rate-day
    effect: reads
    facts: *id002
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

# Read each stream's coverage and last fetch

## Trigger

The person opens the list of streams in Settings.

## Outcome

The person can see what arrived, from where, and what Google answered on the last fetch.
