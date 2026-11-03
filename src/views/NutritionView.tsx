import React, { useMemo, useState } from 'react';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivilLong, formatInteger } from '../i18n/format';
import { completedDays, series, stats, values } from '../pipeline/derive';
import { groupMean, groupSeries } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { BarSeries, DivergingBars, StackedBars } from '../charts';
import { Card, CardHead, CardSummary, EmptyState, Row, fmtNum } from '../ui/primitives';
import { SpanSelector, spanSummaryTitle, useSpan } from '../ui/span';
import { ChartChips } from '../ui/ChartChips';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { SyncResult } from '../pipeline/sync';
import type { DailyRecord } from '../types/health';

/**
 * Food logged in a diary app (MyFitnessPal and the like), as it reaches Google Health: energy,
 * protein, carbohydrate and fat for each day. A day without a log is not a day without food, so
 * every average here is over the days that were logged, and the count of those days is shown
 * beside it. Today is still being logged, so averages read finished days only.
 */

export const MACRO = {
  energy: 'var(--amber-400)',
  protein: 'var(--rose-400)',
  carbs: 'var(--teal-400)',
  fat: 'var(--violet-400)',
} as const;

/** Energy per gram (Atwater general factors). */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 } as const;

const kcalOf = (d: DailyRecord) => d.caloriesKcal ?? null;
const proteinOf = (d: DailyRecord) => d.proteinG ?? null;
const carbsOf = (d: DailyRecord) => d.carbsG ?? null;
const fatOf = (d: DailyRecord) => d.fatG ?? null;
const logged = (d: DailyRecord) => d.caloriesKcal !== undefined || d.proteinG !== undefined;

/**
 * Logged energy less what the watch or phone says was burned. Both are estimates: food labels,
 * portions and the device's own model all carry error, so this is a direction, not a measurement.
 */
const balanceOf = (d: DailyRecord) =>
  d.caloriesKcal !== undefined && d.totalKcal !== null ? d.caloriesKcal - d.totalKcal : null;

/** Each macro's share of the energy it gives, in percent, or null without all three. */
export function macroSplit(d: Pick<DailyRecord, 'proteinG' | 'carbsG' | 'fatG'>): { protein: number; carbs: number; fat: number } | null {
  if (d.proteinG === undefined || d.carbsG === undefined || d.fatG === undefined) return null;
  const p = d.proteinG * KCAL_PER_G.protein;
  const c = d.carbsG * KCAL_PER_G.carbs;
  const f = d.fatG * KCAL_PER_G.fat;
  const total = p + c + f;
  if (total <= 0) return null;
  return { protein: (100 * p) / total, carbs: (100 * c) / total, fat: (100 * f) / total };
}

/** The latest weigh-in in these days, for protein per kilo. */
const latestWeight = (days: DailyRecord[]) => [...days].reverse().find((d) => d.weightKg !== null)?.weightKg ?? null;

type NutritionChart = 'energy' | 'protein' | 'macros' | 'balance';

