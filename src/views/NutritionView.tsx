import React, { useEffect, useMemo, useState } from 'react';
import type { CivilDate } from '../lib/date';
import type { DailyRecord, DayNutrition } from '../types/health';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import {
  formatCivil, formatCivilLong, formatCivilRange, formatClock, formatDuration, formatInteger, formatNumber, weekdayLetter, weekdayShort,
} from '../i18n/format';
import { latestBody, series, weightTrend } from '../pipeline/derive';
import { PROTEIN_PER_KG, proteinTarget } from '../pipeline/goals';
import {
  USUAL_SHARE, againstRange, averageDay, dayLog, deviceBurn, latestMaintenance, maintenanceTrend, mealClock, plateNote,
  plateSquares, sharesOf, towardTarget, type AverageDay, type Maintenance, type MealClock, type Shares, type Standing,
} from '../pipeline/eating';
import { groupSeries } from '../pipeline/aggregate';
import { wallClock } from '../pipeline/insights/helpers';
import type { SyncResult } from '../pipeline/sync';
import { BarSeries, DivergingBars, TrendChart } from '../charts';
import { Card, CardHead, Contributors, DOMAIN, EmptyState, Label, MACRO, Row, tint } from '../ui/primitives';
import { ChartChips } from '../ui/ChartChips';
import { SpanSelector, useSpan } from '../ui/span';
import { useGoals } from '../hooks/useGoals';
import { useHistory } from '../hooks/useHistory';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { Clock } from '../hooks/usePageInsights';

const PAGE = DOMAIN.nutrition.hex;

type NutritionChart = 'balance' | 'protein' | 'fibre';

/** The tiers' colours, as the body battery has them: a mark's, and a word's on a tinted pill. */
const STANDING_COLOUR: Record<Standing, { dot: string; ink: string }> = {
  onTarget: { dot: 'var(--figure-charged)', ink: 'var(--figure-ink-charged)' },
  inRange: { dot: 'var(--figure-charged)', ink: 'var(--figure-ink-charged)' },
  close: { dot: 'var(--figure-balanced)', ink: 'var(--figure-ink-balanced)' },
  short: { dot: 'var(--figure-low)', ink: 'var(--figure-ink-low)' },
  above: { dot: 'var(--figure-low)', ink: 'var(--figure-ink-low)' },
  below: { dot: 'var(--figure-low)', ink: 'var(--figure-ink-low)' },
};

const pct = (share: number) => Math.round(share * 100);
const grams = (v: number) => formatInteger(v);
const kcal = (v: number) => formatInteger(v);

/**
 * The Nutrition page, from the food log in Google Health: today's plate and the week's meals at the
 * top, then the average day, maintenance and the charts for the span chosen.
 */
