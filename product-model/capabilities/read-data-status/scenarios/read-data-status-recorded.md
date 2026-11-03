---
kind: primary
routes:
  personal: Connected profile
  public: Demo mode
steps:
- text: The person opens Settings.
  kind: actor
  entities:
  - entity: synchronization
    effect: reads
    facts: &id001
    - Progress
    - Last sync
    - Failure
    - Window
    - History
  - entity: data-stream
    effect: reads
    facts: &id002
    - Reading
    - Latest day
    - Coverage
    - Fetch detail
    - Shared
  actor: person
  contexts:
    personal:
      place: web::personal::settings
    public:
      place: web::public::settings
- text: The Product reports reconnection first, then whole-sync failure, active history import, failed streams, delayed daily streams, or current data.
  kind: product
  entities:
  - entity: synchronization
    effect: reads
    facts: *id001
  - entity: data-stream
    effect: reads
    facts: *id002
  actor: person
  contexts:
    personal:
      place: web::personal::settings
    public:
      place: web::public::settings
references:
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#dataStatus
- kind: code
  role: implementation
  target: src/views/DataStatus.tsx#StatusCard
---

# Read where the data stands

## Trigger

The person opens Settings.

## Outcome

Only the first thing worth saying is shown: Google access has expired, the last sync failed, history is on its way, some readings couldn't be fetched, some haven't come in for days, or the data is up to date.
