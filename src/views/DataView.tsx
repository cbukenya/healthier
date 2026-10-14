import React, { useMemo, useState } from 'react';
import { formatCivil } from '../lib/date';
import { coverage } from '../pipeline/derive';
import { STREAMS } from '../pipeline/registry';
import { Card, CardHead, Segmented } from '../ui/primitives';
import { bucketLabel, groupDays, mean } from '../pipeline/aggregate';
import { RefreshCw } from 'lucide-react';
import { CoverageGrid } from '../charts';
import type { SyncResult } from '../pipeline/sync';
import { useHistory } from '../hooks/useHistory';
import { SpanSelector, useSpan } from '../ui/span';

const NO_HOURS: number[] = new Array(24).fill(0);

const COVERAGE_HINT = {
  day: "Each block is a day: solid where the stream has an observation. Gaps are days the API returned nothing (or the sentinel 'zero' that means missing).",
  week: 'Each block is a week, shaded by how many of its days have an observation: solid is all seven.',
  month: 'Each block is a month, shaded by how many of its days have an observation.',
} as const;

export function DataView({ data, onFullSync, onDisconnect }: { data: SyncResult; onFullSync: () => void; onDisconnect?: () => void }) {
  const [selectedStream, setSelectedStream] = useState<string | null>(null);

  const spanState = useSpan(data, '90');
  const history = useHistory().info;
  const cov = coverage(spanState.days, STREAMS.map((s) => ({ dataType: s.dataType, label: s.label })));

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
        label: i === 0 ? 'Today' : formatCivil(d.date),
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
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card className="lg:col-span-8">
          <CardHead
            title="Coverage matrix"
            hint={COVERAGE_HINT[spanState.bucket]}
            domain="data"
            right={<SpanSelector state={spanState} />}
          />
          <CoverageGrid rows={cov} dates={spanState.days.map((d) => d.date)} bucket={spanState.bucket} />
        </Card>

        <Card className="lg:col-span-4">
          <CardHead title="Sync status" />
          <div className="px-5 pb-5">
            <div className="space-y-3">
              <div className="flex justify-between text-caption">
                <span className="text-zinc-500">Window</span>
                <span className="text-zinc-200">{formatCivil(data.meta.from)} → {formatCivil(data.meta.to)}</span>
              </div>
              <div className="flex justify-between text-caption">
                <span className="text-zinc-500">Total days</span>
                <span className="text-zinc-200 tabular-nums">{data.days.length}</span>
              </div>
              {history?.from && (
                <div className="flex justify-between text-caption">
                  <span className="text-zinc-500">History</span>
                  <span className="text-zinc-200 text-right">
                    from {formatCivil(history.from)} {history.from.slice(0, 4)} ·{' '}
                    {history.backfilling ? (
                      <span className="text-amber-400">importing…</span>
                    ) : history.complete ? (
                      <span className="text-emerald-400">complete</span>
                    ) : (
                      <span className="text-amber-400" title="Some streams failed to import; they retry after the next sync.">incomplete, retrying</span>
                    )}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-caption">
                <span className="text-zinc-500">Total requests</span>
                <span className="text-zinc-200 tabular-nums">{data.meta.totalRequests}</span>
              </div>
              <div className="flex justify-between text-caption">
                <span className="text-zinc-500">Sync duration</span>
                <span className="text-zinc-200 tabular-nums">{data.meta.ms} ms</span>
              </div>
              <div className="flex justify-between text-caption">
                <span className="text-zinc-500">Served from</span>
                <span className={data.meta.fromCache ? 'text-emerald-400' : 'text-zinc-200'}>
                  {data.meta.fromCache ? `Server (${Math.round(data.meta.cacheAgeMs! / 60000)}m old)` : 'Network'}
                </span>
              </div>
            </div>
            
            <button
              onClick={onFullSync}
              className="mt-6 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-caption font-medium text-zinc-200"
            >
              <RefreshCw size={12} /> Force full sync
            </button>
            {onDisconnect && (
              <button
                onClick={onDisconnect}
                className="mt-2 w-full py-2 rounded-lg text-caption font-medium text-rose-400 hover:bg-rose-500/10 transition-colors"
              >
                Disconnect Google &amp; delete my data
              </button>
            )}
          </div>
        </Card>
      </div>


      
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="lg:col-span-8">
          <Card>
            <CardHead
              title="Intraday coverage (Heart rate)"
              hint={
                hrSpan === '62'
                  ? 'Minutes of heart rate recorded in each hour, averaged per week over the 62 days minute data is kept. Gaps show when the watch is usually off.'
                  : `Minutes of heart rate recorded in each hour over the last ${hrSpan} days. Each block is one hour; solid means most of it was recorded.`
              }
              domain="cardio"
              right={
                <Segmented
                  size="sm"
                  value={hrSpan}
                  onChange={setHrSpan}
                  options={[{ id: '14', label: '14d' }, { id: '30', label: '30d' }, { id: '62', label: '62d' }]}
                />
              }
            />
            <div className="px-5 pb-5 overflow-x-auto">
              <div className={`min-w-[400px] ${hrRows.length > 20 ? 'space-y-1' : 'space-y-1.5'}`}>
                <div className="flex gap-0.5 pl-[64px] text-micro text-zinc-500 mb-1">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} className="flex-1 text-center">
                      {String(i).padStart(2, '0')}
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
                        const hour = `${String(h).padStart(2, '0')}:00`;
                        return (
                          <div
                            key={h}
                            className={`${hrRows.length > 20 ? 'h-2.5' : 'h-4'} flex-1 rounded-sm ${intensity}`}
                            title={
                              row.days === 1
                                ? `${row.title} ${hour} · ${m} min recorded`
                                : `${row.title} ${hour} · ${Math.round(m)} min recorded on average, over ${row.days} days`
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
        <Card className="lg:col-span-4">
          <CardHead title="Intraday Data Sync and smoothing" domain="cardio" />
          <div className="px-5 pb-5 text-caption text-zinc-400 space-y-4">
            <p>
              Google's raw heart rate feed provides a sample every few seconds. Rather than downloading those, this app
              asks Google to roll them up into 1-minute averages, which covers the whole {data.days.length}-day window in
              a handful of requests.
            </p>
            <p>
              Each sync refetches only the last few days; older days are kept from earlier syncs. A full resync runs
              weekly, or on demand from the button above.
            </p>
          </div>
        </Card>
      </div>
  
      <Card>
        <CardHead
          title="Stream diagnostics"
          hint="HTTP outcomes per dataType. Click a failed row to see the error Google returned."
          domain="data"
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-caption">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500">
                <th className="font-normal px-5 py-2">dataType</th>
                <th className="font-normal px-2 py-2">Status</th>
                <th className="font-normal px-2 py-2 text-right">In Window</th>
                <th className="font-normal px-2 py-2 text-right">Out of Window</th>
                <th className="font-normal px-2 py-2 text-right">Requests</th>
                <th className="font-normal px-2 py-2 text-right">Pages</th>
                <th className="font-normal px-5 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {data.meta.streams.map((s) => {
                const isErr = s.status === 'error' || s.status === 'unauthorized';
                const isSkipped = s.status === 'skipped';
                const isEmpty = s.status === 'empty';
                return (
                  <React.Fragment key={s.dataType}>
                    <tr 
                      className={`border-b border-zinc-900/50 transition-colors ${s.error ? 'hover:bg-zinc-800/30 cursor-pointer' : ''} ${selectedStream === s.dataType ? 'bg-zinc-800/50' : ''}`}
                      onClick={() => s.error && setSelectedStream(selectedStream === s.dataType ? null : s.dataType)}
                    >
                      <td className="px-5 py-2.5 font-mono text-zinc-400">
                        {s.dataType}
                        {s.truncated && <span className="ml-2 text-micro px-1 py-0.5 rounded bg-amber-500/20 text-amber-300">TRUNCATED</span>}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-note uppercase tracking-wider font-medium ${
                          isErr ? 'bg-rose-500/10 text-rose-400' : 
                          isSkipped ? 'bg-zinc-800 text-zinc-500' :
                          isEmpty ? 'bg-amber-500/10 text-amber-400/80' : 
                          'bg-emerald-500/10 text-emerald-400'
                        }`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-right text-zinc-300 tabular-nums">{s.observations}</td>
                      <td className="px-2 py-2.5 text-right text-zinc-500 tabular-nums">{s.parsedOutsideWindow ?? 0}</td>
                      <td className="px-2 py-2.5 text-right text-zinc-300 tabular-nums">{s.requests}</td>
                      <td className="px-2 py-2.5 text-right text-zinc-300 tabular-nums">{s.pagesFetched}</td>
                      <td className="px-5 py-2.5 text-right text-zinc-500 tabular-nums">{s.ms} ms</td>
                    </tr>
                    {selectedStream === s.dataType && s.error && (
                      <tr className="bg-zinc-950/80">
                        <td colSpan={7} className="px-5 py-4 border-b border-zinc-900">
                          <div className="p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-caption font-mono whitespace-pre-wrap">
                            {s.error}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
