import React, { useId, useMemo, useState } from 'react';
import { addDays, daysBetween, isoWeekdayIndex, type CivilDate } from '../lib/date';
import { names, t, type MessageKey } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivil, formatCivilLong, formatCivilRange, formatDayMonthLong, formatFixed, formatMonthYear, formatRounded } from '../i18n/format';
import {
  MAX_CYCLE, MIN_CYCLE, MIN_CYCLES, SECOND_HALF_DAYS, byCycleDay, loggedPeriods, sinceRise,
  type Cycle, type CycleLog, type CycleSummary, type Flow, type Night, type Symptom,
} from '../pipeline/cycle';
import {
  currentShape, cycleShape, dayPlusMinus, lengthPlusMinus, ovulationWindow, phaseOn, type CycleShape, type Phase,
} from '../pipeline/cyclePhases';
import { CARD_GROUND, OVULATION_DASH, PAGE_GROUND, PHASE_HEX, PHASE_TEXT, dayColour, mix, ovulationAlpha } from './cycleColours';
import { useCycle } from '../hooks/useCycle';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import { InsightsCarousel } from '../components/InsightsCarousel';
import type { IntradayDays } from '../pipeline/labs';
import type { SyncResult } from '../pipeline/sync';
import { Card, CardHead, Contributors, DOMAIN, tint } from '../ui/primitives';
import { Chips, Sheet } from '../ui/Sheet';

/**
 * The Cycle page: where today sits in the cycle, how the body moves through it, and the cycles so
 * far. Cycles are found in the nights whether or not anything is logged; what's logged makes them
 * certain (src/pipeline/cycle.ts).
 */

const PINK = DOMAIN.cycle.hex;

const FLOW_LABEL: Record<Flow | 'none', MessageKey> = {
  none: 'cycle.flow.none',
  spotting: 'cycle.flow.spotting',
  light: 'cycle.flow.light',
  medium: 'cycle.flow.medium',
  heavy: 'cycle.flow.heavy',
  unspecified: 'cycle.flow.unspecified',
};
/** Flows a person picks; `unspecified` is what "My period started" logs. */
const PICKED_FLOWS = ['none', 'spotting', 'light', 'medium', 'heavy'] as const;
const HEAVINESS: Flow[] = ['spotting', 'light', 'medium', 'heavy'];

const SYMPTOM_LABEL: Record<Symptom, MessageKey> = {
  cramps: 'cycle.symptoms.cramps',
  headache: 'cycle.symptoms.headache',
  bloating: 'cycle.symptoms.bloating',
  breasts: 'cycle.symptoms.breasts',
  back: 'cycle.symptoms.back',
  acne: 'cycle.symptoms.acne',
  tired: 'cycle.symptoms.tired',
  'low-mood': 'cycle.symptoms.lowMood',
  irritable: 'cycle.symptoms.irritable',
  cravings: 'cycle.symptoms.cravings',
  sleep: 'cycle.symptoms.sleep',
};

type SheetState = { kind: 'day'; date: CivilDate } | { kind: 'start'; suggest: CivilDate | null } | null;

