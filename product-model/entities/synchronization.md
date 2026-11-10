---
references:
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
- kind: code
  role: implementation
  target: server/sync.ts#syncStatus
- kind: code
  role: implementation
  target: src/views/DataStatus.tsx#StatusCard
---

# Synchronization

The synchronization progress and history import status shown for a profile.

## Information kept

- **Progress** — Streams completed and total streams while fetching.
- **Last sync** — Last completed sync time, duration and request count.
- **Failure** — The latest whole-sync failure, if any.
- **Window** — The 62-day dashboard date range.
- **History** — Oldest stored day, whether older history is importing, and whether import is complete.

## States

### Waiting

No recent-window import is available yet.

### Running

A sync is fetching the recent window.

### Ready

A recent-window import is available.

### Failed

A sync failed; any earlier usable data remains.
