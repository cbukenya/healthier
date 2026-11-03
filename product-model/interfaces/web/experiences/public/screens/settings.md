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

The Settings page in Demo mode, with the demo person's sync status above its sections.
