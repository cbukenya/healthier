import { buildContext, type InsightDataset, type InsightOptions } from './context';
import { settle } from './conflicts';
import { PAGES, carouselOf, place, placeable } from './place';
import type { HistoryQueries } from '../history';
import { cycleQueries } from '../cycle';
import { activityCards, activityQueries } from './cards/activity';
import { bodyCards, bodyQueries } from './cards/body';
import { sleepCards, sleepQueries } from './cards/sleep';
import { todayCards } from './cards/today';
import { vitalsCards, vitalsQueries } from './cards/vitals';
import type { Finding, InsightFeeds } from './types';

/**
 * The insight engine.
 *
 * Everything here is deterministic arithmetic over the day grid plus the
 * clock: no model call, no invented causation, no stored state. "Today" is
 * always the grid's last day (the server ends the window on the user's today);
 * the clock only says whether it's morning, midday or evening. Novelty is
 * a property *derived from the data*: to know whether an insight is new, the
 * engine re-evaluates the same rule on a truncated window ("the yesterday
 * test") and calls it news only when the state wasn't already true. Nothing is
 * persisted, so behaviour is identical across devices and every guard is a
 * pure function you can unit-test.
 *
 * Guard vocabulary (all stateless):
 *
 *   fresh-fact   about last night / today; new each day by nature
 *   entry        true on the full window, false ENTRY_WINDOW+1 days ago
 *   fresh entry  began within the entry window after a quiet week, so a
 *                trend that lapses for a day or two and comes back stays
 *                on its page instead of returning to Today (freshEntry)
 *   hysteresis   entry measured against a *reset* threshold, so a value
 *                oscillating around the fire threshold cannot re-fire daily
 *   milestone    predicate only true at discrete values (streak ∈ set,
 *                a strictly-beaten record, staleness crossing 15/30/60)
 *   alert        shows while true; copy escalates with the trailing
 *                consecutive-day count instead of repeating verbatim.
 *                States that can last for weeks (sleep debt, a jump in
 *                steps) reach Today as they start and as they deepen, and
 *                wait on their page in between, saying how long they've held
 *   calendar     fires on a clock condition (1st of the month)
 *
 * One pass, five feeds: every card file adds findings for its page, the
 * conflict rules settle them all together, and each one goes to exactly one
 * place. Today while it's key (an alert or nudge while true, anything else
 * while it's news), otherwise its own page for as long as it holds. A Today
 * with fewer than two cards brings forward what matters most from the pages,
 * cautious first: still true, though no longer news.
 *
 * Copy laws, enforced in the cards: plain sentences with the figures inside
 * them; evidence first, the action on its own line after it; wins carry no
 * homework; neutral metrics carry no moral tone; escalation, never repetition.
 */
/**
 * Every question the cards ask of your older days, sent with each dataset
 * request. Each page's cards declare their own beside the code that reads the
 * answers.
 */
export const HISTORY_QUERIES: HistoryQueries = { ...activityQueries, ...sleepQueries, ...vitalsQueries, ...bodyQueries, ...cycleQueries };

export function evaluate(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions) {
  const ctx = buildContext(ds, now, extras);
  if (!ctx) return null;
  const found: Finding[] = [];
  const add = (f: Finding) => found.push(f);
  todayCards(ctx, add);
  activityCards(ctx, add);
  sleepCards(ctx, add);
  vitalsCards(ctx, add);
  bodyCards(ctx, add);
  const settled = settle(found.filter((f) => placeable(f, ctx.part)), (f) => carouselOf(f, ctx.part));
  return { ctx, found, settled, feeds: place(settled, ctx) };
}

/** Today's key insights and each page's own, for the carousels. */
export function insightFeeds(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions): InsightFeeds {
  return evaluate(ds, now, extras)?.feeds ?? {
    today: [],
    pages: Object.fromEntries(PAGES.map((p) => [p, []])) as unknown as InsightFeeds['pages'],
  };
}
