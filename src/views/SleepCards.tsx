import React, { useState } from 'react';
import { formatCivilLong, formatCivilRange, formatClock, weekdayLetter, weekdayShort } from '../lib/date';
import { bedtimeConsistency, type PeriodShift, type SleepDebt } from '../pipeline/derive';
import { scoreSleep } from '../pipeline/sleep';
import { Card, CardHead, DURATION_UNIT, Delta, Row, fmtDuration, withUnits } from '../ui/primitives';
import type { DailyRecord, SleepSession } from '../types/health';
import { Stat } from './ActivityCards';

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

/** The stages a night's bar stacks, bottom up, in the hypnogram's colours. */
const STAGES = [
  { key: 'deep', label: 'Deep', color: '#4338ca' },
  { key: 'light', label: 'Light', color: '#818cf8' },
  { key: 'rem', label: 'REM', color: '#a78bfa' },
] as const;

/** A need as a short label: "7h", or "~7h" when it isn't a whole hour. */
const needShort = (min: number) => (min % 60 === 0 ? `${min / 60}h` : `~${Math.round(min / 60)}h`);

/** One of the week's facts: a figure, its unit, and a word on it. */
interface Fact {
  label: string;
  value: string;
  unit: string;
  tone?: string;
  note?: string;
}

/** How far bedtime strays, in a word. */
const spreadWord = (sd: number) => (sd <= 30 ? 'steady' : sd <= 60 ? 'variable' : 'irregular');

/**
 * The last seven nights: their average against the seven before, each night's sleep split into
 * stages against your need with its score beneath, then nights at need, sleep debt and how far
 * bedtime strayed.
 */
