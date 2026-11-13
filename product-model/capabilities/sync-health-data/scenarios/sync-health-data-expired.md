---
kind: edge
routes:
  personal: Connected profile
steps:
- text: A sync, started by a visit or the schedule, needs a new access token, and Google refuses to renew it.
  kind: condition
  entities: []
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The Product deletes the Google tokens it held and reports the sync as failed because access expired.
  kind: product
  entities:
  - entity: google-connection
    effect: changes
    facts:
    - Available
    from: Connected
    to: Reconnect required
  - entity: synchronization
    effect: changes
    facts:
    - Failure
    from: Ready
    to: Failed
  contexts:
    personal:
      place: web::personal::settings
references:
- kind: code
  role: implementation
  target: server/sync.ts#startSync
- kind: code
  role: implementation
  target: server/sync.ts#syncUserLocked
- kind: code
  role: implementation
  target: src/pipeline/incremental.ts#syncIncremental
- kind: code
  role: implementation
  target: src/hooks/useHealth.ts#useHealth
---

# Ask to reconnect expired Google access

## Trigger

Google refuses renewal because access has expired or been revoked.

## Outcome

The person must sign in with Google again. The next time they open Healthier, the sign-in screen says Google access has expired, in place of the dashboard; if it happens while the app is open, the app reloads into that screen. Until they sign in, the schedule skips them, since no tokens remain. Everything already stored stays.

## Edge cases

- The Settings status card has an expired state, but people hardly ever see it, because the app shows the sign-in screen instead.
