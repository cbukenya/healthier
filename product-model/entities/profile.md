---
relations:
- entity: goals
  verb: keeps
  cardinality: one-to-one
- entity: cycle-settings
  verb: keeps
  cardinality: one-to-one
- entity: source-settings
  verb: keeps
  cardinality: one-to-one
- entity: synchronization
  verb: keeps
  cardinality: one-to-one
- entity: health-day
  verb: keeps
  cardinality: one-to-many
- entity: sleep-session
  verb: keeps
  cardinality: one-to-many
- entity: heart-rate-day
  verb: keeps
  cardinality: one-to-many
- entity: data-stream
  verb: keeps
  cardinality: one-to-many
- entity: data-source
  verb: keeps
  cardinality: one-to-many
references:
- kind: code
  role: implementation
  target: server/sync.ts#loadDataset
- kind: code
  role: implementation
  target: src/App.tsx#App
- kind: code
  role: implementation
  target: src/pipeline/demo.ts#buildDemoPayloads
---

# Profile

The health profile being explored: the person’s own connected profile or the temporary demonstration profile.

## Information kept

- **Origin** — Connected Google Health data or Demo data.
- **Age** — Age supplied by Google Health, when shared.
- **Height** — Latest supplied height, when available.
- **Gender** — Optional female, male or other choice, or no selection.
- **Theme** — Dark, light or device preference; dark is the default.