export function LastSevenNights({ days, shift, needMin, debt, wide }: {
  /** The last seven days, oldest first; each holds the night that ended that morning. */
  days: DailyRecord[];
  /** Their time asleep against the seven days before. */
  shift: PeriodShift;
  needMin: number;
  /** Over the seven nights before last night, as the body battery counts it. */
  debt: SleepDebt | null;
  wide: boolean;
}) {
  const nights = days.map((d) => d.sleep).filter((s): s is SleepSession => s !== null);
  const atNeed = nights.filter((s) => s.minutesAsleep >= needMin).length;
  const spread = bedtimeConsistency(days);
  const need = needShort(needMin);
  const facts: Fact[] = [{ label: `Nights at your ${need} need`, value: `${atNeed}`, unit: `of ${nights.length}` }];
  if (debt) {
    facts.push({
      label: 'Sleep debt',
      value: (Math.abs(debt.netMin) / 60).toFixed(1),
      unit: debt.netMin > 0 ? 'h short' : 'h banked',
      tone: debt.netMin > 0 ? 'text-amber-400' : 'text-emerald-400',
    });
  }
  if (spread) facts.push({ label: 'Bedtime spread', value: `${Math.round(spread.sdMin)}`, unit: 'min', note: spreadWord(spread.sdMin) });

  return (
    <Card className="px-[18px] pt-4 pb-3.5 md:px-5 md:py-[18px] flex flex-col gap-3 md:gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">Last 7 nights</h2>
        <span className="text-detail text-zinc-500">{formatCivilRange(days[0].date, days[days.length - 1].date)}</span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)_230px] gap-3 lg:gap-7 items-center">
        <div>
          <div className="whitespace-nowrap">
            <span className="font-display text-number-md md:text-number-lg text-zinc-50 tabular-nums">{withUnits(fmtDuration(shift.current), DURATION_UNIT)}</span>
            <span className="text-detail md:text-body-sm text-zinc-500"> a night</span>
          </div>
          <div className="mt-1 md:mt-1.5">
            <Delta value={shift.delta} goodWhen="up" digits={0} suffix="min vs the 7 before" />
          </div>
        </div>
        <NightBars days={days} needMin={needMin} need={need} wide={wide} />
        {wide ? (
          <div className="grid grid-cols-3 lg:grid-cols-1 gap-3 lg:gap-3.5">
            {facts.map((f) => <Stat key={f.label} label={f.label} value={f.value} unit={f.note ? `${f.unit} · ${f.note}` : f.unit} tone={f.tone} />)}
          </div>
        ) : (
          <div>
            {facts.map((f) => (
              <Row key={f.label} dense label={f.label}>
                <span className={f.tone}>{f.value} {f.unit}</span>
                {f.note && <span className="text-zinc-500"> · {f.note}</span>}
              </Row>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

/** One bar per night, split into stages, against the need line; each night's score sits beneath. */
function NightBars({ days, needMin, need, wide }: { days: DailyRecord[]; needMin: number; need: string; wide: boolean }) {
  const plot = wide ? 120 : 110;
  const longest = Math.max(0, ...days.map((d) => d.sleep?.minutesAsleep ?? 0));
  // Headroom above the need, and above the longest night.
  const top = Math.max(needMin * 1.2, longest * 1.05);
  const px = (min: number) => (min / top) * plot;
  const columns = 'grid grid-cols-7 gap-x-2 md:gap-x-3.5 pr-[30px]';
  const scored = days.map((d) => ({ date: d.date, sleep: d.sleep, score: d.sleep ? scoreSleep(d.sleep).total : null }));
  return (
    <div
      role="img"
      aria-label={`Time asleep each night against your ${need} need: ${scored
        .map((n) => `${formatCivilLong(n.date)}, ${n.sleep ? `${fmtDuration(n.sleep.minutesAsleep)}, score ${n.score}` : 'not recorded'}`)
        .join('; ')}.`}
    >
      <div className="relative">
        <div className={`${columns} items-end border-b border-zinc-800`} style={{ height: plot }}>
          {scored.map(({ date, sleep }) => {
            if (!sleep) return <div key={date} />;
            const height = Math.max(2, px(sleep.minutesAsleep));
            const stages = sleep.stages;
            const staged = stages ? stages.deep + stages.light + stages.rem : 0;
            return (
              <div key={date} className="flex justify-center">
                <div className="w-full max-w-[30px] flex flex-col-reverse rounded-t-[5px] overflow-hidden" style={{ height }}>
                  {stages && staged > 0
                    ? STAGES.map((s) => <div key={s.key} style={{ height: (stages[s.key] / staged) * height, background: s.color }} />)
                    : <div className="h-full" style={{ background: STAGES[1].color }} />}
                </div>
              </div>
            );
          })}
        </div>
        {/* The need line, over the bars, labelled in the gutter on the right. */}
        <div className="absolute left-0 right-[30px] border-t border-dashed border-zinc-400/70" style={{ bottom: px(needMin) + 1 }} />
        <span className="absolute right-0 translate-y-1/2 text-note leading-none text-zinc-500" style={{ bottom: px(needMin) + 1 }}>{need}</span>
      </div>
      <div className={`${columns} mt-1.5`}>
        {scored.map((n) => (
          <span key={n.date} className="text-center text-note text-zinc-500">{wide ? weekdayShort(n.date) : weekdayLetter(n.date)}</span>
        ))}
      </div>
      <div className={`relative ${columns} mt-1`}>
        {scored.map((n) => (
          <span key={n.date} className="text-center text-caption font-semibold tabular-nums" style={{ color: n.score === null ? '#52525b' : getScoreTier(n.score).dotColor }}>
            {n.score ?? '–'}
          </span>
        ))}
        <span className="absolute right-0 top-0.5 text-micro font-medium text-zinc-500">score</span>
      </div>
      <div className="mt-2.5 flex gap-3.5 text-note text-zinc-500">
        {STAGES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A nap's length: "25 min" under an hour, else "1h 19m". */
const napLength = (min: number) => (Math.round(min) < 60 ? `${Math.round(min)} min` : fmtDuration(min));

/** Naps listed before "Show all". */
const NAPS_SHOWN = 8;

/** The span's naps, newest first, with how many and how long altogether. */
export function Naps({ naps, spanDays, wide }: { naps: SleepSession[]; spanDays: number; wide: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? naps : naps.slice(0, NAPS_SHOWN);
  const total = naps.reduce((a, n) => a + n.minutesAsleep, 0);
  return (
    <Card>
      <CardHead
        domain="sleep"
        title="Naps"
        hint="Sleep outside your main night."
        right={naps.length > 0 && (
          <span>
            <span className="text-indigo-400">{naps.length}</span> {naps.length === 1 ? 'nap' : 'naps'} · <span className="text-indigo-400">{napLength(total)}</span>
          </span>
        )}
      />
      <div className="px-5 pb-4 md:pb-5">
        {naps.length === 0 && <p className="text-caption text-zinc-500">No naps in these {spanDays} days.</p>}
        {shown.map((n) => (
          <Row key={n.bedtimeIso} dense={!wide} label={formatCivilLong(n.date)}>
            {napLength(n.minutesAsleep)}
            <span className="ml-2 text-zinc-500">{formatClock(n.bedtimeMin)} → {formatClock(n.wakeMin)}</span>
          </Row>
        ))}
        {naps.length > NAPS_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            aria-expanded={showAll}
            className="mt-2 w-full min-h-11 rounded-xl border border-[#27272a] text-body-sm text-[#a1a1aa] hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
          >
            {showAll ? `Show the latest ${NAPS_SHOWN}` : `Show all ${naps.length} naps`}
          </button>
        )}
      </div>
    </Card>
  );
}
