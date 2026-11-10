---
references:
- kind: code
  role: implementation
  target: server/sync.ts#describeSources
- kind: code
  role: implementation
  target: src/pipeline/sources.ts#sourceOrders
---

# Data source

A device or app identified among the profile’s stored readings.

## Information kept

- **Name** — Device, app or platform description.
- **Last seen** — Most recent day supplied by this source.
- **Readings** — Reading categories supplied, days offered and days selected in the recent window.
- **Included** — Whether its individual readings are included in source selection.

