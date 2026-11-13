---
references:
- kind: code
  role: implementation
  target: server/sync.ts#accessToken
- kind: code
  role: implementation
  target: server/auth.ts#authRoutes
---

# Google connection

The person’s connection used to read Google Health, including between visits.

## Information kept

- **Shared categories** — Health categories granted through Google consent.
- **Available** — Whether Healthier has usable ongoing Google access.

## States

### Connected

Ongoing access is available.

### Reconnect required

Google refused to renew access, so Healthier deleted the Google tokens it held. Access comes back only when the person signs in with Google again.
