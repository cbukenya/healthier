# Languages

Every word Healthier shows lives in this folder, one file per language. `en-US.json` is English,
and the reference for every other language. Keys are grouped by where the words appear: the tab,
then the card, then the string (`sleep.debt.title`).

## Adding a language

Open an issue with the **Translation** template first, so nobody translates the same language
twice.

1. Copy `en-US.json` to a file named by the language's tag, such as `sv-SE.json`.
2. Translate the values. Keep the keys, and keep every `{argument}` and `<tag>` as it is: translate
   the words around them, in whatever order your language needs.
3. Add the file to `LOCALES` in `src/i18n/index.ts`.
4. Run `npm test`. It checks that the file has every key English has and no others, that each
   message takes the same arguments, and that it parses.

The app follows the browser's language, falling back to English. `?lang=sv-SE` in the address
forces one. To read a translation in place without setting anything up, run `npm run demo`, open
the address it prints with `?lang=sv-SE` added, and choose **Demo mode**. `?lang=en-XA` shows English with every message in ⟦brackets⟧, so any word on screen
outside brackets is one that doesn't come from this folder yet.

## How messages work

Messages are [ICU MessageFormat](https://formatjs.github.io/docs/core-concepts/icu-syntax/):

- `{date}` is filled in by the app: a number, a date already written out, a name.
- `{count, plural, one {# night} other {# nights}}` picks the form for the number; `#` is the number.
  Use your language's own plural forms (`zero`, `one`, `two`, `few`, `many`, `other`), and `=0` for
  a wording of its own for zero.
- `{trend, select, up {…} down {…} other {…}}` picks wording by a value. Translate each branch;
  keep the values (`up`, `down`, `other`) as they are.
- `<b>…</b>` and other tags mark styled words. Keep each tag around the words it styles.
- A straight apostrophe right before `{`, `}` or `#` starts ICU quoting: write it as ’ instead.

The `format` section holds the language's conventions: month and weekday names, the order of day,
month and year, the clock, how durations and lists are written. Numbers follow the language's
decimal mark and digit grouping on their own.
