import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sourceFiles } from '../../i18n/__tests__/scan';

const ROOT = join(import.meta.dirname, '../../..');

/** Files that keep colours of their own, and why. */
const OWN_COLOURS: Record<string, string> = {
  'src/views/SignInParts.tsx': "Google's G, in Google's own colours",
  'src/views/cycleColours.ts': 'the Cycle page blends its phase colours in code, so it needs them as numbers',
};

/**
 * A colour written into code: a hex, in a string or a class such as bg-[#0c0c0e], or a colour
 * function. Three or four digits count only with a letter among them, so "#101" in a comment is
 * a pull request, not a colour.
 */
const COLOUR = /#(?:[0-9a-f]{6}(?:[0-9a-f]{2})?|(?=[0-9a-f]{0,3}[a-f])[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi;

const coloursIn = (file: string, source: string) =>
  source.split('\n').flatMap((line, i) => [...line.matchAll(COLOUR)].map((m) => `${file}:${i + 1} ${m[0]}`));

describe('colours', () => {
  it('all come from the theme (src/theme.css): no hex or rgb() written into the code', () => {
    const found = sourceFiles(ROOT, 'src')
      .filter((f) => !(f in OWN_COLOURS))
      .flatMap((f) => coloursIn(f, readFileSync(join(ROOT, f), 'utf8')));
    assert.deepEqual(found, []);
  });

  it('are found however they are written', () => {
    const src = [
      `const a = '#34d399';`,
      `const b = <div className="bg-[#0c0c0e] text-zinc-400" />;`,
      `const c = 'rgba(52,211,153,.3)';`,
      `const d = '#fffa';`,
      `// Fixed in #101 and #96.`,
      `const e = 'var(--emerald-400)';`,
      `const f = <a href="#data/goals" />;`,
    ].join('\n');
    assert.deepEqual(coloursIn('x.tsx', src), ['x.tsx:1 #34d399', 'x.tsx:2 #0c0c0e', 'x.tsx:3 rgba(', 'x.tsx:4 #fffa']);
  });
});
