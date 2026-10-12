import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, civilClock, startOfCivilDay, todayCivilIn, type CivilDate } from '../../lib/date';
import { buildFixturePayloads, createFixtureFetch } from '../fixtures';
import {
  assembleDays,
  assembleHistory,
  backfillStream,
  DASHBOARD_WINDOW_DAYS,
  fetchStreamPoints,
  historyDue,
  historyStart,
  MemoryStore,
  planFrom,
  REFETCH_DAYS,
  syncIncremental,
  toStreamDay,
  type StreamDay,
  type StreamState,
} from '../incremental';
import { unpackIntraday } from '../intraday';
import { materialise, normalize, type NormalizeInput } from '../normalize';
import { STREAMS, type ScopeKey } from '../registry';
import { HealthTransport, type FetchLike } from '../transport';

/**
 * The incremental engine must be invisible: whatever sequence of syncs built
 * the stored rows, the dashboard sees exactly what one full sync would show.
 */

const ZONE = 'Europe/Stockholm';
const D0 = new Date('2026-08-12T12:00:00+02:00');
const D1 = new Date('2026-08-19T01:39:00+02:00'); // the fixture's "now"
const WINDOW = DASHBOARD_WINDOW_DAYS;

// One payload set for every test: the heart-rate fixture has random spikes.
const payloads = buildFixturePayloads();

function transport(fetchImpl: FetchLike = createFixtureFetch(payloads)) {
  return new HealthTransport({ token: 'test', fetchImpl, maxRetries: 0 });
}

async function syncInto(
  store: MemoryStore,
  now: Date,
  opts: { full: boolean; fetchImpl?: FetchLike; grantedScopes?: ScopeKey[]; windowDays?: number; historyDays?: number },
) {
  const out = await syncIncremental({
    transport: transport(opts.fetchImpl),
    today: todayCivilIn(ZONE, now),
    windowDays: opts.windowDays ?? WINDOW,
    historyDays: opts.historyDays,
    timeZone: ZONE,
    now,
    states: new Map(store.stateMap),
    full: opts.full,
    grantedScopes: opts.grantedScopes,
  });
  store.apply(out);
  return out;
}

function windowOf(now: Date) {
  const to = todayCivilIn(ZONE, now);
  return { from: addDays(to, -(WINDOW - 1)), to };
}

async function fullAt(now: Date) {
  const store = new MemoryStore();
  await syncInto(store, now, { full: true });
  return store;
}

/** Everything the dashboard reads, minus per-fetch costs that legitimately differ. */
function visible(store: MemoryStore, now: Date) {
  const { from, to } = windowOf(now);
  const ds = store.assemble(from, to);
  return {
    days: ds.days,
    samples: unpackIntraday(ds.intraday),
    streams: Object.fromEntries(
      ds.meta.streams.map((s) => [s.dataType, { status: s.status, observations: s.observations, latestDate: s.latestDate }]),
    ),
    profile: ds.profile,
  };
}

const failing = (pattern: string): FetchLike => {
  const good = createFixtureFetch(payloads);
  return async (url, init) => {
    if (url.includes(pattern)) throw new Error('socket hang up');
    return good(url, init);
  };
};

describe('per-stream storage', () => {
  it('reassembles days exactly as normalising every stream at once', async () => {
    const { from, to } = windowOf(D1);
    const t = transport();
    const inputs: NormalizeInput[] = [];
    const rows = new Map<string, Map<CivilDate, StreamDay>>();
    for (const stream of STREAMS) {
      const res = await fetchStreamPoints(t, stream, from, to);
      const points = res.body?.rollupDataPoints ?? res.body?.dataPoints ?? [];
      inputs.push({ stream, points });
      const perStream = new Map<CivilDate, StreamDay>();
      for (const [date, row] of normalize([{ stream, points }]).days) perStream.set(date, toStreamDay(row));
      rows.set(stream.dataType, perStream);
    }
    assert.deepStrictEqual(assembleDays(rows, from, to), materialise(normalize(inputs).days, from, to));
  });

  it('never has two streams writing the same field of a day', async () => {
    const store = await fullAt(D1);
    const owner = new Map<string, string>();
    for (const [dataType, days] of store.rows) {
      for (const [date, day] of days) {
        for (const field of Object.keys(day.fields)) {
          const key = `${date}:${field}`;
          assert.ok(!owner.has(key), `${field} on ${date} written by ${owner.get(key)} and ${dataType}`);
          owner.set(key, dataType);
        }
      }
    }
  });

  it('survives a JSON round trip, as it must to live in Postgres', async () => {
    const store = await fullAt(D1);
    const { from, to } = windowOf(D1);
    const revived = new Map(
      [...store.rows].map(([dt, days]) => [dt, new Map([...days].map(([d, v]) => [d, JSON.parse(JSON.stringify(v))]))]),
    );
    // JSON drops keys whose value is undefined (an absent `app` on a source); nothing else may change.
    const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));
    assert.deepStrictEqual(asJson(assembleDays(revived, from, to)), asJson(assembleDays(store.rows, from, to)));
  });
});

