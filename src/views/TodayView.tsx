import React from 'react';
import { Footprints, Heart, Moon, Activity, Database } from 'lucide-react';
import { formatCivilLong, formatClock, daysBetween } from '../lib/date';
import {
  compareToBaseline, coverage, goal, loadRatio, series, values,
} from '../pipeline/derive';
import { todaySummary } from '../pipeline/insights';
import type { IntradayDays } from '../pipeline/labs';
import { STREAMS } from '../pipeline/registry';
import { Spark } from '../charts';
import {
  BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Label, Meter, Row, Value,
  fmtDuration, fmtNum,
} from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import { BodyBattery } from './BodyBattery';
import { InsightsCarousel } from '../components/InsightsCarousel';

export function TodayView({ data, intraday }: { data: SyncResult; intraday?: IntradayDays }) {
  const s = todaySummary(data, undefined, { intraday });
  const days = data.days;
  const last = days[days.length - 1];

  const stepsSeries = series(days, (d) => d.steps);
  const sleepSeries = series(days, (d) => d.sleep?.minutesAsleep ?? null);
  const hrvSeries = series(days, (d) => d.hrv);
  const rhrSeries = series(days, (d) => d.restingHr);

  const stepsCmp = compareToBaseline(stepsSeries);
  const sleepCmp = compareToBaseline(sleepSeries);

  const mv = s.movementDay && daysBetween(s.movementDay.date, last.date) <= 2 ? s.movementDay : null;
  const slDay = s.sleepDay && daysBetween(s.sleepDay.date, last.date) <= 2 ? s.sleepDay : null;
  const sl = slDay?.sleep ?? null;
  const latestVitalsDay = [...days].reverse().find(d => (d.restingHr !== null || d.hrv !== null) && daysBetween(d.date, last.date) <= 2) ?? null;
  const stepGoal = goal(mv?.steps ?? null, 10000);
  const load = loadRatio(stepsSeries);

  const cov = coverage(days, STREAMS.map((x) => ({ dataType: x.dataType, label: x.label })));
  const freshToday = cov.filter((c) => c.staleDays === 0).length;
  const movementIsToday = mv?.date === last.date;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <BodyBattery 
          score={s.readiness.score} 
          parts={s.readiness.parts} 
          confidence={s.readiness.confidence} 
          label={s.readiness.label}
          className="lg:col-span-8 h-full"
        />

        <div className="lg:col-span-4 grid grid-cols-1 gap-3">
          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>Last night sleep</Label>
                <Moon size={14} className={DOMAIN.sleep.text} />
              </div>
              {sl ? (
                <>
                  <div className="mt-3">
                    <Value value={fmtDuration(sl.minutesAsleep)} size="lg" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <BandPill c={sleepCmp} />
                  </div>
                  <div className="mt-3">
                    <Spark series={sleepSeries.slice(-21)} color={DOMAIN.sleep.hex} />
                  </div>
                  <div className="mt-2 space-y-0">
                    <Row label="Score">
                      {s.sleepScore ? `${s.sleepScore.total} / 100` : '—'}
                    </Row>
                    <Row label="Deep + REM">
                      {sl.stages ? `${Math.round(((sl.stages.deep + sl.stages.rem) / sl.minutesAsleep) * 100)}%` : '—'}
                    </Row>
                    <Row label="Asleep">
                      {formatClock(sl.bedtimeMin)} → {formatClock(sl.wakeMin)}
                    </Row>
                  </div>
                  {slDay!.date !== last.date && (
                    <p className="text-[10px] text-amber-400/80 mt-2">
                      Most recent night on record: {formatCivilLong(slDay!.date)}
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="No sleep recorded" detail="Nothing has synced for last night yet." />
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>{movementIsToday ? 'Activity today' : 'Latest activity'}</Label>
                <Footprints size={14} className={DOMAIN.movement.text} />
              </div>
              {mv ? (
                <>
                  <div className="mt-3">
                    <Value value={mv.steps} size="lg" unit="steps" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <BandPill c={stepsCmp} />
                  </div>
                  <div className="mt-3">
                    <Meter pct={stepGoal.pct} color={DOMAIN.movement.hex} />
                    <p className="text-[10px] text-zinc-500 mt-1.5 tabular-nums">
                      {stepGoal.pct === null ? '' : `${Math.round(stepGoal.pct)}% of 10,000`}
                    </p>
                  </div>
                  <div className="mt-1.5 space-y-0">
                    <Row label="Distance">{fmtNum(mv.distanceKm, 2)} km</Row>
                    <Row label="Active">
                      {mv.activeMinutes
                        ? `${mv.activeMinutes.moderate + mv.activeMinutes.vigorous} min brisk`
                        : '—'}
                    </Row>
                    <Row label="Energy">
                      {mv.activeKcal === null ? '—' : `${fmtNum(mv.activeKcal, 0)} active kcal`}
                    </Row>
                  </div>
                  {!movementIsToday && (
                    <p className="text-[10px] text-amber-400/80 mt-2">
                      {formatCivilLong(mv.date)} · today hasn't synced yet
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="No movement data" detail="No steps have synced in this window." />
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>Overnight vitals</Label>
                <Heart size={14} className={DOMAIN.cardio.text} />
              </div>
              {latestVitalsDay ? (
                <>
                  <div className="mt-3">
                    <Value value={s.rhr.value} size="lg" unit="bpm" />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <BandPill c={s.rhr} />
                  </div>
                  <div className="mt-3">
                    <Spark series={rhrSeries.slice(-21)} color={DOMAIN.cardio.hex} />
                  </div>
                  <div className="mt-2 space-y-0">
                    <Row label="HRV">
                      {fmtNum(s.hrv.value)} ms{' '}
                      <span className="text-zinc-500">
                        (usual {fmtNum(s.hrv.baseline)})
                      </span>
                    </Row>
                    <Row label="Breathing">{fmtNum(latestVitalsDay.respiratoryRate ?? lastKnown(days, (d) => d.respiratoryRate))} /min</Row>
                    <Row label="Blood oxygen">
                      {(() => {
                        const sp = latestVitalsDay.spo2 ?? lastKnownObj(days, (d) => d.spo2);
                        return sp ? `${fmtNum(sp.avg)}%` : '—';
                      })()}
                    </Row>
                  </div>
                  {latestVitalsDay.date !== last.date && (
                    <p className="text-[10px] text-amber-400/80 mt-2">
                      Most recent vitals on record: {formatCivilLong(latestVitalsDay.date)}
                    </p>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <EmptyState title="No vitals recorded" detail="No overnight vitals have synced." />
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
        <div className="lg:col-span-8 flex flex-col h-full">
          <InsightsCarousel observations={s.observations} />
        </div>

        <div className="lg:col-span-4 flex flex-col h-full">
          <Card className="flex-1 flex flex-col">
            <CardHead
              title="Where these numbers came from"
              hint={`${data.meta.streams.filter((x) => x.status === 'ok').length} of ${data.meta.streams.length} streams returned data across ${days.length} days.`}
              domain="data"
            />
            <div className="px-5 pb-5">
            <div className="grid grid-cols-3 gap-3 pb-4 border-b border-zinc-800/60">
              <div>
                <Value value={freshToday} size="md" />
                <p className="text-[10px] text-zinc-500 mt-0.5">streams current</p>
              </div>
              <div>
                <Value value={values(stepsSeries).length} size="md" />
                <p className="text-[10px] text-zinc-500 mt-0.5">days of movement</p>
              </div>
              <div>
                <Value value={values(sleepSeries).length} size="md" />
                <p className="text-[10px] text-zinc-500 mt-0.5">nights of sleep</p>
              </div>
            </div>
            <div className="pt-3 space-y-0">
              {data.meta.sources.map((src) => (
                <Row key={src.id} label={src.label}>
                  <span className="text-zinc-500 text-[11px]">
                    {src.platform.replace('_', ' ').toLowerCase()} · {src.method.replace('_', ' ').toLowerCase()}
                  </span>
                </Row>
              ))}
              <Row label="Activity ramp (this week vs prior 3)">
                {load.ratio === null ? '—' : `${load.ratio.toFixed(2)}×`}
              </Row>
              <Row label={`Sleep vs your ~${Math.round((s.sleepTargetMin / 60) * 10) / 10}h target, last 7 nights`}>
                {s.debt === null ? (
                  <span className="text-zinc-500">too few nights</span>
                ) : s.debt.deficitMin > 0 ? (
                  <span className="text-amber-300">
                    {(s.debt.deficitMin / 60).toFixed(1)}h short
                    {s.debt.coverage === 'partial' && <span className="text-zinc-500"> (est.)</span>}
                  </span>
                ) : (
                  <span className="text-emerald-400">on target</span>
                )}
              </Row>
            </div>
          </div>
        </Card>
      </div>
      </div>
    </div>
  );
}

function lastKnown(days: SyncResult['days'], get: (d: SyncResult['days'][number]) => number | null) {
  for (let i = days.length - 1; i >= 0; i--) {
    const v = get(days[i]);
    if (v !== null) return v;
  }
  return null;
}

function lastKnownObj<T>(days: SyncResult['days'], get: (d: SyncResult['days'][number]) => T | null): T | null {
  for (let i = days.length - 1; i >= 0; i--) {
    const v = get(days[i]);
    if (v !== null) return v;
  }
  return null;
}
