---
references:
- kind: code
  role: implementation
  target: src/lib/dataStatus.ts#streamKind
- kind: code
  role: implementation
  target: src/views/DataStreams.tsx#DataStreams
---

# Data stream

One category of Google Health readings and its visible delivery status for this profile.

## Information kept

- **Reading** — The category and its daily or occasional nature.
- **Latest day** — Latest day with an observation.
- **Coverage** — Days with readings across the selected span.
- **Fetch detail** — Latest request counts, elapsed time, source descriptions and reported error.
- **Shared** — Whether the category was granted through Google consent.

## States

### Nothing recorded

Shared and fetched, with no recorded observation.

### Current

Readings arrived without a current fetch failure or daily delay.

### Behind

A daily stream’s latest observation is at least three days old.

### Not shared

Healthier was not given access to this reading when the person connected Google, so it does not ask for it.

### Failed

The latest fetch failed, whether or not older readings remain.