export function CycleView({ data, clock, intraday }: { data: SyncResult; clock?: Clock; intraday?: IntradayDays }) {
  const { summary, log, nights, today, failed } = useCycle();
  const insights = usePageInsights(data, 'cycle', clock, intraday);
  const [sheet, setSheet] = useState<SheetState>(null);
  if (!summary || !today) return null;
  const close = () => setSheet(null);

  return (
    <div className="space-y-3">
      {/* On a computer each row's cards run to the same height, the side cards sharing what the
          hero leaves, so no row ends in a gap. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <CycleHero
          className="lg:col-span-8"
          summary={summary}
          log={log}
          nights={nights}
          today={today}
          onLog={() => setSheet({ kind: 'day', date: today })}
          onStarted={(suggest) => setSheet({ kind: 'start', suggest })}
        />
        <div className="lg:col-span-4 flex flex-col gap-3">
          <NowCard className="lg:grow" summary={summary} nights={nights} />
          <LastPeriodCard className="lg:grow" summary={summary} log={log} today={today} onStarted={(suggest) => setSheet({ kind: 'start', suggest })} />
          <LoggedDayCard className="lg:grow" log={log} today={today} onLog={() => setSheet({ kind: 'day', date: today })} />
        </div>
      </div>

      {failed && (
        <p role="alert" className="px-1 text-caption text-rose-400">
          {t('cycle.failed')}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <CycleHistory className="lg:col-span-7" summary={summary} today={today} />
        <CycleCalendar className="lg:col-span-5" summary={summary} log={log} today={today} onPick={(date) => setSheet({ kind: 'day', date })} />
      </div>

      <BodyThroughCycle summary={summary} nights={nights} />

      {/* Its footer is the Cycle page's disclaimer: not a way to tell fertile days, nor contraception. */}
      <InsightsCarousel observations={insights} page="cycle" />

      {sheet?.kind === 'day' && <DaySheet date={sheet.date} onClose={close} />}
      {sheet?.kind === 'start' && <StartSheet suggest={sheet.suggest} onClose={close} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────── today

const span = (min: number, max: number) => (min === max ? formatRounded(min, 0) : t('cycle.span', { min, max }));

const PHASE_KEY: Record<Phase, MessageKey> = {
  menstrual: 'cycle.phases.menstrual',
  follicular: 'cycle.phases.follicular',
  ovulation: 'cycle.phases.ovulation',
  earlyLuteal: 'cycle.phases.earlyLuteal',
  lateLuteal: 'cycle.phases.lateLuteal',
};

/** The ± after a day or a length, quieter than the number it qualifies. */
const soft = (w: React.ReactNode) => <span className="text-zinc-400">{w}</span>;

/** "Day 22", or "About day 22 ±3" when the start was found in the nights. */
const dayWords = (day: number, pm: number) => (pm ? rich('cycle.aboutDay', { day, pm, soft }) : t('cycle.day', { day }));

/** An ovulation mark inside a day: a short amber bar at its foot, as bright as it is likely. */
function OvulationBar({ alpha, inset = 'inset-x-[18%]' }: { alpha: number; inset?: string }) {
  if (alpha <= 0) return null;
  return <span aria-hidden="true" className={`absolute ${inset} bottom-[3px] h-[3px] rounded-full`} style={{ background: tint('var(--amber-400)', Math.round(alpha * 100)) }} />;
}

function CycleHero({
  summary, log, nights, today, onLog, onStarted, className = '',
}: {
  summary: CycleSummary;
  log: CycleLog;
  nights: Night[];
  today: CivilDate;
  onLog: () => void;
  onStarted: (suggest: CivilDate | null) => void;
  className?: string;
}) {
  const { setDay, setRejected } = useCycle();
  const c = summary.current;
  const actions = (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={onLog} className="min-h-11 px-4 rounded-xl bg-zinc-50 text-zinc-950 text-body-sm font-semibold hover:bg-white transition-colors">
        {t('cycle.actions.logToday')}
      </button>
      <button type="button" onClick={() => onStarted(null)} className="min-h-11 px-4 rounded-xl border border-pink-400 text-pink-200 text-body-sm font-medium hover:bg-pink-500/10 transition-colors">
        {t('cycle.actions.started')}
      </button>
    </div>
  );

  if (!c) {
    const none = summary.status === 'no-rhythm';
    return (
      <section aria-labelledby="cycle-hero" className={`bg-card border border-card-edge rounded-[28px] p-6 md:p-10 ${className}`}>
        <p className="text-eyebrow uppercase text-pink-300">{t('cycle.eyebrow')}</p>
        <h1 id="cycle-hero" className="mt-2 font-display text-display-lg text-zinc-50">
          {none ? t('cycle.noRhythm.title') : t('cycle.collecting.title')}
        </h1>
        <p className="mt-3 text-body-lg text-zinc-300 max-w-[52ch] leading-relaxed">{none ? t('cycle.noRhythm.text') : t('cycle.collecting.text')}</p>
        {none && <p className="mt-2 text-body text-zinc-400 max-w-[52ch]">{t('cycle.noRhythm.logged')}</p>}
        <div className="mt-6">{actions}</div>
      </section>
    );
  }

  const shape = currentShape(summary)!;
  const phase = phaseOn(c.day, shape);
  const pm = dayPlusMinus(c);
  const shifts = sinceRise(nights, summary);
  const next = summary.next;
  const complete = summary.cycles.filter((x) => x.length !== null && x.length >= MIN_CYCLE && x.length <= MAX_CYCLE).length;
  const b = (w: React.ReactNode) => <strong className="font-semibold text-zinc-50">{w}</strong>;
  const nextLine = !next
    ? t('cycle.next.collecting', { count: Math.max(1, MIN_CYCLES - complete) })
    : today > next.to
      ? t('cycle.next.past', { date: formatDayMonthLong(next.to) })
      : next.basis === 'early'
        ? rich('cycle.next.early', { from: formatDayMonthLong(next.from), to: formatDayMonthLong(next.to), b })
        : next.from === next.to
          ? rich('cycle.next.day', { date: formatDayMonthLong(next.from), b })
          : rich('cycle.next.range', { from: formatDayMonthLong(next.from), to: formatDayMonthLong(next.to), b });
  const pending = c.source === 'found' && c.day <= 10;
  const existing = log.days.find((d) => d.date === c.start);

  const reached: { title: string; detail: string; value: string; color: string }[] = [
    {
      title: t('cycle.reached.start', { source: c.source, date: formatDayMonthLong(c.start) }),
      detail: t('cycle.reached.startDetail', { source: c.source, day: c.day, pm }),
      value: pm ? t('cycle.aboutDayPlain', { day: c.day }) : t('cycle.day', { day: c.day }),
      color: 'text-zinc-50',
    },
  ];
  if (summary.length) {
    reached.push({
      title: t('cycle.reached.cycles', { count: summary.length.count, min: summary.length.min, max: summary.length.max }),
      detail: t('cycle.reached.cyclesDetail', { logged: summary.length.logged, found: summary.length.found, typical: summary.length.typical }),
      value: span(summary.length.min, summary.length.max),
      color: 'text-zinc-50',
    });
  }
  if (!summary.length && summary.early) {
    reached.push({
      title: t('cycle.reached.early', { same: summary.early.min === summary.early.max ? 'yes' : 'no', min: summary.early.min, max: summary.early.max }),
      detail: t('cycle.reached.earlyDetail'),
      value: span(summary.early.min, summary.early.max),
      color: 'text-zinc-50',
    });
  }
  if (c.riseDay) {
    reached.push({
      title: t('cycle.reached.rise', { day: c.riseDay }),
      detail: t('cycle.reached.riseDetail', { days: SECOND_HALF_DAYS }),
      value: shifts?.temp !== null && shifts?.temp !== undefined ? t('cycle.signed', { sign: shifts.temp >= 0 ? 'up' : 'down', value: formatFixed(Math.abs(shifts.temp), 2), unit: t('units.celsius') }) : '',
      color: 'text-violet-300',
    });
  }
  if (next) {
    // The days from this cycle's start the range puts the period on.
    const [min, max] = [daysBetween(c.start, next.from), daysBetween(c.start, next.to)];
    reached.push({
      title: t('cycle.reached.next', { basis: next.basis, min, max }),
      detail: t('cycle.reached.nextDetail', { from: formatDayMonthLong(next.from), to: formatDayMonthLong(next.to) }),
      value: next.from === next.to ? formatCivil(next.from) : formatCivilRange(next.from, next.to),
      color: 'text-pink-300',
    });
  }

  return (
    <section aria-labelledby="cycle-hero" className={`bg-card border border-card-edge rounded-[28px] p-6 md:p-10 flex flex-col gap-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-eyebrow uppercase text-pink-300">{t('cycle.eyebrow')}</p>
          {/* The phase first and the day second: a found start is only as sure as the nights it came from. */}
          <h1 id="cycle-hero" className="mt-1.5 font-display text-display-lg md:text-number-xl text-zinc-50">
            {t(PHASE_KEY[phase])}
            {(pm > 0 || phase === 'ovulation') && (
              <span className="ml-3 inline-block align-middle px-2.5 py-0.5 rounded-full border border-zinc-700 font-sans text-body-sm font-medium tracking-normal text-violet-300">
                {t('cycle.likely')}
              </span>
            )}
          </h1>
          <p className="mt-2 font-display text-display" style={{ color: PHASE_TEXT[phase] }}>{dayWords(c.day, pm)}</p>
          <p className="mt-2.5 text-body-lg text-zinc-300 max-w-[46ch]">
            {t('cycle.start', { source: c.source, date: formatDayMonthLong(c.start) })} {nextLine}
          </p>
        </div>
        {actions}
      </div>

      {pending && (
        <div className="rounded-2xl border border-pink-500/30 bg-pink-500/[0.06] p-4 md:p-5">
          <h2 className="font-display text-title text-pink-100">{t('cycle.found.title')}</h2>
          <p className="mt-1.5 text-body-sm text-zinc-300 leading-relaxed">
            {t('cycle.found.text', { learned: summary.offsetLearned ? 'yes' : 'no', date: formatCivilLong(c.start) })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDay({ ...existing, date: c.start, flow: existing?.flow ?? 'unspecified' })}
              className="min-h-11 px-4 rounded-xl bg-zinc-50 text-zinc-950 text-body-sm font-semibold hover:bg-white transition-colors"
            >
              {t('cycle.found.confirm')}
            </button>
            <button type="button" onClick={() => onStarted(c.start)} className="min-h-11 px-4 rounded-xl border border-zinc-600 text-zinc-200 text-body-sm font-medium hover:bg-zinc-800 transition-colors">
              {t('cycle.found.change')}
            </button>
            <button type="button" onClick={() => setRejected(c.start, true)} className="min-h-11 px-2 text-body-sm text-zinc-400 underline underline-offset-2 hover:text-zinc-200">
              {t('cycle.found.reject')}
            </button>
          </div>
          <p className="mt-2.5 text-caption text-zinc-500">{t('cycle.found.note')}</p>
        </div>
      )}

      <CycleStrip summary={summary} />

      <Contributors>
        {reached.map((r) => (
          <div key={r.title} className="flex items-baseline justify-between gap-4 py-3 border-t border-zinc-800/80">
            <div className="min-w-0">
              <div className="text-body text-zinc-200">{r.title}</div>
              <div className="mt-0.5 text-detail text-zinc-500">{r.detail}</div>
            </div>
            <div className={`shrink-0 font-display text-title tabular-nums ${r.color}`}>{r.value}</div>
          </div>
        ))}
      </Contributors>
    </section>
  );
}

type StripLabel = { key: string; text: string; color: string; at: number; anchor: 'start' | 'centre' | 'end' };

/**
 * The labels under the strip that fit side by side at a width: today's phase first, then the
 * period, the likely next one, ovulation and the follicular phase, each left out where it would
 * run into one already placed. Sizes are estimates; a label is short and the gap generous.
 */
function placeLabels(labels: StripLabel[], cells: number, width: number): StripLabel[] {
  const placed: { from: number; to: number }[] = [];
  const out: StripLabel[] = [];
  for (const l of labels) {
    const w = l.text.length * 5.6 + 8;
    const x = l.anchor === 'start' ? ((l.at - 1) / cells) * width : l.anchor === 'centre' ? ((l.at - 0.5) / cells) * width : width;
    const from = l.anchor === 'start' ? x : l.anchor === 'centre' ? x - w / 2 : x - w;
    const box = { from: Math.max(0, from), to: Math.min(width, from + w) };
    if (placed.some((p) => box.from < p.to && p.from < box.to)) continue;
    placed.push(box);
    out.push(l);
  }
  return out;
}

/**
 * The cycle as a row of days, each in its phase's colour and blended where the boundary is unsure:
 * a found period dimmer, ovulation as a mark inside the days it could be, days to come muted, and
 * the days the next period is likely on dashed.
 */
function CycleStrip({ summary }: { summary: CycleSummary }) {
  const c = summary.current!;
  const shape = currentShape(summary)!;
  const next = summary.next;
  const dayOf = (date: CivilDate) => daysBetween(c.start, date) + 1;
  const from = next ? dayOf(next.from) : null;
  const to = next ? dayOf(next.to) : null;
  const likely = next ? dayOf(next.likely) : null;
  const length = Math.min(MAX_CYCLE, Math.max(28, c.day + 2, to ?? 0));
  const cells = Array.from({ length }, (_, i) => {
    const d = i + 1;
    const past = d <= c.day;
    const inNext = from !== null && to !== null && d >= from && d <= to;
    const colour = dayColour(d, shape);
    const style: React.CSSProperties = inNext
      ? { background: d === likely ? tint('var(--pink-400)', 28) : 'transparent', border: `1px dashed ${PINK}` }
      : { background: past ? colour : mix(colour, PAGE_GROUND, 0.62) };
    return { d, style, height: d === c.day ? 34 : 24, ovulation: inNext ? 0 : ovulationAlpha(d, shape, !past) };
  });

  const phase = phaseOn(c.day, shape);
  const ovulation = ovulationWindow(shape);
  const candidates: StripLabel[] = [
    { key: 'today', text: t(PHASE_KEY[phase]), color: PHASE_TEXT[phase], at: c.day, anchor: 'centre' },
    ...(phase === 'menstrual' ? [] : [{ key: 'menstrual', text: t(PHASE_KEY.menstrual), color: PHASE_TEXT.menstrual, at: 1, anchor: 'start' as const }]),
    ...(from !== null && from > c.day ? [{ key: 'next', text: t('cycle.strip.next'), color: PHASE_TEXT.menstrual, at: length, anchor: 'end' as const }] : []),
    ...(ovulation && phase !== 'ovulation' ? [{ key: 'ovulation', text: t(PHASE_KEY.ovulation), color: PHASE_TEXT.ovulation, at: ovulation.day, anchor: 'centre' as const }] : []),
    ...(phase === 'follicular' ? [] : [{ key: 'follicular', text: t(PHASE_KEY.follicular), color: PHASE_TEXT.follicular, at: shape.periodDays + 2, anchor: 'start' as const }]),
  ];
  const row = (labels: StripLabel[]) => labels.map((l) => (
    <span
      key={l.key}
      className="absolute whitespace-nowrap text-note"
      style={{
        color: l.color,
        ...(l.anchor === 'end' ? { right: 0 } : { left: `${(((l.at - (l.anchor === 'centre' ? 0.5 : 1)) / length) * 100).toFixed(2)}%` }),
        ...(l.anchor === 'centre' ? { transform: 'translateX(-50%)' } : {}),
      }}
    >
      {l.text}
    </span>
  ));

  const label = t('cycle.strip.label', {
    phase: t(PHASE_KEY[phase]),
    about: dayPlusMinus(c) ? 'yes' : 'no',
    day: c.day,
    rise: c.riseDay ? 'yes' : 'no',
    riseDay: c.riseDay ?? 0,
    next: from !== null && to !== null ? 'yes' : 'no',
    from: from ?? 0,
    to: to ?? 0,
  });
  return (
    <div role="img" aria-label={label}>
      <div aria-hidden="true" className="flex gap-[3px] h-4">
        {cells.map((x) => (
          <div key={x.d} className="flex-1 min-w-0 whitespace-nowrap overflow-visible text-note font-semibold text-zinc-50">
            {x.d === c.day ? t('cycle.strip.today') : ''}
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="mt-1 flex gap-[3px] items-end h-[34px]">
        {cells.map((x) => (
          <div key={x.d} className="relative flex-1 min-w-0 rounded-[4px] box-border" style={{ ...x.style, height: x.height }}>
            <OvulationBar alpha={x.ovulation} />
          </div>
        ))}
      </div>
      {/* Wide, the strip has room for every phase's name; narrow, for today's, the period's and the next one's. */}
      <div aria-hidden="true" className="relative mt-2 h-4 hidden md:block">{row(placeLabels(candidates, length, 560))}</div>
      <div aria-hidden="true" className="relative mt-2 h-4 md:hidden">{row(placeLabels(candidates, length, 300))}</div>
    </div>
  );
}

/** Where in the cycle today is, and how the nights since the luteal phase began differ from the ones before it. */
function NowCard({ summary, nights, className = '' }: { summary: CycleSummary; nights: Night[]; className?: string }) {
  const c = summary.current;
  if (!c) return null;
  const shape = currentShape(summary)!;
  const phase = phaseOn(c.day, shape);
  const pm = dayPlusMinus(c);
  const after = c.phase === 'after-rise' && c.riseDay !== null;
  const shifts = sinceRise(nights, summary);
  const rows: { name: string; value: string }[] = shifts
    ? ([
      ['temp', 'cycle.now.rows.temp', 2, t('units.celsius')],
      ['sleepHr', 'cycle.now.rows.sleepHr', 1, t('units.bpm')],
      ['hrv', 'cycle.now.rows.hrv', 0, t('units.ms')],
    ] as const).flatMap(([key, name, digits, unit]) => {
      const v = shifts[key];
      return v === null ? [] : [{ name: t(name), value: t('cycle.signed', { sign: v >= 0 ? 'up' : 'down', value: formatFixed(Math.abs(v), digits), unit }) }];
    })
    : [];
  return (
    <Card className={`p-5 ${className}`}>
      <p className="text-eyebrow uppercase" style={{ color: PHASE_TEXT[phase] }}>{t(PHASE_KEY[phase])}</p>
      <p className="mt-2 font-display text-number-md text-zinc-50">
        {dayWords(after ? c.day - c.riseDay! + 1 : c.day, pm)}
        {after && (
          <span className="ml-2 font-sans text-body-sm font-medium text-zinc-400">{t('cycle.now.afterRise.of', { days: SECOND_HALF_DAYS })}</span>
        )}
      </p>
      <p className="mt-2 text-detail leading-relaxed text-zinc-400">
        {after
          ? t('cycle.now.afterRise.text', { day: c.riseDay! })
          : summary.riseDay
            ? t('cycle.now.beforeRise.text', { days: span(summary.riseDay.min, summary.riseDay.max) })
            : t('cycle.now.beforeRise.unknown')}
      </p>
      {after && rows.length > 0 && (
        <div className="mt-3">
          {rows.map((r) => (
            <div key={r.name} className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
              <span className="text-zinc-400">{r.name}</span>
              <span className="text-zinc-50 tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** A found period's swatch: dim pink brightening, as the strip and the bars draw it. */
const FoundSwatch = () => (
  <span aria-hidden="true" className="inline-block w-3.5 h-2.5 rounded-[3px] shrink-0" style={{ background: `linear-gradient(to right, ${mix(PHASE_HEX.menstrual, PAGE_GROUND, 0.8)}, ${mix(PHASE_HEX.menstrual, PAGE_GROUND, 0.35)})` }} />
);

/**
 * The last period: the one found in the nights when this cycle's start was found after the last
 * logged one, with a way to log it; else the last logged one, how long and how heavy it was, and
 * the usual length.
 */
function LastPeriodCard({ summary, log, today, onStarted, className = '' }: {
  summary: CycleSummary;
  log: CycleLog;
  today: CivilDate;
  onStarted: (suggest: CivilDate | null) => void;
  className?: string;
}) {
  const last = loggedPeriods(log.days).filter((p) => p.start <= today).at(-1);
  const c = summary.current;
  const usual = summary.period && (
    <div className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
      <span className="text-zinc-400">{t('cycle.lastPeriod.usual')}</span>
      <span className="text-zinc-50">{t('cycle.lastPeriod.usualRange', { days: span(summary.period.min, summary.period.max) })}</span>
    </div>
  );
  if (c && c.source === 'found' && (!last || c.start > last.start)) {
    return (
      <Card className={`p-5 ${className}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-eyebrow uppercase text-pink-300">{t('cycle.lastPeriod.eyebrow')}</p>
          <button type="button" onClick={() => onStarted(c.start)} className="-my-2 -mr-2 min-h-11 px-2 text-caption text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
            {t('cycle.lastPeriod.logIt')}
          </button>
        </div>
        <p className="mt-2 font-display text-headline text-zinc-50">{t('cycle.lastPeriod.around', { date: formatDayMonthLong(c.start) })}</p>
        <div className="mt-3">
          <div className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
            <span className="flex items-center gap-2 text-zinc-400"><FoundSwatch />{t('cycle.lastPeriod.found')}</span>
            <span className="text-zinc-50 text-right">{t('cycle.lastPeriod.foundDetail', { pm: dayPlusMinus(c) })}</span>
          </div>
          <div className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
            <span className="text-zinc-400">{t('cycle.lastPeriod.length')}</span>
            <span className="text-zinc-50">{t('cycle.lastPeriod.notLogged')}</span>
          </div>
          {usual}
        </div>
      </Card>
    );
  }
  if (!last) return null;
  const flows = log.days.filter((d) => d.date >= last.start && d.date <= last.end).map((d) => d.flow);
  const heaviest = [...HEAVINESS].reverse().find((f) => flows.includes(f)) ?? null;
  const ongoing = last.end >= addDays(today, -1);
  return (
    <Card className={`p-5 ${className}`}>
      <p className="text-eyebrow uppercase text-pink-300">{t('cycle.lastPeriod.eyebrow')}</p>
      <p className="mt-2 font-display text-headline text-zinc-50">
        {last.start === last.end ? formatDayMonthLong(last.start) : formatCivilRange(last.start, last.end)}
      </p>
      <div className="mt-3">
        <div className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
          <span className="text-zinc-400">{t('cycle.lastPeriod.length')}</span>
          <span className="text-zinc-50">
            {last.length === null ? (ongoing ? t('cycle.lastPeriod.ongoing') : t('cycle.lastPeriod.startOnly')) : t('cycle.days', { count: last.length })}
          </span>
        </div>
        {heaviest && (
          <div className="flex justify-between gap-3 py-2 border-t border-zinc-800/80 text-body-sm">
            <span className="text-zinc-400">{t('cycle.lastPeriod.heaviest')}</span>
            <span className="text-zinc-50">{t(FLOW_LABEL[heaviest])}</span>
          </div>
        )}
        {usual}
      </div>
    </Card>
  );
}

/** What's logged for today, and the way to log or change it. */
function LoggedDayCard({ log, today, onLog, className = '' }: { log: CycleLog; today: CivilDate; onLog: () => void; className?: string }) {
  const day = log.days.find((d) => d.date === today);
  const chips = [
    ...(day?.flow ? [t(FLOW_LABEL[day.flow])] : []),
    ...(day?.symptoms ?? []).map((s) => t(SYMPTOM_LABEL[s])),
  ];
  return (
    <Card className={`p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-eyebrow uppercase text-zinc-400">{t('cycle.logged.eyebrow')}</h2>
        <button type="button" onClick={onLog} className="-my-2 -mr-2 min-h-11 px-2 text-caption text-zinc-300 underline underline-offset-2 hover:text-zinc-100">
          {day ? t('cycle.logged.change') : t('cycle.logged.add')}
        </button>
      </div>
      {chips.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c} className="px-3 py-1.5 rounded-full bg-zinc-800 text-zinc-200 text-detail">{c}</span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-detail text-zinc-500">{t('cycle.logged.none')}</p>
      )}
      {day?.note && <p className="mt-2 text-detail text-zinc-400">{day.note}</p>}
    </Card>
  );
}

// ──────────────────────────────────────────────────────── through the cycle

const CHART_DAYS = 35;
const MEASURES = [
  { field: 'temp', name: 'cycle.body.rows.temp', unit: 'units.celsius', digits: 2, signed: true },
  { field: 'sleepHr', name: 'cycle.body.rows.sleepHr', unit: 'units.bpm', digits: 0, signed: false },
  { field: 'hrv', name: 'cycle.body.rows.hrv', unit: 'units.ms', digits: 0, signed: false },
] as const;

/**
 * Temperature, the sleeping heart rate the finder reads (the night's floor, shown as the basal
 * resting heart rate) and HRV by cycle day: this cycle over the middle of the last six,
 * shaded by this cycle's phases as the strip draws them. The legend names only what's drawn.
 */
function BodyThroughCycle({ summary, nights }: { summary: CycleSummary; nights: Night[] }) {
  const c = summary.current;
  const shifts = sinceRise(nights, summary);
  const rows = MEASURES.map((m) => ({ ...m, points: byCycleDay(nights, summary, m.field, CHART_DAYS) }));
  const pastCount = summary.cycles.filter((x) => x.length !== null && x.length >= MIN_CYCLE && x.length <= MAX_CYCLE).slice(-6).length;
  const hasBand = rows.some((r) => r.points.some((p) => p.middle !== null));
  if (!c && !hasBand) return null;
  const shape = currentShape(summary);
  const pm = c ? dayPlusMinus(c) : 0;
  const ticks = [1, 7, 14, 21, 28, 35].filter((d) => !c || Math.abs(d - c.day) >= 3);

  return (
    <Card>
      <CardHead
        title={t('cycle.body.title')}
        hint={hasBand ? t('cycle.body.hint', { count: pastCount }) : t('cycle.body.hintFew')}
        domain="cycle"
      />
      <div className="px-5 pb-4">
        <div className="pb-3 flex flex-wrap gap-x-3.5 gap-y-1.5 text-caption text-zinc-400">
          {c && <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-zinc-50" />{t('cycle.body.legend.mine')}</span>}
          {hasBand && <span className="flex items-center gap-1.5"><span className="w-4 h-2.5 rounded-sm bg-zinc-700" />{t('cycle.body.legend.usual')}</span>}
          {shape && (shape.foundStart
            ? <span className="flex items-center gap-1.5"><FoundSwatch />{t('cycle.body.legend.periodFound')}</span>
            : <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-pink-400/35" />{t('cycle.body.legend.period')}</span>)}
          {shape?.luteal && <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-violet-400/35" />{t('cycle.body.legend.luteal')}</span>}
          {shape?.luteal && <span className="flex items-center gap-1.5"><span className="w-4 h-[3px] rounded-full" style={{ background: OVULATION_DASH }} />{t('cycle.body.legend.ovulation')}</span>}
        </div>
        {rows.map((r) => {
          const latest = [...r.points].reverse().find((p) => p.mine !== null)?.mine ?? null;
          const shift = shifts?.[r.field] ?? null;
          const unit = t(r.unit);
          return (
            <div key={r.field} className="py-4 border-t border-zinc-800/60 flex flex-wrap items-center gap-x-5 gap-y-3">
              <div className="flex-[1_1_170px] min-w-0">
                <div className="text-body-sm text-zinc-200">{t(r.name)}</div>
                <div className="mt-0.5 font-display text-number-sm text-zinc-50 tabular-nums">
                  {latest === null
                    ? '—'
                    : r.signed
                      ? t('cycle.signedValue', { sign: latest >= 0 ? 'up' : 'down', value: formatFixed(Math.abs(latest), r.digits) })
                      : formatRounded(latest, r.digits)}
                  <span className="ml-1.5 font-sans text-caption font-medium text-zinc-500">{unit}</span>
                </div>
                {shift !== null && c?.riseDay && (
                  <div className="mt-0.5 text-caption text-violet-300">
                    {t('cycle.body.change', { change: formatFixed(Math.abs(shift), r.digits), unit, direction: shift >= 0 ? 'up' : 'down', day: c.riseDay, about: pm ? 'yes' : 'no' })}
                  </div>
                )}
              </div>
              <div className="flex-[999_1_280px] min-w-0">
                <CycleChart
                  points={r.points}
                  today={c?.day ?? null}
                  shape={shape}
                  label={t('cycle.body.chart', { name: t(r.name) })}
                />
              </div>
            </div>
          );
        })}
        <div aria-hidden="true" className="flex flex-wrap gap-x-5">
          <div className="flex-[1_1_170px]" />
          <div className="flex-[999_1_280px] relative h-4 text-note text-zinc-500">
            {ticks.map((d) => (
              <span key={d} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: `${((d - 1) / (CHART_DAYS - 1)) * 100}%` }}>
                {d === 1 ? t('cycle.body.axisDay', { day: d }) : d}
              </span>
            ))}
            {c && c.day <= CHART_DAYS && (
              <span className="absolute -translate-x-1/2 font-semibold text-zinc-50" style={{ left: `${((c.day - 1) / (CHART_DAYS - 1)) * 100}%` }}>
                {t('cycle.strip.today')}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * One measure by cycle day, drawn to fill its width: lines keep their weight as it stretches. The
 * period and the luteal phase shade the ground, each fading in over the days it could begin on,
 * and ovulation is a dash along the foot.
 */
function CycleChart({
  points, today, shape, label,
}: {
  points: ReturnType<typeof byCycleDay>;
  today: number | null;
  shape: CycleShape | null;
  label: string;
}) {
  const gid = useId().replace(/:/g, '');
  const W = 340;
  const H = 90;
  const all = points.flatMap((p) => [p.low, p.high, p.mine]).filter((v): v is number => v !== null);
  if (!all.length) return <div className="h-[90px] rounded-lg bg-faint/60" />;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.12;
  const x = (d: number) => ((d - 1) / (CHART_DAYS - 1)) * W;
  const y = (v: number) => H - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * H;
  const banded = points.filter((p) => p.low !== null && p.high !== null);
  const band = banded.length > 1
    ? `M${banded.map((p) => `${x(p.day).toFixed(1)} ${y(p.high!).toFixed(1)}`).join(' L')} L${[...banded].reverse().map((p) => `${x(p.day).toFixed(1)} ${y(p.low!).toFixed(1)}`).join(' L')} Z`
    : null;
  let mine = '';
  let pen = false;
  for (const p of points) {
    if (p.mine === null) {
      pen = false;
      continue;
    }
    mine += `${pen ? ' L' : ' M'}${x(p.day).toFixed(1)} ${y(p.mine).toFixed(1)}`;
    pen = true;
  }
  const last = [...points].reverse().find((p) => p.mine !== null);
  const period = shape && { from: x(0.5), to: x(shape.periodDays + 0.5 + shape.periodBlend) };
  const luteal = shape?.luteal ? (() => {
    const from = x(shape.luteal - shape.lutealBlend - 0.5);
    const to = x((shape.length ?? CHART_DAYS) + 0.5);
    return { from, to, ramp: Math.min(1, (x(shape.luteal + shape.lutealBlend - 0.5) - from) / Math.max(1, to - from)) };
  })() : null;
  const ovulation = shape ? ovulationWindow(shape) : null;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-[90px]">
      <defs>
        <linearGradient id={`${gid}p`} x1="0" x2="1" y1="0" y2="0">
          {shape?.foundStart
            ? <><stop offset="0" stopColor={PINK} stopOpacity={0.04} /><stop offset="0.6" stopColor={PINK} stopOpacity={0.2} /><stop offset="0.72" stopColor={PINK} stopOpacity={0.2} /><stop offset="1" stopColor={PINK} stopOpacity={0} /></>
            : <><stop offset="0" stopColor={PINK} stopOpacity={0.13} /><stop offset="1" stopColor={PINK} stopOpacity={0.13} /></>}
        </linearGradient>
        <linearGradient id={`${gid}l`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={PHASE_HEX.earlyLuteal} stopOpacity={0} />
          <stop offset={luteal?.ramp ?? 0} stopColor={PHASE_HEX.earlyLuteal} stopOpacity={0.12} />
          <stop offset="1" stopColor={PHASE_HEX.earlyLuteal} stopOpacity={0.12} />
        </linearGradient>
        <linearGradient id={`${gid}o`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={PHASE_HEX.ovulation} stopOpacity={0} />
          <stop offset="0.4" stopColor={PHASE_HEX.ovulation} stopOpacity={0.95} />
          <stop offset="0.6" stopColor={PHASE_HEX.ovulation} stopOpacity={0.95} />
          <stop offset="1" stopColor={PHASE_HEX.ovulation} stopOpacity={0} />
        </linearGradient>
      </defs>
      {period && <rect x={period.from} y={0} width={period.to - period.from} height={H} fill={`url(#${gid}p)`} />}
      {luteal && <rect x={luteal.from} y={0} width={luteal.to - luteal.from} height={H} fill={`url(#${gid}l)`} />}
      {band && <path d={band} fill="var(--color-zinc-700)" fillOpacity={0.75} stroke="none" />}
      {today !== null && today <= CHART_DAYS && (
        <path d={`M${x(today)} 0 L${x(today)} ${H}`} stroke="var(--color-zinc-400)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      {ovulation && <rect x={x(ovulation.day - ovulation.spread)} y={H - 4} width={x(ovulation.day + ovulation.spread) - x(ovulation.day - ovulation.spread)} height={3} fill={`url(#${gid}o)`} />}
      {mine && <path d={mine} fill="none" stroke="var(--color-zinc-50)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {last && (
        <path
          d={`M${x(last.day)} ${y(last.mine!)} L${x(last.day)} ${y(last.mine!)}`}
          stroke="var(--color-zinc-50)"
          strokeWidth={7}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

// ──────────────────────────────────────────────────────────────── cycles

/** Bars are drawn on this many days, so cycles of different lengths line up. */
const BAR_DAYS = 35;
const pct = (days: number) => `${(Math.max(0, Math.min(days, BAR_DAYS)) / BAR_DAYS) * 100}%`;

/** A phase's swatch in a legend. */
const PhaseSwatch = ({ phase }: { phase: Phase }) => <span aria-hidden="true" className="inline-block w-3.5 h-2.5 rounded-[3px] shrink-0" style={{ background: PHASE_HEX[phase] }} />;

/** Each cycle as a bar, newest first, shaded from phase to phase, with how far its length may be off. */
function CycleHistory({ summary, today, className = '' }: { summary: CycleSummary; today: CivilDate; className?: string }) {
  const rows = [...summary.cycles].reverse().slice(0, 8);
  const nextOf = (c: Cycle) => summary.cycles[summary.cycles.indexOf(c) + 1] ?? null;
  return (
    <Card className={className}>
      <CardHead title={t('cycle.history.title')} hint={t('cycle.history.hint')} domain="cycle" />
      <div className="px-5 pb-5">
        {!rows.length && <p className="py-6 text-center text-detail text-zinc-500">{t('cycle.history.empty')}</p>}
        {rows.map((c) => (
          <CycleBar key={c.start} cycle={c} next={nextOf(c)} summary={summary} today={today} />
        ))}
        {rows.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-2 text-caption text-zinc-400">
            <span className="flex items-center gap-1.5"><PhaseSwatch phase="menstrual" />{t('cycle.history.legend.logged')}</span>
            <span className="flex items-center gap-1.5"><PhaseSwatch phase="follicular" />{t('cycle.phases.follicular')}</span>
            <span className="flex items-center gap-1.5"><PhaseSwatch phase="earlyLuteal" />{t('cycle.phases.earlyLuteal')}</span>
            <span className="flex items-center gap-1.5"><PhaseSwatch phase="lateLuteal" />{t('cycle.phases.lateLuteal')}</span>
            <span className="flex items-center gap-1.5"><span aria-hidden="true" className="inline-block w-[18px] h-[3px] rounded-full" style={{ background: OVULATION_DASH }} />{t('cycle.history.legend.ovulation')}</span>
            <span className="flex items-center gap-1.5"><FoundSwatch />{t('cycle.history.legend.found')}</span>
          </div>
        )}
        {summary.length && (
          <div className="mt-4 pt-4 border-t border-zinc-800/60 grid grid-cols-3 gap-3">
            <Stat label={t('cycle.history.stats.typical')} value={formatRounded(summary.length.typical, 0)} unit={t('cycle.history.stats.days')} />
            <Stat label={t('cycle.history.stats.range')} value={span(summary.length.min, summary.length.max)} unit={t('cycle.history.stats.days')} />
            <Stat
              label={t('cycle.history.stats.period')}
              value={summary.period ? span(summary.period.min, summary.period.max) : '—'}
              unit={summary.period ? t('cycle.history.stats.days') : ''}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div>
      <div className="text-eyebrow-sm uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-display text-number-xs text-zinc-50 tabular-nums">
        {value} <span className="font-sans text-caption font-medium text-zinc-500">{unit}</span>
      </div>
    </div>
  );
}

function CycleBar({ cycle: c, next, summary, today }: { cycle: Cycle; next: Cycle | null; summary: CycleSummary; today: CivilDate }) {
  const current = c.next === null;
  const shape = cycleShape(c, next, summary);
  const end = current ? daysBetween(c.start, today) + 1 : c.length!;
  const typical = shape.length ?? 28;
  const drawn = Math.min(end, BAR_DAYS);
  const stops = Array.from({ length: drawn }, (_, i) => `${dayColour(i + 1, shape)} ${(((i + 0.5) / BAR_DAYS) * 100).toFixed(2)}%`).join(', ');
  const ovulation = ovulationWindow(shape);
  const showOvulation = ovulation && (!current || end >= ovulation.day - ovulation.spread);
  const pm = current ? dayPlusMinus(c) : lengthPlusMinus(c, next);
  const riseDay = c.rise ? daysBetween(c.start, c.rise) + 1 : null;
  const length = current ? t('cycle.day', { day: end }) : t('cycle.days', { count: c.length! });
  const shown = current
    ? (pm ? rich('cycle.dayPm', { day: end, pm, soft }) : length)
    : (pm ? rich('cycle.daysPm', { count: c.length!, pm, soft }) : length);
  const aria = t('cycle.history.row', {
    date: formatDayMonthLong(c.start),
    length,
    pm,
    source: c.source,
    rise: riseDay ? 'yes' : 'no',
    riseDay: riseDay ?? 0,
  });
  return (
    <div className="flex items-center gap-3 py-[7px]">
      <div className={`w-[52px] shrink-0 text-detail ${current ? 'text-zinc-50' : 'text-zinc-400'}`}>{formatCivil(c.start)}</div>
      <div role="img" aria-label={aria} className="relative flex-1 min-w-0 h-3.5 rounded-[7px] bg-faint">
        <div className={`absolute inset-y-0 left-0 ${current ? 'rounded-l-[7px]' : 'rounded-[7px]'}`} style={{ width: pct(drawn), background: `linear-gradient(to right, ${stops})` }} />
        {current && typical > end && (
          <div className="absolute inset-y-0 box-border rounded-r-[7px]" style={{ left: pct(end), width: pct(typical - end), border: '1px dashed var(--color-zinc-500)' }} />
        )}
        {showOvulation && (
          <div className="absolute top-1/2 -translate-y-1/2 h-[3px] rounded-full" style={{ left: pct(ovulation.day - 0.5 - ovulation.spread), width: pct(2 * ovulation.spread), background: OVULATION_DASH }} />
        )}
      </div>
      <div className={`w-[72px] shrink-0 text-right text-detail tabular-nums ${current ? 'text-zinc-50' : 'text-zinc-300'}`}>{shown}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── calendar

const BLEEDING: ReadonlySet<Flow> = new Set(['light', 'medium', 'heavy', 'unspecified']);
const monthOf = (date: CivilDate) => date.slice(0, 7);
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * A month at a glance: each day up to today shaded by its cycle's phase, ovulation as a mark inside
 * the days it could be, the likely window dashed, logged days dotted. Tap a day to log it.
 */
function CycleCalendar({
  summary, log, today, onPick, className = '',
}: {
  summary: CycleSummary;
  log: CycleLog;
  today: CivilDate;
  onPick: (date: CivilDate) => void;
  className?: string;
}) {
  const [month, setMonth] = useState(monthOf(today));
  const marks = useMemo(() => {
    const byDate = new Map(log.days.map((d) => [d.date, d]));
    const shapes = summary.cycles.map((c, i) => ({ cycle: c, shape: cycleShape(c, summary.cycles[i + 1] ?? null, summary) }));
    return {
      day: (date: CivilDate) => byDate.get(date),
      found: new Set(summary.cycles.filter((c) => c.source === 'found').map((c) => c.start)),
      rises: new Set(summary.cycles.map((c) => c.rise).filter((r): r is CivilDate => r !== null)),
      /** The cycle a date falls in, and its day of that cycle. */
      cycleOf: (date: CivilDate) => {
        const at = [...shapes].reverse().find((s) => s.cycle.start <= date && (s.cycle.next === null || date < s.cycle.next));
        return at ? { ...at, day: daysBetween(at.cycle.start, date) + 1 } : null;
      },
    };
  }, [log, summary]);
  const first = `${month}-01`;
  const lead = isoWeekdayIndex(first);
  const dates: CivilDate[] = [];
  for (let d = first; monthOf(d) === month; d = addDays(d, 1)) dates.push(d);
  const next = summary.next;
  const titleId = useId();

  return (
    <Card className={className}>
      <div className="px-5 pt-4 flex items-center justify-between gap-2">
        <h3 id={titleId} className="font-display text-title-sm text-zinc-100">{formatMonthYear(month)}</h3>
        <div className="flex gap-1">
          <button type="button" aria-label={t('cycle.calendar.previous')} onClick={() => setMonth(shiftMonth(month, -1))} className="size-10 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800">
            <span aria-hidden="true">‹</span>
          </button>
          <button
            type="button"
            aria-label={t('cycle.calendar.next')}
            disabled={month >= monthOf(today)}
            onClick={() => setMonth(shiftMonth(month, 1))}
            className="size-10 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
      <div className="px-5 pb-5">
        <div aria-hidden="true" className="mt-3 grid grid-cols-7 gap-1 text-center text-note font-semibold text-zinc-500">
          {Array.from({ length: 7 }, (_, i) => (
            // The language's weekdays start on Sunday; the calendar's on Monday.
            <span key={i}>{names('format.weekdaysNarrow')[(i + 1) % 7]}</span>
          ))}
        </div>
        <div role="group" aria-labelledby={titleId} className="mt-1.5 grid grid-cols-7 gap-1">
          {Array.from({ length: lead }, (_, i) => <span key={`lead-${i}`} />)}
          {dates.map((date) => {
            const logged = marks.day(date);
            const bleeding = !!logged?.flow && BLEEDING.has(logged.flow);
            const spotting = logged?.flow === 'spotting';
            const found = marks.found.has(date);
            const rose = marks.rises.has(date);
            const noted = !!(logged?.symptoms?.length || logged?.note);
            const likely = !!next && date >= next.from && date <= next.to && date > today;
            const isToday = date === today;
            const future = date > today;
            const inCycle = marks.cycleOf(date);
            const ovulation = inCycle && !likely ? ovulationAlpha(inCycle.day, inCycle.shape, future) : 0;
            const notes = [
              isToday && t('cycle.calendar.notes.today'),
              bleeding && t('cycle.calendar.notes.period'),
              spotting && t('cycle.calendar.notes.spotting'),
              found && t('cycle.calendar.notes.found'),
              rose && t('cycle.calendar.notes.rise'),
              ovulation >= 0.5 && t('cycle.calendar.notes.ovulation'),
              noted && t('cycle.calendar.notes.logged'),
              likely && (date === next!.likely ? t('cycle.calendar.notes.likelyDay') : t('cycle.calendar.notes.likely')),
            ].filter((n): n is string => !!n);
            const style: React.CSSProperties = likely
              ? date === next!.likely
                ? { background: tint('var(--pink-400)', 16), border: `1px dashed ${PINK}` }
                : { border: `1px dashed ${PINK}` }
              : inCycle && !future
                ? { background: mix(dayColour(inCycle.day, inCycle.shape), CARD_GROUND, 0.72) }
                : {};
            return (
              <button
                key={date}
                type="button"
                disabled={future}
                onClick={() => onPick(date)}
                aria-label={t('cycle.calendar.day', { date: formatCivilLong(date), notes: notes.length ? 'yes' : 'no', list: notes.join(', ') })}
                className={`relative h-10 rounded-[10px] box-border text-body-sm tabular-nums transition-colors ${
                  isToday ? 'ring-2 ring-zinc-50 font-bold' : 'font-medium'
                } ${future ? 'text-zinc-600' : 'text-zinc-200 hover:brightness-125'}`}
                style={style}
              >
                {Number(date.slice(8, 10))}
                {(noted || spotting) && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 bottom-2 size-[5px] -ml-[2.5px] rounded-full"
                    style={{ background: spotting ? PINK : 'var(--color-zinc-400)' }}
                  />
                )}
                <OvulationBar alpha={ovulation} inset="inset-x-1.5" />
              </button>
            );
          })}
        </div>
        <div className="mt-3.5 flex flex-wrap gap-x-3.5 gap-y-2 text-caption text-zinc-400">
          <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px]" style={{ background: `linear-gradient(to right, ${mix(PHASE_HEX.follicular, CARD_GROUND, 0.6)}, ${mix(PHASE_HEX.earlyLuteal, CARD_GROUND, 0.6)})` }} />{t('cycle.calendar.legend.phases')}</span>
          <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] box-border" style={{ border: `1px dashed ${PINK}` }} />{t('cycle.calendar.legend.likely')}</span>
          <span className="flex items-center gap-1.5"><span className="w-4 h-[3px] rounded-full" style={{ background: OVULATION_DASH }} />{t('cycle.calendar.legend.ovulation')}</span>
          <span className="flex items-center gap-1.5"><span className="size-[7px] rounded-full bg-zinc-400" />{t('cycle.calendar.legend.logged')}</span>
        </div>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────── sheets

/** Log one day: how heavy, how it felt, a note. */
function DaySheet({ date, onClose }: { date: CivilDate; onClose: () => void }) {
  const { log, summary, setDay } = useCycle();
  const existing = log.days.find((d) => d.date === date);
  const [flow, setFlow] = useState<Flow | 'none'>(existing?.flow ?? 'none');
  const [symptoms, setSymptoms] = useState<Set<Symptom>>(new Set(existing?.symptoms ?? []));
  const [note, setNote] = useState(existing?.note ?? '');
  const titleId = useId();
  const noteId = useId();
  const c = summary?.current;
  const cycleDay = c && date >= c.start ? daysBetween(c.start, date) + 1 : null;
  const running = loggedPeriods(log.days.filter((d) => d.date !== date)).find((p) => daysBetween(p.end, date) >= 0 && daysBetween(p.end, date) <= 2);
  const flowNote = flow === 'none'
    ? t('cycle.sheet.day.flowNote.none')
    : flow === 'spotting'
      ? t('cycle.sheet.day.flowNote.spotting')
      : running
        ? t('cycle.sheet.day.flowNote.continues', { date: formatDayMonthLong(running.start) })
        : t('cycle.sheet.day.flowNote.starts');
  const save = () => {
    setDay({
      date,
      ...(flow !== 'none' ? { flow } : {}),
      ...(symptoms.size ? { symptoms: [...symptoms] } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    onClose();
  };
  // A start logged without saying how heavy keeps that until a flow is picked.
  const flowOptions: { id: Flow | 'none'; label: string }[] = [
    ...PICKED_FLOWS.map((id) => ({ id, label: t(FLOW_LABEL[id]) })),
    ...(existing?.flow === 'unspecified' ? [{ id: 'unspecified' as const, label: t(FLOW_LABEL.unspecified) }] : []),
  ];

  return (
    <Sheet labelledBy={titleId} onClose={onClose}>
      <p className="text-eyebrow uppercase text-pink-300">{cycleDay ? t('cycle.sheet.day.eyebrow', { day: cycleDay }) : t('cycle.sheet.day.eyebrowPlain')}</p>
      <h2 id={titleId} className="mt-1 pr-12 font-display text-headline text-zinc-50">{formatCivilLong(date)}</h2>

      <div className="mt-5">
        <p className="text-body font-semibold text-zinc-50">{t('cycle.sheet.day.flow')}</p>
        <div className="mt-2.5">
          <Chips label={t('cycle.sheet.day.flow')} tone="pink" options={flowOptions} on={(id) => flow === id} onToggle={(id) => setFlow(id)} />
        </div>
        <p className="mt-2 text-caption text-zinc-400">{flowNote}</p>
      </div>

      <div className="mt-5">
        <p className="text-body font-semibold text-zinc-50">{t('cycle.sheet.day.feel')}</p>
        <div className="mt-2.5">
          <Chips
            label={t('cycle.sheet.day.feel')}
            options={(Object.keys(SYMPTOM_LABEL) as Symptom[]).map((id) => ({ id, label: t(SYMPTOM_LABEL[id]) }))}
            on={(id) => symptoms.has(id)}
            onToggle={(id) => {
              const next = new Set(symptoms);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setSymptoms(next);
            }}
          />
        </div>
      </div>

      <div className="mt-5">
        <label htmlFor={noteId} className="block text-body font-semibold text-zinc-50">{t('cycle.sheet.day.note')}</label>
        <textarea
          id={noteId}
          rows={3}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('cycle.sheet.day.notePlaceholder')}
          className="mt-2.5 w-full box-border p-3 rounded-xl border border-zinc-700 bg-zinc-950 text-body-sm text-zinc-100 placeholder:text-zinc-500 resize-none"
        />
      </div>

      <p className="mt-4 text-caption text-zinc-400">{t('cycle.sheet.private')}</p>
      <button type="button" onClick={save} className="mt-3 w-full min-h-12 rounded-xl bg-zinc-50 text-zinc-950 text-body font-semibold hover:bg-white transition-colors">
        {t('cycle.sheet.save')}
      </button>
    </Sheet>
  );
}

/** "My period started": today, a day or two ago, or another day, with what the nights suggest. */
function StartSheet({ suggest, onClose }: { suggest: CivilDate | null; onClose: () => void }) {
  const { today } = useCycle();
  return today ? <StartSheetFor today={today} suggest={suggest} onClose={onClose} /> : null;
}

function StartSheetFor({ today, suggest, onClose }: { today: CivilDate; suggest: CivilDate | null; onClose: () => void }) {
  const { log, summary, setDay } = useCycle();
  const quick = [
    { id: 'today', date: today },
    { id: 'yesterday', date: addDays(today, -1) },
    { id: 'two', date: addDays(today, -2) },
  ] as const;
  const suggested = suggest ? quick.find((q) => q.date === suggest)?.id ?? 'pick' : 'today';
  const [choice, setChoice] = useState<'today' | 'yesterday' | 'two' | 'pick'>(suggested);
  const [picked, setPicked] = useState<CivilDate>(suggest ?? addDays(today, -3));
  const [month, setMonth] = useState(monthOf(suggest ?? today));
  const [flow, setFlow] = useState<Flow | null>(null);
  const titleId = useId();
  const date = choice === 'pick' ? picked : quick.find((q) => q.id === choice)!.date;
  // The cycle this start ends: the latest that began before it, other than one a few days off it, which it replaces.
  const before = summary?.cycles.filter((c) => daysBetween(c.start, date) > 5).at(-1) ?? null;
  const lastLength = before ? daysBetween(before.start, date) : null;
  const usual = summary?.length ?? null;
  const short = lastLength !== null && lastLength < 20;
  const existing = log.days.find((d) => d.date === date);
  const save = () => {
    setDay({ ...existing, date, flow: flow ?? (existing?.flow && existing.flow !== 'spotting' ? existing.flow : 'unspecified') });
    onClose();
  };
  const quickLabel: Record<(typeof quick)[number]['id'] | 'pick', MessageKey> = {
    today: 'cycle.sheet.start.today',
    yesterday: 'cycle.sheet.start.yesterday',
    two: 'cycle.sheet.start.twoDays',
    pick: 'cycle.sheet.start.another',
  };
  const first = `${month}-01`;
  const days: CivilDate[] = [];
  for (let d = first; monthOf(d) === month; d = addDays(d, 1)) days.push(d);

  return (
    <Sheet labelledBy={titleId} onClose={onClose}>
      <p className="text-eyebrow uppercase text-pink-300">{formatCivilLong(today)}</p>
      <h2 id={titleId} className="mt-1 pr-12 font-display text-headline text-zinc-50">{t('cycle.sheet.start.title')}</h2>
      {suggest && <p className="mt-1.5 text-body-sm text-violet-300">{t('cycle.sheet.start.suggest', { date: formatCivilLong(suggest) })}</p>}

      <div className="mt-4">
        <Chips
          label={t('cycle.sheet.start.title')}
          tone="pink"
          options={(['today', 'yesterday', 'two', 'pick'] as const).map((id) => ({ id, label: t(quickLabel[id]) }))}
          on={(id) => choice === id}
          onToggle={(id) => setChoice(id)}
        />
      </div>

      {choice === 'pick' && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-body-sm text-zinc-300">{formatMonthYear(month)}</p>
            <div className="flex gap-1">
              <button type="button" aria-label={t('cycle.calendar.previous')} onClick={() => setMonth(shiftMonth(month, -1))} className="size-10 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                <span aria-hidden="true">‹</span>
              </button>
              <button
                type="button"
                aria-label={t('cycle.calendar.next')}
                disabled={month >= monthOf(today)}
                onClick={() => setMonth(shiftMonth(month, 1))}
                className="size-10 flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
              >
                <span aria-hidden="true">›</span>
              </button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {Array.from({ length: isoWeekdayIndex(first) }, (_, i) => <span key={`lead-${i}`} />)}
            {days.map((d) => (
              <button
                key={d}
                type="button"
                disabled={d > today}
                aria-pressed={d === picked}
                aria-label={formatCivilLong(d)}
                onClick={() => setPicked(d)}
                className={`h-10 rounded-[10px] text-body-sm tabular-nums border ${
                  d === picked ? 'border-pink-400 bg-pink-500/15 text-pink-100 font-bold' : 'border-transparent text-zinc-200 hover:bg-zinc-800'
                } disabled:text-zinc-600 disabled:hover:bg-transparent`}
              >
                {Number(d.slice(8, 10))}
              </button>
            ))}
          </div>
          <p className="mt-2 text-caption text-zinc-500">{t('cycle.sheet.start.future')}</p>
        </div>
      )}

      <div className={`mt-4 p-4 rounded-2xl border ${short ? 'border-rose-500/30 bg-rose-500/[0.06]' : 'border-zinc-800 bg-zinc-950'}`}>
        <p className="text-body text-zinc-50">{t('cycle.sheet.start.result', { date: formatCivilLong(date) })}</p>
        {lastLength !== null && (
          <p className={`mt-1 text-detail ${short ? 'text-rose-300' : 'text-zinc-400'}`}>
            {short
              ? t('cycle.sheet.start.short', { days: lastLength, usual: usual ? 'yes' : 'no', min: usual?.min ?? 0, max: usual?.max ?? 0 })
              : t('cycle.sheet.start.detail', { days: lastLength, day: daysBetween(date, today) + 1 })}
          </p>
        )}
      </div>

      <div className="mt-5">
        <p className="text-body font-semibold text-zinc-50">
          {t('cycle.sheet.start.flow')} <span className="font-normal text-zinc-400">{t('cycle.sheet.start.optional')}</span>
        </p>
        <div className="mt-2.5">
          <Chips
            label={t('cycle.sheet.start.flow')}
            tone="pink"
            options={(['light', 'medium', 'heavy'] as const).map((id) => ({ id, label: t(FLOW_LABEL[id]) }))}
            on={(id) => flow === id}
            onToggle={(id) => setFlow(flow === id ? null : id)}
          />
        </div>
      </div>

      <p className="mt-4 text-caption text-zinc-400">{t('cycle.sheet.start.note')}</p>
      <button type="button" onClick={save} className="mt-3 w-full min-h-12 rounded-xl bg-zinc-50 text-zinc-950 text-body font-semibold hover:bg-white transition-colors">
        {t('cycle.sheet.save')}
      </button>
    </Sheet>
  );
}

