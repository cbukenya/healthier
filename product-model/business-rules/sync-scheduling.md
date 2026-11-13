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
- kind: code
  role: implementation
  target: server/repo.ts#usersDueForSync
---

# Background sync follows the host interval

Every five minutes the server looks for people who are due: connected to Google and admitted, and never synced, last synced longer ago than the host's interval (60 minutes by default), or stored by older code after an upgrade. It syncs them one at a time. An interval of zero stops scheduled syncs; opening the app, coming back to it, Full sync and Retry still sync.

The history import follows every sync that stored the window, whether a visit or the schedule started it, and whatever the interval. It runs one stream at a time and one person at a time across the server, and a stream that fails waits until after the next sync to try again.
