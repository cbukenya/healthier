import React, { useMemo, useState } from 'react';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivilLong, formatInteger, formatThousands } from '../i18n/format';
import {
  byWeekday, completedDays, loadRatio, periodShift, series, stats, values, windowShift, type Point,
} from '../pipeline/derive';
import { BarSeries, StackedBars, TrendChart, WeekdayProfile } from '../charts';
import { Card, CardHead, DOMAIN, Delta, EFFORT, EmptyState, Row, fmtNum, CardSummary } from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import type { DailyRecord } from '../types/health';
import { groupMean, groupSeries, wholeWeeks } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { SpanSelector, spanSummaryTitle, useSpan } from '../ui/span';
import { ChartChips } from '../ui/ChartChips';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useGoals } from '../hooks/useGoals';
import { WHO_WEEK } from '../pipeline/goals';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import type { IntradayDays } from '../pipeline/labs';
import { LastSevenDays, TodaySoFar, WeeklyTotals, briskOf, type WeekTotal } from './ActivityCards';

type ActivityChart = 'steps' | 'energy' | 'intensity' | 'distance' | 'weekdays' | 'weekly';

export function ActivityView({ data, clock, intraday }: { data: SyncResult; clock?: Clock; intraday?: IntradayDays }) {
  const days = data.days;
  const insights = usePageInsights(data, 'activity', clock, intraday);
  const goal = useGoals().steps;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;
  // A phone shows one chart at a time behind chips; wider screens show them all.
  const wide = useMediaQuery('(min-width: 768px)');
  const [chart, setChart] = useState<ActivityChart>('steps');

  const today = days.at(-1)?.date ?? null;
  const stepsWin = series(window, (d) => d.steps);
  const distWin = series(window, (d) => d.distanceKm);
  const kcalWin = series(window, (d) => d.activeKcal);
  // Today is still in progress: averages, the ramp and week-on-week read finished days only.
  const done = completedDays(days);
  const stepsDone = series(done, (d) => d.steps);
  const spanDone = completedDays(window);
  const stepsSpanDone = series(spanDone, (d) => d.steps);
  const recorded = values(series(days, (d) => d.steps)).length;

  // Grouped spans (a hook, so it must run before the early return below): average minutes per recorded day, per intensity.
  const mixDays = useMemo(() => {
    if (bucket === 'day') return window;
    const [light, moderate, vigorous] = (['light', 'moderate', 'vigorous'] as const).map((k) =>
      groupMean(window, bucket, (d) => d.activeMinutes?.[k] ?? null),
    );
    return light.map((g, i) => ({
      ...emptyRecord(g.date),
      activeMinutes:
        g.value === null && moderate[i].value === null && vigorous[i].value === null
          ? null
          : { light: g.value ?? 0, moderate: moderate[i].value ?? 0, vigorous: vigorous[i].value ?? 0 },
    }));
  }, [window, bucket]);

  if (!recorded) {
    return (
      <Card>
        <EmptyState
          title={t('activity.empty.title')}
          detail={t('activity.empty.detail')}
        />
      </Card>
    );
  }

  // Weekly totals: the span's finished Monday-to-Sunday weeks, cut ones left out, newest first.
  const weeks: WeekTotal[] = wholeWeeks(spanDone).flatMap((w) => {
    const steps = values(series(w.days, (d) => d.steps));
    return steps.length >= 4 ? [{ start: w.date, end: w.days[6].date, total: steps.reduce((x, y) => x + y, 0), days: steps.length }] : [];
  }).reverse();
  // The day card shows today once it has steps, else the latest day that does.
  const latestDay = [...days].reverse().find((d) => d.steps !== null)!;
  const lastWeek = done.slice(-7);

  const latestMixRow = [...window].reverse().find(d => d.activeMinutes !== null);

  // The over-time cards: side by side on wider screens, one at a time behind chips on a phone.
  const stepsCard = (
    <Card>
      <CardHead
        domain="movement"
        title={t('activity.steps.title')}
        hint={t('activity.steps.hint', { goal: fmtNum(goal, 0) })}
        right={<CardSummary data={stepsWin} color={DOMAIN.movement.hex} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(stepsWin, bucket)} bucket={bucket} color={DOMAIN.movement.hex} goal={goal} unit={t('units.steps')} height={210} />
      </div>
    </Card>
  );
  const energyCard = (
    <Card>
      <CardHead domain="movement" title={t('activity.energy.title')} hint={t('activity.energy.hint')} right={<CardSummary data={kcalWin} color="var(--amber-400)" unit={t('units.kcal')} format={(v) => fmtNum(v, 0)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(kcalWin, bucket)} bucket={bucket} color="var(--amber-400)" unit={t('units.kcal')} height={200} />
      </div>
    </Card>
  );
  const intensityCard = (
    <Card>
      <CardHead
        domain="movement"
        title={t('activity.mix.title')}
        hint={
          <span>
            {rich('activity.mix.note', {
              target: WHO_WEEK,
              light: (w) => <span className="font-medium" style={{ color: EFFORT.light }}>{w}</span>,
              moderate: (w) => <span className="font-medium" style={{ color: EFFORT.moderate }}>{w}</span>,
              vigorous: (w) => <span className="font-medium" style={{ color: EFFORT.vigorous }}>{w}</span>,
            })}
          </span>
        }
        right={
          latestMixRow?.activeMinutes ? (() => {
            const lightMean = stats(values(series(window, d => d.activeMinutes?.light ?? null)))?.mean ?? 0;
            const modMean = stats(values(series(window, d => d.activeMinutes?.moderate ?? null)))?.mean ?? 0;
            const vigMean = stats(values(series(window, d => d.activeMinutes?.vigorous ?? null)))?.mean ?? 0;
            return (
              <div className="flex items-center gap-2.5 text-caption font-medium text-zinc-300">
                <span className="text-zinc-500">{t(latestMixRow.date === today ? 'activity.mix.vsToday' : 'activity.mix.vsLatest')}</span>
                <span className="flex items-center gap-1.5" title={t('activity.mix.lightMinutes')}><i className="w-2 h-2 rounded-full" style={{ background: EFFORT.light }} /> {t('activity.mix.pair', { average: fmtNum(lightMean, 0), latest: fmtNum(latestMixRow.activeMinutes.light, 0) })}</span>
                <span className="flex items-center gap-1.5" title={t('activity.mix.moderateMinutes')}><i className="w-2 h-2 rounded-full" style={{ background: EFFORT.moderate }} /> {t('activity.mix.pair', { average: fmtNum(modMean, 0), latest: fmtNum(latestMixRow.activeMinutes.moderate, 0) })}</span>
                <span className="flex items-center gap-1.5" title={t('activity.mix.vigorousMinutes')}><i className="w-2 h-2 rounded-full" style={{ background: EFFORT.vigorous }} /> {t('activity.mix.pair', { average: fmtNum(vigMean, 0), latest: fmtNum(latestMixRow.activeMinutes.vigorous, 0) })}</span>
              </div>
            );
          })() : null
        }
      />
      <StackedBars
        days={mixDays}
        bucket={bucket}
        unit={t('units.minutes')}
        keys={[
          { key: 'light', label: t('activity.mix.light'), color: EFFORT.light, get: (d) => d.activeMinutes?.light ?? null },
          { key: 'moderate', label: t('activity.mix.moderate'), color: EFFORT.moderate, get: (d) => d.activeMinutes?.moderate ?? null },
          { key: 'vigorous', label: t('activity.mix.vigorous'), color: EFFORT.vigorous, get: (d) => d.activeMinutes?.vigorous ?? null },
        ]}
        height={200}
      />
    </Card>
  );
  const distanceCard = (
    <Card>
      <CardHead domain="movement" title={t('activity.distance.title')} hint={t('activity.distance.hint')} right={<CardSummary data={distWin} color="var(--teal-400)" unit={t('units.km')} format={(v) => fmtNum(v, 2)} />} />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(distWin, bucket)} bucket={bucket} color="var(--teal-400)" unit={t('units.km')} height={150} format={(v) => fmtNum(v, 2)} />
      </div>
    </Card>
  );
  const weeklyCard = weeks.length > 0 && <WeeklyTotals weeks={weeks} />;
  // The span in numbers: totals count today so far; the typical and best days are finished ones.
  const spanSteps = values(stepsSpanDone);
  const typical = stats(spanSteps)?.median;
  const best = spanDone.reduce<DailyRecord | null>((a, d) => (d.steps !== null && (!a || d.steps > (a.steps ?? 0)) ? d : a), null);
  const briskPerDay = stats(values(series(spanDone, briskOf)));
  const firstToLast = windowShift(stepsSpanDone, 7).delta;
  const total = (s: Point[]) => stats(values(s))?.sum;
  const summaryCard = (
    <Card>
      <CardHead domain="movement" title={spanSummaryTitle(spanState)} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label={t('activity.summary.typicalDay')}>
          {t('activity.summary.typicalSteps', { count: Math.round(typical ?? 0), steps: fmtNum(typical, 0) })}
        </Row>
        {best && (
          <Row dense={!wide} label={t('activity.summary.bestDay')}>
            {rich('activity.summary.bestDayValue', {
              steps: fmtNum(best.steps, 0),
              date: formatCivilLong(best.date),
              muted: (w) => <span className="text-zinc-500">{w}</span>,
            })}
          </Row>
        )}
        <Row dense={!wide} label={t('activity.summary.daysOver', { goal: formatThousands(goal) })}>{formatInteger(values(stepsWin).filter((v) => v >= goal).length)}</Row>
        <Row dense={!wide} label={t('activity.summary.distance')}>{fmtNum(total(distWin), 1)} {t('units.km')}</Row>
        <Row dense={!wide} label={t('activity.summary.energy')}>{fmtNum(total(kcalWin), 0)} {t('units.kcal')}</Row>
        {briskPerDay && (
          <Row dense={!wide} label={t('activity.summary.brisk')}>
            {rich('activity.summary.briskWeek', {
              minutes: fmtNum(briskPerDay.mean * 7, 0),
              target: WHO_WEEK,
              muted: (w) => <span className="text-zinc-500">{w}</span>,
            })}
          </Row>
        )}
        {spanSteps.length >= 14 && (
          <Row dense={!wide} label={t('activity.summary.firstToLast')}>
            <Delta
              value={firstToLast}
              goodWhen="up"
              digits={0}
              phrase="activity.summary.stepsADay"
              values={{ count: Math.round(Math.abs(firstToLast ?? 0)) }}
            />
          </Row>
        )}
      </div>
    </Card>
  );
  const weekdayCard = (
    <Card className="flex flex-col">
      <CardHead domain="movement" title={t('activity.weekdays.title')} hint={t('activity.weekdays.hint')} />
      {/* Wider screens stretch the chart to the summary beside it; a phone shows it alone, at a fixed height. */}
      {wide ? (
        <div className="flex-1 flex flex-col min-h-[170px]">
          <WeekdayProfile data={byWeekday(stepsSpanDone)} color={DOMAIN.movement.hex} className="flex-1" />
        </div>
      ) : (
        <WeekdayProfile data={byWeekday(stepsSpanDone)} color={DOMAIN.movement.hex} className="h-[180px]" />
      )}
    </Card>
  );
  const charts: { key: ActivityChart; label: string; card: React.ReactNode }[] = [
    { key: 'steps', label: t('activity.chips.steps'), card: stepsCard },
    { key: 'energy', label: t('activity.chips.energy'), card: energyCard },
    { key: 'intensity', label: t('activity.chips.intensity'), card: intensityCard },
    { key: 'distance', label: t('activity.chips.distance'), card: distanceCard },
    { key: 'weekdays', label: t('activity.chips.weekdays'), card: weekdayCard },
    ...(weeklyCard ? [{ key: 'weekly' as const, label: t('activity.chips.weekly'), card: weeklyCard }] : []),
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TodaySoFar day={latestDay} isToday={latestDay.date === today} wide={wide} />
        {lastWeek.some((d) => d.steps !== null) && (
          <LastSevenDays days={lastWeek} shift={periodShift(stepsDone, 7)} ratio={loadRatio(stepsDone).ratio} wide={wide} />
        )}
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-page-ink">
          {t('activity.overTime.title')}
        </h2>
        <SpanSelector state={spanState} />
      </div>

      {wide ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summaryCard}
            {weekdayCard}
          </div>
          {stepsCard}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {energyCard}
            {intensityCard}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {distanceCard}
            {weeklyCard}
          </div>
        </>
      ) : (
        <>
          {summaryCard}
          <ChartChips label={t('activity.chips.label')} options={charts} value={shownChart.key} onChange={setChart} />
          {shownChart.card}
        </>
      )}

      <InsightsCarousel observations={insights} page="activity" />
    </div>
  );
}
