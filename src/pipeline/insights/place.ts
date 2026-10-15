import type { InsightContext } from './context';
import { pageFloor, todayFloor } from './cards/floors';
import type { Daypart, Finding, InsightFeeds, InsightPage, Observation } from './types';

export const PAGES: InsightPage[] = ['activity', 'sleep', 'vitals', 'body'];

const inPart = (f: Finding, part: Daypart) => !f.daypart || f.daypart.includes(part);

/** Key right now: an alert or nudge while it's true, anything else only while it's news. */
export const onToday = (f: Finding, part: Daypart) =>
  f.today !== 'never' && inPart(f, part) && (f.today === 'while-true' || f.news);

/**
 * Whether a finding can show anywhere at this moment. Nudges and whole-day
 * cards only mean something on Today, in their part of the day; the rest fall
 * back to their page. Run before the conflict rules, so a card that can't
 * show never silences one that can.
 */
export const placeable = (f: Finding, part: Daypart) =>
  onToday(f, part) || (f.kind !== 'nudge' && f.page !== 'today');

/** The carousel a card shows in, before a quiet Today brings any forward. */
export const carouselOf = (f: Finding, part: Daypart): string => (onToday(f, part) ? 'today' : f.page);

/** Today never shows fewer cards than this while others it could show wait on their pages. */
export const TODAY_MIN = 2;

/** Good news and a cautious card from the same family: never side by side (see the conflict rules). */
const clash = (a: Finding, b: Finding) =>
  a.family === b.family && ((a.tone === 'good' && b.tone === 'watch') || (a.tone === 'watch' && b.tone === 'good'));

/** Cautious first, then the more important. */
const forwardOrder = (a: Finding, b: Finding) =>
  Number(b.tone === 'watch') - Number(a.tone === 'watch') || b.importance - a.importance;

/**
 * A quiet Today brings forward what matters most from the pages: a card that is still true but no
 * longer news, cautious ones first, until Today has TODAY_MIN. It moves, so it shows in one place.
 * Page-only cards stay put, and so does a card outside its part of the day or beside its rival.
 */
export function bringForward(today: Finding[], waiting: Finding[], part: Daypart): Finding[] {
  const out = [...today];
  const candidates = waiting.filter((f) => f.today !== 'never' && inPart(f, part)).sort(forwardOrder);
  for (const f of candidates) {
    if (out.length >= TODAY_MIN) break;
    if (!out.some((g) => clash(f, g))) out.push(f);
  }
  return out;
}

/** What needs attention first, then fresh news, then the rest by importance. */
const pageOrder = (a: Finding, b: Finding) =>
  Number(b.tone === 'watch') - Number(a.tone === 'watch') || Number(b.news) - Number(a.news) || b.importance - a.importance;

/** Today cards that speak for a page, so its floor points to them instead of contradicting them. */
const SPEAKS_FOR: Partial<Record<InsightPage, string[]>> = { vitals: ['illness-pattern'] };

export const toObservation = (f: Finding): Observation => ({
  id: f.id, domain: f.domain, page: f.page, kind: f.kind, tone: f.tone, title: f.title, text: f.text,
  ...(f.action ? { action: f.action } : {}),
  ...(f.direction ? { direction: f.direction } : {}),
});

/**
 * Each settled finding goes to exactly one place: Today while it's key, otherwise its own page. A
 * quiet Today brings forward what matters most from the pages (bringForward).
 */
export function place(settled: Finding[], ctx: InsightContext): InsightFeeds {
  const key = settled.filter((f) => onToday(f, ctx.part));
  const waiting = settled.filter((f) => !onToday(f, ctx.part));
  const today = bringForward(key, waiting, ctx.part).sort((a, b) => b.importance - a.importance);
  const rest = settled.filter((f) => !today.includes(f));

  const todayFeed = (today.length ? today : [todayFloor(ctx)]).map(toObservation);
  const pages = {} as InsightFeeds['pages'];
  for (const page of PAGES) {
    const own = rest.filter((f) => f.page === page).sort(pageOrder);
    const elsewhere = today.filter((f) => f.page === page || SPEAKS_FOR[page]?.includes(f.id)).map(toObservation);
    pages[page] = (own.length ? own : [pageFloor(page, ctx, elsewhere)]).map(toObservation);
  }
  return { today: todayFeed, pages };
}
