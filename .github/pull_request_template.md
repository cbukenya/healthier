## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] Words on screen come from `src/locales/en-US.json`, not the code
- [ ] New or changed insight cards and labs read as plain sentences, make no medical claims, and cite their evidence
- [ ] Changes to normalisation (`registry.ts`, `normalize.ts`, sleep parsing) bump `PIPELINE_VERSION`
- [ ] Database changes are a new migration in `server/db.ts`, not an edit to an existing one
- [ ] New settings are documented in `.env.example` and the README
- [ ] Screenshots of visible changes come from demo mode, never real health data
