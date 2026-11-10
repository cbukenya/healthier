---
scope: 'A first slice: sync and data freshness in the Healthier server and browser dashboard (background and on-request sync, history import and retention, partial failures, expired Google access, and the Settings views of data status, data streams and data facts), at 74b02a122410b81b6aee92f2d2954abbde64fd2b.'
method: Static inspection of the pinned tracked source, product documentation and selected tests.
covered:
- description: Server sync jobs, the background scheduler, history import and token refresh, and the storage calls they make.
  paths:
  - server/sync.ts
  - server/repo.ts
- description: The incremental sync engine that fetches each stream in date chunks, keeps failed ranges retryable and assembles days.
  paths:
  - src/pipeline/incremental.ts
  - src/pipeline/transport.ts
  - src/pipeline/sync.ts
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
  - server/auth.ts
  - server/access.ts
  - server/api.ts
  - server/config.ts
  - server/google.ts
  - server/http.ts
  - server/db.ts
  - server/crypto.ts
  - server.ts
- description: The browser shell, and the page views and hooks other than those above, including Today, sleep, activity, vitals, body, cycle, Labs and Devices and sources.
  paths:
  - src/App.tsx
  - src/views/
  - src/components/
  - src/charts/
  - src/hooks/
- description: Pipeline code other than the sync engine above, such as normalization, source selection, derived scores, insights, cycles, Labs and the demo data.
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
- description: Browser installation prompts and native browser gestures.
  paths:
  - public/manifest.webmanifest
  - index.html
limitations: []
---

# Coverage
