# Healthier

[![CI](https://github.com/cbukenya/healthier/actions/workflows/ci.yml/badge.svg)](https://github.com/cbukenya/healthier/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A personal health and fitness dashboard for your Google Health data, built to be self-hosted.

The server signs you in with Google, keeps your tokens encrypted in its own Postgres database,
and syncs your data in the background, so the dashboard opens on recent numbers. Nothing runs
on third-party infrastructure except Google's own APIs, which hold the data. There is no
telemetry.

**Intended purpose.** Healthier is a personal wellness and data-visualisation tool. It is not a
medical device: it does not diagnose, screen for, detect, monitor, prevent or treat any disease or
condition, and it must not be used to make medical decisions. Its insights describe changes in
your own data against your own usual ranges. If you have symptoms or concerns, talk to a clinician.

The first sign-in imports the last 62 days (the window every baseline and insight is computed
over) before the dashboard opens. Older history, up to two years by default, then imports in the
background for the 90-day, 1-year and All views. After that, each sync fetches only the last few
days.

## Self-hosting

Requires Docker with Compose, and a Google OAuth client of your own (next section). You don't
need to clone the repository:

```sh
mkdir healthier && cd healthier
curl -fsSLO https://raw.githubusercontent.com/cbukenya/healthier/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/cbukenya/healthier/main/.env.example -o .env
# edit .env: Google client ID/secret, ENCRYPTION_KEY, POSTGRES_PASSWORD
docker compose up -d
```

Open http://localhost:3000 and choose **Connect Google Account**; the first account to sign in is
created on the spot. If a required setting is missing, the app container exits and
`docker compose logs app` lists what to set.

**Upgrading:** `docker compose pull && docker compose up -d`. Database migrations run on start.
To control when upgrades happen, pin `HEALTHIER_VERSION` in `.env` to a
[release](https://github.com/cbukenya/healthier/releases) and change it deliberately.

**Backups:** your data is in the `db-data` Docker volume.
`docker compose exec db pg_dump -U healthier healthier > backup.sql` dumps it. Keep
`ENCRYPTION_KEY` safe as well: without it, stored Google tokens can't be read and everyone has to
sign in again.

**Demo mode** on the sign-in screen shows bundled sample data through the same pipeline as live
data, without signing in.

## Setting up Google access

Each install needs its own OAuth client in a Google Cloud project you own:

1. Create a project in the [Google Cloud console](https://console.cloud.google.com).
2. **APIs & Services → Library**: enable the **Google Health API**.
3. **Google Auth Platform** (formerly "OAuth consent screen"):
   - **Branding**: choose **External**, set the app name and support email.
   - **Data access**: add `openid`, `email`, `profile`,
     `googlehealth.activity_and_fitness.readonly`, `googlehealth.sleep.readonly`,
     `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.nutrition.readonly`,
     `googlehealth.ecg.readonly`, `googlehealth.irn.readonly`.
   - **Audience**: while in **Testing**, add each Google account that will sign in as a test user.
4. **Clients → Create client**: type **Web application**, with `<APP_URL>/auth/callback` as an
   authorized redirect URI, e.g. `http://localhost:3000/auth/callback`.
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

**Who can sign up.** Signing in creates the account; there is no separate registration. Who gets
that far depends on the OAuth app's status:

- **Testing**: only its test users, and Google expires their access every 7 days, after which the
  app asks them to reconnect.
- **In production, unverified**: anyone with a Google account, after an "unverified app" warning.
  Google caps unverified apps at 100 users, and access no longer expires weekly. Set
  `ALLOWED_EMAILS` so only the people you choose can join.
- **Verified**: no cap. The Google Health scopes are restricted, so verification includes an annual
  third-party security assessment; see [Google's app verification guide](https://developers.google.com/health/app-verification).
  A personal or family install doesn't need it.

## Configuration

All settings are environment variables, read from `.env`. [`.env.example`](.env.example) is the
reference.

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID from Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret. |
| `ENCRYPTION_KEY` | yes | Encrypts Google tokens at rest. `openssl rand -base64 32`. |
| `POSTGRES_PASSWORD` | yes, with compose | Password for the bundled Postgres. `openssl rand -hex 24`. |
| `DATABASE_URL` | outside compose | Postgres connection string. Compose sets it for you. |
| `ALLOWED_EMAILS` | no | Who may sign up: addresses and/or `@domain` entries. Empty admits anyone Google lets through. |
| `HEALTHIER_VERSION` | no | Image tag to run. Default `latest`. |
| `PORT` | no | Port the app is reachable on. Default `3000`. |
| `BIND_ADDRESS` | no | Interface the port is published on. Default `0.0.0.0`; `127.0.0.1` behind a local proxy. |
| `APP_URL` | no | Public URL users open. Default `http://localhost:$PORT`. |
| `SYNC_INTERVAL_MINUTES` | no | Background sync interval per user. Default `60`; `0` turns it off. |
| `HISTORY_DAYS` | no | Days of daily history kept and imported per user. Default `730` (62–3650). |

## Running behind a domain

Put a TLS-terminating reverse proxy (Caddy, Traefik, nginx, or a Cloudflare Tunnel) in front of
the app, then:

- set `APP_URL=https://your.domain`, and add `https://your.domain/auth/callback` as a redirect URI
  on the OAuth client;
- set `BIND_ADDRESS=127.0.0.1` if the proxy runs on the same machine. Ports published by Docker
  bypass host firewalls such as `ufw`, so otherwise the app is also reachable over plain HTTP.

Session cookies are marked `Secure` automatically when `APP_URL` is https.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the release process. In short:

```sh
npm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres on localhost:5432
npm run dev        # http://localhost:3000 with hot reload; reads .env
npm test
```

### How it fits together

- `server.ts` and `server/`: Express app. Google OAuth (`auth.ts`), sign-up control (`access.ts`),
  the JSON API (`api.ts`), background sync (`sync.ts`), Postgres access and migrations (`db.ts`,
  `repo.ts`).
- `src/pipeline/`: fetches and normalises Google Health data and derives the insights.
  `incremental.ts` is the sync engine: what to fetch, and how per-stream daily rows are stored and
  reassembled. It runs on the server for live data and in the browser for demo mode.
- `src/`: the React dashboard.

How it works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

Planned work is tracked as [milestones](https://github.com/cbukenya/healthier/milestones) on GitHub.
Ideas and bug reports are welcome as [issues](https://github.com/cbukenya/healthier/issues).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[GNU Affero General Public License v3.0](LICENSE). You may use, modify and self-host Healthier
freely. If you run a modified version as a service for others, you must make your source code
available to its users under the same license.