export function NutritionView({ data }: { data: SyncResult }) {
  const days = data.days;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;
  const wide = useMediaQuery('(min-width: 768px)');
  const [chart, setChart] = useState<NutritionChart>('energy');

  const today = days.at(-1)?.date ?? null;
  const kcalWin = series(window, kcalOf);
  const proteinWin = series(window, proteinOf);
  const spanDone = completedDays(window);
  const balanceWin = series(spanDone, balanceOf);
  // The span with today left out but kept as a day, so a summary averages finished days and names
  // its latest reading by its own date.
  const finished = (get: (d: DailyRecord) => number | null) => series(window, (d) => (d.date === today ? null : get(d)));

  const macroDays = useMemo(() => {
    if (bucket === 'day') return window;
    const [p, c, f] = [proteinOf, carbsOf, fatOf].map((get) => groupMean(window, bucket, get));
    return p.map((g, i) => ({
      ...emptyRecord(g.date),
      ...(g.value !== null ? { proteinG: g.value } : {}),
      ...(c[i].value !== null ? { carbsG: c[i].value! } : {}),
      ...(f[i].value !== null ? { fatG: f[i].value! } : {}),
    }));
  }, [window, bucket]);

  const latest = [...days].reverse().find(logged);
  if (!latest) {
    return (
      <Card>
        <EmptyState title={t('nutrition.empty.title')} detail={t('nutrition.empty.detail')} />
      </Card>
    );
  }

  const weight = latestWeight(days) ?? latestWeight(window);
  const lastWeek = completedDays(days).slice(-7);

  const energyCard = (
    <Card>
      <CardHead
        title={t('nutrition.energy.title')}
        hint={t('nutrition.energy.hint')}
        right={<CardSummary data={finished(kcalOf)} color={MACRO.energy} unit={t('units.kcal')} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(kcalWin, bucket)} bucket={bucket} color={MACRO.energy} unit={t('units.kcal')} height={210} />
      </div>
    </Card>
  );
  const proteinCard = (
    <Card>
      <CardHead
        title={t('nutrition.protein.title')}
        hint={weight !== null ? t('nutrition.protein.hintWeight', { weight: fmtNum(weight, 1) }) : t('nutrition.protein.hint')}
        right={<CardSummary data={finished(proteinOf)} color={MACRO.protein} unit={t('units.grams')} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(proteinWin, bucket)} bucket={bucket} color={MACRO.protein} unit={t('units.grams')} height={200} />
      </div>
    </Card>
  );
  const macrosCard = (
    <Card>
      <CardHead
        title={t('nutrition.macros.title')}
        hint={rich('nutrition.macros.hint', {
          protein: (w) => <span className="font-medium" style={{ color: MACRO.protein }}>{w}</span>,
          carbs: (w) => <span className="font-medium" style={{ color: MACRO.carbs }}>{w}</span>,
          fat: (w) => <span className="font-medium" style={{ color: MACRO.fat }}>{w}</span>,
        })}
      />
      <StackedBars
        days={macroDays}
        bucket={bucket}
        unit={t('units.grams')}
        keys={[
          { key: 'protein', label: t('nutrition.macros.protein'), color: MACRO.protein, get: proteinOf },
          { key: 'carbs', label: t('nutrition.macros.carbs'), color: MACRO.carbs, get: carbsOf },
          { key: 'fat', label: t('nutrition.macros.fat'), color: MACRO.fat, get: fatOf },
        ]}
        height={200}
      />
    </Card>
  );
  const balanceCard = (
    <Card>
      <CardHead title={t('nutrition.balance.title')} hint={t('nutrition.balance.hint')} />
      <div className="px-2 pb-3">
        <DivergingBars
          series={groupSeries(balanceWin, bucket)}
          bucket={bucket}
          unit={t('units.kcal')}
          digits={0}
          symbol={false}
          seriesLabel={t('nutrition.balance.series', { bucket })}
          posColor={MACRO.energy}
          negColor="var(--sky-500)"
          height={190}
        />
      </div>
    </Card>
  );

  // The span in numbers, over the finished days that were logged.
  const loggedDone = spanDone.filter(logged);
  const kcal = stats(values(series(loggedDone, kcalOf)));
  const protein = stats(values(series(loggedDone, proteinOf)));
  const balance = stats(values(balanceWin));
  const split = macroSplit({
    proteinG: stats(values(series(loggedDone, proteinOf)))?.mean,
    carbsG: stats(values(series(loggedDone, carbsOf)))?.mean,
    fatG: stats(values(series(loggedDone, fatOf)))?.mean,
  });
  const summaryCard = (
    <Card>
      <CardHead title={spanSummaryTitle(spanState)} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label={t('nutrition.summary.daysLogged')}>
          {rich('nutrition.summary.daysLoggedValue', {
            logged: formatInteger(loggedDone.length),
            total: formatInteger(spanDone.length),
            muted: (w) => <span className="text-zinc-500">{w}</span>,
          })}
        </Row>
        {kcal && (
          <Row dense={!wide} label={t('nutrition.summary.typicalDay')}>
            {fmtNum(kcal.median, 0)} {t('units.kcal')}
          </Row>
        )}
        {protein && (
          <Row dense={!wide} label={t('nutrition.summary.protein')}>
            {weight !== null
              ? rich('nutrition.summary.proteinPerKg', {
                  grams: fmtNum(protein.mean, 0),
                  perKg: fmtNum(protein.mean / weight, 1),
                  muted: (w) => <span className="text-zinc-500">{w}</span>,
                })
              : t('nutrition.summary.proteinGrams', { grams: fmtNum(protein.mean, 0) })}
          </Row>
        )}
        {split && (
          <Row dense={!wide} label={t('nutrition.summary.split')}>
            {t('nutrition.summary.splitValue', {
              protein: fmtNum(split.protein, 0),
              carbs: fmtNum(split.carbs, 0),
              fat: fmtNum(split.fat, 0),
            })}
          </Row>
        )}
        {balance && (
          <Row dense={!wide} label={t('nutrition.summary.balance')}>
            {rich('nutrition.summary.balanceValue', {
              kcal: `${balance.mean > 0 ? '+' : ''}${fmtNum(balance.mean, 0)}`,
              days: formatInteger(balance.n),
              muted: (w) => <span className="text-zinc-500">{w}</span>,
            })}
          </Row>
        )}
      </div>
    </Card>
  );

  const charts: { key: NutritionChart; label: string; card: React.ReactNode }[] = [
    { key: 'energy', label: t('nutrition.chips.energy'), card: energyCard },
    { key: 'protein', label: t('nutrition.chips.protein'), card: proteinCard },
    { key: 'macros', label: t('nutrition.chips.macros'), card: macrosCard },
    { key: 'balance', label: t('nutrition.chips.balance'), card: balanceCard },
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <LatestDay day={latest} isToday={latest.date === today} weight={weight} />
        <LastSevenDays days={lastWeek} weight={weight} />
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-page-ink">{t('nutrition.overTime.title')}</h2>
        <SpanSelector state={spanState} />
      </div>

      {wide ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summaryCard}
            {balanceCard}
          </div>
          {energyCard}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {proteinCard}
            {macrosCard}
          </div>
        </>
      ) : (
        <>
          {summaryCard}
          <ChartChips label={t('nutrition.chips.label')} options={charts} value={shownChart.key} onChange={setChart} />
          {shownChart.card}
        </>
      )}
    </div>
  );
}

