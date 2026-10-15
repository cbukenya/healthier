import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { parse } from '@babel/parser';
import { IntlMessageFormat } from 'intl-messageformat';
import enUS from '../../locales/en-US.json';
import { DEFAULT_LOCALE, ICU, LANGUAGES, PSEUDO, names, pickLocale, setLocale, t, type Element } from '..';
import {
  bucketLabel, capitalize, durationPieces, formatCivil, formatCivilLong, formatCivilNumeric, formatCivilYear, formatClock,
  formatDuration, formatFixed, formatHour, formatHours, formatHoursDecimal, formatList, formatMinutes, formatMonth,
  formatMonthYear, formatNumber, formatRounded, formatThousands, formatYear, meanLabel,
} from '../format';
import { INTRADAY_HEART_RATE, STREAMS } from '../../pipeline/registry';
import { scanFiles, scanSource, sourceFiles } from './scan';

const ROOT = join(import.meta.dirname, '../../..');

/** Every message and list in a language file, by key. */
function leaves(tree: unknown, prefix = ''): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || Array.isArray(v)) out.set(key, v as string | string[]);
    else for (const [kk, vv] of leaves(v, key)) out.set(kk, vv);
  }
  return out;
}

/** What a message takes from the code: its arguments, its tags, and the values each select chooses between. */
function shapeOf(source: string, lang: string) {
  const args = new Set<string>();
  const tags = new Set<string>();
  const selects = new Map<string, Set<string>>();
  const walk = (els: Element[]) => {
    for (const el of els) {
      if (el.type === ICU.tag) tags.add(el.value as string);
      else if (el.type !== ICU.literal && el.type !== ICU.pound) args.add(el.value as string);
      if (el.type === ICU.select) {
        const keys = selects.get(el.value as string) ?? new Set<string>();
        for (const k of Object.keys(el.options!)) keys.add(k);
        selects.set(el.value as string, keys);
      }
      if (el.children) walk(el.children);
      if (el.options) for (const o of Object.values(el.options)) walk(o.value);
    }
  };
  walk(new IntlMessageFormat(source, lang).getAst() as Element[]);
  return { args, tags, selects };
}

/**
 * Arguments the code passes that English doesn't use, for a language that writes things another
 * way: a 12-hour clock with its am/pm.
 */
const SUPPLIED: Record<string, string[]> = {
  'format.time.clock': ['hours12', 'period'],
  'format.time.hour': ['hours12', 'period'],
};

const LOCALE_FILES = Object.fromEntries(
  LANGUAGES.map((l) => [l, JSON.parse(readFileSync(join(ROOT, 'src/locales', `${l}.json`), 'utf8'))]),
);
const english = leaves(enUS);

/** Files whose words haven't moved to the language file yet. */
const PENDING = new Set<string>([
  'src/charts/heartRate.ts',
  'src/hooks/useHealth.ts',
  'src/lib/api.ts',
  'src/pipeline/incremental.ts',
  'src/pipeline/insights/floors.ts',
  'src/pipeline/insights/helpers.ts',
  'src/pipeline/insights/patterns.ts',
  'src/pipeline/insights/rules/activity.ts',
  'src/pipeline/insights/rules/body.ts',
  'src/pipeline/insights/rules/sleep.ts',
  'src/pipeline/insights/rules/today.ts',
  'src/pipeline/insights/rules/vitals.ts',
  'src/pipeline/intraday.ts',
  'src/pipeline/labs.ts',
  'src/pipeline/normalize.ts',
  'src/pipeline/transport.ts',
  'src/views/BodyView.tsx',
  'src/views/HeartRateCard.tsx',
  'src/views/LabsView.tsx',
  'src/views/VitalsView.tsx',
]);

/** Files whose words are never the app's own: data, and notes for developers. */
const NOT_SHOWN: Record<string, string> = {
  'src/pipeline/registry.ts':
    "English stream labels and notes for developers and server logs; the app names streams from the language file's streams section",
  'src/pipeline/fixtures.ts': "demo data, shown the way a person's own data is: device names, as their data would carry them",
};

