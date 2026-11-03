---
appliesTo:
- type: entity
  id: installation
- type: entity
  id: synchronization
references:
- kind: code
  role: implementation
  target: server/sync.ts#startScheduler
- kind: code
  role: implementation
  target: server/sync.ts#backfillUser
---

# Background sync follows the host interval

An interval of zero stops scheduled refreshes; visits and explicit sync still work. Connected admitted users are processed in turn. Older history follows successful window syncs, one stream at a time, and a failed extension retries after a later sync.
