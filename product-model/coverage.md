---
scope: 'A first slice: sync and data freshness in the Healthier server and browser dashboard (background and on-request sync, history import and retention, partial failures, expired Google access, and the Settings views of data status, data streams and data facts), checked against main at 045ffebc29db5ace6371acda98a52c2c73d2eb8f (v0.11.0).'
method: Static inspection of the tracked source, product documentation and selected tests.
covered:
- description: Server sync jobs, the background scheduler, history import and token refresh, and the storage calls they make.
  paths:
  - server/sync.ts
  - server/repo.ts
- description: The incremental sync engine that fetches each stream in date chunks or pages, keeps failed ranges from replacing stored days and assembles days.
  paths:
  - src/pipeline/incremental.ts
  - src/pipeline/transport.ts
  - src/pipeline/sync.ts
- description: Which streams exist, which are read as daily totals or as lists, and which arrive only now and then (only that part of registry.ts), and the minute heart rate kept for the window (only its storage, not its charts).
  paths:
  - src/pipeline/registry.ts
  - src/pipeline/intraday.ts
- description: The signed-in check and sign-in's request for a full sync (only those parts of auth.ts), and the sync and dataset routes (only those parts of api.ts).
  paths:
  - server/auth.ts
  - server/api.ts
- description: Browser sync state and the Settings views of data status, data streams and data facts (only the data facts part of DataCards.tsx).
  paths:
  - src/hooks/useHealth.ts
  - src/lib/dataStatus.ts
  - src/views/DataStatus.tsx
  - src/views/DataStreams.tsx
  - src/views/DataCards.tsx
exclusions:
- description: Build, packaging and deployment tooling; these are contributor operations rather than dashboard behavior.
  paths:
  - package.json
  - docker-compose.yml
  - docker-compose.dev.yml
  - .github/
  - Dockerfile
- description: Visual assets and rendering primitives; layout and styling are outside product meaning.
  paths:
  - public/
  - src/index.css
  - src/theme.css
  - src/ui/
  - src/views/silhouettes.ts
  - src/views/cycleColours.ts
unmapped:
- description: Sign-in, admission, the account, host settings and the HTTP routes beyond what sync needs.
  paths:
  - server/access.ts
  - server/config.ts
  - server/google.ts
  - server/http.ts
  - server/db.ts
  - server/crypto.ts
  - server.ts
- description: The browser shell, and the page views and hooks other than those above, including Today, sleep, activity, vitals, body, nutrition, cycle, Labs and Devices and sources.
  paths:
  - src/App.tsx
  - src/views/
  - src/components/
  - src/charts/
  - src/hooks/
- description: Pipeline code other than the sync engine above, such as normalization, source selection, derived scores, insights, nutrition, cycles, Labs and the demo data.
  paths:
  - src/pipeline/
- description: Date, theme and sign-in note helpers, and the shared health and API types.
  paths:
  - src/lib/
  - src/types/
- description: Translation tooling and the served English words.
  paths:
  - src/i18n/
  - src/locales/
- description: The page the browser loads first.
  paths:
  - index.html
limitations: []
---

# Coverage
