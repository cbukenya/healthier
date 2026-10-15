import React, { useState } from 'react';
import { Footprints } from 'lucide-react';
import type { CivilDate } from '../lib/date';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import { formatCivilLong, formatCivilRange, formatInteger, formatThousands, weekdayLetter, weekdayShort } from '../i18n/format';
import type { PeriodShift } from '../pipeline/derive';
import { Card, CardHead, CardSummary, DOMAIN, Delta, Meter, Row, fmtNum } from '../ui/primitives';
import type { DailyRecord } from '../types/health';
import { WHO_WEEK } from '../pipeline/goals';
import { useGoals } from '../hooks/useGoals';

const BRISK_HEX = '#fb923c';

/** Moderate plus vigorous minutes, the ones activity guidelines count. */
export const briskOf = (d: DailyRecord) => (d.activeMinutes ? d.activeMinutes.moderate + d.activeMinutes.vigorous : null);

/**
 * The day's two goals as rings, steps outside and brisk minutes inside, then its distance and
 * energy. It shows today while today has steps, else the latest day that does.
 */
export function TodaySoFar({ day, isToday, wide }: { day: DailyRecord; isToday: boolean; wide: boolean }) {
  const goals = useGoals();
  const steps = day.steps ?? 0;
  const brisk = briskOf(day);
  const reached = [steps >= goals.steps, ...(brisk === null ? [] : [brisk >= goals.briskMinutes])];
  const met = reached.filter(Boolean).length;
  const goalNote = reached.length === 2 ? t('activity.day.goalsMet', { met }) : met ? t('activity.day.stepGoalMet') : null;

  return (
    <Card className="px-[18px] pt-4 pb-[18px] md:px-5 flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">{isToday ? t('activity.day.title') : t('activity.day.latest', { date: formatCivilLong(day.date) })}</h2>
        {goalNote && <span className="text-detail text-zinc-400 whitespace-nowrap">{goalNote}</span>}
      </div>
      {/* Distance sits under the rings and energy under the two goals, so the four figures wrap the rings at every width. */}
      <div className="flex-1 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[22px] gap-y-3.5 md:gap-x-7">
        <GoalRings
          size={wide ? 140 : 128}
          rings={[
            { value: steps, goal: goals.steps, color: DOMAIN.movement.hex },
            { value: brisk, goal: goals.briskMinutes, color: BRISK_HEX },
          ]}
          label={
            brisk === null
              ? t('activity.day.ringsNoBrisk', { steps: fmtNum(steps, 0), stepGoal: fmtNum(goals.steps, 0) })
              : t('activity.day.rings', { steps: fmtNum(steps, 0), stepGoal: fmtNum(goals.steps, 0), brisk, briskGoal: goals.briskMinutes })
          }
        />
        <div className="flex flex-col gap-3.5 md:gap-4 min-w-0">
          <GoalValue color={DOMAIN.movement.hex} label={t('activity.day.steps')} value={fmtNum(steps, 0)} goal={t('activity.day.stepGoal', { goal: fmtNum(goals.steps, 0) })} />
          <GoalValue color={BRISK_HEX} label={t('activity.day.brisk')} value={brisk === null ? '—' : fmtNum(brisk, 0)} goal={t('activity.day.briskGoal', { goal: goals.briskMinutes })} />
        </div>
        <Stat label={t('activity.day.distance')} value={fmtNum(day.distanceKm, 2)} unit={day.distanceKm === null ? undefined : t('units.km')} />
        <Stat label={t('activity.day.energy')} value={fmtNum(day.activeKcal, 0)} unit={day.activeKcal === null ? undefined : t('units.kcal')} />
      </div>
    </Card>
  );
}

/**
 * The last seven finished days: their average against the week before, each day against the
 * step goal's line, and the week against the three before it.
 */
