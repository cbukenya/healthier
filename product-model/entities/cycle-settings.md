---
references:
- kind: code
  role: implementation
  target: src/pipeline/cycle.ts#DEFAULT_CYCLE_SETTINGS
- kind: code
  role: implementation
  target: src/views/DataCards.tsx#CycleCard
---

# Cycle settings

The person’s choices about cycle tracking and where its effects appear.

## Information kept

- **Tracking** — Off initially; enables cycle calculations and the Cycle page.
- **Today cards** — Whether cycle reminders may appear on Today; initially on.
- **Other pages** — Whether other pages allow for the person’s cycle; initially on.
- **Log kept** — Whether logged days or rejected starts remain available to delete.
