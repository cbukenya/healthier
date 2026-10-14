import React from 'react';
import { Footprints, Heart, Moon, Wind } from 'lucide-react';
import { formatCivilLong, formatClock, type CivilDate } from '../lib/date';
import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, compareToBaseline, goal, isRecent, latestPoint, series, NOISE_FLOOR,
  type Comparison, type Point,
} from '../pipeline/derive';
import { todaySummary } from '../pipeline/insights';
import type { IntradayDays } from '../pipeline/labs';
import { Spark } from '../charts';
import {
  BandPill, Card, DOMAIN, EmptyState, Label, Meter, Row, Value,
  fmtDuration, fmtNum,
} from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import { useGoals } from '../hooks/useGoals';
import { BodyBattery, BodyBatteryCompact } from './BodyBattery';
import { ThisWeek } from './ThisWeek';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { Tile } from '../ui/Tile';

/** Breathing's colour on the Vitals page. */
const BREATHING_HEX = '#a855f7';

/** A comparison's usual range for a sparkline's band, once it has a baseline. */
const usual = (c: Comparison | null) =>
  c && c.baseline !== null && c.spread !== null ? { centre: c.baseline, spread: c.spread } : null;

export function TodayView({
  data,
  intraday,
  clock,
}: {
  data: SyncResult;
  intraday?: IntradayDays;
  /** Demo mode runs on the fixture's clock and zone; live data on this device's. */
  clock?: { now: Date; timeZone: string };
}) {
  const goals = useGoals();
  const s = todaySummary(data, clock?.now, { intraday, timeZone: clock?.timeZone, goals });
  const days = data.days;
  const last = days[days.length - 1];
  const today = last.date;

  const stepsSeries = series(days, (d) => d.steps);
  const sleepSeries = series(days, (d) => d.sleep?.minutesAsleep ?? null);
  const rhrSeries = series(days, (d) => d.restingHr);
  const respSeries = series(days, (d) => d.respiratoryRate);

  const stepsCmp = compareToBaseline(stepsSeries);
  const sleepCmp = compareToBaseline(sleepSeries);

  // The summary keeps only today's or yesterday's movement and sleep; older days aren't "now".
  const mv = s.movementDay;
  const slDay = s.sleepDay;
  const sl = slDay?.sleep ?? null;
  const stepGoal = goal(mv?.steps ?? null, goals.steps);
  const ofGoal = `of ${fmtNum(goals.steps, 0)}`;
  const movementIsToday = mv?.date === today;

  // Each overnight vital from last night or the one before, never further back.
  const rhrNow = isRecent(s.rhr.date, today) ? s.rhr : null;
  const hrvNow = isRecent(s.hrv.date, today) ? s.hrv : null;
  const resp = compareToBaseline(respSeries, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.respiratoryRate);
  const respNow = isRecent(resp.date, today) ? resp : null;
  const spo2Now = recentPoint(series(days, (d) => d.spo2?.avg ?? null), today);
  const vitalsDate = [rhrNow?.date, hrvNow?.date, respNow?.date, spo2Now?.date]
    .filter((d): d is CivilDate => !!d)
    .sort()
    .at(-1) ?? null;

  const battery = {
    score: s.readiness.score,
    parts: s.readiness.parts,
    confidence: s.readiness.confidence,
    label: s.readiness.label,
    missing: s.readiness.missing,
    calibrating: s.readiness.calibrating,
  };
  // A tile's date note, when its reading isn't today's.
  const from = (date: CivilDate | null | undefined) => (date && date !== today ? `From ${formatCivilLong(date)}` : null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        {/* Phones get the compact battery and four tiles; wider screens the full card and its column. */}
        <BodyBatteryCompact {...battery} className="md:hidden" />
        <BodyBattery {...battery} className="hidden md:block lg:col-span-8 h-full" />

        <div className="grid grid-cols-2 gap-2.5 md:hidden">
          <Tile
            label="Last night"
            icon={<Moon size={14} className={DOMAIN.sleep.text} />}
            value={<Value value={sl ? fmtDuration(sl.minutesAsleep) : null} size="md" />}
            pill={sl && <BandPill c={sleepCmp} />}
            chart={sl && <Spark series={sleepSeries.slice(-21)} color={DOMAIN.sleep.hex} height={28} baseline={usual(sleepCmp)} />}
            rows={sl ? [
              ['Score', s.sleepScore && `${s.sleepScore.total}`],
              ['Deep+REM', sl.stages && `${Math.round(((sl.stages.deep + sl.stages.rem) / sl.minutesAsleep) * 100)}%`],
              ['Window', `${formatClock(sl.bedtimeMin)} → ${formatClock(sl.wakeMin)}`],
            ] : []}
            empty={sl ? null : 'Nothing synced for last night or the night before'}
            note={from(slDay?.date)}
          />
          <Tile
            label={movementIsToday ? 'Activity today' : 'Latest activity'}
            icon={<Footprints size={14} className={DOMAIN.movement.text} />}
            value={<Value value={mv?.steps ?? null} size="md" unit="steps" />}
            pill={mv && <BandPill c={stepsCmp} partial={movementIsToday} />}
            chart={mv && (
              <div className="mt-2.5 mb-1">
                <Meter pct={stepGoal.pct} color={DOMAIN.movement.hex} />
                {stepGoal.pct !== null && (
                  <p className="text-note text-zinc-500 mt-1.5 tabular-nums">{Math.round(stepGoal.pct)}% {ofGoal}</p>
                )}
              </div>
            )}
            rows={mv ? [
              ['Distance', mv.distanceKm !== null && `${fmtNum(mv.distanceKm, 2)} km`],
              ['Active', mv.activeMinutes && `${mv.activeMinutes.moderate + mv.activeMinutes.vigorous} min brisk`],
              ['Energy', mv.activeKcal !== null && `${fmtNum(mv.activeKcal, 0)} kcal`],
            ] : []}
            empty={mv ? null : 'No steps synced today or yesterday'}
            note={mv && !movementIsToday ? `${formatCivilLong(mv.date)} · today hasn't synced yet` : null}
          />
          <Tile
            label="Resting HR"
            icon={<Heart size={14} className={DOMAIN.cardio.text} />}
            value={<Value value={rhrNow?.value ?? null} size="md" unit="bpm" />}
            pill={rhrNow && <BandPill c={rhrNow} />}
            chart={rhrNow && <Spark series={rhrSeries.slice(-21)} color={DOMAIN.cardio.hex} height={28} baseline={usual(rhrNow)} />}
            rows={[
              ['HRV', hrvNow && `${fmtNum(hrvNow.value)} ms`],
              ['Usual HRV', hrvNow && hrvNow.baseline !== null && `${fmtNum(hrvNow.baseline)} ms`],
            ]}
            empty={rhrNow || hrvNow ? null : 'No reading for last night or the night before'}
            note={from(rhrNow?.date)}
          />
          <Tile
            label="Breathing"
            icon={<Wind size={14} style={{ color: BREATHING_HEX }} />}
            value={<Value value={respNow?.value ?? null} size="md" digits={1} unit="/min" />}
            pill={respNow && <BandPill c={respNow} />}
            chart={respNow && <Spark series={respSeries.slice(-21)} color={BREATHING_HEX} height={28} baseline={usual(respNow)} />}
            rows={[
              ['Usual', respNow && respNow.baseline !== null && `${fmtNum(respNow.baseline)} /min`],
              ['Blood oxygen', spo2Now && `${fmtNum(spo2Now.value)}%`],
            ]}
            empty={respNow || spo2Now ? null : 'No reading for last night or the night before'}
            note={from(respNow?.date)}
          />
        </div>

        <div className="hidden md:grid lg:col-span-4 grid-cols-1 gap-3">
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
                    <Spark series={sleepSeries.slice(-21)} color={DOMAIN.sleep.hex} baseline={usual(sleepCmp)} />
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
                  {slDay!.date !== today && (
                    <p className="text-note text-amber-400/80 mt-2">
                      Most recent night on record: {formatCivilLong(slDay!.date)}
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="No sleep recorded" detail="Nothing has synced for last night or the night before." />
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
                    <BandPill c={stepsCmp} partial={movementIsToday} />
                  </div>
                  <div className="mt-3">
                    <Meter pct={stepGoal.pct} color={DOMAIN.movement.hex} />
                    <p className="text-note text-zinc-500 mt-1.5 tabular-nums">
                      {stepGoal.pct === null ? '' : `${Math.round(stepGoal.pct)}% ${ofGoal}`}
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
                    <p className="text-note text-amber-400/80 mt-2">
                      {formatCivilLong(mv.date)} · today hasn't synced yet
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title="No movement data" detail="No steps have synced today or yesterday." />
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>Overnight vitals</Label>
                <Heart size={14} className={DOMAIN.cardio.text} />
              </div>
              {vitalsDate ? (
                <>
                  <div className="mt-3">
                    <Value value={rhrNow?.value ?? null} size="lg" unit="bpm" />
                  </div>
                  {rhrNow && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <BandPill c={rhrNow} />
                    </div>
                  )}
                  <div className="mt-3">
                    <Spark series={rhrSeries.slice(-21)} color={DOMAIN.cardio.hex} baseline={usual(rhrNow)} />
                  </div>
                  <div className="mt-2 space-y-0">
                    <Row label="HRV">
                      {hrvNow ? (
                        <>
                          {fmtNum(hrvNow.value)} ms{' '}
                          <span className="text-zinc-500">
                            (usual {fmtNum(hrvNow.baseline)})
                          </span>
                        </>
                      ) : '—'}
                    </Row>
                    <Row label="Breathing">{respNow ? `${fmtNum(respNow.value)} /min` : '—'}</Row>
                    <Row label="Blood oxygen">{spo2Now ? `${fmtNum(spo2Now.value)}%` : '—'}</Row>
                  </div>
                  {vitalsDate !== today && (
                    <p className="text-note text-amber-400/80 mt-2">
                      Most recent vitals on record: {formatCivilLong(vitalsDate)}
                    </p>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <EmptyState title="No vitals recorded" detail="No overnight vitals have synced for last night or the night before." />
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Stacked, the carousel comes last, as on every other page; side by side it leads the row. */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">
        <div className="order-2 lg:order-1 lg:col-span-8 flex flex-col h-full">
          <InsightsCarousel observations={s.observations} />
        </div>

        {s.week && (
          <div className="order-1 lg:order-2 lg:col-span-4 flex flex-col h-full">
            <ThisWeek week={s.week} days={days} needMin={s.sleepTargetMin} className="flex-1" />
          </div>
        )}
      </div>
    </div>
  );
}


/** A series' latest reading, if it's from today or yesterday. */
function recentPoint(s: Point[], today: CivilDate): Point | null {
  const p = latestPoint(s);
  return p && isRecent(p.date, today) ? p : null;
}
