---
references:
- kind: code
  role: implementation
  target: src/pipeline/sleep.ts#parseSleepSession
- kind: code
  role: implementation
  target: src/pipeline/sleep.ts#combineSleepPoints
---

# Sleep session

A recorded main sleep or nap, preserved with its timing and available stages.

## Information kept

- **Date** — Day the main sleep ends, or the day a nap starts.
- **Kind** — Main sleep or nap.
- **Timing** — Bedtime and wake time.
- **Duration** — Minutes asleep, awake and in bed; onset latency when supplied.
- **Stages** — Light, deep, REM and awake stages and short awakenings, when available.
- **Efficiency** — Share of time in bed spent asleep.
- **Source** — Device or app supplying this session.
