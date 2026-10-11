# Contributing

Thanks for helping. Bug reports, fixes and new insights are all welcome.

## Development setup

Requires Node.js 22+ and Docker. You also need a Google OAuth client (see the README) to sign in
with real data; **Demo mode** works without one.

```sh
npm install
cp .env.example .env    # fill in the required values
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres on localhost
npm run dev             # http://localhost:3000, hot reload
```

Checks that CI runs on every pull request:

```sh
npm run typecheck
npm test                # runs in UTC, the zone the fixtures assume
npm run build
```

To build and run the Docker image from your checkout instead of a published release:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Ground rules

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first if you're changing sync or storage.

- **Insights must be accurate.** Changes to how data is normalised or interpreted need tests, and
  new insights should cite the research behind them.
- **Changing normalisation means bumping `PIPELINE_VERSION`** in `src/pipeline/incremental.ts`.
  Stored data was produced by the old code; the bump makes every install rebuild it.
- **Migrations are append-only.** Add a new entry in `server/db.ts`; never edit one that has been
  released, because installs that already ran it won't run it again.
- **No telemetry, no third-party calls** beyond Google's APIs.
- **Never commit secrets or health data**, including in test fixtures.

## Pull requests

Keep them focused, describe what and why, and make sure CI is green. Squash-merged PR titles become
the release notes, so write them for users.

## Releasing (maintainers)

Releases are cut from `main` by pushing a version tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The Release workflow runs CI, publishes `ghcr.io/cbukenya/healthier:0.2.0`, `:0.2` and `:latest`
for amd64 and arm64, and creates a GitHub release with generated notes. Use semantic versioning;
call out database migrations and `PIPELINE_VERSION` bumps in the release notes, since those make
upgrades take longer.

## License

Healthier is licensed under the [GNU AGPL-3.0](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.
