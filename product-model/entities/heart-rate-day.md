---
references:
- kind: code
  role: implementation
  target: src/pipeline/intraday.ts
- kind: code
  role: implementation
  target: src/views/HeartRateCard.tsx#HeartRateCard
---

# Heart rate day

Minute-level heart rate available for one civil day.

## Information kept

- **Date** — Civil day in the person’s zone.
- **Readings** — Timestamped one-minute average heart rates and their gaps.
