import type { Finding, Tone } from './types';

/**
 * The conflict rules: pure functions over the findings, applied in order to
 * Today and every page together, so no two cards anywhere contradict.
 *
 *   1. "Several of your signals are off" speaks for the whole recovery family.
 *   2. Opposite claims about the same metric never show together.
 *   3. Inside a family, a cautious card beats good news.
 *   4. Nothing suggests pushing hard while anything advises rest.
 *   5. One card per topic.
 */
export function settle(findings: Finding[]): Finding[] {
  return [illnessSpeaksForRecovery, oppositeClaims, familyTone, advice, oneCardPerTopic].reduce(
    (fs, rule) => rule(fs),
    findings,
  );
}

const CAUTION: Record<Tone, number> = { watch: 2, neutral: 1, good: 0 };

/** Cautious first, then the one with more days behind it, then the more important. */
const stronger = (a: Finding, b: Finding) =>
  CAUTION[b.tone] - CAUTION[a.tone] || (b.evidence ?? 0) - (a.evidence ?? 0) || b.importance - a.importance;

export function illnessSpeaksForRecovery(fs: Finding[]): Finding[] {
  if (!fs.some((f) => f.id === 'illness-pattern')) return fs;
  return fs.filter((f) => f.family !== 'recovery' || f.id === 'illness-pattern');
}

export function oppositeClaims(fs: Finding[]): Finding[] {
  const winner = new Map<string, Finding>();
  for (const f of fs) {
    if (!f.claims) continue;
    const held = winner.get(f.claims.metric);
    if (!held || stronger(f, held) < 0) winner.set(f.claims.metric, f);
  }
  return fs.filter((f) => !f.claims || f.claims.direction === winner.get(f.claims.metric)!.claims!.direction);
}

export function familyTone(fs: Finding[]): Finding[] {
  const cautious = new Set(fs.filter((f) => f.tone === 'watch').map((f) => f.family));
  return fs.filter((f) => f.tone !== 'good' || !cautious.has(f.family));
}

export function advice(fs: Finding[]): Finding[] {
  if (!fs.some((f) => f.advice === 'rest')) return fs;
  return fs.filter((f) => f.advice !== 'push');
}

export function oneCardPerTopic(fs: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of fs) {
    const held = best.get(f.topic);
    if (!held || f.importance > held.importance) best.set(f.topic, f);
  }
  return fs.filter((f) => best.get(f.topic) === f);
}
