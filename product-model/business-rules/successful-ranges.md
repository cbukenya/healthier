---
appliesTo:
- type: entity
  id: data-stream
- type: entity
  id: health-day
references:
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#fetchStreamDays
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#settle
- kind: code
  role: implementation
  target: server/repo.ts#writeStreams
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
---

# Only successful fetched ranges replace readings

A date range that failed keeps its earlier readings. A daily total is fetched in chunks of up to 14 days, and each chunk that arrived complete replaces its own days even when another chunk failed. A stream read as a list replaces nothing unless its whole fetch succeeded.

A stream's coverage moves only when its whole fetch succeeds. That doesn't mean the failed days are fetched again on the next sync: an ordinary sync only re-checks the last three days after the settled ones, so days from a failed chunk inside settled coverage wait for the next full sync. The history import is the exception: its coverage stays put on a failure, so the next import after a sync asks for the same days again.

When every stream a sync attempted fails, nothing is stored, and the sync reports Google's error as a whole-sync failure.
