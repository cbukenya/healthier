---
availability:
- place: web::personal
references:
- kind: code
  role: implementation
  target: server/sync.ts#startSync
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#syncIncremental
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
---

# Sync health data

Import the recent 62-day window, re-check the last three days on every sync, fetch the whole window again on a full sync, and import older history in the background once the window is stored.
