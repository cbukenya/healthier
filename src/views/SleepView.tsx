
export function getScoreTier(total: number) {
  if (total >= 85) {
    return {
      name: "Excellent",
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
      name: "Good",
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
      name: "Fair",
      color: "#f59e0b",
      dotColor: "#fbbf24",
      bg: "bg-amber-500/10",
      text: "text-amber-400",
      border: "border-amber-500/30",
      glow: "0 0 10px rgba(245,158,11,0.6)",
    };
  }
  return {
    name: "Poor",
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
import type { SleepSession } from '../types/health';

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
                  detail: latest ? `${fmtDuration(latest.minutesAsleep)} asleep · full marks at 7–9h` : "",
                },
                {
                  label: "Restoration",
                  pct: Math.min(100, Math.max(0, Math.round((score.restoration / 25) * 100))),
                  points: score.restoration,
                  max: 25,
                  color: "#6366f1", // Indigo / Purple
                  detail: score.restorativePct !== null ? `${score.restorativePct}% deep + REM · full marks at 45%` : "no stage data · scored at the midpoint",
                },
                {
                  label: "Efficiency",
                  pct: Math.min(100, Math.max(0, Math.round((score.efficiency / 25) * 100))),
                  points: score.efficiency,
                  max: 25,
                  color: "#10b981", // Emerald
                  detail: latest ? `${Math.round(latest.efficiency)}% of time in bed asleep · full marks at 100%` : "",
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
                    <div className="space-y-2.5">
                      {contributors.map((c, i) => (
                        <div key={i}>
                        <div className="flex items-center text-xs">
                          <span className="w-28 text-zinc-300 truncate pr-2 text-[11.5px] font-medium">
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
                        {c.detail && <p className="mt-0.5 text-[10.5px] text-zinc-500">{c.detail}</p>}
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
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#818cf8]" />70–84</span>
                          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24]" />50–69</span>
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
              <ArchitectureMeasures session={latest} />

              <div className="flex-1">
                <Hypnogram session={latest} height={156} />
              </div>
              <StageLegend />
              
              <p className="px-5 pb-5 mt-3 text-[11.5px] leading-relaxed text-zinc-500">
                Wrist staging is an estimate and can merge bouts, so the trend against your own history says more than any one night.
              </p>
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
          <CardHead title="Sleep summary" hint={`${recorded} nights recorded in the last ${days.length} days.`} />
          <div className="px-5 pb-5">
            <Row label="Typical night">
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
            <Row label="Latest 7 nights vs first 7">
              <Delta value={windowShift(sleepAll, 7).delta} goodWhen="up" digits={0} suffix="min a night" />
            </Row>
          </div>
        </Card>

        <Card>
          <CardHead title="Naps" hint="Sleep outside your main night." />
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
              <Label>Last 7 nights</Label>
              <div className="mt-2">
                <Value value={shift.current ? fmtDuration(shift.current) : null} size="lg" />
              </div>
              <div className="mt-2">
                <Delta value={shift.delta} goodWhen="up" digits={0} suffix="min a night vs the 7 before" />
              </div>
            </div>
            <div>
              <Label>Sleep debt</Label>
              <div className="mt-2">
                <Value
                  value={debt === null ? null : (Math.abs(debt.netMin) / 60).toFixed(1)}
                  size="lg"
                  unit={debt === null ? '' : debt.netMin > 0 ? 'h short' : 'h banked'}
                  tone={debt !== null && debt.netMin > 0 ? 'text-amber-400' : 'text-emerald-400'}
                />
              </div>
              <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">Over the 7 nights before last night, against your ~{Math.round(targetMin / 60)}h need. Longer nights pay back shorter ones.</p>
            </div>
            <div>
              <Label>Bedtime spread</Label>
              <div className="mt-2">
                <Value value={consistency?.sdMin} size="lg" unit="min" digits={0} />
              </div>
              <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
                {consistency
                  ? `How far your bedtime strayed from its ${formatClock(consistency.meanMin)} average over ${consistency.n} nights. Under 30 min is steady; over 60 is social jetlag.`
                  : 'Needs three nights in the last two weeks.'}
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
          hint="Time asleep each night, not counting time awake in bed."
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
          <CardHead domain="sleep" title="REM sleep" hint="Usually about 20–25% of a night." right={<CardSummary isSleep data={remWin} color="#a78bfa" format={(v) => fmtDuration(v)} />} />
          <div className="px-2 pb-3">
            <BarSeries series={groupSeries(remWin, bucket)} bucket={bucket} color="#a78bfa" unit="min" height={150} />
          </div>
        </Card>
        <Card>
          <CardHead domain="sleep" title="Deep sleep" hint="Usually about 15–20% of a night, most of it early." right={<CardSummary isSleep data={deepWin} color="#4338ca" format={(v) => fmtDuration(v)} />} />
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

/** One architecture measure: its value, a line on what it means, and the fuller account a phone shows on tap. */
interface Measure {
  label: string;
  /** The label on a phone's narrower tile. */
  short: string;
  value: string;
  /** The value on a phone's tile, where it differs. */
  shortValue?: string;
  sub?: string;
  hint: string;
  more: string;
}

/**
 * The night's architecture measures, each explaining itself. Desktop shows every measure with a
 * line on what it means under its value; a phone shows a grid of values, and tapping one explains
 * it underneath.
 */
function ArchitectureMeasures({ session }: { session: SleepSession }) {
  const [picked, setPicked] = useState<number | null>(null);
  const arch = sleepArchitecture(session);
  const bed = formatClock(session.bedtimeMin);
  const wake = formatClock(session.wakeMin);
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const measures: Measure[] = [
    {
      label: 'Window', short: 'Window', value: `${bed} → ${wake}`, shortValue: `${bed}–${wake}`,
      hint: 'asleep to awake',
      more: `From falling asleep at ${bed} to waking at ${wake}.`,
    },
    {
      label: 'Efficiency', short: 'Efficiency', value: `${session.efficiency}%`,
      hint: 'of time in bed spent asleep; 90%+ is good',
      more: `${session.efficiency}% of your time in bed was spent asleep. 90% or more is good.`,
    },
  ];
  if (arch) {
    const perCycle = arch.minutesPerCycleApprox;
    const rem = arch.remLatencyMin;
    const early = arch.deepFirstThirdPct;
    const tph = arch.transitionsPerHour;
    measures.push(
      {
        label: 'Cycles', short: 'Cycles', value: `${arch.cycles}`, sub: perCycle ? `~${perCycle} min each` : undefined,
        hint: 'light → deep → REM loops, usually 90–110 min',
        more: `${arch.cycles} light → deep → REM ${plural(arch.cycles, 'loop', 'loops')}${perCycle ? ` of about ${perCycle} min each` : ''}; 90–110 min is usual. Wrist staging can merge bouts, so cycles can look fewer and longer.`,
      },
      {
        label: 'REM latency', short: 'REM latency', value: rem !== null ? `${rem} min` : '—',
        hint: 'to your first REM; usually 60–120 min',
        more: `${rem !== null ? `${rem} min from falling asleep to your first REM` : 'Time from falling asleep to your first REM'}; 60–120 min is usual. Unusually early REM is the shift to watch.`,
      },
      {
        label: 'Deep, first third', short: 'Deep early', value: early !== null ? `${early}%` : '—',
        hint: 'of deep sleep came early; a high share is normal',
        more: `${early !== null ? `${early}% of the night’s deep sleep came in its first third` : 'How much of the night’s deep sleep came in its first third'}. A high share is normal; a falling share over weeks matters more.`,
      },
      {
        label: 'Transitions', short: 'Transitions', value: tph !== null ? `${tph}/h` : '—',
        hint: 'stage changes per hour asleep',
        more: tph !== null ? `${tph} stage changes per hour asleep.` : 'How often you switched stages, per hour asleep.',
      },
      {
        label: 'Awakenings, 5 min+', short: 'Awakenings', value: `${arch.awakenings}`,
        hint: 'wake-ups long enough to be staged',
        more: arch.awakenings
          ? `${arch.awakenings} ${plural(arch.awakenings, 'wake-up', 'wake-ups')} of 5 min or more that the watch staged.`
          : 'No wake-ups of 5 min or more that the watch staged.',
      },
    );
  }
  if (session.onsetLatencyMin != null) {
    measures.push({
      label: 'Fell asleep in', short: 'Asleep in', value: `${session.onsetLatencyMin} min`,
      hint: 'near zero night after night can mean sleep debt',
      more: `${session.onsetLatencyMin} min to fall asleep. Near zero night after night can be a sign of sleep debt.`,
    });
  }
  measures.push({
    label: 'Awake after onset', short: 'Awake after', value: `${session.minutesAwake} min`,
    hint: 'all wake time, including the ticks above the chart',
    more: `${session.minutesAwake} min awake after first falling asleep, including the brief restless wake-ups marked as ticks above the chart.`,
  });
  const shown = picked !== null && picked < measures.length ? measures[picked] : null;

  return (
    <div className="px-5 mb-4">
      {/* Desktop: every measure says what it means. */}
      <div className="hidden md:grid grid-cols-3 gap-x-5 gap-y-3.5 px-4 py-3.5 rounded-xl bg-[#111114] border border-zinc-800/60">
        {measures.map((m) => (
          <div key={m.label} className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[9.5px] font-semibold tracking-[0.12em] uppercase text-zinc-500">{m.label}</span>
            <span className="text-[13px] font-semibold text-zinc-200 tabular-nums">
              {m.value}
              {m.sub && <span className="ml-1 font-medium text-zinc-400">· {m.sub}</span>}
            </span>
            <span className="text-[10.5px] leading-snug text-zinc-500">{m.hint}</span>
          </div>
        ))}
      </div>

      {/* Phone: the values at a glance; tap one to read what it means. */}
      <div className="md:hidden">
        <div className="grid grid-cols-3 gap-2">
          {measures.map((m, i) => (
            <button
              key={m.label}
              type="button"
              onClick={() => setPicked(picked === i ? null : i)}
              aria-pressed={picked === i}
              className={`min-h-14 px-2.5 py-2 rounded-xl border text-left flex flex-col justify-center gap-0.5 transition-colors ${
                picked === i ? 'border-indigo-400 bg-[#1a1a22]' : 'border-zinc-800/80 bg-[#0c0c0e]'
              }`}
            >
              <span className="text-[9px] font-semibold tracking-[0.1em] uppercase text-zinc-500">{m.short}</span>
              <span className="text-[13px] font-semibold text-zinc-200 tabular-nums">{m.shortValue ?? m.value}</span>
            </button>
          ))}
        </div>
        <div aria-live="polite" className="mt-2.5 px-3.5 py-3 rounded-xl bg-[#17171c] border border-zinc-800">
          {shown ? (
            <>
              <div className="text-[12.5px] font-semibold text-zinc-100">{shown.label}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-zinc-400">{shown.more}</p>
            </>
          ) : (
            <p className="text-[12px] text-zinc-500">Tap a measure to see what it means.</p>
          )}
        </div>
      </div>
    </div>
  );
}
