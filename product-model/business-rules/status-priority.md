---
appliesTo:
- type: entity
  id: synchronization
- type: entity
  id: data-stream
references:
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#dataStatus
---

# Overall status reports the first actionable data condition

Reconnection precedes whole-sync failure, then active history import, failed streams and delayed daily streams. Current status does not assert that every category has readings or is shared.