export function LastSevenDays({ days, shift, ratio, wide }: {
  /** The seven finished days, oldest first. */
  days: DailyRecord[];
  /** Their steps against the seven days before. */
  shift: PeriodShift;
  /** Their average against the three weeks before. */
  ratio: number | null;
  wide: boolean;
}) {
  const goal = useGoals().steps;
  const steps = days.map((d) => d.steps).filter((s): s is number => s !== null);
  const over = steps.filter((s) => s >= goal).length;
  const overLabel = t('activity.lastSevenDays.daysOver', { goal: formatThousands(goal) });
  const briskDays = days.map(briskOf).filter((m): m is number => m !== null);
  const brisk = briskDays.length ? briskDays.reduce((a, b) => a + b, 0) : null;
  const ramp = rampOf(ratio);

  const headline = (
    <div>
      <div className="whitespace-nowrap">
        {rich('activity.lastSevenDays.perDay', {
          count: Math.round(shift.current ?? 0),
          steps: <span className="font-display text-number-md md:text-number-lg text-zinc-50 tabular-nums">{fmtNum(shift.current, 0)}</span>,
          muted: (w) => <span className="text-detail md:text-body-sm text-zinc-500">{w}</span>,
        })}
      </div>
      <div className="mt-1 md:mt-1.5">
        <Delta value={shift.delta} goodWhen="up" digits={0} phrase="activity.lastSevenDays.vsWeekBefore" />
      </div>
    </div>
  );
  const bars = <WeekBars days={days} goal={goal} long={wide} />;

  return (
    <Card className="px-[18px] pt-4 pb-3.5 md:px-5 md:pb-[18px] flex flex-col gap-3 md:gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">{t('activity.lastSevenDays.title')}</h2>
        <span className="text-detail text-zinc-500">{formatCivilRange(days[0].date, days[days.length - 1].date)}</span>
      </div>
      {wide ? (
        <div className="flex-1 grid grid-cols-[minmax(0,1fr)_minmax(250px,1.4fr)] gap-4 items-center">
          {headline}
          {bars}
        </div>
      ) : (
        <>
          {headline}
          {bars}
        </>
      )}
      {wide ? (
        <div className="grid grid-cols-3 gap-3">
          <Stat label={overLabel} value={rich('activity.lastSevenDays.daysOverCount', { over, total: steps.length, muted: statUnit })} />
          {brisk !== null && (
            <Stat
              label={t('activity.lastSevenDays.brisk')}
              value={rich('activity.lastSevenDays.briskTotal', { minutes: fmtNum(brisk, 0), target: WHO_WEEK, muted: statUnit })}
            />
          )}
          {ramp && (
            <Stat
              label={t('activity.lastSevenDays.vsThreeWeeks')}
              value={rich('activity.lastSevenDays.ramp.value', { change: ramp.change, verdict: ramp.verdict, muted: statUnit })}
            />
          )}
        </div>
      ) : (
        <div>
          <Row dense label={overLabel}>{t('activity.lastSevenDays.daysOverCount', { over, total: steps.length })}</Row>
          {brisk !== null && (
            <Row dense label={t('activity.lastSevenDays.brisk')}>
              {rich('activity.lastSevenDays.briskTotal', {
                minutes: fmtNum(brisk, 0),
                target: WHO_WEEK,
                muted: (w) => <span className="text-zinc-500">{w}</span>,
              })}
            </Row>
          )}
          {ramp && (
            <Row dense label={t('activity.lastSevenDays.vsThreeWeeksLong')}>
              {rich('activity.lastSevenDays.ramp.value', {
                change: ramp.change,
                verdict: ramp.verdict,
                muted: (w) => <span className="text-zinc-500">{w}</span>,
              })}
            </Row>
          )}
        </div>
      )}
    </Card>
  );
}

export interface WeekTotal {
  /** Its Monday. */
  start: CivilDate;
  /** Its Sunday. */
  end: CivilDate;
  total: number;
  /** Days with steps. */
  days: number;
}

/** Weeks listed before "Show all". */
const WEEKS_SHOWN = 8;

