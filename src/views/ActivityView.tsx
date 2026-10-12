import React, { useMemo, useState } from 'react';
import { formatCivil, formatCivilLong } from '../lib/date';
import {
  byWeekday, completedDays, loadRatio, periodShift, series, stats, values, windowShift, type Point,
} from '../pipeline/derive';
import { BarSeries, StackedBars, TrendChart, WeekdayProfile } from '../charts';
import { Card, CardHead, DOMAIN, Delta, EmptyState, Meter, Row, fmtNum, CardSummary } from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import type { DailyRecord } from '../types/health';
import { groupMean, groupSeries } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { SpanSelector, spanName, useSpan } from '../ui/span';
import { ChartChips } from '../ui/ChartChips';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { LastSevenDays, STEP_GOAL, TodaySoFar, briskOf } from './ActivityCards';

type ActivityChart = 'steps' | 'energy' | 'intensity' | 'distance' | 'weekdays' | 'weekly';

export function ActivityView({ data }: { data: SyncResult }) {
  const days = data.days;
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
          title="No movement data in this window"
          detail="Steps, distance and active minutes come from the activity_and_fitness scope. The Data tab shows exactly what each stream returned."
        />
      </Card>
    );
  }

  // Weekly totals, Monday-anchored, only for weeks that are fully covered.
  const weeks = groupWeeks(days);
  // The day card shows today once it has steps, else the latest day that does.
  const latestDay = [...days].reverse().find((d) => d.steps !== null)!;
  const lastWeek = done.slice(-7);

  const latestMixRow = [...window].reverse().find(d => d.activeMinutes !== null);

  // The over-time cards: side by side on wider screens, one at a time behind chips on a phone.
  const stepsCard = (
    <Card>
      <CardHead
        domain="movement"
        title="Daily steps"
        hint="Solid bars cleared 10,000. Missing bars are days the tracker recorded nothing — they're excluded from every average on this page."
        right={<CardSummary data={stepsWin} color={DOMAIN.movement.hex} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(stepsWin, bucket)} bucket={bucket} color={DOMAIN.movement.hex} goal={10000} unit="steps" height={210} />
      </div>
    </Card>
  );
  const energyCard = (
    <Card>
      <CardHead domain="movement" title="Active energy" hint="Above your basal rate — the part you moved for." right={<CardSummary data={kcalWin} color="#fbbf24" unit="kcal" format={(v) => fmtNum(v, 0)} />} />
      <div className="px-2 pb-3">
        <BarSeries series={groupSeries(kcalWin, bucket)} bucket={bucket} color="#fbbf24" unit="kcal" height={200} />
      </div>
    </Card>
  );
  const intensityCard = (
    <Card>
      <CardHead
        domain="movement"
        title="Intensity mix"
        hint={
          <span>
            <span className="text-emerald-400 font-medium">Light</span> minutes accumulate from daily life; <span className="text-amber-400 font-medium">Moderate</span> and <span className="text-rose-400 font-medium">Vigorous</span> are the ones guidelines count. 150 brisk minutes a week is the usual target.
          </span>
        }
        right={
          latestMixRow?.activeMinutes ? (() => {
            const lightMean = stats(values(series(window, d => d.activeMinutes?.light ?? null)))?.mean ?? 0;
            const modMean = stats(values(series(window, d => d.activeMinutes?.moderate ?? null)))?.mean ?? 0;
            const vigMean = stats(values(series(window, d => d.activeMinutes?.vigorous ?? null)))?.mean ?? 0;
            return (
              <div className="flex items-center gap-2.5 text-[11px] font-medium text-zinc-300">
                <span className="text-zinc-500">{latestMixRow.date === today ? 'avg vs today so far (min):' : 'avg vs latest (min):'}</span>
                <span className="flex items-center gap-1.5" title="Light minutes"><i className="w-2 h-2 rounded-full bg-[#22c55e]" /> {fmtNum(lightMean, 0)}/{fmtNum(latestMixRow.activeMinutes.light, 0)}</span>
                <span className="flex items-center gap-1.5" title="Moderate minutes"><i className="w-2 h-2 rounded-full bg-[#eab308]" /> {fmtNum(modMean, 0)}/{fmtNum(latestMixRow.activeMinutes.moderate, 0)}</span>
                <span className="flex items-center gap-1.5" title="Vigorous minutes"><i className="w-2 h-2 rounded-full bg-[#f43f5e]" /> {fmtNum(vigMean, 0)}/{fmtNum(latestMixRow.activeMinutes.vigorous, 0)}</span>
              </div>
            );
          })() : null
        }
      />
      <StackedBars
        days={mixDays}
        bucket={bucket}
        unit="min"
        keys={[
          { key: 'light', label: 'Light', color: '#22c55e', get: (d) => d.activeMinutes?.light ?? null },
          { key: 'moderate', label: 'Moderate', color: '#eab308', get: (d) => d.activeMinutes?.moderate ?? null },
          { key: 'vigorous', label: 'Vigorous', color: '#f43f5e', get: (d) => d.activeMinutes?.vigorous ?? null },
        ]}
        height={200}
      />
    </Card>
  );
  const distanceCard = (
    <Card>
      <CardHead domain="movement" title="Distance" hint="From the reported distance stream, not estimated from step count." right={<CardSummary data={distWin} color="#2dd4bf" unit="km" format={(v) => fmtNum(v, 2)} />} />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(distWin, bucket)} bucket={bucket} color="#2dd4bf" unit="km" height={150} format={(v) => fmtNum(v, 2)} />
      </div>
    </Card>
  );
  const weeklyCard = weeks.length > 1 && (
    <Card>
      <CardHead
        domain="movement"
        title="Weekly totals"
        hint="Only weeks with at least four recorded days are shown, so a partial week can't look like a collapse."
        right={<CardSummary vals={weeks.map(w => w.total).reverse()} color={DOMAIN.movement.hex} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-5 pb-5 space-y-2">
        {weeks.map((w) => (
          <div key={w.start} className="flex items-center gap-3">
            <span className="w-[92px] shrink-0 text-[11px] text-zinc-500">{formatCivil(w.start)}</span>
            <div className="flex-1">
              <Meter pct={(w.total / 70000) * 100} color={DOMAIN.movement.hex} />
            </div>
            <span className="w-[64px] shrink-0 text-right text-[11.5px] text-zinc-200 tabular-nums">
              {fmtNum(w.total, 0)}
            </span>
            <span className="w-[54px] shrink-0 text-right text-[10px] text-zinc-600">
              {w.days}/7 days
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
  // The span in numbers: totals count today so far; the typical and best days are finished ones.
  const spanSteps = values(stepsSpanDone);
  const best = spanDone.reduce<DailyRecord | null>((a, d) => (d.steps !== null && (!a || d.steps > (a.steps ?? 0)) ? d : a), null);
  const briskPerDay = stats(values(series(spanDone, briskOf)));
  const total = (s: Point[]) => stats(values(s))?.sum;
  const summaryCard = (
    <Card>
      <CardHead domain="movement" title={`${spanName(spanState)} summary`} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label="Typical day">{fmtNum(stats(spanSteps)?.median, 0)} steps</Row>
        {best && (
          <Row dense={!wide} label="Best day">
            {fmtNum(best.steps, 0)}
            <span className="text-zinc-500"> · {formatCivilLong(best.date)}</span>
          </Row>
        )}
        <Row dense={!wide} label="Days over 10k">{values(stepsWin).filter((v) => v >= STEP_GOAL).length}</Row>
        <Row dense={!wide} label="Distance">{fmtNum(total(distWin), 1)} km</Row>
        <Row dense={!wide} label="Active energy">{fmtNum(total(kcalWin), 0)} kcal</Row>
        {briskPerDay && (
          <Row dense={!wide} label="Brisk minutes">
            {fmtNum(briskPerDay.mean * 7, 0)} a week
            <span className="text-zinc-500"> · target 150</span>
          </Row>
        )}
        {spanSteps.length >= 14 && (
          <Row dense={!wide} label="First week to last">
            <Delta value={windowShift(stepsSpanDone, 7).delta} goodWhen="up" digits={0} suffix="steps a day" />
          </Row>
        )}
      </div>
    </Card>
  );
  const weekdayCard = (
    <Card className="flex flex-col">
      <CardHead domain="movement" title="Which days you move" hint="Average steps on each day of the week." />
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
    { key: 'steps', label: 'Steps', card: stepsCard },
    { key: 'energy', label: 'Energy', card: energyCard },
    { key: 'intensity', label: 'Intensity', card: intensityCard },
    { key: 'distance', label: 'Distance', card: distanceCard },
    { key: 'weekdays', label: 'Weekdays', card: weekdayCard },
    ...(weeklyCard ? [{ key: 'weekly' as const, label: 'Weekly totals', card: weeklyCard }] : []),
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
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your movement over time
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
          <ChartChips label="Chart" options={charts} value={shownChart.key} onChange={setChart} />
          {shownChart.card}
        </>
      )}
    </div>
  );
}

function groupWeeks(days: SyncResult['days']) {
  const out: { start: string; total: number; days: number }[] = [];
  let cur: { start: string; total: number; days: number } | null = null;
  for (const d of days) {
    const [y, m, dd] = d.date.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    const isMonday = wd === 1;
    if (!cur || isMonday) {
      if (cur && cur.days >= 4) out.push(cur);
      cur = { start: d.date, total: 0, days: 0 };
    }
    if (d.steps !== null) {
      cur.total += d.steps;
      cur.days++;
    }
  }
  if (cur && cur.days >= 4) out.push(cur);
  return out.reverse();
}
