import React, { useMemo, useState } from 'react';
import { bucketLabel, formatCivil, formatClock, formatHour } from '../i18n/format';
import { t, type MessageKey } from '../i18n';
import { streamName } from '../i18n/streams';
import { coverage, estimatedSleepTarget } from '../pipeline/derive';
import { STREAMS } from '../pipeline/registry';
import { Card, CardHead, Segmented } from '../ui/primitives';
import { groupDays, mean, type Bucket } from '../pipeline/aggregate';
import { CoverageGrid } from '../charts';
import { CycleCard, DataFacts, DataStreams, GoalsCard, SyncStatus } from './DataCards';
import { SourcesCard } from './SourcesCard';
import { DASHBOARD_WINDOW_DAYS, type SyncResult } from '../pipeline/sync';
import { useHistory } from '../hooks/useHistory';
import { SpanSelector, useSpan } from '../ui/span';

const NO_HOURS: number[] = new Array(24).fill(0);

const COVERAGE_HINT = {
  day: 'data.coverage.hint.day',
  week: 'data.coverage.hint.week',
  month: 'data.coverage.hint.month',
} as const satisfies Record<Bucket, MessageKey>;

export function DataView({ data, live, onFullSync, onDisconnect, onSourcesChanged }: {
  data: SyncResult;
  /** False in demo mode. */
  live: boolean;
  onFullSync: () => void;
  onDisconnect?: () => void;
  /** After a new choice of devices: `refetching` when daily totals are being fetched again. */
  onSourcesChanged: (refetching: boolean) => void;
}) {
  const spanState = useSpan(data, '90');
  const history = useHistory().info;
  const cov = coverage(spanState.days, STREAMS.map((s) => ({ dataType: s.dataType, label: streamName(s.dataType, s.label) })));

  // Minutes of heart rate recorded per hour, per day: counted once, not per row.
  const [hrSpan, setHrSpan] = useState<'14' | '30' | '62'>('14');
  const minutesByDay = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const s of data.heartRateSamples ?? []) {
      let hours = out.get(s.date);
      if (!hours) out.set(s.date, (hours = new Array(24).fill(0)));
      const h = Math.floor(s.minutesOfDay / 60);
      if (h >= 0 && h < 24) hours[h]++;
    }
    return out;
  }, [data.heartRateSamples]);
  const hrRows = useMemo(() => {
    const days = data.days.slice(-Number(hrSpan));
    const hoursOf = (date: string) => minutesByDay.get(date) ?? NO_HOURS;
    if (hrSpan !== '62') {
      return [...days].reverse().map((d, i) => ({
        key: d.date,
        label: i === 0 ? t('data.intraday.today') : formatCivil(d.date),
        title: formatCivil(d.date),
        minutes: hoursOf(d.date),
        days: 1,
      }));
    }
    // Two months of daily rows is too tall to read: one row per week, each hour the average across its days.
    return groupDays(days, 'week')
      .reverse()
      .map((g) => ({
        key: g.date,
        label: bucketLabel(g.date, 'week'),
        title: bucketLabel(g.date, 'week', 'full'),
        minutes: Array.from({ length: 24 }, (_, h) => mean(g.days.map((d) => hoursOf(d.date)[h])) ?? 0),
        days: g.days.length,
      }));
  }, [data.days, hrSpan, minutesByDay]);

  return (
    <div className="space-y-3">
      {/* The sync card is small, so the goals fit under it beside the matrix; stacked, they follow it.
          Cycle tracking runs full width below them, so on a phone it comes straight after the goals. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <Card className="lg:col-span-8">
          <CardHead
            title={t('data.coverage.title')}
            hint={t(COVERAGE_HINT[spanState.bucket])}
            domain="data"
            right={<SpanSelector state={spanState} />}
          />
          <CoverageGrid rows={cov} dates={spanState.days.map((d) => d.date)} bucket={spanState.bucket} />
        </Card>

        <div className="lg:col-span-4 space-y-3">
          <SyncStatus data={data} history={history} onFullSync={onFullSync} onDisconnect={onDisconnect} />
          <GoalsCard autoNeed={estimatedSleepTarget(data.days)} />
        </div>
      </div>

      <CycleCard kept={!!data.profile?.cycleKept} />

      <SourcesCard data={data} live={live} onChanged={onSourcesChanged} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="lg:col-span-8">
          {/* Full height, so it ends level with the facts beside it. */}
          <Card className="h-full">
            <CardHead
              title={t('data.intraday.title')}
              hint={
                hrSpan === '62'
                  ? t('data.intraday.hintWeekly', { days: DASHBOARD_WINDOW_DAYS })
                  : t('data.intraday.hint', { days: Number(hrSpan) })
              }
              domain="cardio"
              right={
                <Segmented
                  size="sm"
                  value={hrSpan}
                  onChange={setHrSpan}
                  options={(['14', '30', '62'] as const).map((id) => ({ id, label: t('data.intraday.span', { days: Number(id) }) }))}
                />
              }
            />
            <div className="px-5 pb-5 overflow-x-auto">
              <div className={`min-w-[400px] ${hrRows.length > 20 ? 'space-y-1' : 'space-y-1.5'}`}>
                <div className="flex gap-0.5 pl-[64px] text-micro text-zinc-500 mb-1">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} className="flex-1 text-center">
                      {formatHour(i)}
                    </div>
                  ))}
                </div>
                {hrRows.map((row, index) => (
                  <div key={row.key} className="flex items-center gap-2">
                    <div className="w-14 text-note text-zinc-400 shrink-0 tabular-nums text-right">
                      {hrRows.length <= 14 || index % 2 === 0 ? row.label : ''}
                    </div>
                    <div className="flex gap-0.5 flex-1">
                      {row.minutes.map((m, h) => {
                        const intensity =
                          m === 0 ? 'bg-zinc-900/50' : m < 15 ? 'bg-emerald-500/20' : m < 45 ? 'bg-emerald-500/50' : 'bg-emerald-500';
                        const hour = formatClock(h * 60);
                        return (
                          <div
                            key={h}
                            className={`${hrRows.length > 20 ? 'h-2.5' : 'h-4'} flex-1 rounded-sm ${intensity}`}
                            title={
                              row.days === 1
                                ? t('data.intraday.cell', { date: row.title, time: hour, minutes: m })
                                : t('data.intraday.cellAverage', { date: row.title, time: hour, minutes: Math.round(m), days: row.days })
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>
        <DataFacts
          className="lg:col-span-4"
          windowDays={data.days.length}
          windowFrom={data.meta.from}
          historyFrom={history?.from ?? null}
        />
      </div>

      <DataStreams data={data} />
    </div>
  );
}
