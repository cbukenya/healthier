# Contributing

Thanks for helping. Healthier is meant to be built in the open, by people who look at their own
data and ask better questions of it. Bug reports, fixes, new insights, labs and translations are
all welcome.

## Ways to help

- **Report what's wrong or unclear.** Use the bug template. The Settings page shows which streams
  arrived and from where, and that often explains a lot. Never paste health data, tokens or your
  `.env`.
- **Insight cards:** check the arithmetic behind a card, make its words clearer, or add one. See
  [Insight cards](#insight-cards).
- **Labs:** improve an experiment, or bring a new one. See [Labs](#labs).
- **Translations:** see [Translations](#translations).
- **Docs:** if something here or in the README tripped you up, a fix is welcome.

Not sure where to start? Open an issue and describe what you'd like to do.

## Development setup

Requires Node.js 22+ and Docker. You also need a Google OAuth client (see the README) to sign in
with real data; **Demo mode** works without one.

```sh
npm install
cp .env.example .env    # fill in the required values
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db   # Postgres on localhost
npm run dev             # http://localhost:3000, hot reload
```

For work on the dashboard alone, `npm run demo` serves it without the server, database or Google
account. Choose **Demo mode** on the sign-in screen. The demo person is a year of made-up data,
written in `src/pipeline/demo.ts`.

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
- **Arithmetic, not guesswork.** Every score and insight is worked out from the person's own data,
  the same way every time, and can be traced back to the readings behind it. No AI writes or
  guesses anything shown.
- **Measure changes to cycle detection.** If you change `src/pipeline/cycle.ts`, `cycleShapes.ts`
  or `sleepHrFloor.ts`, run `npm run eval:cycles` before and after, and put both results in the
  pull request (see `scripts/cycle-eval/README.md`). It needs the mcPHASES data from PhysioNet. If
  you can't get it, say so and a maintainer will run it.
- **Changing normalisation means bumping `PIPELINE_VERSION`** in `src/pipeline/incremental.ts`.
  Stored data was produced by the old code; the bump makes every install rebuild it.
- **Migrations are append-only.** Add a new entry in `server/db.ts`; never edit one that has been
  released, because installs that already ran it won't run it again.
- **No medical claims.** Healthier is a wellness tool, not a medical device. Copy describes what was
  observed against the person's own usual range, with everyday explanations. It never names a
  condition, presents a card as screening or detection, or reads as an all-clear. It points to a
  clinician only alongside symptoms.
- **Every word on screen comes from the language file** (see [Translations](#translations)).
- **No telemetry, no third-party calls** beyond Google's APIs.
- **Never commit secrets or health data**, including in test fixtures and screenshots. Take
  screenshots in demo mode.

## Insight cards

Cards are written in `src/pipeline/insights/cards/`, with one file per page: `activity.ts`,
`sleep.ts`, `vitals.ts` and `body.ts`.
- `today.ts` holds the cards that only make sense on Today, such as the body battery, the weekly
  review and Labs reminders.
- `floors.ts` writes the card a carousel shows when nothing else has anything to say.

A card is a function. It reads the day grid in its context (`ctx.days`, oldest first, ending
today). When its condition holds, it adds a finding: its words from the language file, and the
fields the engine uses to place it:

- `importance`, from 0 to 100, which orders cards.
- `topic`: only one card per topic shows.
- `family`: good news never shows beside a cautious card from its family.
- `today`: whether it may reach Today for as long as it's true (`while-true`), only while it's news
  (`as-news`), or never (`never`).
- `news`: true only when its condition started in the last couple of days. The "yesterday test" in
  `helpers.ts` (`entered`, `freshEntry`) works this out.
- `claims` and `advice`, for the conflict rules: no metric is claimed both ways, and no push sits
  beside rest.

The engine (`insights/engine.ts`) runs every card, settles conflicts (`conflicts.ts`) and places
each finding in exactly one carousel (`place.ts`). The comment at the top of `engine.ts` explains
the vocabulary.

When you add or change a card:

- **Write plain sentences, with the numbers inside them:** "You slept 7h 58m, 41 minutes more than
  you need", not shorthand like "52/100 · vs usual".
- **Read goals from `ctx.goals`,** never as literals.
- **For days older than the 62-day window,** declare a history query beside the card, as
  `bodyQueries` does. `src/pipeline/history.ts` lists what can be asked.
- **Cite the research** behind a threshold in a comment beside it, and in the pull request.
- **Test it** in `src/pipeline/__tests__/pipeline.test.ts`: build the days that should fire it,
  and the days that shouldn't.
- **See it in place** with `npm run demo`. If the demo person should show it, change
  `src/pipeline/demo.ts` so they do.

## Labs

Labs are experiments, and the place for new ideas about what our data can show. A lab lives in
three places:
- **Arithmetic:** a pure function in `src/pipeline/labs.ts`. It takes the days (and minute heart
  rate, if it needs it) and returns a status with its figures.
- **Card:** in `src/views/LabsView.tsx`.
- **Words:** in the `labs` section of the language file, including its "How it works": what it
  watches, when it lights up, and where its thresholds come from.

A good lab:

- compares the person with their own usual range where it can, worked out from days before the ones
  it judges, and says where any fixed threshold comes from;
- says plainly what it watched and what it found, without naming a condition or reading as
  screening or an all-clear;
- handles missing data: too few nights reads as "collecting", never as "nothing found";
- has tests in `src/pipeline/__tests__/labs.test.ts`, edge cases included.

A lab can start rough. Say what's uncertain in its "How it works", and cite what it builds on.
Being open is what lets it get better. To talk an idea through before writing code, open an issue
with the **Insight or lab idea** template.

## Translations

Every word Healthier shows lives in `src/locales/`, with one JSON file per language. The guide for
translators is [src/locales/README.md](src/locales/README.md). In short:

1. Copy `en-US.json` to a file named by the language's tag, such as `sv-SE.json`.
2. Translate the values. Keep the keys, every `{argument}` and every `<tag>`.
3. Add the file to `LOCALES` in `src/i18n/index.ts`.
4. Run `npm test`. Then run `npm run demo` and add `?lang=sv-SE` to the address to read it in
   place.

Messages use ICU MessageFormat, so plurals and word order follow each language's own rules. To
say you're working on a language, open an issue with the **Translation** template, so nobody
translates it twice.

**Writing code that shows words?** Add them to `en-US.json` and read them with `t()`, or `rich()`
for styled words. Numbers, dates, durations and lists go through `src/i18n/format.ts`, so they
follow each language's conventions. The tests fail when:

- a word on screen is written into the code;
- a key in the language file isn't used anywhere;
- a language is missing a key that English has, or a message takes different arguments.

`?lang=en-XA` shows English with every message in ⟦brackets⟧, so any word outside brackets
doesn't come from the language file yet.

## Pull requests

Keep them focused, describe what and why, and make sure CI is green. Add screenshots from demo
mode for anything visible. Squash-merged PR titles become the release notes, so write them for
users.

## Releasing (maintainers)

Releases are cut from `main` by pushing a version tag on it. A tag on any other commit fails
before anything is published:

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