export function NutritionView({ data, clock }: { data: SyncResult; clock?: Clock }) {
  const goals = useGoals();
  const history = useHistory();
  const spanState = useSpan(data, '30');
  const wide = useMediaQuery('(min-width: 768px)');
  const [chart, setChart] = useState<NutritionChart>('balance');

  // Maintenance and its trend look back further than the window: ask for the stored history once.
  useEffect(() => {
    if (!history.days && !history.loading) history.request();
  }, [history]);

  const all = history.days ?? data.days;
  const today = data.days[data.days.length - 1].date;
  const minutesNow = wallClock(clock?.now ?? new Date(), clock?.timeZone);
  const maintenance = useMemo(() => latestMaintenance(all, today), [all, today]);
  const devices = useMemo(() => deviceBurn(all, today), [all, today]);
  const weight = useMemo(() => latestBody(all).latest?.value ?? null, [all]);
  const protein = proteinTarget(goals, weight);
  const week = useMemo(() => mealClock(all, today), [all, today]);
  const usual = useMemo(() => averageDay(all.slice(-29), today), [all, today]);
  const span = spanState.days;
  const average = useMemo(() => averageDay(span, today), [span, today]);

  if (!all.some((d) => d.nutrition)) {
    return (
      <Card>
        <EmptyState title={t('nutrition.empty.title')} detail={t('nutrition.empty.detail')} />
      </Card>
    );
  }

  const todayRow = data.days[data.days.length - 1];
  const balance = <BalanceCard span={span} all={all} today={today} maintenance={maintenance} bucket={spanState.bucket} />;
  const proteinCard = <TargetCard kind="protein" span={span} today={today} target={protein} weight={weight} ownTarget={goals.protein !== null} bucket={spanState.bucket} />;
  const fibreCard = <TargetCard kind="fibre" span={span} today={today} target={goals.fibre} weight={weight} ownTarget bucket={spanState.bucket} />;
  const charts: { key: NutritionChart; label: string; card: React.ReactNode }[] = [
    { key: 'balance', label: t('nutrition.chips.balance'), card: balance },
    { key: 'protein', label: t('nutrition.chips.protein'), card: proteinCard },
    { key: 'fibre', label: t('nutrition.chips.fibre'), card: fibreCard },
  ];
  const shown = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <PlateCard
          day={todayRow.nutrition}
          maintenance={maintenance?.kcal ?? null}
          devices={devices}
          proteinTarget={protein}
          fibreTarget={goals.fibre}
          note={todayRow.nutrition ? plateNote(todayRow.nutrition, usual?.shares ?? null, protein, minutesNow) : null}
          wide={wide}
        />
        <MealClockCard week={week} />
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-page-ink">{t('nutrition.overTime.title')}</h2>
        <SpanSelector state={spanState} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <AverageDayCard average={average} maintenance={maintenance?.kcal ?? null} protein={protein} fibre={goals.fibre} />
        <MaintenanceCard maintenance={maintenance} all={all} today={today} from={span[0]?.date ?? today} loading={!history.days} />
      </div>

      {wide ? (
        <>
          {balance}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {proteinCard}
            {fibreCard}
          </div>
        </>
      ) : (
        <>
          <ChartChips label={t('nutrition.chips.label')} options={charts} value={shown.key} onChange={setChart} colour={PAGE} />
          {shown.card}
        </>
      )}

      <p className="px-4 pt-2 text-center text-note leading-relaxed text-zinc-500">{t('insights.carousel.disclaimer')}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── today's plate

/** A label for how a figure stands, tinted in its tier's colour, the word in a lighter shade of it. */
function StandingPill({ standing }: { standing: Standing }) {
  const { dot, ink } = STANDING_COLOUR[standing];
  return (
    <span
      className="status-pill shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border text-note font-semibold"
      style={{ '--pill': dot, '--pill-ink': ink } as React.CSSProperties}
    >
      <span className="status-pill-word">{t(`nutrition.standing.${standing}`)}</span>
    </span>
  );
}

/** A target's progress bar: what's in, against the target. */
function TargetBar({ label, got, target, colour }: { label: string; got: number; target: number | null; colour: string }) {
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2 text-detail text-zinc-400">
        <span>{label}</span>
        <span className="text-zinc-500">
          {target === null
            ? rich('nutrition.plate.grams', { grams: grams(got), b: (w) => <span className="text-zinc-100">{w}</span> })
            : rich('nutrition.plate.ofTarget', { got: grams(got), target: grams(target), b: (w) => <span className="text-zinc-100">{w}</span> })}
        </span>
      </div>
      {target !== null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-[var(--faint)] overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, (got / target) * 100)}%`, background: colour }} />
        </div>
      )}
    </div>
  );
}

/** A grid of squares in the macros' colours, then empty ones. */
function Squares({ protein, carbs, fat, empty, size }: { protein: number; carbs: number; fat: number; empty: number; size: number }) {
  const cells = [
    ...Array.from({ length: protein }, () => MACRO.protein),
    ...Array.from({ length: carbs }, () => MACRO.carbs),
    ...Array.from({ length: fat }, () => MACRO.fat),
    ...Array.from({ length: empty }, () => null),
  ];
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(10, ${size}px)` }} aria-hidden="true">
      {cells.map((c, i) => (
        <span
          key={i}
          className={`rounded-[3px] ${c ? '' : 'border border-[var(--rule-strong)]'}`}
          style={{ width: size, height: size, background: c ?? undefined }}
        />
      ))}
    </div>
  );
}

/**
 * Today's plate: a hundred squares, each 1% of what the body burns in a day, filled in the
 * macros' colours as the day is eaten. Past maintenance, the plate is full and the rest spills
 * into new squares under a line; both keep the day's own mix.
 */
