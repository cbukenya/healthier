import { useMemo } from 'react';
import { insightFeeds, type InsightPage, type Observation } from '../pipeline/insights';
import type { IntradayDays } from '../pipeline/labs';
import type { SyncResult } from '../pipeline/sync';
import { useGoals } from './useGoals';

/** Demo mode runs on the fixture's clock and zone; live data on this device's. */
export type Clock = { now: Date; timeZone: string };

/**
 * One page's insights, on the same clock and goals as Today's, so a card that's
 * on Today right now is never repeated on its page.
 */
export function usePageInsights(data: SyncResult, page: InsightPage, clock?: Clock, intraday?: IntradayDays): Observation[] {
  const goals = useGoals();
  return useMemo(
    () => insightFeeds(data, clock?.now, { intraday, timeZone: clock?.timeZone, goals }).pages[page],
    [data, page, clock, intraday, goals],
  );
}
