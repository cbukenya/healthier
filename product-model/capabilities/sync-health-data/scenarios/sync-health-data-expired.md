---
kind: edge
routes:
  personal: Connected profile
steps:
- text: A background refresh needs renewed Google access.
  kind: condition
  entities: []
  unattended: true
  contexts:
    personal:
      place: web::personal::settings
- text: The Product marks the Google connection as requiring reconnection and reports synchronization failure.
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

The person must sign in with Google again to renew consent; until then, background sync stops for them.
