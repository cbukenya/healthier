---
appliesTo:
- type: entity
  id: health-day
- type: entity
  id: heart-rate-day
- type: entity
  id: synchronization
references:
- kind: code
  role: implementation
  target: server/config.ts#loadConfig
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
- kind: code
  role: implementation
  target: server/repo.ts#applySyncOutput
---

# Daily history and minute history have different retention

Daily history follows the host’s 62–3650 day setting, default 730. Minute heart rate remains within the 62-day window. A processing-version change rebuilds retained processed data before presenting current results.
