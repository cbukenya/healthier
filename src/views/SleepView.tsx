
import React, { useState } from 'react';
import { formatCivilLong, formatClock } from '../i18n/format';
import {
  compareToBaseline, isRecent, periodShift, series, sleepArchitecture, sleepDebt, sleepNeedFor, stats, values, windowShift,
} from '../pipeline/derive';
import { scoreSleep } from '../pipeline/sleep';
import { BarSeries, Hypnogram, StageBar, StageLegend, TrendChart, SleepWindowChart } from '../charts';
import { BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Row, Segmented, Value, fmtDuration, CardSummary } from '../ui/primitives';
import { SpanSelector, spanSummaryTitle, useSpan } from '../ui/span';
import { ChartChips } from '../ui/ChartChips';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useGoals } from '../hooks/useGoals';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import type { IntradayDays } from '../pipeline/labs';
import { groupSeries } from '../pipeline/aggregate';
import type { SyncResult } from '../pipeline/sync';
import type { DailyRecord, SleepSession } from '../types/health';
import { LastSevenNights, Naps, getScoreTier } from './SleepCards';

type SleepChart = 'window' | 'duration' | 'rem' | 'deep' | 'naps';

export function SleepView({ data, clock, intraday }: { data: SyncResult; clock?: Clock; intraday?: IntradayDays }) {
  const days = data.days;
  const insights = usePageInsights(data, 'sleep', clock, intraday);
  const needSet = useGoals().sleepNeed;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;
  // A phone shows one chart at a time behind chips; wider screens show them all.
  const wide = useMediaQuery('(min-width: 768px)');
  const [chart, setChart] = useState<SleepChart>('window');

  const sleepAll = series(days, (d) => d.sleep?.minutesAsleep ?? null);
  const sleepWin = series(window, (d) => d.sleep?.minutesAsleep ?? null);
  const remWin = series(window, (d) => (d.sleep?.stages ? d.sleep.stages.rem : null));
  const deepWin = series(window, (d) => (d.sleep?.stages ? d.sleep.stages.deep : null));

  const sleepCmp = compareToBaseline(sleepAll);
  const shift = periodShift(sleepAll, 7);
  const targetMin = sleepNeedFor(days, needSet);
  const debt = sleepDebt(days, targetMin);
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

  // The over-time charts: side by side on wider screens, one at a time behind chips on a phone.
  const windowCard = <SleepWindowChart days={window} bucket={bucket} />;
  const durationCard = (
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
  );
  const remCard = (
    <Card>
      <CardHead domain="sleep" title="REM sleep" hint="Usually about 20–25% of a night." right={<CardSummary isSleep data={remWin} color="#a78bfa" format={(v) => fmtDuration(v)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(remWin, bucket)} bucket={bucket} color="#a78bfa" unit="min" height={150} />
      </div>
    </Card>
  );
  const deepCard = (
    <Card>
      <CardHead domain="sleep" title="Deep sleep" hint="Usually about 15–20% of a night, most of it early." right={<CardSummary isSleep data={deepWin} color="#4338ca" format={(v) => fmtDuration(v)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(deepWin, bucket)} bucket={bucket} color="#4338ca" unit="min" height={150} />
      </div>
    </Card>
  );
  // The span in numbers, and its naps.
  const sleepSpan = series(window, (d) => d.sleep?.minutesAsleep ?? null);
  const longest = window.reduce<DailyRecord | null>((a, d) => (d.sleep && (!a || d.sleep.minutesAsleep > a.sleep!.minutesAsleep) ? d : a), null);
  const typical = (get: (d: DailyRecord) => number | null) => stats(values(series(window, get)))?.median;
  const efficiency = typical((d) => d.sleep?.efficiency ?? null);
  const restingHr = typical((d) => d.restingHr);
  const summaryCard = (
    <Card>
      <CardHead domain="sleep" title={spanSummaryTitle(spanState)} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label="Typical night">{fmtDuration(typical((d) => d.sleep?.minutesAsleep ?? null))}</Row>
        <Row dense={!wide} label="Typical efficiency">{efficiency === undefined ? '—' : `${Math.round(efficiency)}%`}</Row>
        <Row dense={!wide} label="Typical resting HR">{restingHr === undefined ? '—' : `${Math.round(restingHr)} bpm`}</Row>
        {longest?.sleep && (
          <Row dense={!wide} label="Longest night">
            {fmtDuration(longest.sleep.minutesAsleep)}
            <span className="text-zinc-500"> · {formatCivilLong(longest.date)}</span>
          </Row>
        )}
        {values(sleepSpan).length >= 14 && (
          <Row dense={!wide} label="First week to last">
            <Delta value={windowShift(sleepSpan, 7).delta} goodWhen="up" digits={0} suffix="min a night" />
          </Row>
        )}
      </div>
    </Card>
  );
  const napsCard = (
    <Naps naps={window.flatMap((d) => d.naps).sort((a, b) => b.bedtimeIso.localeCompare(a.bedtimeIso))} spanDays={window.length} wide={wide} />
  );
  const charts: { key: SleepChart; label: string; card: React.ReactNode }[] = [
    { key: 'window', label: 'Window', card: windowCard },
    { key: 'duration', label: 'Duration', card: durationCard },
    { key: 'rem', label: 'REM', card: remCard },
    { key: 'deep', label: 'Deep', card: deepCard },
    { key: 'naps', label: 'Naps', card: napsCard },
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

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

              return (
                <div className="mt-1 pt-4 border-t border-zinc-800/60 space-y-4">
                  {/* 1. Score and Tier pill with glossy dot */}
                  <div>
                    <div className="text-eyebrow uppercase text-zinc-500 mb-1">
                      Sleep score
                    </div>
                    <div className="flex items-baseline justify-between">
                      <div className="flex items-baseline gap-1.5">
                        <span className="font-display text-number-lg text-white tabular-nums">
                          {score.total}
                        </span>
                        <span className="text-detail text-zinc-500 font-medium">/ 100</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#18181b] border border-zinc-800 shadow-sm">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                          style={{
                            backgroundColor: currentTier.dotColor,
                            boxShadow: currentTier.glow,
                          }}
                        />
                        <span className="text-detail font-semibold text-zinc-200 tracking-tight">
                          {currentTier.name}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 2. Contributors */}
                  <div>
                    <div className="text-eyebrow uppercase text-zinc-500 mb-2.5">
                      Contributors
                    </div>
                    <div className="space-y-2.5">
                      {contributors.map((c, i) => (
                        <div key={i}>
                        <div className="flex items-center text-detail">
                          <span className="w-28 text-zinc-300 truncate pr-2 text-caption font-medium">
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
                          <div className="w-14 text-right font-mono text-caption tabular-nums">
                            <span className="text-zinc-100 font-semibold">{c.points}</span>
                            <span className="text-zinc-500 font-normal">/{c.max}</span>
                          </div>
                        </div>
                        {c.detail && <p className="mt-0.5 text-note text-zinc-500">{c.detail}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
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
                <Hypnogram session={latest} height={200} />
              </div>
              <StageLegend />
              
              <p className="px-5 pb-5 mt-3 text-caption leading-relaxed text-zinc-500">
                Wrist staging is an estimate and can merge bouts, so the trend against your own history says more than any one night.
              </p>
            </div>
          </Card>
        ) : (
          <Card className="lg:col-span-8 flex flex-col justify-center items-center h-full">
            <span className="text-caption text-zinc-500">No sleep session available to draw.</span>
          </Card>
        )}
      </div>

      {/* ── 2. The week ─────────────────────────────────────────────── */}
      <LastSevenNights days={days.slice(-7)} shift={shift} needMin={targetMin} debt={debt} wide={wide} />

      {/* ── 3. Over time, following the span ─────────────────────────── */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-zinc-500">
          Your sleep over time
        </h2>
        <SpanSelector state={spanState} />
      </div>

      {wide ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summaryCard}
            {napsCard}
          </div>
          {windowCard}
          {durationCard}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {remCard}
            {deepCard}
          </div>
        </>
      ) : (
        <>
          {summaryCard}
          <ChartChips label="Chart" options={charts} value={shownChart.key} onChange={setChart} />
          {shownChart.card}
        </>
      )}

      <InsightsCarousel observations={insights} page="sleep" />
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
            <span className="text-eyebrow-sm uppercase text-zinc-500">{m.label}</span>
            <span className="text-body-sm font-semibold text-zinc-200 tabular-nums">
              {m.value}
              {m.sub && <span className="ml-1 font-medium text-zinc-400">· {m.sub}</span>}
            </span>
            <span className="text-note leading-snug text-zinc-500">{m.hint}</span>
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
              <span className="text-eyebrow-sm uppercase text-zinc-500">{m.short}</span>
              <span className="text-body-sm font-semibold text-zinc-200 tabular-nums">{m.shortValue ?? m.value}</span>
            </button>
          ))}
        </div>
        <div aria-live="polite" className="mt-2.5 px-3.5 py-3 rounded-xl bg-[#17171c] border border-zinc-800">
          {shown ? (
            <>
              <div className="text-detail font-semibold text-zinc-100">{shown.label}</div>
              <p className="mt-1 text-detail leading-relaxed text-zinc-400">{shown.more}</p>
            </>
          ) : (
            <p className="text-detail text-zinc-500">Tap a measure to see what it means.</p>
          )}
        </div>
      </div>
    </div>
  );
}