describe('language files', () => {
  it('parse as ICU MessageFormat, every message in every language', () => {
    for (const [lang, file] of Object.entries(LOCALE_FILES)) {
      for (const [key, v] of leaves(file)) {
        if (typeof v !== 'string') continue;
        assert.doesNotThrow(() => new IntlMessageFormat(v, lang), `${lang} ${key}`);
      }
    }
  });

  it('have the keys and lists English has, and take what the code passes', () => {
    for (const [lang, file] of Object.entries(LOCALE_FILES)) {
      const theirs = leaves(file);
      assert.deepEqual([...theirs.keys()].sort(), [...english.keys()].sort(), `${lang} has the keys English has, and no others`);
      for (const [key, en] of english) {
        const v = theirs.get(key)!;
        if (Array.isArray(en)) {
          assert.equal((v as string[]).length, en.length, `${lang} ${key} names as many as English`);
          continue;
        }
        const want = shapeOf(en, 'en');
        const got = shapeOf(v as string, lang);
        const allowed = new Set([...want.args, ...(SUPPLIED[key] ?? [])]);
        const unknown = [...got.args].filter((a) => !allowed.has(a));
        assert.deepEqual(unknown, [], `${lang} ${key} uses only the arguments the code passes`);
        assert.deepEqual([...got.tags].sort(), [...want.tags].sort(), `${lang} ${key} keeps English's tags`);
        // The code passes a select's values; a translation that renames them never matches.
        for (const [arg, keys] of want.selects) {
          assert.deepEqual([...(got.selects.get(arg) ?? [])].sort(), [...keys].sort(), `${lang} ${key} chooses {${arg}} by English's values`);
        }
      }
    }
  });

  it("use apostrophes as letters, never as ICU's quote marks", () => {
    // In ICU an apostrophe before { } # or | starts a quoted run, and swallows what follows: write ’.
    for (const [lang, file] of Object.entries(LOCALE_FILES)) {
      for (const [key, v] of leaves(file)) {
        if (typeof v === 'string') assert.doesNotMatch(v, /'[{}#|']/, `${lang} ${key}`);
      }
    }
  });

  it('name every data stream the app syncs, and no others', () => {
    const synced = [...STREAMS.map((s) => s.dataType), INTRADAY_HEART_RATE.dataType];
    assert.deepEqual(Object.keys(enUS.streams).sort(), synced.sort());
  });

  it('are used: every key in the English file is named somewhere in the code', () => {
    const literals = new Set<string>();
    const prefixes: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const n = node as { type?: string; value?: unknown; quasis?: { value: { cooked: string } }[] };
      if (n.type === 'StringLiteral') literals.add(n.value as string);
      // A key put together at run time, such as `streams.${dataType}`, covers every key under its prefix.
      if (n.type === 'TemplateLiteral' && n.quasis![0].value.cooked.endsWith('.')) prefixes.push(n.quasis![0].value.cooked);
      for (const [k, v] of Object.entries(n)) if (k !== 'loc' && k !== 'leadingComments' && k !== 'trailingComments') walk(v);
    };
    for (const f of sourceFiles(ROOT, 'src')) {
      const source = readFileSync(join(ROOT, f), 'utf8');
      walk(parse(source, { sourceType: 'module', plugins: f.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] }).program);
    }
    const unused = [...english.keys()].filter((k) => !literals.has(k) && !prefixes.some((p) => k.startsWith(p)));
    assert.deepEqual(unused, []);
  });
});

