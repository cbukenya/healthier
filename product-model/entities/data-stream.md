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

- **Reading** — The category, whether it is read as daily totals or as a list of readings, and whether it arrives daily or only now and then.
- **Latest day** — The newest day with a reading. For a list it can be older than the window, since a list's first page can reach back past it.
- **Coverage** — Days with readings across the selected span.
- **Fetch detail** — The last fetch's requests, pages, time taken, sources and any error Google gave, and whether a list stopped at its page limit.
- **Shared** — Whether the category was granted through Google consent.

## States

### Nothing recorded

Shared and fetched without an error, with no latest day.

### Current

The last fetch worked and there is a latest day, recent enough for a daily stream or of any age for an occasional one.

### Behind

A daily stream whose latest day is three or more days before today. It is worked out from today's date each time the status is read, so a stream turns Behind as days pass, with or without a sync.

### Not shared

Healthier was not given access to this reading when the person connected Google, so it does not ask for it.

### Failed

Google answered the last fetch with an error, or refused it (the list reads No access), whether or not older readings remain.
