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
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#fetchStreamPoints
- kind: code
  role: implementation
  target: src/pipeline/transport.ts#HealthTransport
---

# Daily history and minute history have different retention

Daily history follows the host’s 62–3650 day setting, default 730: every sync drops stored days older than that. Minute heart rate is kept for the 62-day window only.

When an upgrade changes how stored days are worked out, the next sync is a full sync that keeps only the 62-day window and deletes every older stored day; the dashboard opens on the window, and the history import then fetches the older days again. A single stream that Healthier now fetches another way (the food log moved from daily totals to a list of meals) starts over on its own, history included, without the others.

A stream read as a list can hold less history than the setting allows. Google's list has no date filter, so Healthier pages back from today and stops after 40 pages: 1,000 sleep sessions, or 4,000 entries of any other list. Sleep and the food log can reach that well inside two years, with naps, a second device or many food entries a day. If the import stops there, it still counts as complete, and older entries of that stream are never imported.
