
import React, { useState } from 'react';
import { t } from '../i18n';
import { formatCivilLong, formatClock, formatRounded } from '../i18n/format';
import {
  compareToBaseline, isRecent, periodShift, series, sleepArchitecture, sleepDebt, sleepNeedFor, stats, values, windowShift,
} from '../pipeline/derive';
import { scoreSleep } from '../pipeline/sleep';
import { BarSeries, Hypnogram, StageBar, StageLegend, TrendChart, SleepWindowChart } from '../charts';
import { BandPill, Card, CardHead, Contributors, DOMAIN, Delta, EmptyState, Row, Segmented, Value, fmtDuration, CardSummary } from '../ui/primitives';
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
        <EmptyState title={t('sleep.empty.title')} detail={t('sleep.empty.detail')} />
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
        title={t('sleep.duration.title')}
        hint={t('sleep.duration.hint')}
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
      <CardHead domain="sleep" title={t('sleep.rem.title')} hint={t('sleep.rem.hint')} right={<CardSummary isSleep data={remWin} color="#a78bfa" format={(v) => fmtDuration(v)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(remWin, bucket)} bucket={bucket} color="#a78bfa" unit={t('units.minutes')} height={150} />
      </div>
    </Card>
  );
  const deepCard = (
    <Card>
      <CardHead domain="sleep" title={t('sleep.deep.title')} hint={t('sleep.deep.hint')} right={<CardSummary isSleep data={deepWin} color="#4338ca" format={(v) => fmtDuration(v)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(deepWin, bucket)} bucket={bucket} color="#4338ca" unit={t('units.minutes')} height={150} />
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
        <Row dense={!wide} label={t('sleep.summary.typicalNight')}>{fmtDuration(typical((d) => d.sleep?.minutesAsleep ?? null))}</Row>
        <Row dense={!wide} label={t('sleep.summary.typicalEfficiency')}>{efficiency === undefined ? '—' : `${Math.round(efficiency)}${t('units.percent')}`}</Row>
        <Row dense={!wide} label={t('sleep.summary.typicalRestingHr')}>{restingHr === undefined ? '—' : `${Math.round(restingHr)} ${t('units.bpm')}`}</Row>
        {longest?.sleep && (
          <Row dense={!wide} label={t('sleep.summary.longestNight')}>
            {fmtDuration(longest.sleep.minutesAsleep)}
            <span className="text-zinc-500"> · {formatCivilLong(longest.date)}</span>
          </Row>
        )}
        {values(sleepSpan).length >= 14 && (
          <Row dense={!wide} label={t('sleep.summary.firstToLast')}>
            <Delta value={windowShift(sleepSpan, 7).delta} goodWhen="up" digits={0} phrase="sleep.summary.change" />
          </Row>
        )}
      </div>
    </Card>
  );
  const napsCard = (
    <Naps naps={window.flatMap((d) => d.naps).sort((a, b) => b.bedtimeIso.localeCompare(a.bedtimeIso))} spanDays={window.length} wide={wide} />
  );
  const charts: { key: SleepChart; label: string; card: React.ReactNode }[] = [
    { key: 'window', label: t('sleep.overTime.chips.window'), card: windowCard },
    { key: 'duration', label: t('sleep.overTime.chips.duration'), card: durationCard },
    { key: 'rem', label: t('sleep.overTime.chips.rem'), card: remCard },
    { key: 'deep', label: t('sleep.overTime.chips.deep'), card: deepCard },
    { key: 'naps', label: t('sleep.overTime.chips.naps'), card: napsCard },
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      {/* ── 1. The headline night ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card className="lg:col-span-4 flex flex-col">
          {/* Older than yesterday, it's the latest night on record, not last night. */}
          <CardHead
            title={t(latestRow && isRecent(latestRow.date, days.at(-1)?.date) ? 'sleep.night.last' : 'sleep.night.latest')}
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
                  label: t('sleep.night.score.duration.label'),
                  pct: Math.min(100, Math.max(0, Math.round((score.duration / 50) * 100))),
                  points: score.duration,
                  max: 50,
                  color: "#818cf8", // Light Indigo
                  detail: latest ? t('sleep.night.score.duration.detail', { duration: fmtDuration(latest.minutesAsleep) }) : "",
                },
                {
                  label: t('sleep.night.score.restoration.label'),
                  pct: Math.min(100, Math.max(0, Math.round((score.restoration / 25) * 100))),
                  points: score.restoration,
                  max: 25,
                  color: "#6366f1", // Indigo / Purple
                  detail: score.restorativePct !== null
                    ? t('sleep.night.score.restoration.detail', { percent: score.restorativePct })
                    : t('sleep.night.score.restoration.noStages'),
                },
                {
                  label: t('sleep.night.score.efficiency.label'),
                  pct: Math.min(100, Math.max(0, Math.round((score.efficiency / 25) * 100))),
                  points: score.efficiency,
                  max: 25,
                  color: "#10b981", // Emerald
                  detail: latest ? t('sleep.night.score.efficiency.detail', { percent: Math.round(latest.efficiency) }) : "",
                },
              ];

              return (
                <div className="mt-1 pt-4 border-t border-zinc-800/60 space-y-4">
                  {/* 1. Score and Tier pill with glossy dot */}
                  <div>
                    <div className="text-eyebrow uppercase text-zinc-500 mb-1">
                      {t('sleep.night.score.title')}
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
                  <Contributors heading="text-eyebrow uppercase text-zinc-500 mb-2.5">
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
                  </Contributors>
                </div>
              );
            })()}
          </div>
        </Card>

        {latest ? (
          <Card className="lg:col-span-8 flex flex-col">
            <CardHead
              title={t('sleep.architecture.title')}
            />
            <div className="flex-1 flex flex-col pt-2">
              <ArchitectureMeasures session={latest} />

              <div className="flex-1">
                <Hypnogram session={latest} height={200} />
              </div>
              <StageLegend />
              
              <p className="px-5 pb-5 mt-3 text-caption leading-relaxed text-zinc-500">
                {t('sleep.architecture.caveat')}
              </p>
            </div>
          </Card>
        ) : (
          <Card className="lg:col-span-8 flex flex-col justify-center items-center h-full">
            <span className="text-caption text-zinc-500">{t('sleep.architecture.empty')}</span>
          </Card>
        )}
      </div>

      {/* ── 2. The week ─────────────────────────────────────────────── */}
      <LastSevenNights days={days.slice(-7)} shift={shift} needMin={targetMin} debt={debt} wide={wide} />

      {/* ── 3. Over time, following the span ─────────────────────────── */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-zinc-500">
          {t('sleep.overTime.title')}
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
          <ChartChips label={t('sleep.overTime.chips.label')} options={charts} value={shownChart.key} onChange={setChart} />
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
  /** Which measure, named as its messages are: React's key, where a translated label could repeat. */
  id: 'window' | 'efficiency' | 'cycles' | 'remLatency' | 'deepEarly' | 'transitions' | 'awakenings' | 'onset' | 'awakeAfterOnset';
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

  const measures: Measure[] = [
    {
      id: 'window', label: t('sleep.architecture.window.label'), short: t('sleep.architecture.window.short'),
      value: t('sleep.architecture.window.value', { bed, wake }), shortValue: t('sleep.architecture.window.shortValue', { bed, wake }),
      hint: t('sleep.architecture.window.hint'),
      more: t('sleep.architecture.window.more', { bed, wake }),
    },
    {
      id: 'efficiency', label: t('sleep.architecture.efficiency.label'), short: t('sleep.architecture.efficiency.short'), value: `${session.efficiency}${t('units.percent')}`,
      hint: t('sleep.architecture.efficiency.hint'),
      more: t('sleep.architecture.efficiency.more', { percent: session.efficiency }),
    },
  ];
  if (arch) {
    const perCycle = arch.minutesPerCycleApprox;
    // Timed from the stages' own timestamps, so it can fall between whole minutes.
    const rem = arch.remLatencyMin === null ? null : formatRounded(arch.remLatencyMin, 1);
    const early = arch.deepFirstThirdPct;
    const tph = arch.transitionsPerHour;
    measures.push(
      {
        id: 'cycles', label: t('sleep.architecture.cycles.label'), short: t('sleep.architecture.cycles.short'), value: `${arch.cycles}`,
        sub: perCycle ? t('sleep.architecture.cycles.each', { minutes: perCycle }) : undefined,
        hint: t('sleep.architecture.cycles.hint'),
        more: perCycle
          ? t('sleep.architecture.cycles.moreWithLength', { count: arch.cycles, minutes: perCycle })
          : t('sleep.architecture.cycles.more', { count: arch.cycles }),
      },
      {
        id: 'remLatency', label: t('sleep.architecture.remLatency.label'), short: t('sleep.architecture.remLatency.short'),
        value: rem !== null ? `${rem} ${t('units.minutes')}` : '—',
        hint: t('sleep.architecture.remLatency.hint'),
        more: rem !== null ? t('sleep.architecture.remLatency.more', { minutes: rem }) : t('sleep.architecture.remLatency.moreUnknown'),
      },
      {
        id: 'deepEarly', label: t('sleep.architecture.deepEarly.label'), short: t('sleep.architecture.deepEarly.short'),
        value: early !== null ? `${early}${t('units.percent')}` : '—',
        hint: t('sleep.architecture.deepEarly.hint'),
        more: early !== null ? t('sleep.architecture.deepEarly.more', { percent: early }) : t('sleep.architecture.deepEarly.moreUnknown'),
      },
      {
        id: 'transitions', label: t('sleep.architecture.transitions.label'), short: t('sleep.architecture.transitions.short'),
        value: tph !== null ? `${formatRounded(tph, 1)}${t('units.perHour')}` : '—',
        hint: t('sleep.architecture.transitions.hint'),
        more: tph !== null ? t('sleep.architecture.transitions.more', { count: tph }) : t('sleep.architecture.transitions.moreUnknown'),
      },
      {
        id: 'awakenings', label: t('sleep.architecture.awakenings.label'), short: t('sleep.architecture.awakenings.short'), value: `${arch.awakenings}`,
        hint: t('sleep.architecture.awakenings.hint'),
        more: t('sleep.architecture.awakenings.more', { count: arch.awakenings }),
      },
    );
  }
  if (session.onsetLatencyMin != null) {
    measures.push({
      id: 'onset', label: t('sleep.architecture.onset.label'), short: t('sleep.architecture.onset.short'), value: `${session.onsetLatencyMin} ${t('units.minutes')}`,
      hint: t('sleep.architecture.onset.hint'),
      more: t('sleep.architecture.onset.more', { minutes: session.onsetLatencyMin }),
    });
  }
  measures.push({
    id: 'awakeAfterOnset', label: t('sleep.architecture.awakeAfterOnset.label'), short: t('sleep.architecture.awakeAfterOnset.short'), value: `${session.minutesAwake} ${t('units.minutes')}`,
    hint: t('sleep.architecture.awakeAfterOnset.hint'),
    more: t('sleep.architecture.awakeAfterOnset.more', { minutes: session.minutesAwake }),
  });
  const shown = picked !== null && picked < measures.length ? measures[picked] : null;

  return (
    <div className="px-5 mb-4">
      {/* Desktop: every measure says what it means. */}
      <div className="hidden md:grid grid-cols-3 gap-x-5 gap-y-3.5 px-4 py-3.5 rounded-xl bg-[#111114] border border-zinc-800/60">
        {measures.map((m) => (
          <div key={m.id} className="flex flex-col gap-0.5 min-w-0">
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
              key={m.id}
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
            <p className="text-detail text-zinc-500">{t('sleep.architecture.pick')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
