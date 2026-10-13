
export function getScoreTier(total: number) {
  if (total >= 85) {
    return {
      name: "Emerald",
      color: "#10b981",
      dotColor: "#22c55e",
      bg: "bg-emerald-500/10",
      text: "text-emerald-400",
      border: "border-emerald-500/30",
      glow: "0 0 10px rgba(34,197,94,0.6)",
    };
  }
  if (total >= 70) {
    return {
      name: "Indigo",
      color: "#818cf8",
      dotColor: "#818cf8",
      bg: "bg-indigo-500/10",
      text: "text-indigo-400",
      border: "border-indigo-500/30",
      glow: "0 0 10px rgba(129,140,248,0.6)",
    };
  }
  if (total >= 50) {
    return {
      name: "Amber",
      color: "#f59e0b",
      dotColor: "#fbbf24",
      bg: "bg-amber-500/10",
      text: "text-amber-400",
      border: "border-amber-500/30",
      glow: "0 0 10px rgba(245,158,11,0.6)",
    };
  }
  return {
    name: "Rose",
    color: "#f43f5e",
    dotColor: "#ef4444",
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/30",
    glow: "0 0 10px rgba(244,63,94,0.6)",
  };
}
import React, { useState } from 'react';
import { formatCivil, formatCivilLong, formatClock } from '../lib/date';
import {
  bedtimeConsistency, compareToBaseline, estimatedSleepTarget, isRecent, periodShift, series, sleepArchitecture, sleepDebt, stats, values, windowShift,
} from '../pipeline/derive';
import { scoreSleep } from '../pipeline/sleep';
import { BarSeries, Hypnogram, StageBar, StageLegend, TrendChart, SleepWindowChart } from '../charts';
import { BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Label, Row, Segmented, Value, fmtDuration, CardSummary } from '../ui/primitives';
import { SpanSelector, useSpan } from '../ui/span';
import { groupSeries } from '../pipeline/aggregate';
import type { SyncResult } from '../pipeline/sync';

