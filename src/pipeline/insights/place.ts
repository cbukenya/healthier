import type { InsightContext } from './context';
import { pageFloor, todayFloor } from './floors';
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

/** Each settled finding goes to exactly one place: Today while it's key, otherwise its own page. */
export function place(settled: Finding[], ctx: InsightContext): InsightFeeds {
  const today = settled.filter((f) => onToday(f, ctx.part)).sort((a, b) => b.importance - a.importance);
  const rest = settled.filter((f) => !onToday(f, ctx.part));

  const todayFeed = (today.length ? today : [todayFloor(ctx)]).map(toObservation);
  const pages = {} as InsightFeeds['pages'];
  for (const page of PAGES) {
    const own = rest.filter((f) => f.page === page).sort(pageOrder);
    const elsewhere = today.filter((f) => f.page === page || SPEAKS_FOR[page]?.includes(f.id)).map(toObservation);
    pages[page] = (own.length ? own : [pageFloor(page, ctx, elsewhere)]).map(toObservation);
  }
  return { today: todayFeed, pages };
}
