---
references:
- kind: code
  role: implementation
  target: src/pipeline/goals.ts#DEFAULT_GOALS
- kind: code
  role: implementation
  target: src/hooks/useGoals.tsx#GoalsProvider
---

# Goals

Personal targets used throughout the dashboard.

## Information kept

- **Steps** — Daily step target, initially 10000.
- **Brisk minutes** — Daily brisk-minute target, initially 30.
- **Sleep need** — Nightly minutes the person sets, or Auto, worked out from their recent nights; initially Auto.
