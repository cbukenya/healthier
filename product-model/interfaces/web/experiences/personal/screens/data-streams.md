---
entities:
- entity: data-stream
  shows:
  - Reading
  - Latest day
  - Coverage
  - Fetch detail
  - Shared
- entity: heart-rate-day
  shows:
  - Date
  - Readings
references:
- kind: code
  role: implementation
  target: src/views/DataStreams.tsx#DataStreams
---

# Data streams

Every stream Healthier reads from Google Health, a block per day, week or month of coverage, with its latest day, where it came from and what happened on its last fetch.
