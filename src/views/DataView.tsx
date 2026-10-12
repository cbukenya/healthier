import React, { useState } from 'react';
import { formatCivil } from '../lib/date';
import { coverage } from '../pipeline/derive';
import { STREAMS } from '../pipeline/registry';
import { Card, CardHead } from '../ui/primitives';
import { RefreshCw } from 'lucide-react';
import { CoverageGrid } from '../charts';
import type { SyncResult } from '../pipeline/sync';
import { useHistory } from '../hooks/useHistory';
import { SpanSelector, useSpan } from '../ui/span';

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

  const targetDays = [...data.days].reverse().slice(0, 14);

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
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">Window</span>
                <span className="text-zinc-200">{formatCivil(data.meta.from)} → {formatCivil(data.meta.to)}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">Total days</span>
                <span className="text-zinc-200 tabular-nums">{data.days.length}</span>
              </div>
              {history?.from && (
                <div className="flex justify-between text-[11px]">
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
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">Total requests</span>
                <span className="text-zinc-200 tabular-nums">{data.meta.totalRequests}</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">Sync duration</span>
                <span className="text-zinc-200 tabular-nums">{data.meta.ms} ms</span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-zinc-500">Served from</span>
                <span className={data.meta.fromCache ? 'text-emerald-400' : 'text-zinc-200'}>
                  {data.meta.fromCache ? `Server (${Math.round(data.meta.cacheAgeMs! / 60000)}m old)` : 'Network'}
                </span>
              </div>
            </div>
            
            <button
              onClick={onFullSync}
              className="mt-6 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors text-[11px] font-medium text-zinc-200"
            >
              <RefreshCw size={12} /> Force full sync
            </button>
            {onDisconnect && (
              <button
                onClick={onDisconnect}
                className="mt-2 w-full py-2 rounded-lg text-[11px] font-medium text-rose-400 hover:bg-rose-500/10 transition-colors"
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
              hint="Hourly breakdown of minute-by-minute heart rate samples over the last 14 days. Each block represents one hour (24 blocks per day)."
              domain="cardio"
            />
            <div className="px-5 pb-5 overflow-x-auto">
              <div className="min-w-[400px] space-y-1.5">
                <div className="flex gap-0.5 pl-[56px] text-[9px] text-zinc-500 mb-1">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <div key={i} className="flex-1 text-center">
                      {String(i).padStart(2, '0')}
                    </div>
                  ))}
                </div>
                {targetDays.map((d, index) => {
                  const daySamples = data.heartRateSamples?.filter(s => s.date === d.date) || [];
                  const hours = new Array(24).fill(0);
                  daySamples.forEach(s => {
                    const h = Math.floor(s.minutesOfDay / 60);
                    if (h >= 0 && h < 24) hours[h]++;
                  });

                  const [, m, day] = d.date.split('-');
                  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                  const dateLabel = index === 0 ? 'Today' : `${months[parseInt(m, 10) - 1]} ${parseInt(day, 10)}`;

                  return (
                    <div key={d.date} className="flex items-center gap-2">
                      <div className="w-12 text-[10px] text-zinc-400 shrink-0 tabular-nums text-right">
                        {dateLabel}
                      </div>
                      <div className="flex gap-0.5 flex-1">
                        {hours.map((count, h) => {
                          const intensity = count === 0 
                            ? 'bg-zinc-900/50' 
                            : count < 15 ? 'bg-emerald-500/20' 
                            : count < 45 ? 'bg-emerald-500/50' 
                            : 'bg-emerald-500';
                          return (
                            <div 
                              key={h} 
                              className={`h-4 flex-1 rounded-sm ${intensity}`}
                              title={`${d.date} ${String(h).padStart(2, '0')}:00 - ${count} samples`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        </div>
        <Card className="lg:col-span-4">
          <CardHead title="Intraday Data Sync and smoothing" domain="cardio" />
          <div className="px-5 pb-5 text-[11px] text-zinc-400 space-y-4">
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
          <table className="w-full text-left text-[11px]">
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
                        {s.truncated && <span className="ml-2 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-300">TRUNCATED</span>}
                      </td>
                      <td className="px-2 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium ${
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
                          <div className="p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[11px] font-mono whitespace-pre-wrap">
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