describe('the code', () => {
  it('says nothing in words of its own: every word a person sees comes from the language file', () => {
    const files = sourceFiles(ROOT, 'src').filter((f) => !f.startsWith('src/i18n/') && !(f in NOT_SHOWN) && !PENDING.has(f));
    const found = scanFiles(ROOT, files).map((f) => `${f.file}:${f.line} ${f.kind}: ${f.text}`);
    assert.deepEqual(found, []);
  });

  it('keeps the server free of languages: it sends codes, and the app says them', () => {
    const out = buildSync({
      entryPoints: [join(ROOT, 'server.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      metafile: true,
      write: false,
      logLevel: 'silent',
    });
    const inputs = Object.keys(out.metafile.inputs);
    assert.deepEqual(inputs.filter((p) => /src\/(i18n|locales)\//.test(p)), []);
    const imports = Object.values(out.metafile.inputs).flatMap((i) => i.imports.map((x) => x.path));
    assert.ok(!imports.includes('intl-messageformat'), 'intl-messageformat is a dev dependency, not shipped to the server');
  });

  it('is checked by a scanner that finds words where they hide', () => {
    const src = [
      `import { formatCivil } from '../i18n/format';`,
      `const a = 'Two words';`,
      `const b = <p className="text-zinc-500 flex">Hi</p>;`,
      `const c = <i aria-label="Close" title={t('app.name')} />;`,
      `const d = <b>{n === 1 ? 'night' : \`\${n} nights\`}</b>;`,
      `const e = t('app.name');`,
      `if (kind === 'Some Kind') console.log('Debug words here');`,
      `const f = formatCivil('2026-08-18');`,
      `const g = ['Sign-in', 'failed'];`,
      `throw new Error('Sync failed');`,
      `const h = new DOMException('Aborted', 'AbortError');`,
    ].join('\n');
    const found = scanSource('x.tsx', src).map((f) => `${f.line} ${f.kind} ${f.text}`);
    assert.deepEqual(found, [
      '2 string Two words',
      '3 jsx-text Hi',
      '4 attribute Close',
      '4 module-t t()',
      '5 rendered night',
      '5 rendered § nights',
      '6 module-t t()',
      '8 module-t formatCivil()',
      '9 string Sign-in',
      '10 string Sync failed',
    ]);
  });
});

describe('formatting in English', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('writes dates and times the way the app always has', () => {
    assert.equal(formatCivil('2026-08-18'), '18 Aug');
    assert.equal(formatCivilYear('2025-03-02'), '2 Mar 2025');
    assert.equal(formatCivilLong('2026-08-18'), 'Tue 18 Aug');
    assert.equal(formatCivilNumeric('2026-06-02'), '2026-06-02');
    assert.equal(formatYear('2026-06-02'), '2026');
    assert.equal(formatMonthYear('2026-10-14'), 'October 2026');
    assert.equal(formatMonth('2026-09', '2026-10-14'), 'September');
    assert.equal(formatMonth('2025-03', '2026-10-14'), 'March 2025');
    assert.equal(bucketLabel('2026-10-01', 'month'), 'Oct 26');
    assert.equal(bucketLabel('2026-10-05', 'week', 'full'), 'Week of 5 Oct 2026');
    assert.equal(meanLabel('day', 7), '7-day mean');
    assert.equal(meanLabel('week', 4), '4-week mean');
    assert.equal(formatClock(117), '01:57');
    assert.equal(formatClock(1440 + 30), '00:30', 'past midnight wraps');
    assert.equal(formatHour(7), '07');
  });

  it('writes durations the way the app always has', () => {
    assert.equal(formatDuration(479.6), '8h 00m');
    assert.equal(formatDuration(-95), '−1h 35m');
    assert.equal(formatDuration(65, { signed: true }), '+1h 05m');
    assert.equal(formatMinutes(25), '25m');
    assert.equal(formatMinutes(-25, { signed: true }), '−25m');
    assert.equal(formatMinutes(0, { signed: true }), '+0m');
    assert.equal(formatHours(420), '7h');
    assert.equal(formatHours(437.5), '7h 18m');
    assert.equal(formatHoursDecimal(60), '1 hour');
    assert.equal(formatHoursDecimal(180), '3.0 hours');
    assert.equal(formatHoursDecimal(216), '3.6 hours');
  });

  it('writes numbers with the language’s grouping and decimals', () => {
    assert.equal(formatNumber(1234.5, 1), '1,234.5');
    assert.equal(formatNumber(52, 1), '52.0');
    assert.equal(formatRounded(52.04), '52');
    assert.equal(formatRounded(52.06), '52.1');
    assert.equal(formatRounded(10234, 0), '10,234');
    // 7.05 is stored as 7.0499…: toFixed rounds that down, toLocaleString rounds "7.05" up.
    assert.equal(formatFixed(423 / 60, 1), (423 / 60).toFixed(1));
    assert.equal(formatNumber(423 / 60, 1), (423 / 60).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    assert.equal(formatFixed(1234.5, 1), '1,234.5');
    assert.equal(formatThousands(7500), '7.5k');
    assert.equal(formatThousands(10000), '10k');
  });

  it('joins lists with commas and a final "and" or "or", and capitalises one that opens a sentence', () => {
    assert.equal(formatList([]), '');
    assert.equal(formatList(['a']), 'a');
    assert.equal(formatList(['a', 'b']), 'a and b');
    assert.equal(formatList(['a', 'b', 'c', 'd']), 'a, b, c and d');
    assert.equal(formatList(['a', 'b', 'c'], 'or'), 'a, b or c');
    assert.equal(capitalize('resting HR and HRV'), 'Resting HR and HRV');
    assert.equal(capitalize('⟦resting HR⟧'), '⟦Resting HR⟧', 'the first letter, past any brackets');
  });

  it('finds the numbers and units of a duration it wrote, so a big figure can set the units small', () => {
    assert.deepEqual(durationPieces(formatDuration(425)), [
      { unit: false, text: '7' },
      { unit: true, text: 'h' },
      { unit: false, text: ' 05' },
      { unit: true, text: 'm' },
    ]);
    assert.equal(durationPieces(formatDuration(-95))?.map((p) => p.text).join(''), '−1h 35m');
    assert.equal(durationPieces('62 bpm'), null);
  });

  it('chooses plurals by count', () => {
    assert.equal(t('ui.band.needsDays', { count: 1 }), 'baseline needs 1 more day');
    assert.equal(t('ui.band.needsDays', { count: 3 }), 'baseline needs 3 more days');
  });
});

describe('choosing a language', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('takes an exact match, then the same language, then English', () => {
    assert.equal(pickLocale(['en-US']), 'en-US');
    assert.equal(pickLocale(['en-GB']), 'en-US', 'British English reads the English file');
    assert.equal(pickLocale(['xx-YY']), DEFAULT_LOCALE);
    assert.equal(pickLocale(['xx', 'en']), 'en-US', 'the first language we have wins');
  });

  it('brackets every message in the pseudo-language, so stray words stand out', () => {
    setLocale(PSEUDO);
    assert.equal(t('app.nav.today'), '⟦Today⟧');
    assert.equal(formatCivil('2026-08-18'), '⟦18 ⟦Aug⟧⟧');
    assert.equal(names('format.weekdaysShort')[0], '⟦Sun⟧');
    assert.ok(durationPieces(formatDuration(65)), 'durations still split into numbers and units');
  });
});
