import React, { useMemo } from 'react';
import { formatCivil } from '../lib/date';
import {
  byWeekday, compareToBaseline, completedDays, goal, goalStreak, loadRatio, periodShift, series,
  stats, values, windowShift,
} from '../pipeline/derive';
import { BarSeries, StackedBars, TrendChart, WeekdayProfile } from '../charts';
import {
  BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Label, Meter, Row, Segmented, Value,
  fmtNum,
  CardSummary,
} from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import { groupMean, groupSeries } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { SpanSelector, useSpan } from '../ui/span';

export function ActivityView({ data }: { data: SyncResult }) {
  const days = data.days;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;

  const today = days.at(-1)?.date ?? null;
  const mvpaOf = (d: SyncResult['days'][number]) =>
    d.activeMinutes ? d.activeMinutes.moderate + d.activeMinutes.vigorous : null;
  const stepsAll = series(days, (d) => d.steps);
  const stepsWin = series(window, (d) => d.steps);
  const distWin = series(window, (d) => d.distanceKm);
  const kcalWin = series(window, (d) => d.activeKcal);
  const mvpaAll = series(days, mvpaOf);
  // Today is still in progress: averages, the ramp and week-on-week read finished days only.
  const done = completedDays(days);
  const stepsDone = series(done, (d) => d.steps);
  const mvpaDone = series(done, mvpaOf);

  const stepsCmp = compareToBaseline(stepsAll);
  const mvpaCmp = compareToBaseline(mvpaAll);
  const load = loadRatio(stepsDone);
  const stepStats = stats(values(stepsDone));
  const streak = goalStreak(stepsAll, (v) => v >= 10000);
  const shift = periodShift(stepsDone, 7);
  const recorded = values(stepsAll).length;

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

  const latestMixRow = [...window].reverse().find(d => d.activeMinutes !== null);
  return (
    <div className="space-y-3">
      {/* headline row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Steps, latest day"
          value={stepsCmp.value}
          unit="steps"
          cmp={stepsCmp}
          today={today}
          meter={goal(stepsCmp.value, 10000)}
          color={DOMAIN.movement.hex}
        />
        <StatCard
          label="Brisk minutes, latest"
          value={mvpaCmp.value}
          unit="min"
          cmp={mvpaCmp}
          today={today}
          meter={goal(mvpaCmp.value, 30)}
          color={DOMAIN.movement.hex}
          footnote="moderate + vigorous"
        />
        <Card>
          <div className="px-4 py-4">
            <Label>Week on week</Label>
            <div className="mt-2">
              <Value value={shift.current} size="lg" unit="avg steps" digits={0} />
            </div>
            <div className="mt-2">
              <Delta value={shift.delta} goodWhen="up" digits={0} suffix="vs previous 7 days" />
            </div>
            <p className="text-[10px] text-zinc-600 mt-2">
              {streak > 0 ? `${streak}-day streak over 10,000` : 'No current 10k streak'}
            </p>
          </div>
        </Card>
        <Card>
          <div className="px-4 py-4">
            <Label>Ramp rate</Label>
            <div className="mt-2">
              <Value value={load.ratio} size="lg" unit="×" digits={2} />
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 leading-relaxed">
              This week's volume against the three weeks before it — separate windows, so
              the comparison isn't diluted by itself.{' '}
              {load.ratio === null
                ? ''
                : load.ratio > 1.5
                  ? 'A fast ramp. Worth noticing, though the popular injury-risk reading of this ratio is contested.'
                  : load.ratio < 0.8
                    ? 'Easing off.'
                    : 'Steady.'}
            </p>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead title="Activity summary" hint={`${recorded} recorded days of ${days.length}.`} />
          <div className="px-5 pb-5">
            <Row label="Typical day (median)">{fmtNum(stepStats?.median, 0)} steps</Row>
            <Row label="Best day">
              {fmtNum(stepStats?.max, 0)}
              {(() => {
                const best = done.reduce<null | typeof days[number]>(
                  (a, d) => (d.steps !== null && (!a || d.steps > (a.steps ?? 0)) ? d : a), null);
                return best ? <span className="text-zinc-600"> · {formatCivil(best.date)}</span> : null;
              })()}
            </Row>
            <Row label="Days over 10k">
              {values(stepsAll).filter((v) => v >= 10000).length} of {recorded}
            </Row>
            <Row label="Total distance">
              {fmtNum(stats(values(series(days, (d) => d.distanceKm)))?.sum, 1)} km
            </Row>
            <Row label="Total active energy">
              {fmtNum(stats(values(series(days, (d) => d.activeKcal)))?.sum, 0)} kcal
            </Row>
            <Row label="Brisk minutes / week">
              {(() => {
                const m = stats(values(mvpaDone));
                return m ? `${Math.round(m.mean * 7)} (target 150)` : '—';
              })()}
            </Row>
            <Row label="Across the window">
              <Delta value={windowShift(stepsDone, 7).delta} goodWhen="up" digits={0} suffix="steps/day" />
            </Row>
          </div>
        </Card>
        <Card className="flex flex-col">
          <CardHead
            domain="movement"
            title="Which days you move"
            hint={`Average steps per weekday across ${values(stepsDone).length} finished days.`}
          />
          {/* The chart takes the card's height, which on desktop matches the summary beside it. */}
          <div className="flex-1 flex flex-col min-h-[170px]">
            <WeekdayProfile data={byWeekday(stepsDone)} color={DOMAIN.movement.hex} className="flex-1" />
          </div>
        </Card>
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your movement over time
        </h2>
        <SpanSelector state={spanState} />
      </div>

      {/* volume */}
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

      {/* active energy + intensity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead domain="movement" title="Active energy" hint="Above your basal rate — the part you moved for." right={<CardSummary data={kcalWin} color="#fbbf24" unit="kcal" format={(v) => fmtNum(v, 0)} />} />
          <div className="px-2 pb-3">
            <BarSeries series={groupSeries(kcalWin, bucket)} bucket={bucket} color="#fbbf24" unit="kcal" height={200} />
          </div>
        </Card>
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
      </div>

      {/* distance / weekly totals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead domain="movement" title="Distance" hint="From the reported distance stream, not estimated from step count." right={<CardSummary data={distWin} color="#2dd4bf" unit="km" format={(v) => fmtNum(v, 2)} />} />
          <div className="px-2 pb-3">
            <TrendChart series={groupSeries(distWin, bucket)} bucket={bucket} color="#2dd4bf" unit="km" height={150} format={(v) => fmtNum(v, 2)} />
          </div>
        </Card>
        {weeks.length > 1 && (
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
        )}
      </div>
    </div>
  );
}

function StatCard({
  label, value, unit, cmp, today, meter, color, footnote,
}: {
  label: string;
  value: number | null;
  unit: string;
  cmp: ReturnType<typeof compareToBaseline>;
  /** The window's last day: today, still in progress. */
  today: string | null;
  meter?: ReturnType<typeof goal>;
  color: string;
  footnote?: string;
}) {
  const isToday = cmp.date !== undefined && cmp.date === today;
  return (
    <Card>
      <div className="px-4 py-4">
        <Label>{label} <span className="text-[9px] font-normal lowercase tracking-normal">({isToday ? 'today' : 'latest'})</span></Label>
        <div className="mt-2"><Value value={value} size="lg" unit={unit} /></div>
        <div className="mt-2"><BandPill c={cmp} partial={isToday} /></div>
        {meter && (
          <div className="mt-3">
            <Meter pct={meter.pct} color={color} />
            <p className="text-[10px] text-zinc-600 mt-1.5 tabular-nums">
              {meter.pct === null ? '' : `${Math.round(meter.pct)}% of ${fmtNum(meter.goal, 0)}`}
              {footnote ? ` · ${footnote}` : ''}
            </p>
          </div>
        )}
      </div>
    </Card>
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