export function SleepView({ data }: { data: SyncResult }) {
  const days = data.days;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;

  const sleepAll = series(days, (d) => d.sleep?.minutesAsleep ?? null);
  const sleepWin = series(window, (d) => d.sleep?.minutesAsleep ?? null);
  const remWin = series(window, (d) => (d.sleep?.stages ? d.sleep.stages.rem : null));
  const deepWin = series(window, (d) => (d.sleep?.stages ? d.sleep.stages.deep : null));

  const sleepCmp = compareToBaseline(sleepAll);
  const shift = periodShift(sleepAll, 7);
  const targetMin = estimatedSleepTarget(days);
  const debt = sleepDebt(days, targetMin);
  const consistency = bedtimeConsistency(days.slice(-14));
  const recorded = values(sleepAll).length;

  if (!recorded) {
    return (
      <Card>
        <EmptyState title="No sleep data in this window" detail="Sleep sessions come from the sleep scope." />
      </Card>
    );
  }

  const latestRow = [...days].reverse().find((d) => d.sleep !== null);
  const latest = latestRow?.sleep ?? null;
  const score = latest ? scoreSleep(latest) : null;

  return (
    <div className="space-y-3">
      {/* ── 1. The headline night ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card className="lg:col-span-4 flex flex-col">
          {/* Older than yesterday, it's the latest night on record, not last night. */}
          <CardHead
            title={latestRow && isRecent(latestRow.date, days.at(-1)?.date) ? 'Last night' : 'Latest night'}
            hint={latestRow ? formatCivilLong(latestRow.date) : ''}
            domain="sleep"
          />
          <div className="px-5 pb-4 flex-1 flex flex-col">
            <div className="mt-1">
              <Value value={latest ? fmtDuration(latest.minutesAsleep) : null} size="xl" />
            </div>
            <div className="mt-2 mb-4"><BandPill c={sleepCmp} /></div>

            {score && (() => {
              const currentTier = getScoreTier(score.total);
              const contributors = [
                {
                  label: "Duration",
                  pct: Math.min(100, Math.max(0, Math.round((score.duration / 50) * 100))),
                  points: score.duration,
                  max: 50,
                  color: "#818cf8", // Light Indigo
                  detail: latest ? `${fmtDuration(latest.minutesAsleep)} asleep (target 7–9h)` : "",
                },
                {
                  label: "Restoration",
                  pct: Math.min(100, Math.max(0, Math.round((score.restoration / 25) * 100))),
                  points: score.restoration,
                  max: 25,
                  color: "#6366f1", // Indigo / Purple
                  detail: score.restorativePct !== null ? `${score.restorativePct}% deep+REM (target ≥40%)` : "",
                },
                {
                  label: "Efficiency",
                  pct: Math.min(100, Math.max(0, Math.round((score.efficiency / 25) * 100))),
                  points: score.efficiency,
                  max: 25,
                  color: "#10b981", // Emerald
                  detail: latest ? `${Math.round(latest.efficiency)}% asleep in bed (target ≥90%)` : "",
                },
              ];

              // Replay historical sleep scores for the last 7 recorded nights
              const last7Days = days
                .filter((d) => d.sleep !== null)
                .slice(-7)
                .map((d) => {
                  const [y, m, day] = d.date.split("-").map(Number);
                  const dt = new Date(Date.UTC(y, m - 1, day));
                  const weekday = dt.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
                  const sc = scoreSleep(d.sleep!);
                  const tier = getScoreTier(sc.total);
                  return {
                    date: d.date,
                    weekday,
                    score: sc.total,
                    tier,
                  };
                });

              // Chart dimensions
              const chartHeight = 70;
              const chartWidth = 260;
              const minScore = 40;
              const maxScore = 100;
              const getY = (val: number) => {
                const clamped = Math.min(maxScore, Math.max(minScore, val));
                return chartHeight - ((clamped - minScore) / (maxScore - minScore)) * (chartHeight - 20) - 10;
              };
              const getX = (index: number, total: number) => {
                if (total <= 1) return chartWidth / 2;
                return 18 + (index / (total - 1)) * (chartWidth - 36);
              };

              const points = last7Days.map((d, i) => ({
                x: getX(i, last7Days.length),
                y: getY(d.score),
                d,
              }));

              const pathD = points.length > 1
                ? points.reduce((acc, p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`), "")
                : "";

              return (
                <div className="mt-auto pt-4 border-t border-zinc-800/60 space-y-4">
                  {/* 1. Score and Tier pill with glossy dot */}
                  <div>
                    <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-zinc-500 mb-1">
                      Sleep score
                    </div>
                    <div className="flex items-baseline justify-between">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-3xl font-bold tracking-tight text-white tabular-nums">
                          {score.total}
                        </span>
                        <span className="text-xs text-zinc-500 font-medium">/ 100</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#18181b] border border-zinc-800 shadow-sm">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                          style={{
                            backgroundColor: currentTier.dotColor,
                            boxShadow: currentTier.glow,
                          }}
                        />
                        <span className="text-xs font-semibold text-zinc-200 tracking-tight">
                          {currentTier.name}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 2. Contributors */}
                  <div>
                    <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-zinc-500 mb-2.5">
                      Contributors
                    </div>
                    <div className="space-y-3">
                      {contributors.map((c, i) => (
                        <div key={i} className="flex items-center text-xs">
                          <span className="w-28 text-zinc-300 truncate pr-2 text-[11.5px] font-medium" title={c.detail}>
                            {c.label}
                          </span>
                          <div className="flex-1 flex items-center h-3 relative mx-2">
                            <div className="w-full h-1.5 bg-zinc-900 rounded-full overflow-hidden flex">
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{ width: `${c.pct}%`, backgroundColor: c.color }}
                              />
                            </div>
                          </div>
                          <div className="w-14 text-right font-mono text-[11px] tabular-nums">
                            <span className="text-zinc-100 font-semibold">{c.points}</span>
                            <span className="text-zinc-500 font-normal">/{c.max}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 3. Historical Sleep Score (LAST 7 DAYS) */}
                  {last7Days.length > 0 && (
                    <div className="pt-3 border-t border-zinc-800/60">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] font-semibold tracking-[0.14em] uppercase text-zinc-500">
                          Last 7 days
                        </div>
                        <div className="flex items-center gap-2 text-[9px] font-medium text-zinc-500">
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" />≥85</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#818cf8]" />70-84</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24]" />50-69</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#ef4444]" />&lt;50</span>
                        </div>
                      </div>

                      <div className="relative w-full bg-[#101013] rounded-xl p-2.5 border border-zinc-800/60">
                        {/* SVG Line Chart */}
                        <div className="h-16 w-full">
                          <svg
                            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                            className="w-full h-full overflow-visible"
                            preserveAspectRatio="none"
                          >
                            {/* Threshold Guide Lines */}
                            <line
                              x1="0"
                              y1={getY(85)}
                              x2={chartWidth}
                              y2={getY(85)}
                              stroke="#10b981"
                              strokeWidth="0.5"
                              strokeDasharray="2 3"
                              strokeOpacity="0.3"
                            />
                            <line
                              x1="0"
                              y1={getY(70)}
                              x2={chartWidth}
                              y2={getY(70)}
                              stroke="#818cf8"
                              strokeWidth="0.5"
                              strokeDasharray="2 3"
                              strokeOpacity="0.3"
                            />
                            <line
                              x1="0"
                              y1={getY(50)}
                              x2={chartWidth}
                              y2={getY(50)}
                              stroke="#f59e0b"
                              strokeWidth="0.5"
                              strokeDasharray="2 3"
                              strokeOpacity="0.3"
                            />

                            {/* Connecting Line */}
                            {pathD && (
                              <path
                                d={pathD}
                                fill="none"
                                stroke="#52525b"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            )}

                            {/* Day Dots */}
                            {points.map((p, i) => {
                              const isLast = i === points.length - 1;
                              return (
                                <g key={i}>
                                  {isLast && (
                                    <circle
                                      cx={p.x}
                                      cy={p.y}
                                      r="6"
                                      fill="none"
                                      stroke={p.d.tier.dotColor}
                                      strokeWidth="1"
                                      strokeOpacity="0.5"
                                    />
                                  )}
                                  <circle
                                    cx={p.x}
                                    cy={p.y}
                                    r={isLast ? "3.5" : "2.5"}
                                    fill={p.d.tier.dotColor}
                                    stroke="#18181b"
                                    strokeWidth="1"
                                  />
                                </g>
                              );
                            })}
                          </svg>
                        </div>

                        {/* X-Axis Labels & Scores */}
                        <div className="flex justify-between items-center mt-2 px-1 text-center">
                          {points.map((p, i) => (
                            <div key={i} className="flex flex-col items-center gap-0.5">
                              <span className="text-[9.5px] font-medium text-zinc-500">
                                {p.d.weekday}
                              </span>
                              <span className="text-[10.5px] font-mono font-medium text-zinc-300 tabular-nums">
                                {p.d.score}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </Card>

        {latest ? (
          <Card className="lg:col-span-8 flex flex-col">
            <CardHead
              title="Sleep architecture"
            />
            <div className="flex-1 flex flex-col pt-2">
              {(() => {
                const arch = sleepArchitecture(latest);
                const stat = (k: string, v: React.ReactNode, sub?: string) => (
                  <div key={k} className="flex flex-col gap-0.5">
                    <span className="text-[9px] font-semibold tracking-[0.12em] uppercase text-zinc-600">{k}</span>
                    <span className="text-[12px] font-semibold text-zinc-200 tabular-nums">
                      {v}{sub && <span className="ml-1 text-[10px] font-medium text-zinc-500">{sub}</span>}
                    </span>
                  </div>
                );
                return (
                  <div className="px-5 mb-4">
                    <div className="flex flex-wrap gap-x-6 gap-y-3 px-4 py-3 rounded-xl bg-[#111114] border border-zinc-800/60">
                      {stat('Window', `${formatClock(latest.bedtimeMin)} → ${formatClock(latest.wakeMin)}`)}
                      {stat('Efficiency', `${latest.efficiency}%`)}
                      {arch && stat('Cycles', arch.cycles, arch.minutesPerCycleApprox ? `~${arch.minutesPerCycleApprox} min` : undefined)}
                      {arch && stat('REM latency', arch.remLatencyMin !== null ? `${arch.remLatencyMin} min` : '—')}
                      {arch && stat('Deep, first third', arch.deepFirstThirdPct !== null ? `${arch.deepFirstThirdPct}%` : '—')}
                      {arch && stat('Transitions', arch.transitionsPerHour !== null ? `${arch.transitionsPerHour}/h` : '—')}
                      {arch && stat('Awakenings (5min+)', arch.awakenings)}
                      {latest.onsetLatencyMin != null && stat('Fell asleep in', `${latest.onsetLatencyMin} min`)}
                      {stat('Awake after onset', `${latest.minutesAwake} min`, '(restless/micro-awakenings)')}
                    </div>
                  </div>
                );
              })()}

              <div className="flex-1">
                <Hypnogram session={latest} height={200} />
              </div>
              <StageLegend />
              
              <div className="px-5 pb-5 mt-4">
                <p className="text-[11.5px] leading-relaxed text-zinc-400">
                  One night’s structure, read from the hypnogram. <strong className="text-zinc-200 font-medium">Cycles</strong> are repeating light → deep → REM loops, usually 90–110 minutes; wrist staging can merge bouts, making cycles appear fewer and longer. <strong className="text-zinc-200 font-medium">REM latency</strong> is the time to first REM, typically 60–120 minutes—unusually early REM is the shift to watch. <strong className="text-zinc-200 font-medium">Deep, first third</strong> shows how much deep sleep occurred early; a high share is expected, while declining front-loading matters. <strong className="text-zinc-200 font-medium">Transitions</strong> measure stage switches per hour. <strong className="text-zinc-200 font-medium">Awakenings (5min+)</strong> count sustained staged wake-ups, while <strong className="text-zinc-200 font-medium">awake after onset</strong> totals all wake minutes including sub-3-minute restless micro-awakenings (the tick marks on the chart). <strong className="text-zinc-200 font-medium">Fell asleep in</strong> is onset latency; consistently near-zero may suggest sleep debt. Treat absolute values as estimates—the most reliable signal is the trend against your own history.
                </p>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="lg:col-span-8 flex flex-col justify-center items-center h-full">
            <span className="text-[11px] text-zinc-500">No sleep session available to draw.</span>
          </Card>
        )}
      </div>

      {/* ── 2. The trends ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card>
          <CardHead title="Sleep summary" hint={`${recorded} recorded nights of ${days.length}.`} />
          <div className="px-5 pb-5">
            <Row label="Typical duration (median)">
              {(() => {
                const s = stats(values(sleepAll));
                return s ? fmtDuration(s.median) : '—';
              })()}
            </Row>
            <Row label="Typical efficiency">
              {(() => {
                const s = stats(values(series(days, (d) => d.sleep?.efficiency ?? null)));
                return s ? `${Math.round(s.median)}%` : '—';
              })()}
            </Row>
            <Row label="Typical resting HR">
              {(() => {
                const s = stats(values(series(days, (d) => d.restingHr)));
                return s ? `${Math.round(s.median)} bpm` : '—';
              })()}
            </Row>
            <Row label="Across the window">
              <Delta value={windowShift(sleepAll, 7).delta} goodWhen="up" digits={0} suffix="min/night" />
            </Row>
          </div>
        </Card>

        <Card>
          <CardHead title="Your latest naps" hint="Sleep outside the main overnight session." />
          <div className="px-5 pb-5 space-y-2">
            {(() => {
              const naps = days.flatMap((d) => d.naps).sort((a, b) => b.date.localeCompare(a.date));
              if (!naps.length) return <p className="text-[11px] text-zinc-500">No naps recorded.</p>;
              return naps.slice(0, 10).map((n, i) => (
                <div key={i} className="flex justify-between items-center text-[11px]">
                  <span className="text-zinc-400">{formatCivil(n.date)}</span>
                  <div className="text-zinc-200 tabular-nums">
                    {fmtDuration(n.minutesAsleep)}
                    <span className="text-zinc-600 ml-2">
                      {formatClock(n.bedtimeMin)} → {formatClock(n.wakeMin)}
                    </span>
                  </div>
                </div>
              ));
            })()}
          </div>
        </Card>

        <Card>
          <div className="px-4 py-4 space-y-5">
            <div>
              <Label>Week on week</Label>
              <div className="mt-2">
                <Value value={shift.current ? fmtDuration(shift.current) : null} size="lg" />
              </div>
              <div className="mt-2">
                <Delta value={shift.delta} goodWhen="up" digits={0} suffix="min vs previous 7 days" />
              </div>
            </div>
            <div>
              <Label>Debt (7 nights before last)</Label>
              <div className="mt-2">
                <Value
                  value={debt === null ? null : (Math.abs(debt.netMin) / 60).toFixed(1)}
                  size="lg"
                  unit={debt === null ? '' : debt.netMin > 0 ? 'h short' : 'h banked'}
                  tone={debt !== null && debt.netMin > 0 ? 'text-amber-400' : 'text-emerald-400'}
                />
              </div>
              <p className="text-[10px] text-zinc-500 mt-2">Against your {Math.round(targetMin / 60)}h target, longer nights counted against shorter ones.</p>
            </div>
            <div>
              <Label>Bedtime consistency</Label>
              <div className="mt-2">
                <Value value={consistency?.sdMin} size="lg" unit="min" digits={0} />
              </div>
              <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
                {consistency
                  ? `Standard deviation over 14 nights (average bedtime ${formatClock(consistency.meanMin)}). Under 30 is tight; over 60 means social jetlag.`
                  : 'Not enough data.'}
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* ── 3. The raw log ───────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your sleep over time
        </h2>
        <SpanSelector state={spanState} />
      </div>

      <SleepWindowChart days={window} bucket={bucket} />

      <Card>
        <CardHead
          domain="sleep"
          title="Sleep duration"
          hint="Total time actually asleep (excluding brief awakenings)."
          right={<CardSummary isSleep data={sleepWin} color={DOMAIN.sleep.hex} format={(v) => fmtDuration(v)} />}
        />
        <div className="px-2 pb-3">
          <TrendChart
            series={groupSeries(sleepWin, bucket)} bucket={bucket} color={DOMAIN.sleep.hex} height={190}
            format={(v) => fmtDuration(v)} area={false}
            baseline={sleepCmp.baseline ? { centre: sleepCmp.baseline, spread: sleepCmp.spread! } : null}
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead domain="sleep" title="REM sleep" hint="Usually ~20-25% of total sleep." right={<CardSummary isSleep data={remWin} color="#a78bfa" format={(v) => fmtDuration(v)} />} />
          <div className="px-2 pb-3">
            <BarSeries series={groupSeries(remWin, bucket)} bucket={bucket} color="#a78bfa" unit="min" height={150} />
          </div>
        </Card>
        <Card>
          <CardHead domain="sleep" title="Deep sleep" hint="Usually ~15-20% of total sleep, concentrated early in the night." right={<CardSummary isSleep data={deepWin} color="#4338ca" format={(v) => fmtDuration(v)} />} />
          <div className="px-2 pb-3">
            <BarSeries series={groupSeries(deepWin, bucket)} bucket={bucket} color="#4338ca" unit="min" height={150} />
          </div>
        </Card>
      </div>



    </div>
  );
}

function ScoreBar({ val, max, color, label }: { val: number; max: number; color: string; label: string }) {
  const pct = Math.max(0, Math.min(100, (val / max) * 100));
  return (
    <div className="flex-1 flex flex-col gap-1.5 group" title={`${label}: ${val} / ${max}`}>
      <div className="h-1.5 bg-zinc-800 rounded-[1px] overflow-hidden">
        <div className="h-full rounded-[1px] transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