describe('incremental sync', () => {
  it('produces exactly what a full sync shows', async () => {
    const incremental = await fullAt(D0);
    await syncInto(incremental, D1, { full: false });
    assert.deepStrictEqual(visible(incremental, D1), visible(await fullAt(D1), D1));
  });

  it('fetches only the unsettled tail', async () => {
    const store = await fullAt(D0);
    const full = store.run!.totalRequests;
    const out = await syncInto(store, D1, { full: false });
    assert.equal(out.run.kind, 'incremental');
    const steps = out.streams.find((s) => s.dataType === 'steps')!;
    assert.equal(steps.state.report.pagesFetched, 1, 'ten days fit one rollup chunk');
    assert.deepEqual(steps.replace, [{ from: '2026-08-10', to: '2026-08-19' }]);
    assert.ok(out.run.totalRequests < full / 2, `${out.run.totalRequests} vs ${full}`);
  });

  it('picks up revisions inside the refetch tail', async () => {
    const store = await fullAt(D1);
    const late = structuredClone(payloads);
    const point = late['steps'].rollupDataPoints.find((p: any) => p.civilStartTime.date.day === 18 && p.civilStartTime.date.month === 8);
    point.steps.countSum = '12345';
    await syncInto(store, D1, { full: false, fetchImpl: createFixtureFetch(late) });
    const { from, to } = windowOf(D1);
    assert.equal(store.assemble(from, to).days.find((d) => d.date === '2026-08-18')!.steps, 12345);
  });

  it('keeps stored days and coverage when a stream fails, then catches up', async () => {
    const store = await fullAt(D0);
    const before = store.stateMap.get('steps') as StreamState;
    const stored = new Map(store.rows.get('steps'));

    const out = await syncInto(store, D1, { full: false, fetchImpl: failing('/steps/') });
    const steps = out.streams.find((s) => s.dataType === 'steps')!;
    assert.equal(steps.state.report.status, 'error');
    assert.deepEqual(steps.replace, [], 'a failed fetch replaces nothing');
    assert.equal(steps.state.finalThrough, before.finalThrough, 'coverage does not advance');
    assert.deepStrictEqual(store.rows.get('steps'), new Map([...stored].filter(([d]) => d >= out.keepFrom)));

    // The next good sync fetches from where the failed one should have, and converges.
    await syncInto(store, D1, { full: false });
    assert.deepStrictEqual(visible(store, D1), visible(await fullAt(D1), D1));
  });

  it('forgets a stream when its scope is withdrawn', async () => {
    const store = await fullAt(D1);
    assert.ok(store.rows.get('sleep')!.size > 0);
    const granted = (['activity', 'metrics', 'nutrition', 'ecg', 'irn'] as ScopeKey[]);
    await syncInto(store, D1, { full: false, grantedScopes: granted });
    assert.equal(store.rows.get('sleep')!.size, 0);
    const { from, to } = windowOf(D1);
    const ds = store.assemble(from, to);
    assert.ok(ds.days.every((d) => d.sleep === null));
    assert.equal(ds.meta.streams.find((s) => s.dataType === 'sleep')!.status, 'skipped');
  });

  it('drops stored days that fall out of the window', async () => {
    const store = await fullAt(D0);
    await syncInto(store, D1, { full: false });
    const { from } = windowOf(D1);
    for (const days of [...store.rows.values(), store.intradayDays]) {
      for (const date of days.keys()) assert.ok(date >= from, `${date} is before ${from}`);
    }
  });
});

