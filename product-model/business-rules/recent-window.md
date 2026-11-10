---
appliesTo:
- type: entity
  id: health-day
references:
- kind: code
  role: implementation
  target: src/ui/span.tsx#useSpan
- kind: code
  role: implementation
  target: server/sync.ts#loadDataset
---

# Current judgements use the recent window

The dashboard’s analysis window is 62 civil days ending on the person’s today. Longer selected history changes descriptive views and historical records, not current baselines or readiness.
