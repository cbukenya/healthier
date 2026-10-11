# Security policy

Healthier stores Google access to people's health data, so security reports are taken seriously
and handled privately.

## Reporting a vulnerability

Please **do not open a public issue**. Report it through
[GitHub private vulnerability reporting](https://github.com/cbukenya/healthier/security/advisories/new).
Include what you found, how to reproduce it, and the version (image tag or commit) affected.

You can expect an acknowledgement within a week. Once a fix is released, the advisory is published
with credit to you, unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release. Self-hosters should keep up with releases
(`docker compose pull && docker compose up -d`).

## Particularly sensitive areas

- Google OAuth: the sign-in flow, state handling and token refresh (`server/auth.ts`, `server/google.ts`)
- Token encryption at rest (`server/crypto.ts`)
- Session handling and access checks (`server/auth.ts`, `server/access.ts`)
- Anything that could expose one user's data to another (`server/api.ts`, `server/repo.ts`)
