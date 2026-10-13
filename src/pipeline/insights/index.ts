import type { HealthDataset } from '../../types/health';
import type { InsightOptions } from './context';
import { insightFeeds } from './engine';
import type { Observation } from './types';

export { evaluate, insightFeeds } from './engine';
export { settle } from './conflicts';
export { todaySummary, weekSummary, type WeekSummary } from './summary';
export { needLabel, STEP_GOAL } from './helpers';
export { movementHrvAssociation, recoveryTax, type MovementHrvAssociation } from './association';
export type { InsightOptions } from './context';
export type { Daypart, Domain, Finding, InsightFeeds, InsightPage, Kind, Observation, Page, Tone } from './types';

/** Today's key insights. */
export function observations(ds: HealthDataset, now: Date = new Date(), extras?: InsightOptions): Observation[] {
  return insightFeeds(ds, now, extras).today;
}
