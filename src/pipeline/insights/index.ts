import type { InsightDataset, InsightOptions } from './context';
import { insightFeeds } from './engine';
import type { Observation } from './types';

export { HISTORY_QUERIES, evaluate, insightFeeds } from './engine';
export { settle } from './conflicts';
export { monthSummary, todaySummary, weekSummary, type PeriodSummary, type WeekSummary } from './summary';
export { needLabel, STEP_GOAL } from './helpers';
export { movementHrvAssociation, recoveryTax, type MovementHrvAssociation } from './association';
export type { InsightDataset, InsightOptions } from './context';
export type { Daypart, Domain, Finding, InsightFeeds, InsightPage, Kind, Observation, Page, Tone } from './types';

/** Today's key insights. */
export function observations(ds: InsightDataset, now: Date = new Date(), extras?: InsightOptions): Observation[] {
  return insightFeeds(ds, now, extras).today;
}
