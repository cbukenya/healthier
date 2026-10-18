import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addDays, type CivilDate } from '../../lib/date';
import { BEHIND_AFTER, dataStatus, streamKind } from '../../lib/dataStatus';
import { STREAMS_BY_TYPE } from '../registry';
import type { StreamReport } from '../../types/health';

/**
 * The Data page's status card says one thing first: a sync that can't run, a sync that failed,
 * history still importing, streams Google refused, streams that stopped arriving, or that
 * everything is in.
 */

const TODAY: CivilDate = '2026-10-12';

/** A stream's last fetch: fine, with its latest reading `daysAgo` days back, unless told otherwise. */
function report(dataType: string, daysAgo: number | null, over: Partial<StreamReport> = {}): StreamReport {
  const known = STREAMS_BY_TYPE.get(dataType);
  return {
    dataType,
    label: known?.label ?? dataType,
    domain: known?.domain ?? 'cardio',
    mode: 'list',
    status: daysAgo === null ? 'empty' : 'ok',
    observations: daysAgo === null ? 0 : 30,
    requests: 1,
    pagesFetched: 1,
    truncated: false,
    ms: 50,
    ...(daysAgo === null ? {} : { latestDate: addDays(TODAY, -daysAgo) }),
    ...over,
  };
}

const ALL_IN = [
  report('steps', 0),
  report('sleep', 0),
  report('daily-sleep-temperature-derivations', 1),
  report('weight', 40),
  report('blood-glucose', null),
  report('hydration-log', null, { status: 'skipped' }),
];

const status = (streams: StreamReport[], over: Partial<Parameters<typeof dataStatus>[0]> = {}) =>
  dataStatus({ failure: null, history: { from: '2025-09-08', complete: true, backfilling: false }, streams, today: TODAY, ...over });

describe('a stream on its last fetch', () => {
  it('is behind once a daily stream has had nothing for days, never an occasional one', () => {
    assert.equal(streamKind(report('steps', BEHIND_AFTER - 1), TODAY), 'ok');
    assert.equal(streamKind(report('steps', BEHIND_AFTER), TODAY), 'behind');
    assert.equal(streamKind(report('weight', 90), TODAY), 'ok');
  });

  it('is empty, not shared or failed by what Google answered', () => {
    assert.equal(streamKind(report('blood-glucose', null), TODAY), 'empty');
    assert.equal(streamKind(report('hydration-log', null, { status: 'skipped' }), TODAY), 'unshared');
    assert.equal(streamKind(report('steps', 0, { status: 'error' }), TODAY), 'failed');
    assert.equal(streamKind(report('steps', 0, { status: 'unauthorized' }), TODAY), 'failed');
  });
});

describe('the status card', () => {
  it('says the data is up to date when nothing daily has stopped, whatever has nothing recorded or is shared', () => {
    assert.deepEqual(status(ALL_IN), { kind: 'current' });
  });

  it('names the streams behind in the list order, since the newest of their last readings', () => {
    const streams = [
      ...ALL_IN.filter((r) => r.dataType !== 'daily-sleep-temperature-derivations' && r.dataType !== 'sleep'),
      report('daily-sleep-temperature-derivations', 8),
      report('sleep', 4),
    ];
    assert.deepEqual(status(streams), {
      kind: 'behind',
      streams: ['sleep', 'daily-sleep-temperature-derivations'],
      since: addDays(TODAY, -4),
    });
  });

  it('puts streams Google refused before streams that are behind', () => {
    const streams = [...ALL_IN, report('daily-respiratory-rate', 9), report('daily-oxygen-saturation', 0, { status: 'unauthorized' })];
    assert.deepEqual(status(streams), { kind: 'failed', streams: ['daily-oxygen-saturation'] });
  });

  it('says history is importing before any stream', () => {
    const streams = [...ALL_IN, report('daily-respiratory-rate', 9)];
    assert.deepEqual(status(streams, { history: { from: '2026-08-12', complete: false, backfilling: true } }), { kind: 'importing' });
  });

  it('says a failed sync before anything else, and one that needs signing in again before that', () => {
    const failure = { code: 'request', status: 503 } as const;
    assert.deepEqual(status(ALL_IN, { failure }), { kind: 'failing', failure });
    assert.deepEqual(
      status(ALL_IN, { failure: { code: 'reconnect' }, history: { from: '2026-08-12', complete: false, backfilling: true } }),
      { kind: 'expired' },
    );
  });
});
