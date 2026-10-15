import React from 'react';
import { Footprints, Heart, Moon, Wind } from 'lucide-react';
import type { CivilDate } from '../lib/date';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivilLong, formatClock } from '../i18n/format';
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
import { useCycle } from '../hooks/useCycle';
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
  const { insight: cycle, judged } = useCycle();
  const s = todaySummary(data, clock?.now, { intraday, timeZone: clock?.timeZone, goals, cycle: cycle ?? undefined });
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
  const ofGoal = (pct: number) => t('today.activity.ofGoal', { percent: Math.round(pct), goal: fmtNum(goals.steps, 0) });
  const movementIsToday = mv?.date === today;

  // Each overnight vital from last night or the one before, never further back.
  const rhrNow = isRecent(s.rhr.date, today) ? s.rhr : null;
  // With cycle tracking on, the same reading judged against this part of the cycle.
  const rhrCycle = judged && compareToBaseline(series(judged, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);
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
  const from = (date: CivilDate | null | undefined) => (date && date !== today ? t('today.from', { date: formatCivilLong(date) }) : null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        {/* Phones get the compact battery and four tiles; wider screens the full card and its column. */}
        <BodyBatteryCompact {...battery} className="md:hidden" />
        <BodyBattery {...battery} className="hidden md:block lg:col-span-8 h-full" />

        <div className="grid grid-cols-2 gap-2.5 md:hidden">
          <Tile
            label={t('today.sleep.tile')}
            icon={<Moon size={14} className={DOMAIN.sleep.text} />}
            value={<Value value={sl ? fmtDuration(sl.minutesAsleep) : null} size="md" />}
            pill={sl && <BandPill c={sleepCmp} />}
            chart={sl && <Spark series={sleepSeries.slice(-21)} color={DOMAIN.sleep.hex} height={28} baseline={usual(sleepCmp)} />}
            rows={sl ? [
              [t('today.sleep.score'), s.sleepScore && `${s.sleepScore.total}`],
              [t('today.sleep.restorativeShort'), sl.stages && `${Math.round(((sl.stages.deep + sl.stages.rem) / sl.minutesAsleep) * 100)}${t('units.percent')}`],
              [t('today.sleep.window'), t('today.sleep.span', { from: formatClock(sl.bedtimeMin), to: formatClock(sl.wakeMin) })],
            ] : []}
            empty={sl ? null : t('today.sleep.tileEmpty')}
            note={from(slDay?.date)}
          />
          <Tile
            label={movementIsToday ? t('today.activity.today') : t('today.activity.latest')}
            icon={<Footprints size={14} className={DOMAIN.movement.text} />}
            value={<Value value={mv?.steps ?? null} size="md" unit={t('units.steps')} />}
            pill={mv && <BandPill c={stepsCmp} partial={movementIsToday} />}
            chart={mv && (
              <div className="mt-2.5 mb-1">
                <Meter pct={stepGoal.pct} color={DOMAIN.movement.hex} />
                {stepGoal.pct !== null && (
                  <p className="text-note text-zinc-500 mt-1.5 tabular-nums">{ofGoal(stepGoal.pct)}</p>
                )}
              </div>
            )}
            rows={mv ? [
              [t('today.activity.distance'), mv.distanceKm !== null && `${fmtNum(mv.distanceKm, 2)} ${t('units.km')}`],
              [t('today.activity.active'), mv.activeMinutes && t('today.activity.brisk', { minutes: mv.activeMinutes.moderate + mv.activeMinutes.vigorous })],
              [t('today.activity.energy'), mv.activeKcal !== null && `${fmtNum(mv.activeKcal, 0)} ${t('units.kcal')}`],
            ] : []}
            empty={mv ? null : t('today.activity.tileEmpty')}
            note={mv && !movementIsToday ? t('today.activity.notSynced', { date: formatCivilLong(mv.date) }) : null}
          />
          <Tile
            label={t('today.heart.label')}
            icon={<Heart size={14} className={DOMAIN.cardio.text} />}
            value={<Value value={rhrNow?.value ?? null} size="md" unit={t('units.bpm')} />}
            pill={rhrNow && <BandPill c={rhrNow} cycle={rhrCycle} />}
            chart={rhrNow && <Spark series={rhrSeries.slice(-21)} color={DOMAIN.cardio.hex} height={28} baseline={usual(rhrNow)} />}
            rows={[
              [t('today.heart.hrv'), hrvNow && `${fmtNum(hrvNow.value)} ${t('units.ms')}`],
              [t('today.heart.usualHrv'), hrvNow && hrvNow.baseline !== null && `${fmtNum(hrvNow.baseline)} ${t('units.ms')}`],
            ]}
            empty={rhrNow || hrvNow ? null : t('today.heart.empty')}
            note={from(rhrNow?.date)}
          />
          <Tile
            label={t('today.breathing.label')}
            icon={<Wind size={14} style={{ color: BREATHING_HEX }} />}
            value={<Value value={respNow?.value ?? null} size="md" digits={1} unit={t('units.perMinute')} />}
            pill={respNow && <BandPill c={respNow} />}
            chart={respNow && <Spark series={respSeries.slice(-21)} color={BREATHING_HEX} height={28} baseline={usual(respNow)} />}
            rows={[
              [t('today.breathing.usual'), respNow && respNow.baseline !== null && `${fmtNum(respNow.baseline)} ${t('units.perMinute')}`],
              [t('today.breathing.bloodOxygen'), spo2Now && `${fmtNum(spo2Now.value)}${t('units.percent')}`],
            ]}
            empty={respNow || spo2Now ? null : t('today.breathing.empty')}
            note={from(respNow?.date)}
          />
        </div>

        <div className="hidden md:grid lg:col-span-4 grid-cols-1 gap-3">
          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>{t('today.sleep.title')}</Label>
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
                    <Row label={t('today.sleep.score')}>
                      {s.sleepScore ? t('today.sleep.scoreOutOf', { score: s.sleepScore.total }) : '—'}
                    </Row>
                    <Row label={t('today.sleep.restorative')}>
                      {sl.stages ? `${Math.round(((sl.stages.deep + sl.stages.rem) / sl.minutesAsleep) * 100)}${t('units.percent')}` : '—'}
                    </Row>
                    <Row label={t('today.sleep.asleep')}>
                      {t('today.sleep.span', { from: formatClock(sl.bedtimeMin), to: formatClock(sl.wakeMin) })}
                    </Row>
                  </div>
                  {slDay!.date !== today && (
                    <p className="text-note text-amber-400/80 mt-2">
                      {t('today.sleep.latest', { date: formatCivilLong(slDay!.date) })}
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title={t('today.sleep.emptyTitle')} detail={t('today.sleep.emptyDetail')} />
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>{movementIsToday ? t('today.activity.today') : t('today.activity.latest')}</Label>
                <Footprints size={14} className={DOMAIN.movement.text} />
              </div>
              {mv ? (
                <>
                  <div className="mt-3">
                    <Value value={mv.steps} size="lg" unit={t('units.steps')} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <BandPill c={stepsCmp} partial={movementIsToday} />
                  </div>
                  <div className="mt-3">
                    <Meter pct={stepGoal.pct} color={DOMAIN.movement.hex} />
                    <p className="text-note text-zinc-500 mt-1.5 tabular-nums">
                      {stepGoal.pct === null ? '' : ofGoal(stepGoal.pct)}
                    </p>
                  </div>
                  <div className="mt-1.5 space-y-0">
                    <Row label={t('today.activity.distance')}>{fmtNum(mv.distanceKm, 2)} {t('units.km')}</Row>
                    <Row label={t('today.activity.active')}>
                      {mv.activeMinutes
                        ? t('today.activity.brisk', { minutes: mv.activeMinutes.moderate + mv.activeMinutes.vigorous })
                        : '—'}
                    </Row>
                    <Row label={t('today.activity.energy')}>
                      {mv.activeKcal === null ? '—' : t('today.activity.activeKcal', { kcal: fmtNum(mv.activeKcal, 0) })}
                    </Row>
                  </div>
                  {!movementIsToday && (
                    <p className="text-note text-amber-400/80 mt-2">
                      {t('today.activity.notSynced', { date: formatCivilLong(mv.date) })}
                    </p>
                  )}
                </>
              ) : (
                <EmptyState title={t('today.activity.emptyTitle')} detail={t('today.activity.emptyDetail')} />
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <div className="px-4 pt-4 pb-3 flex-1 flex flex-col">
              <div className="flex items-start justify-between">
                <Label>{t('today.vitals.title')}</Label>
                <Heart size={14} className={DOMAIN.cardio.text} />
              </div>
              {vitalsDate ? (
                <>
                  <div className="mt-3">
                    <Value value={rhrNow?.value ?? null} size="lg" unit={t('units.bpm')} />
                  </div>
                  {rhrNow && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <BandPill c={rhrNow} cycle={rhrCycle} />
                    </div>
                  )}
                  <div className="mt-3">
                    <Spark series={rhrSeries.slice(-21)} color={DOMAIN.cardio.hex} baseline={usual(rhrNow)} />
                  </div>
                  <div className="mt-2 space-y-0">
                    <Row label={t('today.vitals.hrv')}>
                      {hrvNow
                        ? rich('today.vitals.hrvValue', {
                            value: `${fmtNum(hrvNow.value)} ${t('units.ms')}`,
                            usual: fmtNum(hrvNow.baseline),
                            muted: (words) => <span className="text-zinc-500">{words}</span>,
                          })
                        : '—'}
                    </Row>
                    <Row label={t('today.vitals.breathing')}>{respNow ? `${fmtNum(respNow.value)} ${t('units.perMinute')}` : '—'}</Row>
                    <Row label={t('today.vitals.bloodOxygen')}>{spo2Now ? `${fmtNum(spo2Now.value)}${t('units.percent')}` : '—'}</Row>
                  </div>
                  {vitalsDate !== today && (
                    <p className="text-note text-amber-400/80 mt-2">
                      {t('today.vitals.latest', { date: formatCivilLong(vitalsDate) })}
                    </p>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <EmptyState title={t('today.vitals.emptyTitle')} detail={t('today.vitals.emptyDetail')} />
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
