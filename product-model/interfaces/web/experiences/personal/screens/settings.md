---
entities:
- entity: synchronization
  shows:
  - Progress
  - Last sync
  - Failure
  - Window
  - History
- entity: data-stream
  shows:
  - Reading
  - Latest day
  - Coverage
  - Fetch detail
  - Shared
references:
- kind: code
  role: implementation
  target: src/views/DataStatus.tsx#StatusCard
---

# Settings

The Settings page: where the person's data stands (sync status, the window, history import and the last sync) above its sections: Devices and sources, Data streams, Goals, Cycle tracking, Data facts and Account.
