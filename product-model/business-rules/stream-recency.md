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

Not shared takes precedence over a failed fetch, and a failed fetch over how recent the latest reading is. A shared stream fetched successfully with no latest reading has nothing recorded. Occasional streams such as weight do not become behind solely with age.