/** The latest logged day: energy and the three macros, and how the energy splits between them. */
function LatestDay({ day, isToday, weight }: { day: DailyRecord; isToday: boolean; weight: number | null }) {
  const split = macroSplit(day);
  const tiles: { label: string; value: number | undefined; unit: string; color: string }[] = [
    { label: t('nutrition.day.energy'), value: day.caloriesKcal, unit: t('units.kcal'), color: MACRO.energy },
    { label: t('nutrition.macros.protein'), value: day.proteinG, unit: t('units.grams'), color: MACRO.protein },
    { label: t('nutrition.macros.carbs'), value: day.carbsG, unit: t('units.grams'), color: MACRO.carbs },
    { label: t('nutrition.macros.fat'), value: day.fatG, unit: t('units.grams'), color: MACRO.fat },
  ];
  return (
    <Card>
      <CardHead
        title={isToday ? t('nutrition.day.today') : t('nutrition.day.latest', { date: formatCivilLong(day.date) })}
        hint={isToday ? t('nutrition.day.inProgress') : undefined}
      />
      <div className="px-5 pb-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {tiles.map((tile) => (
            <div key={tile.label}>
              <div className="text-caption text-zinc-500">{tile.label}</div>
              <div className="mt-0.5 font-display text-number-xs tabular-nums" style={{ color: tile.color }}>
                {fmtNum(tile.value, 0)}
                <span className="ml-1 text-caption font-medium text-zinc-500">{tile.unit}</span>
              </div>
            </div>
          ))}
        </div>
        {split && (
          <div className="mt-4">
            <div
              className="flex h-2 rounded-full overflow-hidden bg-zinc-800"
              role="img"
              aria-label={t('nutrition.day.splitBar', {
                protein: fmtNum(split.protein, 0),
                carbs: fmtNum(split.carbs, 0),
                fat: fmtNum(split.fat, 0),
              })}
            >
              <div style={{ width: `${split.protein}%`, background: MACRO.protein }} />
              <div style={{ width: `${split.carbs}%`, background: MACRO.carbs }} />
              <div style={{ width: `${split.fat}%`, background: MACRO.fat }} />
            </div>
            <p className="mt-2 text-caption text-zinc-500">
              {t('nutrition.day.split', {
                protein: fmtNum(split.protein, 0),
                carbs: fmtNum(split.carbs, 0),
                fat: fmtNum(split.fat, 0),
              })}
              {weight !== null && day.proteinG !== undefined && !isToday && (
                <> · {t('nutrition.day.proteinPerKg', { perKg: fmtNum(day.proteinG / weight, 1) })}</>
              )}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The last seven finished days: how many were logged, and the averages over those. */
function LastSevenDays({ days, weight }: { days: DailyRecord[]; weight: number | null }) {
  const loggedDays = days.filter(logged);
  const kcal = stats(values(series(loggedDays, kcalOf)));
  const protein = stats(values(series(loggedDays, proteinOf)));
  const balance = stats(values(series(days, balanceOf)));
  const muted = (w: React.ReactNode) => <span className="text-zinc-500">{w}</span>;
  return (
    <Card>
      <CardHead title={t('nutrition.week.title')} hint={t('nutrition.week.hint')} />
      <div className="px-5 pb-4">
        <Row label={t('nutrition.summary.daysLogged')}>
          {rich('nutrition.summary.daysLoggedValue', { logged: formatInteger(loggedDays.length), total: formatInteger(days.length), muted })}
        </Row>
        <Row label={t('nutrition.week.energy')}>{kcal ? `${fmtNum(kcal.mean, 0)} ${t('units.kcal')}` : '—'}</Row>
        <Row label={t('nutrition.summary.protein')}>
          {!protein
            ? '—'
            : weight !== null
              ? rich('nutrition.summary.proteinPerKg', { grams: fmtNum(protein.mean, 0), perKg: fmtNum(protein.mean / weight, 1), muted })
              : t('nutrition.summary.proteinGrams', { grams: fmtNum(protein.mean, 0) })}
        </Row>
        <Row label={t('nutrition.summary.balance')}>
          {balance
            ? rich('nutrition.summary.balanceValue', {
                kcal: `${balance.mean > 0 ? '+' : ''}${fmtNum(balance.mean, 0)}`,
                days: formatInteger(balance.n),
                muted,
              })
            : '—'}
        </Row>
      </div>
    </Card>
  );
}

