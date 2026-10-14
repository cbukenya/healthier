import React, { useState } from 'react';
import { Footprints } from 'lucide-react';
import { formatCivilLong, formatCivilRange, weekdayLetter, weekdayShort, type CivilDate } from '../lib/date';
import type { PeriodShift } from '../pipeline/derive';
import { Card, CardHead, CardSummary, DOMAIN, Delta, Meter, Row, fmtNum } from '../ui/primitives';
import type { DailyRecord } from '../types/health';
import { STEP_GOAL } from '../pipeline/insights';

export { STEP_GOAL };
/** A brisk day: the WHO's 150 weekly minutes spread over five days. */
const BRISK_GOAL = 30;
const WHO_WEEK = 150;
const BRISK_HEX = '#fb923c';

/** Moderate plus vigorous minutes, the ones activity guidelines count. */
export const briskOf = (d: DailyRecord) => (d.activeMinutes ? d.activeMinutes.moderate + d.activeMinutes.vigorous : null);

/**
 * The day's two goals as rings, steps outside and brisk minutes inside, then its distance and
 * energy. It shows today while today has steps, else the latest day that does.
 */
export function TodaySoFar({ day, isToday, wide }: { day: DailyRecord; isToday: boolean; wide: boolean }) {
  const steps = day.steps ?? 0;
  const brisk = briskOf(day);
  const goals = [steps >= STEP_GOAL, ...(brisk === null ? [] : [brisk >= BRISK_GOAL])];
  const met = goals.filter(Boolean).length;
  const goalNote = goals.length === 2 ? `${met} of 2 goals met` : met ? 'Step goal met' : null;

  return (
    <Card className="px-[18px] pt-4 pb-[18px] md:px-5 flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">{isToday ? 'Today so far' : `Latest day, ${formatCivilLong(day.date)}`}</h2>
        {goalNote && <span className="text-detail text-zinc-400 whitespace-nowrap">{goalNote}</span>}
      </div>
      <div className="flex-1 flex items-center gap-[22px] md:gap-7">
        <GoalRings
          size={wide ? 140 : 128}
          rings={[
            { value: steps, goal: STEP_GOAL, color: DOMAIN.movement.hex },
            { value: brisk, goal: BRISK_GOAL, color: BRISK_HEX },
          ]}
          label={`Steps: ${fmtNum(steps, 0)} of ${fmtNum(STEP_GOAL, 0)}. Brisk minutes: ${brisk === null ? 'not recorded' : `${brisk} of ${BRISK_GOAL}`}.`}
        />
        <div className="flex flex-col gap-3.5 md:gap-4 min-w-0">
          <GoalValue color={DOMAIN.movement.hex} label="Steps" value={fmtNum(steps, 0)} goal={`/ ${fmtNum(STEP_GOAL, 0)}`} />
          <GoalValue color={BRISK_HEX} label="Brisk minutes" value={brisk === null ? '—' : fmtNum(brisk, 0)} goal={`/ ${BRISK_GOAL} min`} />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-3">
        <Stat label="Distance" value={fmtNum(day.distanceKm, 2)} unit={day.distanceKm === null ? undefined : 'km'} />
        <Stat label="Active energy" value={fmtNum(day.activeKcal, 0)} unit={day.activeKcal === null ? undefined : 'kcal'} />
      </div>
    </Card>
  );
}

