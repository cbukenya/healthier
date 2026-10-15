import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays } from '../../lib/date';
import { DEMO_CLOCK, DEMO_CYCLE_LOG, DEMO_DAYS, buildDemoPayloads } from '../demo';
import { nightsFrom, summarizeCycles } from '../cycle';
import { createFixtureFetch } from '../fixtures';
import { HISTORY_QUERIES, insightFeeds } from '../insights';
import { PAGES, TODAY_MIN } from '../insights/place';
import { dipping, entropyShift, nocturnalTachycardia, sdbScreen, strainToday, type IntradayDays } from '../labs';
import { DASHBOARD_WINDOW_DAYS, syncWithHistory, type SyncResult } from '../sync';
import type { DailyRecord } from '../../types/health';

/**
 * Demo mode: a year of made-up data through the real pipeline, so someone who hasn't connected an
 * account still sees what every page does.
 */

describe('demo mode', () => {
  let data: SyncResult;
  let history: DailyRecord[];
  const intraday: IntradayDays = {};

  before(async () => {
    ({ data, history } = await syncWithHistory({
      token: 'demo',
      fetchImpl: createFixtureFetch(buildDemoPayloads()),
      windowDays: DASHBOARD_WINDOW_DAYS,
      historyDays: DEMO_DAYS,
      now: DEMO_CLOCK.now,
      timeZone: DEMO_CLOCK.timeZone,
      includeIntraday: true,
      queries: HISTORY_QUERIES,
    }));
    for (const s of data.heartRateSamples) (intraday[s.date] ??= []).push(s);
  });

  it('is the same on every run, so every device shows the same demo', () => {
    // As text, minute heart rate included: a deep comparison of this much takes seconds.
    const text = () => JSON.stringify(buildDemoPayloads(), (_k, v) => (ArrayBuffer.isView(v) ? Buffer.from(v.buffer).toString('base64') : v));
    assert.ok(text() === text());
  });

  it('ends on the demo morning, with a year of history behind the window', () => {
    const today = '2026-10-12';
    assert.equal(data.days.at(-1)!.date, today);
    assert.equal(data.days.length, DASHBOARD_WINDOW_DAYS);
    assert.equal(history.length, DEMO_DAYS);
    assert.equal(history[0].date, addDays(today, -(DEMO_DAYS - 1)));
    assert.equal(history.at(-1)!.date, today);
  });

  it('fills every stream a watch and a scale would, and leaves the rest empty without errors', () => {
    const status = Object.fromEntries(data.meta.streams.map((s) => [s.dataType, s.status]));
    assert.deepEqual(
      Object.keys(status).filter((k) => status[k] !== 'ok').sort(),
      ['blood-glucose', 'electrocardiogram', 'hydration-log', 'nutrition-log'],
    );
    assert.ok(Object.values(status).every((s) => s === 'ok' || s === 'empty'));
    assert.ok(data.heartRateSamples.length > 60 * 24 * 50, 'minute heart rate for most of the window');
  });

  it('shows cards everywhere: at least two on Today, and cards of its own on every page', () => {
    const feeds = insightFeeds(data, DEMO_CLOCK.now, { intraday, timeZone: DEMO_CLOCK.timeZone });
    assert.ok(feeds.today.length >= TODAY_MIN, `Today: ${feeds.today.map((o) => o.id)}`);
    assert.ok(feeds.today.every((o) => !o.id.startsWith('floor-')));
    for (const page of PAGES) {
      const own = feeds.pages[page].filter((o) => !o.id.endsWith('-floor') && !o.id.endsWith('-on-today'));
      assert.ok(own.length >= 3, `${page}: ${feeds.pages[page].map((o) => o.id)}`);
    }
  });

  it('has cycles for the Cycle page: found in its nights, three periods logged, the demo morning on day 18', () => {
    const s = summarizeCycles(nightsFrom(data.days, data.answers), DEMO_CYCLE_LOG, data.days.at(-1)!.date);
    assert.equal(s.status, 'ready');
    assert.equal(s.current?.day, 18);
    assert.equal(s.current?.phase, 'after-rise');
    assert.ok(s.length && s.length.found > 0 && s.length.logged > 0, 'cycles both found and logged');
    assert.ok(s.next, 'a range for the next period');
  });

  it('gives every lab something to show', () => {
    assert.equal(sdbScreen(data.days).status, 'pattern');
    assert.equal(strainToday(data.days).status, 'ready');
    assert.equal(entropyShift(data.days).status, 'monitor');
    assert.equal(dipping(data.days, intraday).status, 'monitor');
    assert.ok(nocturnalTachycardia(data.days, intraday).events.length > 0);
    assert.ok(data.days.some((d) => (d.irn ?? 0) > 0), 'an irregular rhythm notification');
  });
});
