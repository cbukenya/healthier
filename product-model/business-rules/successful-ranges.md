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

A fully failed date range retains its prior readings. Successful rollup chunks may replace their own ranges even when another chunk fails. Overall stream coverage advances only when the stream succeeds, leaving failed work retryable. A window run in which every attempted stream fails is reported as a whole-run failure before its output is stored.
