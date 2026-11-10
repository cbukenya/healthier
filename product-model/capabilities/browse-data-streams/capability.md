---
availability:
- place: web::personal
- place: web::public
references:
- kind: code
  role: implementation
  target: src/views/DataStreams.tsx#DataStreams
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#streamKind
---

# Browse data streams

Inspect every supported category, its coverage, sources and last fetch result over the selected span.
