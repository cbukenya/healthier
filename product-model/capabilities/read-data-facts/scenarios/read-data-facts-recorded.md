---
kind: primary
routes:
  personal: Connected profile
  public: Demo mode
steps:
- text: The person opens Data facts in Settings.
  kind: actor
  entities:
  - entity: synchronization
    effect: reads
    facts: &id001
    - Window
    - History
  actor: person
  contexts:
    personal:
      place: web::personal::data-facts
    public:
      place: web::public::data-facts
- text: The Product explains the recent analysis window, retained history, usual ranges, absent readings and the meaning of one-minute averages.
  kind: product
  entities:
  - entity: synchronization
    effect: reads
    facts: *id001
  actor: person
  contexts:
    personal:
      place: web::personal::data-facts
    public:
      place: web::public::data-facts
references:
- kind: code
  role: implementation
  target: src/views/DataCards.tsx#DataFacts
---

# Read how the numbers are worked out

## Trigger

The person opens Data facts.

## Outcome

The section explains plain arithmetic, usual ranges, the window and history, blank days and one-minute averages, with this person's own window and history dates.
