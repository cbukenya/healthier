---
references:
- kind: code
  role: implementation
  target: src/types/health.ts
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#assembleDays
---

# Health day

The health measurements associated with one civil day, with absent readings kept distinct from zero.

## Information kept

- **Date** — Civil day of the readings.
- **Movement** — Steps, distance, floors, energy, active minutes and zone minutes, when recorded.
- **Vitals** — Resting and non-REM heart rate, HRV, deep-sleep HRV, HRV entropy, breathing, oxygen, skin-temperature deviation and cardio fitness, when recorded.
- **Body** — Weight and body-fat percentage, when recorded.
- **Logged** — Food eaten (energy, protein, carbohydrate, fat, fibre when the app records it, and each meal's time and amounts), water and blood glucose, when logged.
- **Notifications** — Count of device irregular rhythm notifications, when recorded.
- **Zones** — Heart-rate zone bounds supplied for the day.
- **Sources** — Source of each selected reading and whether another source filled it.
- **Sleeping heart rate floor** — Derived nightly tenth-percentile heart rate, kept while cycle tracking is on.