function PlateCard({ day, maintenance, devices, proteinTarget, fibreTarget, note, wide }: {
  day: DayNutrition | null;
  maintenance: number | null;
  devices: number | null;
  proteinTarget: number | null;
  fibreTarget: number;
  note: ReturnType<typeof plateNote>;
  wide: boolean;
}) {
  const ref = maintenance ?? devices;
  const shares = day ? sharesOf(day) : null;
  const eaten = day?.kcal ?? 0;
  const squares = ref ? plateSquares(eaten, ref, shares) : null;
  const over = squares && squares.total > 100 ? plateSquares(eaten - ref!, ref!, shares) : null;
  const inside = over ? plateSquares(ref!, ref!, shares) : squares;
  const size = wide ? 14 : 12;
  const vsRef = ref === null ? null : eaten > ref
    ? t('nutrition.plate.over', { kcal: kcal(eaten - ref), devices: maintenance === null ? 'yes' : 'no' })
    : t('nutrition.plate.of', { kcal: kcal(ref), devices: maintenance === null ? 'yes' : 'no' });

  return (
    <Card glow={PAGE} className="px-5 pt-4 pb-5 flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="card-title-detail text-zinc-50">{t('nutrition.plate.title')}</h2>
        <span className="text-caption text-zinc-500">{t('nutrition.plate.meals', { count: day?.meals.length ?? 0 })}</span>
      </div>
      <div className="mt-4 flex items-start gap-5 md:gap-6">
        {inside && (
          <div
            role="img"
            aria-label={t('nutrition.plate.aria', { protein: inside.protein + (over?.protein ?? 0), carbs: inside.carbs + (over?.carbs ?? 0), fat: inside.fat + (over?.fat ?? 0) })}
            className="shrink-0"
          >
            <Squares protein={inside.protein} carbs={inside.carbs} fat={inside.fat} empty={Math.max(0, 100 - inside.total)} size={size} />
            {over && (
              <>
                <div className="relative h-6" aria-hidden="true">
                  <span className="absolute right-0 top-1 text-note text-zinc-300">{t('nutrition.plate.maintenanceLine')}</span>
                  <span className="absolute -left-1 -right-1 top-[17px] border-t border-dashed border-zinc-400" />
                </div>
                <Squares protein={over.protein} carbs={over.carbs} fat={over.fat} empty={0} size={size} />
              </>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display text-number md:text-number-lg leading-tight text-zinc-50 tabular-nums">{kcal(eaten)}</span>
            <span className="text-detail text-zinc-500">{t('units.kcal')}</span>
          </div>
          {vsRef && <div className="text-caption text-zinc-500">{vsRef}</div>}
          <div className="mt-3 text-eyebrow uppercase text-zinc-500">{t('nutrition.plate.targets')}</div>
          <TargetBar label={t('nutrition.macros.protein')} got={day?.proteinG ?? 0} target={proteinTarget} colour={MACRO.protein} />
          {day?.fibreG !== null && (
            <TargetBar label={t('nutrition.macros.fibre')} got={day?.fibreG ?? 0} target={fibreTarget} colour={MACRO.fibre} />
          )}
        </div>
      </div>
      {note && (
        <p className="mt-4 text-detail leading-relaxed text-zinc-400">
          {note.kind === 'protein'
            ? t('nutrition.plate.note.protein', { got: grams(note.got), target: grams(note.target) })
            : t('nutrition.plate.note.mix', { macro: note.macro, share: pct(note.share), usual: pct(note.usual) })}
        </p>
      )}
      {/* The key sits at the foot of the card, however tall the meal clock beside it makes the row. */}
      <div className="mt-auto pt-4 flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
        <Key colour={MACRO.protein}>{t('nutrition.plate.legend.protein', { pct: shares ? pct(shares.protein) : 0, known: shares ? 'yes' : 'no' })}</Key>
        <Key colour={MACRO.carbs}>{t('nutrition.plate.legend.carbs', { pct: shares ? pct(shares.carbs) : 0, known: shares ? 'yes' : 'no' })}</Key>
        <Key colour={MACRO.fat}>{t('nutrition.plate.legend.fat', { pct: shares ? pct(shares.fat) : 0, known: shares ? 'yes' : 'no' })}</Key>
        {!over && <Key outline>{t('nutrition.plate.legend.toEat')}</Key>}
      </div>
    </Card>
  );
}

function Key({ colour, outline = false, children }: { colour?: string; outline?: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`size-2 rounded-[2px] ${outline ? 'border border-[var(--rule-strong)]' : ''}`}
        style={colour ? { background: colour } : undefined}
      />
      {children}
    </span>
  );
}

// ───────────────────────────────────────────────────────────── meal clock

const CLOCK = 230;
const CENTRE = CLOCK / 2;
const RING0 = 46;
const RING_STEP = 6.5;

const at = (r: number, minutes: number) => {
  const a = (minutes / 1440) * 2 * Math.PI;
  return [CENTRE + r * Math.sin(a), CENTRE - r * Math.cos(a)] as const;
};
const pt = ([x, y]: readonly [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** The usual sleep as a wedge of the clock, from bedtime round to waking. */
function sleepWedge(bed: number, wake: number): string {
  const end = wake < bed ? wake + 1440 : wake;
  const big = end - bed > 720 ? 1 : 0;
  const outer = RING0 + 6 * RING_STEP + 6;
  const inner = RING0 - 6;
  return `M${pt(at(outer, bed))}A${outer},${outer} 0 ${big} 1 ${pt(at(outer, end))}L${pt(at(inner, end))}A${inner},${inner} 0 ${big} 0 ${pt(at(inner, bed))}Z`;
}

/**
 * The 7-day meal clock: a 24-hour dial with one ring a day, yesterday outermost, each meal a dot
 * where it was eaten, bigger for more food, and the person's usual sleep shaded. Beside it, each
 * day's mix of protein, carbs and fat.
 */
function MealClockCard({ week }: { week: MealClock }) {
  const { days, sleep } = week;
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  const logged = days.filter((d) => d.shares);
  const weekShares: Shares | null = logged.length
    ? {
        protein: logged.reduce((a, d) => a + d.shares!.protein, 0) / logged.length,
        carbs: logged.reduce((a, d) => a + d.shares!.carbs, 0) / logged.length,
        fat: logged.reduce((a, d) => a + d.shares!.fat, 0) / logged.length,
      }
    : null;
  const outer = RING0 + 6 * RING_STEP + 6;

  return (
    <Card glow={PAGE} className="px-5 pt-4 pb-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="card-title-detail text-zinc-50">{t('nutrition.clock.title')}</h2>
        {first && last && <span className="text-caption text-zinc-500">{formatCivilRange(first, last)}</span>}
      </div>
      <div className="mt-3 flex flex-col sm:flex-row items-center sm:items-start gap-5">
        <div className="shrink-0">
          <div className="relative" style={{ width: CLOCK, height: CLOCK }}>
            <svg
              width={CLOCK}
              height={CLOCK}
              viewBox={`0 0 ${CLOCK} ${CLOCK}`}
              role="img"
              aria-label={sleep ? t('nutrition.clock.aria', { bed: clockText(sleep.bed), wake: clockText(sleep.wake) }) : t('nutrition.clock.ariaNoSleep')}
            >
              {sleep && <path d={sleepWedge(sleep.bed, sleep.wake)} fill={tint('var(--indigo-400)', 16)} stroke={tint('var(--indigo-400)', 50)} strokeWidth={1} />}
              {days.map((_, j) => (
                <circle key={j} cx={CENTRE} cy={CENTRE} r={RING0 + j * RING_STEP} fill="none" stroke="var(--rule)" strokeWidth={1} />
              ))}
              <circle cx={CENTRE} cy={CENTRE} r={outer + 3} fill="none" stroke="var(--rule-strong)" strokeWidth={1} />
              {Array.from({ length: 24 }, (_, h) => (
                <line
                  key={h}
                  x1={at(h % 6 === 0 ? outer - 1 : outer + 3, h * 60)[0]}
                  y1={at(h % 6 === 0 ? outer - 1 : outer + 3, h * 60)[1]}
                  x2={at(outer + 7, h * 60)[0]}
                  y2={at(outer + 7, h * 60)[1]}
                  stroke="var(--color-zinc-600)"
                  strokeWidth={1.2}
                  strokeLinecap="round"
                />
              ))}
              {days.flatMap((d, j) =>
                d.meals.map((m, k) => {
                  const [x, y] = at(RING0 + j * RING_STEP, m.minutes);
                  return (
                    <circle key={`${j}-${k}`} cx={x} cy={y} r={2 + m.kcal / 340} fill={PAGE} stroke="var(--card-edge)" strokeWidth={1}>
                      <title>{t('nutrition.clock.meal', { day: weekdayShort(d.date), time: clockText(m.minutes), kcal: kcal(m.kcal), protein: grams(m.proteinG) })}</title>
                    </circle>
                  );
                }),
              )}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {week.windowMin !== null && (
                <>
                  <span className="font-display text-title-sm leading-tight text-zinc-50">{formatDuration(week.windowMin)}</span>
                  <span className="text-note text-zinc-500">{t('nutrition.clock.window')}</span>
                </>
              )}
            </div>
            <span className="absolute left-1/2 -translate-x-1/2 top-0 text-note text-zinc-500">{t('nutrition.clock.midnight')}</span>
            <span className="absolute right-0 top-1/2 -translate-y-1/2 text-note text-zinc-500">{t('nutrition.clock.morning')}</span>
            <span className="absolute left-1/2 -translate-x-1/2 bottom-0 text-note text-zinc-500">{t('nutrition.clock.noon')}</span>
            <span className="absolute left-0 top-1/2 -translate-y-1/2 text-note text-zinc-500">{t('nutrition.clock.evening')}</span>
          </div>
          <p className="mt-1 text-center text-caption text-zinc-400">
            {week.lastToBedMin !== null ? t('nutrition.clock.lastToBed', { duration: formatDuration(week.lastToBedMin) }) : t('nutrition.clock.outer')}
          </p>
        </div>
        <div className="w-full sm:flex-1 min-w-0 sm:pt-4">
          <Label>{t('nutrition.clock.mix')}</Label>
          <div className="mt-2.5 flex gap-1.5 h-[132px]">
            {days.map((d) => (
              <div
                key={d.date}
                title={d.shares ? t('nutrition.clock.dayMix', { day: weekdayShort(d.date), protein: pct(d.shares.protein), carbs: pct(d.shares.carbs), fat: pct(d.shares.fat) }) : t('nutrition.clock.dayNone', { day: weekdayShort(d.date) })}
                className={`flex-1 flex flex-col-reverse gap-0.5 rounded overflow-hidden ${d.shares ? '' : 'border border-dashed border-[var(--rule-strong)]'} ${d.log === 'partial' ? 'opacity-50' : ''}`}
              >
                {d.shares && (
                  <>
                    <div style={{ flex: `${d.shares.protein} 1 0`, background: MACRO.protein }} />
                    <div style={{ flex: `${d.shares.carbs} 1 0`, background: MACRO.carbs }} />
                    <div style={{ flex: `${d.shares.fat} 1 0`, background: MACRO.fat }} />
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1.5" aria-hidden="true">
            {days.map((d) => <span key={d.date} className="flex-1 text-center text-note text-zinc-500">{weekdayLetter(d.date)}</span>)}
          </div>
          {weekShares && (
            <div className="mt-3 space-y-1 text-caption text-zinc-400">
              <MixRow colour={MACRO.fat} label={t('nutrition.macros.fat')} share={weekShares.fat} />
              <MixRow colour={MACRO.carbs} label={t('nutrition.macros.carbs')} share={weekShares.carbs} />
              <MixRow colour={MACRO.protein} label={t('nutrition.macros.protein')} share={weekShares.protein} />
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: PAGE }} />{t('nutrition.clock.legend.meal')}</span>
        {sleep && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px]" style={{ background: tint('var(--indigo-400)', 40) }} />{t('nutrition.clock.legend.sleep')}</span>}
        <span className="text-zinc-500">{t('nutrition.clock.outer')}</span>
      </div>
    </Card>
  );
}

/** A time of day in the language's own clock: "07:40". */
const clockText = (minutes: number) => formatClock(minutes);

function MixRow({ colour, label, share }: { colour: string; label: string; share: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px]" style={{ background: colour }} />{label}</span>
      <span className="text-zinc-100 tabular-nums">{t('nutrition.percent', { pct: pct(share) })}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────── average day

/** One of the average day's macros: its grams, how it stands, and against what. */
function MacroRow({ colour, name, value, detail, standing, sub = false }: {
  colour: string;
  name: React.ReactNode;
  value: string;
  detail: string;
  standing: Standing | null;
  sub?: boolean;
}) {
  return (
    <div className={sub ? 'pl-3.5 pb-3' : 'py-3 border-t border-zinc-800/70'}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-body-sm text-zinc-300 whitespace-nowrap">
          <span className="inline-block size-2 rounded-[2px] mr-1.5 align-[1px]" style={{ background: colour }} />
          {name} {value}
        </span>
        {standing && <StandingPill standing={standing} />}
      </div>
      <div className="mt-0.5 ml-3.5 text-detail text-zinc-500">{detail}</div>
    </div>
  );
}

const strong = (w: React.ReactNode) => <span className="font-semibold text-zinc-50">{w}</span>;

/** The span's average day, from its days logged in full, each figure with how it stands. */
function AverageDayCard({ average, maintenance, protein, fibre }: {
  average: AverageDay | null;
  maintenance: number | null;
  protein: number | null;
  fibre: number;
}) {
  if (!average) {
    return (
      <Card className="flex flex-col">
        <CardHead title={t('nutrition.average.title')} />
        <EmptyState title={t('nutrition.average.empty')} />
      </Card>
    );
  }
  const gap = maintenance === null ? null : Math.round(average.kcal - maintenance);
  return (
    <Card className="px-5 pt-4 pb-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="card-title-detail text-zinc-50">{t('nutrition.average.title')}</h3>
        <span className="text-caption text-zinc-500">{t('nutrition.average.days', { count: average.complete })}</span>
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <span className="text-body font-semibold text-zinc-100">{t('nutrition.average.energy')}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="font-display text-number md:text-number-lg leading-tight text-zinc-50 tabular-nums">{kcal(average.kcal)}</span>
          <span className="text-detail text-zinc-500">{t('units.kcal')}</span>
        </span>
      </div>
      {gap !== null && Math.abs(gap) >= 20 && (
        <div className="text-right text-caption text-zinc-500">{t('nutrition.average.vsMaintenance', { kcal: kcal(Math.abs(gap)), dir: gap < 0 ? 'under' : 'over' })}</div>
      )}
      <div className="mt-2">
        <MacroRow
          colour={MACRO.protein}
          name={rich('nutrition.average.name', { name: t('nutrition.macros.protein'), b: strong })}
          value={t('nutrition.grams', { grams: grams(average.proteinG) })}
          detail={protein === null ? t('nutrition.average.noTarget') : t('nutrition.average.ofTarget', { pct: Math.round((average.proteinG / protein) * 100), target: grams(protein) })}
          standing={protein === null ? null : towardTarget(average.proteinG, protein)}
        />
        <MacroRow
          colour={MACRO.carbs}
          name={rich('nutrition.average.name', { name: t('nutrition.macros.carbs'), b: strong })}
          value={t('nutrition.grams', { grams: grams(average.carbsG) })}
          detail={t('nutrition.average.ofEnergy', { pct: pct(average.shares.carbs), lo: USUAL_SHARE.carbs[0], hi: USUAL_SHARE.carbs[1] })}
          standing={againstRange(average.shares.carbs, USUAL_SHARE.carbs)}
        />
        {average.fibreG !== null && (
          <MacroRow
            sub
            colour={MACRO.fibre}
            name={rich('nutrition.average.fibreOf', { b: strong })}
            value={t('nutrition.grams', { grams: grams(average.fibreG) })}
            detail={t('nutrition.average.ofTarget', { pct: Math.round((average.fibreG / fibre) * 100), target: grams(fibre) })}
            standing={towardTarget(average.fibreG, fibre)}
          />
        )}
        <MacroRow
          colour={MACRO.fat}
          name={rich('nutrition.average.name', { name: t('nutrition.macros.fat'), b: strong })}
          value={t('nutrition.grams', { grams: grams(average.fatG) })}
          detail={t('nutrition.average.ofEnergy', { pct: pct(average.shares.fat), lo: USUAL_SHARE.fat[0], hi: USUAL_SHARE.fat[1] })}
          standing={againstRange(average.shares.fat, USUAL_SHARE.fat)}
        />
        <div className="pt-3 border-t border-zinc-800/70 flex items-baseline justify-between gap-3 text-body-sm text-zinc-300">
          <span>{rich('nutrition.average.meals', { count: formatNumber(average.meals, 1), b: strong })}</span>
          <span className="text-detail text-zinc-500">{t('nutrition.average.logged', { logged: average.logged, finished: average.finished })}</span>
        </div>
      </div>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── maintenance

/**
 * Maintenance: what the body burns in a day, from what was eaten and how the weight moved, over
 * the latest block of weeks; and, under it, the same block worked out week by week across the
 * span, so the number is today's and the line shows how it has moved.
 */
function MaintenanceCard({ maintenance, all, today, from, loading }: {
  maintenance: Maintenance | null;
  all: DailyRecord[];
  today: CivilDate;
  from: CivilDate;
  loading: boolean;
}) {
  const trend = useMemo(
    () => (maintenance ? maintenanceTrend(all, today, from, maintenance.blockDays) : []),
    [all, today, from, maintenance],
  );
  if (!maintenance) {
    const recent = all.slice(-29, -1);
    return (
      <Card glow={PAGE} className="flex flex-col">
        <CardHead title={t('nutrition.maintenance.title')} hint={t('nutrition.maintenance.hint')} />
        <p className="px-5 pb-5 text-detail leading-relaxed text-zinc-400">
          {loading
            ? t('nutrition.maintenance.loading')
            : t('nutrition.maintenance.needs', {
                days: recent.filter((d) => dayLog(d, today) === 'complete').length,
                weighIns: recent.filter((d) => d.weightKg !== null).length,
              })}
        </p>
      </Card>
    );
  }
  const weeks = Math.round(maintenance.blockDays / 7);
  const points = trend.filter((p) => p.value !== null);
  // Up to a month, the weekly figures sit on a day axis through yesterday, the last day worked out, so
  // every day has its tick and the ruler's dates fall on the points. Past a month, days are too
  // narrow to tick, so the axis is the weeks themselves, a tick for each point.
  const weekly = new Map(trend.map((p) => [p.date, p.value]));
  const spanDays = all.filter((d) => d.date >= from && d.date < today);
  const line = spanDays.length <= 31 ? spanDays.map((d) => ({ date: d.date, value: weekly.get(d.date) ?? null })) : trend;
  // A scale of at least 200 kcal, in a whole number of 200s so its five ticks fall on round fifties
  // or hundreds, and a quiet fortnight doesn't read as a cliff.
  const values = points.map((p) => p.value!);
  const lo = values.length ? Math.floor((Math.min(...values) - 25) / 50) * 50 : 0;
  const domain: [number, number] = [lo, lo + Math.max(200, Math.ceil((Math.max(...values, lo) + 25 - lo) / 200) * 200)];
  const firstPoint = points[0];
  const change = firstPoint && points.length >= 2 ? maintenance.kcal - firstPoint.value! : null;
  const weightKcal = Math.round(Math.abs(maintenance.kgPerWeek / 7) * 7700);
  const weightDir = Math.abs(maintenance.kgPerWeek) < 0.02 ? 'held' : maintenance.kgPerWeek < 0 ? 'lost' : 'gained';
  const devicesDiff = maintenance.deviceKcal === null ? null : Math.round(((maintenance.deviceKcal - maintenance.kcal) / maintenance.kcal) * 100);

  return (
    <Card glow={PAGE} className="px-5 pt-4 pb-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="card-title-detail text-zinc-50">{t('nutrition.maintenance.title')}</h3>
        <span className="text-caption text-zinc-500">{t('nutrition.maintenance.block', { weeks })}</span>
      </div>
      <p className="mt-1 text-caption leading-relaxed text-zinc-500">{t('nutrition.maintenance.hint')}</p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="font-display text-number-xl leading-none text-zinc-50 tabular-nums">{kcal(maintenance.kcal)}</span>
        <span className="text-detail text-zinc-500">{t('nutrition.maintenance.perDay')}</span>
      </div>
      <div className="mt-1 text-caption text-zinc-500">{t('nutrition.maintenance.margin', { kcal: kcal(maintenance.margin) })}</div>

      {points.length >= 2 && (
        <div className="mt-4">
          <Label>{t('nutrition.maintenance.moved')}</Label>
          <div className="-ml-3 pr-6 mt-1 [&_.recharts-surface]:overflow-visible">
            <TrendChart series={line} color={PAGE} height={150} unit={t('units.kcal')} format={(v) => kcal(v)} meanWindow={null} area={false} joined domain={domain} seriesName={t('nutrition.maintenance.series')} />
          </div>
          <p className="mt-1 text-detail leading-relaxed text-zinc-400">
            {t('nutrition.maintenance.each', { weeks })}{' '}
            {change !== null &&
              t('nutrition.maintenance.change', { dir: Math.abs(change) < 20 ? 'steady' : change < 0 ? 'down' : 'up', kcal: kcal(Math.abs(change)), date: formatCivil(firstPoint.date) })}
          </p>
        </div>
      )}

      <div className="mt-3">
        <Row label={t('nutrition.maintenance.ate')}>{t('nutrition.maintenance.kcalPerDay', { kcal: kcal(maintenance.ateKcal) })}</Row>
        <Row label={t('nutrition.maintenance.weight', { dir: weightDir })}>
          {t('nutrition.maintenance.weightValue', { kg: formatNumber(Math.abs(maintenance.kgPerWeek), 2) })}
          {weightDir !== 'held' && <span className="text-zinc-500"> · {t('nutrition.maintenance.kcalPerDay', { kcal: kcal(weightKcal) })}</span>}
        </Row>
        {maintenance.deviceKcal !== null && (
          <Row label={t('nutrition.maintenance.devices')}>
            {t('nutrition.maintenance.kcalPerDay', { kcal: kcal(maintenance.deviceKcal) })}
            <span className="text-zinc-500"> · {t('nutrition.maintenance.devicesDiff', { pct: Math.abs(devicesDiff!), dir: devicesDiff! > 0 ? 'higher' : devicesDiff! < 0 ? 'lower' : 'same' })}</span>
          </Row>
        )}
      </div>
      <div className="mt-3">
        <Contributors label={t('nutrition.maintenance.how')} heading="text-eyebrow uppercase text-zinc-500 mb-1.5 pt-3 border-t border-zinc-800/70">
          <p className="text-detail leading-relaxed text-zinc-400">
            {t('nutrition.maintenance.howText', {
              ate: kcal(maintenance.ateKcal),
              days: maintenance.days,
              weeks,
              dir: weightDir,
              kg: formatNumber(Math.abs(maintenance.kgPerWeek), 2),
              kcal: kcal(weightKcal),
              maintenance: kcal(maintenance.kcal),
              weighIns: maintenance.weighIns,
            })}
          </p>
        </Contributors>
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────── charts

/** Each day logged in full against the maintenance of its own week: above the line, more eaten than burned. */
function BalanceCard({ span, all, today, maintenance, bucket }: {
  span: DailyRecord[];
  all: DailyRecord[];
  today: CivilDate;
  maintenance: Maintenance | null;
  bucket: ReturnType<typeof useSpan>['bucket'];
}) {
  const from = span[0]?.date ?? today;
  const trend = useMemo(() => (maintenance ? maintenanceTrend(all, today, from, maintenance.blockDays) : []), [all, today, from, maintenance]);
  const daily = useMemo(() => {
    return span.map((d) => {
      if (!maintenance || dayLog(d, today) !== 'complete') return { date: d.date, value: null };
      const week = trend.find((p) => p.date >= d.date && p.value !== null)?.value ?? maintenance.kcal;
      return { date: d.date, value: d.nutrition!.kcal - week };
    });
  }, [span, trend, maintenance, today]);
  const counted = daily.filter((p) => p.value !== null);
  const under = counted.filter((p) => p.value! < 0).length;
  const weights = series(span, (d) => d.weightKg);
  const trendKg = weightTrend(weights);
  const moved = trendKg ? (trendKg.kgPerWeek * span.length) / 7 : null;

  return (
    <Card>
      <CardHead
        title={t('nutrition.balance.title')}
        hint={t('nutrition.balance.hint')}
        right={span.length > 0 && formatCivilRange(span[0].date, span[span.length - 1].date)}
      />
      <div className="px-2 pb-1">
        {maintenance ? (
          <DivergingBars
            series={groupSeries(daily, bucket)}
            bucket={bucket}
            height={190}
            unit={t('units.kcal')}
            posColor={PAGE}
            negColor="var(--color-zinc-500)"
            format={(v) => kcal(v)}
            seriesName={t('nutrition.balance.series')}
            ruler
          />
        ) : (
          <p className="px-3 pb-4 text-detail text-zinc-500">{t('nutrition.balance.needsMaintenance')}</p>
        )}
      </div>
      {maintenance && counted.length > 0 && (
        <div className="px-5 pb-5">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
            <Key colour={PAGE}>{t('nutrition.balance.more')}</Key>
            <Key colour="var(--color-zinc-500)">{t('nutrition.balance.less')}</Key>
          </div>
          <p className="mt-2 text-detail leading-relaxed text-zinc-400">
            {t('nutrition.balance.summary', {
              under,
              days: counted.length,
              moved: moved === null || Math.abs(moved) < 0.2 ? 'none' : moved < 0 ? 'fell' : 'rose',
              kg: moved === null ? '' : formatNumber(Math.abs(moved), 1),
            })}
          </p>
        </div>
      )}
    </Card>
  );
}

/** Protein or fibre, day by day, against its target: bright days reached it, partly logged ones are outlined. */
function TargetCard({ kind, span, today, target, weight, ownTarget, bucket }: {
  kind: 'protein' | 'fibre';
  span: DailyRecord[];
  today: CivilDate;
  target: number | null;
  weight: number | null;
  ownTarget: boolean;
  bucket: ReturnType<typeof useSpan>['bucket'];
}) {
  const get = (n: DayNutrition) => (kind === 'protein' ? n.proteinG : n.fibreG);
  const colour = kind === 'protein' ? MACRO.protein : MACRO.fibre;
  const logs = span.map((d) => ({ d, log: dayLog(d, today) }));
  // Grouped into weeks or months, only full days count; day by day, a partly logged one shows as an outline.
  const points = logs.map(({ d, log }) => ({
    date: d.date,
    value: d.nutrition && (log === 'complete' || log === 'today' || (bucket === 'day' && log === 'partial')) ? get(d.nutrition) : null,
  }));
  const hollow = useMemo(() => new Set(bucket === 'day' ? logs.filter((x) => x.log === 'partial').map((x) => x.d.date) : []), [logs, bucket]);
  const full = logs.filter((x) => x.log === 'complete' && x.d.nutrition && get(x.d.nutrition) !== null);
  const values = full.map((x) => get(x.d.nutrition!)!);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const met = target === null ? 0 : values.filter((v) => v >= target).length;
  const best = full.reduce<(typeof full)[number] | null>((a, x) => (!a || get(x.d.nutrition!)! > get(a.d.nutrition!)! ? x : a), null);

  const hint = kind === 'fibre'
    ? t('nutrition.fibre.hint')
    : target === null
      ? t('nutrition.protein.hintNone')
      : ownTarget
        ? t('nutrition.protein.hintOwn', { target: grams(target) })
        : t('nutrition.protein.hintAuto', { perKg: formatNumber(PROTEIN_PER_KG, 1), target: grams(target), weight: formatNumber(weight ?? 0, 1) });

  return (
    <Card>
      <CardHead
        title={t(`nutrition.${kind}.title`)}
        hint={hint}
        right={avg !== null && (
          <span>
            {rich('nutrition.chartAverage', {
              avg: grams(avg),
              target: target === null ? '' : grams(target),
              known: target === null ? 'no' : 'yes',
              value: (w) => <span style={{ color: kind === 'protein' ? 'var(--purple-400)' : MACRO.fibre }}>{w}</span>,
            })}
          </span>
        )}
      />
      <div className="px-2 pb-1">
        <BarSeries
          series={groupSeries(points, bucket)}
          bucket={bucket}
          color={colour}
          goal={target ?? undefined}
          height={180}
          unit={t('nutrition.gramsUnit')}
          hollow={hollow}
          hollowNote={t('nutrition.partly')}
        />
      </div>
      <div className="px-5 pb-5">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-zinc-400">
          {target !== null && <Key colour={colour}>{t('nutrition.legend.reached')}</Key>}
          {target !== null && <Key colour={tint(colour, 42)}>{t('nutrition.legend.under')}</Key>}
          {hollow.size > 0 && <Key outline>{t('nutrition.legend.partly')}</Key>}
        </div>
        {target !== null && values.length > 0 && (
          <p className="mt-2 text-detail leading-relaxed text-zinc-400">
            {met === 0 && best
              ? t('nutrition.legend.noneMet', { target: grams(target), best: grams(get(best.d.nutrition!)!), date: formatCivilLong(best.d.date) })
              : t('nutrition.legend.met', { met, days: values.length })}
          </p>
        )}
      </div>
    </Card>
  );
}