describe('history', () => {
  const HISTORY = 180;
  const today = todayCivilIn(ZONE, D1);
  const start = historyStart(today, HISTORY, WINDOW);

  /** Backfill every stream that is due, as the server's background job does. */
  async function backfill(store: MemoryStore, fetchImpl?: FetchLike) {
    for (const stream of historyDue(store.stateMap, start)) {
      const write = await backfillStream(transport(fetchImpl), stream, store.stateMap.get(stream.dataType)!, start);
      if (write) store.applyWrites([write]);
    }
  }

  const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));

  it('window sync plus backfill stores exactly what one long full sync does', async () => {
    const backfilled = new MemoryStore();
    await syncInto(backfilled, D1, { full: true, historyDays: HISTORY });
    assert.ok(historyDue(backfilled.stateMap, start).length > 0, 'history starts out due');
    await backfill(backfilled);
    assert.deepEqual(historyDue(backfilled.stateMap, start), [], 'and is complete after one pass');

    const oneShot = new MemoryStore();
    await syncInto(oneShot, D1, { full: true, windowDays: HISTORY });
    assert.deepStrictEqual(
      asJson(assembleHistory(backfilled.rows, start, today)),
      asJson(assembleHistory(oneShot.rows, start, today)),
    );
  });

  it('keeps history through incremental and weekly full syncs', async () => {
    const store = new MemoryStore();
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    await backfill(store);
    const weight = (s: MemoryStore) => [...s.rows.get('weight')!.keys()].sort();
    const before = weight(store);
    assert.ok(before[0] < addDays(today, -(WINDOW - 1)), 'backfill reached past the window');

    await syncInto(store, D1, { full: false, historyDays: HISTORY });
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    assert.deepEqual(historyDue(store.stateMap, start), [], 'coverage still reaches the history start');
    assert.deepEqual(weight(store), before, 'history rows survive');
  });

  it('keeps minute-level heart rate to the window only', async () => {
    const store = new MemoryStore();
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    const windowStart = addDays(today, -(WINDOW - 1));
    for (const date of store.intradayDays.keys()) assert.ok(date >= windowStart);
  });

  it('drops history when a sync keeps only the window (a pipeline upgrade)', async () => {
    const store = new MemoryStore();
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    await backfill(store);
    const reset = new MemoryStore();
    for (const [k, v] of store.rows) reset.rows.set(k, new Map(v));
    await syncInto(reset, D1, { full: true });
    const windowStart = addDays(today, -(WINDOW - 1));
    for (const days of reset.rows.values()) for (const date of days.keys()) assert.ok(date >= windowStart);
  });

  it('leaves coverage alone when a backfill fails, so it is retried', async () => {
    const store = new MemoryStore();
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    const before = store.stateMap.get('steps')!.coveredFrom;
    await backfill(store, failing('/steps/'));
    assert.equal(store.stateMap.get('steps')!.coveredFrom, before);
    assert.ok(historyDue(store.stateMap, start).some((s) => s.dataType === 'steps'));
  });

  it('strips per-minute sleep detail from history', async () => {
    const store = new MemoryStore();
    await syncInto(store, D1, { full: true, historyDays: HISTORY });
    const nights = assembleHistory(store.rows, start, today).filter((d) => d.sleep);
    assert.ok(nights.length > 0);
    assert.ok(nights.every((d) => d.sleep!.segments.length === 0 && d.sleep!.minutesAsleep > 0));
  });
});

describe('planning', () => {
  const today = '2026-08-19';
  const windowStart = addDays(today, -(WINDOW - 1));
  const state = (coveredFrom: string | null, finalThrough: string | null) =>
    ({ coveredFrom, finalThrough }) as StreamState;

  it('fetches the whole window the first time, when forced, or when coverage has a hole', () => {
    assert.equal(planFrom(undefined, today, windowStart, false), windowStart);
    assert.equal(planFrom(state(windowStart, '2026-08-15'), today, windowStart, true), windowStart);
    assert.equal(planFrom(state(addDays(windowStart, 1), '2026-08-15'), today, windowStart, false), windowStart);
  });

  it('always refetches the trailing days, even when they are settled', () => {
    assert.equal(planFrom(state(windowStart, '2026-08-18'), today, windowStart, false), addDays(today, -(REFETCH_DAYS - 1)));
  });

  it('resumes after the last settled day when syncs were missed', () => {
    assert.equal(planFrom(state(windowStart, '2026-08-01'), today, windowStart, false), '2026-08-02');
  });

  it('never reaches before the window', () => {
    assert.equal(planFrom(state('2026-01-01', '2026-02-01'), today, windowStart, false), windowStart);
  });
});

describe('time zones', () => {
  it('finds the instant a civil day starts across DST changes', () => {
    assert.equal(new Date(startOfCivilDay('2026-03-29', ZONE)).toISOString(), '2026-03-28T23:00:00.000Z');
    assert.equal(new Date(startOfCivilDay('2026-10-25', ZONE)).toISOString(), '2026-10-24T22:00:00.000Z');
    assert.equal(new Date(startOfCivilDay('2026-08-19', 'America/New_York')).toISOString(), '2026-08-19T04:00:00.000Z');
  });

  it('maps instants to civil minutes on both sides of a DST change', () => {
    const clock = civilClock(ZONE);
    assert.deepEqual(clock(Date.parse('2026-10-24T23:30:00Z')), { date: '2026-10-25', minutesOfDay: 90 }); // 01:30 CEST
    assert.deepEqual(clock(Date.parse('2026-10-25T01:30:00Z')), { date: '2026-10-25', minutesOfDay: 150 }); // 02:30 CET
  });

  it('files intraday minutes under the user’s day, not UTC’s', async () => {
    const store = await fullAt(D1);
    const samples = unpackIntraday(store.intraday);
    // The fixture's evening run starts 21:00 UTC: 23:00 in Stockholm in August.
    assert.equal(samples[0].date, '2026-08-18');
    assert.equal(samples[0].minutesOfDay, 23 * 60);
  });
});