/** Steps per finished Monday-to-Sunday week, newest first, each against seven days of the step goal. */
export function WeeklyTotals({ weeks }: { weeks: WeekTotal[] }) {
  const goal = useGoals().steps;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? weeks : weeks.slice(0, WEEKS_SHOWN);
  return (
    <Card>
      <CardHead
        domain="movement"
        title={t('activity.weekly.title')}
        hint={t('activity.weekly.hint')}
        right={<CardSummary vals={weeks.map((w) => w.total).reverse()} color={DOMAIN.movement.hex} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-5 pb-5 space-y-2">
        {shown.map((w) => (
          <div key={w.start} className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 whitespace-nowrap text-caption text-zinc-500">{formatCivilRange(w.start, w.end)}</span>
            <div className="flex-1">
              <Meter pct={(w.total / (goal * 7)) * 100} color={DOMAIN.movement.hex} />
            </div>
            <span className="w-[64px] shrink-0 text-right text-detail text-zinc-200 tabular-nums">{fmtNum(w.total, 0)}</span>
            <span className="w-[54px] shrink-0 text-right text-note text-zinc-600">{t('activity.weekly.days', { days: w.days })}</span>
          </div>
        ))}
        {weeks.length > WEEKS_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            aria-expanded={showAll}
            className="mt-1.5 w-full min-h-11 rounded-xl border border-[#27272a] text-body-sm text-[#a1a1aa] hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
          >
            {showAll ? t('activity.weekly.showLatest', { count: WEEKS_SHOWN }) : t('activity.weekly.showAll', { count: weeks.length })}
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * The week's average against the three weeks before, in words. It describes the change and
 * claims nothing about injury risk; see loadRatio.
 */
function rampOf(ratio: number | null): { change: string; verdict: string } | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const pct = Math.round((ratio - 1) * 100);
  return {
    change:
      pct === 0
        ? t('activity.lastSevenDays.ramp.same')
        : pct < 0
          ? t('activity.lastSevenDays.ramp.less', { percent: formatInteger(-pct) })
          : t('activity.lastSevenDays.ramp.more', { percent: formatInteger(pct) }),
    verdict: t(ratio > 1.5 ? 'activity.lastSevenDays.ramp.fast' : ratio < 0.8 ? 'activity.lastSevenDays.ramp.easing' : 'activity.lastSevenDays.ramp.steady'),
  };
}

/** Concentric goal rings, outermost first, each filling clockwise from the top until its goal. */
function GoalRings({ rings, size, label }: {
  rings: { value: number | null; goal: number; color: string }[];
  size: number;
  label: string;
}) {
  const stroke = size >= 140 ? 13 : 12;
  const c = size / 2;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={label}>
        {rings.map((ring, i) => {
          const r = c - 2 - stroke / 2 - i * (stroke + 4);
          const length = 2 * Math.PI * r;
          const share = ring.value === null ? 0 : Math.min(1, Math.max(0, ring.value / ring.goal));
          return (
            <g key={i}>
              <circle cx={c} cy={c} r={r} fill="none" stroke={ring.color} strokeOpacity={0.16} strokeWidth={stroke} />
              {share >= 1 ? (
                <circle cx={c} cy={c} r={r} fill="none" stroke={ring.color} strokeWidth={stroke} />
              ) : share > 0 && (
                <circle
                  cx={c} cy={c} r={r} fill="none" stroke={ring.color} strokeWidth={stroke} strokeLinecap="round"
                  strokeDasharray={`${share * length} ${length}`} transform={`rotate(-90 ${c} ${c})`}
                />
              )}
            </g>
          );
        })}
      </svg>
      <Footprints size={18} aria-hidden="true" className="absolute inset-0 m-auto text-zinc-500" />
    </div>
  );
}

function GoalValue({ color, label, value, goal }: { color: string; label: string; value: string; goal: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-eyebrow uppercase text-zinc-500">{label}</span>
      </div>
      <div className="mt-1 whitespace-nowrap">
        <span className="font-display text-number-md md:text-number-lg text-zinc-50 tabular-nums">{value}</span>
        <span className="text-detail md:text-body-sm text-zinc-500"> {goal}</span>
      </div>
    </div>
  );
}

/** How a Stat sets the words after its figure: its unit, or the rest of its phrase (the "of 7" in "2 of 7"). */
const STAT_UNIT = 'font-sans text-caption font-medium text-zinc-500';

/** Sets a message's <muted> words as a Stat's unit, so a phrase like "2 of 7" stays one message. */
export const statUnit = (words: React.ReactNode[]) => <span className={STAT_UNIT}>{words}</span>;

/** A small figure under an uppercase label, for a card's row of stats. */
export function Stat({ label, value, unit, tone }: { label: string; value: React.ReactNode; unit?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-eyebrow-sm uppercase text-zinc-500">{label}</span>
      <span className={`font-display text-number-xs leading-tight tabular-nums ${tone ?? 'text-zinc-50'}`}>
        {value}
        {unit && <span className={STAT_UNIT}> {unit}</span>}
      </span>
    </div>
  );
}

/** One bar per day against the step goal's line; the days that cleared it are solid. */
function WeekBars({ days, goal, long }: { days: DailyRecord[]; goal: number; long: boolean }) {
  const plot = long ? 128 : 110;
  const busiest = Math.max(0, ...days.map((d) => d.steps ?? 0));
  // Headroom above the line, and above the busiest day.
  const top = Math.max(goal * 1.2, busiest * 1.05);
  const px = (v: number) => (v / top) * plot;
  const columns = 'grid grid-cols-7 gap-x-2 md:gap-x-3';
  return (
    <div
      role="img"
      aria-label={t('activity.lastSevenDays.bars.label', {
        days: days
          .map((d) =>
            d.steps === null
              ? t('activity.lastSevenDays.bars.noData', { date: formatCivilLong(d.date) })
              : t('activity.lastSevenDays.bars.day', { date: formatCivilLong(d.date), steps: fmtNum(d.steps, 0) }),
          )
          .join(t('activity.lastSevenDays.bars.separator')),
      })}
    >
      <div className="relative pr-7">
        <div className={`${columns} items-end border-b border-zinc-800`} style={{ height: plot }}>
          {days.map((d) => (
            <div key={d.date} className="flex justify-center">
              {d.steps !== null && (
                <div
                  className="w-full max-w-[26px] rounded-t-[4px]"
                  style={{ height: Math.max(2, px(d.steps)), background: DOMAIN.movement.hex, opacity: d.steps >= goal ? 1 : 0.42 }}
                />
              )}
            </div>
          ))}
        </div>
        {/* The goal's line, over the bars, labelled in the gutter on the right. */}
        <div className="absolute left-0 right-7 border-t border-dashed border-zinc-400/70" style={{ bottom: px(goal) + 1 }} />
        <span className="absolute right-0 translate-y-1/2 text-note leading-none text-zinc-500" style={{ bottom: px(goal) + 1 }}>{formatThousands(goal)}</span>
      </div>
      <div className={`${columns} pr-7 mt-1.5`}>
        {days.map((d) => (
          <span key={d.date} className="text-center text-note text-zinc-500">{long ? weekdayShort(d.date) : weekdayLetter(d.date)}</span>
        ))}
      </div>
    </div>
  );
}
