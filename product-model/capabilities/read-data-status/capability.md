---
availability:
- place: web::personal
- place: web::public
references:
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#dataStatus
- kind: code
  role: implementation
  target: src/views/DataStatus.tsx#StatusCard
---

# Read data status

Read where the person's data stands at the top of Settings: whether Google access has expired, the last sync failed, history is still arriving, some readings failed or stopped arriving, or everything is up to date.
