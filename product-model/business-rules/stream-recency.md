---
appliesTo:
- type: entity
  id: data-stream
references:
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#streamKind
---

# Only daily streams become behind after three days

Not shared takes precedence over a failed fetch, and a failed fetch over how recent the latest reading is. A shared stream fetched successfully with no latest day has nothing recorded. A daily stream whose latest day is three or more days old is behind; this is worked out from today's date whenever the status is read, not set by a sync. Occasional streams such as weight never become behind with age.