/**
 * The last seven finished days: their average against the week before, each day against the
 * 10,000 line, and the week against the three before it.
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
  const steps = days.map((d) => d.steps).filter((s): s is number => s !== null);
  const over = steps.filter((s) => s >= STEP_GOAL).length;
  const briskDays = days.map(briskOf).filter((m): m is number => m !== null);
  const brisk = briskDays.length ? briskDays.reduce((a, b) => a + b, 0) : null;
  const ramp = rampOf(ratio);

  const headline = (
    <div>
      <div className="whitespace-nowrap">
        <span className="font-display text-number-md md:text-number-lg text-zinc-50 tabular-nums">{fmtNum(shift.current, 0)}</span>
        <span className="text-detail md:text-body-sm text-zinc-500"> steps a day</span>
      </div>
      <div className="mt-1 md:mt-1.5">
        <Delta value={shift.delta} goodWhen="up" digits={0} suffix="vs the week before" />
      </div>
    </div>
  );
  const bars = <WeekBars days={days} long={wide} />;

  return (
    <Card className="px-[18px] pt-4 pb-3.5 md:px-5 md:pb-[18px] flex flex-col gap-3 md:gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">Last 7 days</h2>
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
          <Stat label="Days over 10k" value={`${over}`} unit={`of ${steps.length}`} />
          {brisk !== null && <Stat label="Brisk minutes" value={fmtNum(brisk, 0)} unit={`of ${WHO_WEEK}`} />}
          {ramp && <Stat label="vs 3 weeks before" value={ramp.change} unit={`· ${ramp.verdict}`} />}
        </div>
      ) : (
        <div>
          <Row dense label="Days over 10k">{over} of {steps.length}</Row>
          {brisk !== null && (
            <Row dense label="Brisk minutes">
              {fmtNum(brisk, 0)} <span className="text-zinc-500">of {WHO_WEEK}</span>
            </Row>
          )}
          {ramp && (
            <Row dense label="vs the 3 weeks before">
              {ramp.change} <span className="text-zinc-500">· {ramp.verdict}</span>
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

/** Steps per finished Monday-to-Sunday week, newest first, each against 70,000 (10,000 a day). */
export function WeeklyTotals({ weeks }: { weeks: WeekTotal[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? weeks : weeks.slice(0, WEEKS_SHOWN);
  return (
    <Card>
      <CardHead
        domain="movement"
        title="Weekly totals"
        hint="Monday to Sunday, finished weeks only. Weeks with fewer than four recorded days are left out."
        right={<CardSummary vals={weeks.map((w) => w.total).reverse()} color={DOMAIN.movement.hex} format={(v) => fmtNum(v, 0)} />}
      />
      <div className="px-5 pb-5 space-y-2">
        {shown.map((w) => (
          <div key={w.start} className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 whitespace-nowrap text-caption text-zinc-500">{formatCivilRange(w.start, w.end)}</span>
            <div className="flex-1">
              <Meter pct={(w.total / (STEP_GOAL * 7)) * 100} color={DOMAIN.movement.hex} />
            </div>
            <span className="w-[64px] shrink-0 text-right text-detail text-zinc-200 tabular-nums">{fmtNum(w.total, 0)}</span>
            <span className="w-[54px] shrink-0 text-right text-note text-zinc-600">{w.days}/7 days</span>
          </div>
        ))}
        {weeks.length > WEEKS_SHOWN && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            aria-expanded={showAll}
            className="mt-1.5 w-full min-h-11 rounded-xl border border-[#27272a] text-body-sm text-[#a1a1aa] hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
          >
            {showAll ? `Show the latest ${WEEKS_SHOWN}` : `Show all ${weeks.length} weeks`}
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
    change: pct === 0 ? 'about the same' : pct < 0 ? `${-pct}% less` : `${pct}% more`,
    verdict: ratio > 1.5 ? 'a fast ramp' : ratio < 0.8 ? 'easing off' : 'steady',
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

/** A small figure under an uppercase label, for a card's row of stats. */
export function Stat({ label, value, unit, tone }: { label: string; value: string; unit?: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-eyebrow-sm uppercase text-zinc-500">{label}</span>
      <span className={`font-display text-number-xs leading-tight tabular-nums ${tone ?? 'text-zinc-50'}`}>
        {value}
        {unit && <span className="font-sans text-caption font-medium text-zinc-500"> {unit}</span>}
      </span>
    </div>
  );
}

/** One bar per day against the 10,000 line; the days that cleared it are solid. */
function WeekBars({ days, long }: { days: DailyRecord[]; long: boolean }) {
  const plot = long ? 128 : 110;
  const busiest = Math.max(0, ...days.map((d) => d.steps ?? 0));
  // Headroom above the line, and above the busiest day.
  const top = Math.max(STEP_GOAL * 1.2, busiest * 1.05);
  const px = (v: number) => (v / top) * plot;
  const columns = 'grid grid-cols-7 gap-x-2 md:gap-x-3';
  return (
    <div
      role="img"
      aria-label={`Steps each day: ${days.map((d) => `${formatCivilLong(d.date)}, ${d.steps === null ? 'no data' : fmtNum(d.steps, 0)}`).join('; ')}.`}
    >
      <div className="relative pr-7">
        <div className={`${columns} items-end border-b border-zinc-800`} style={{ height: plot }}>
          {days.map((d) => (
            <div key={d.date} className="flex justify-center">
              {d.steps !== null && (
                <div
                  className="w-full max-w-[26px] rounded-t-[4px]"
                  style={{ height: Math.max(2, px(d.steps)), background: DOMAIN.movement.hex, opacity: d.steps >= STEP_GOAL ? 1 : 0.42 }}
                />
              )}
            </div>
          ))}
        </div>
        {/* The 10,000 line, over the bars, labelled in the gutter on the right. */}
        <div className="absolute left-0 right-7 border-t border-dashed border-zinc-400/70" style={{ bottom: px(STEP_GOAL) + 1 }} />
        <span className="absolute right-0 translate-y-1/2 text-note leading-none text-zinc-500" style={{ bottom: px(STEP_GOAL) + 1 }}>10k</span>
      </div>
      <div className={`${columns} pr-7 mt-1.5`}>
        {days.map((d) => (
          <span key={d.date} className="text-center text-note text-zinc-500">{long ? weekdayShort(d.date) : weekdayLetter(d.date)}</span>
        ))}
      </div>
    </div>
  );
}
