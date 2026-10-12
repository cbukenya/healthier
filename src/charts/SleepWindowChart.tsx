import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatCivil, formatClock } from '../lib/date';
import { sleepRegularity, typicalSleepWindow } from '../pipeline/derive';
import { bucketLabel, groupNights, type Bucket } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { Card, CardHead, fmtDuration } from '../ui/primitives';
import type { DailyRecord, SleepSession } from '../types/health';

/**
 * Sleep window: one row per calendar day, bars positioned at real clock time,
 * filled by stage share, judged against YOUR OWN typical window.
 *
 * The two vertical lines are not a preset target: they are the circular mean
 * of your actual bedtimes and wake times over exactly the days shown, with a
 * shaded ± one circular-SD band around each. Change the page's 14/30/90
 * selector and the lines move with it — the chart describes the schedule you
 * keep, not the one you wish you kept. (A fixed target remains available via
 * `mode="target"`.)
 *
 * Days with no recorded night stay as visible empty rows: the vertical axis is
 * calendar time, and hiding gaps would misrepresent the rhythm this chart
 * exists to show.
 *
 * Over long spans a row per night would run to hundreds of rows, so each row
 * becomes a week (or month): median bedtime for the median time in bed, filled
 * by the average stage share. The regularity score and the average window are
 * still computed from every real night in the span.
 */

/** One drawable row per bucket, newest first, shaped like a day so the drawing code is shared. */
function bucketRows(days: DailyRecord[], bucket: Bucket): DailyRecord[] {
  return groupNights(days, bucket)
    .reverse()
    .map((g) => ({
      ...emptyRecord(g.date),
      sleep: g.night ? ({ ...g.night, date: g.date } as unknown as SleepSession) : null,
    }));
}

const STAGE_FILL: [key: 'deep' | 'rem' | 'light' | 'awake', color: string][] = [
  ['deep', '#4338ca'],
  ['rem', '#a78bfa'],
  ['light', '#818cf8'],
  ['awake', '#d8b48a'],
];

const REG_COPY: Record<string, { label: string; color: string; text: string }> = {
  excellent: { label: 'VERY REGULAR', color: '#22c55e', text: 'You fall asleep and wake at nearly the same times every day.' },
  good: { label: 'REGULAR', color: '#6ee7b7', text: 'Your timing holds fairly steady from night to night.' },
  bad: { label: 'IRREGULAR', color: '#eab308', text: 'Your timing shifts by hours from night to night. Regular timing predicts how you feel better than total hours do.' },
  critical: { label: 'VERY IRREGULAR', color: '#f43f5e', text: 'No steady schedule in these nights: your body clock rarely gets the same day twice.' },
};

/** Fold a minutes-of-day onto an 18:00-anchored evening→next-noon line. */
const EVENING = 18 * 60;
const fold = (m: number) => (m >= EVENING ? m : m + 1440);

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const signed = (mins: number) => {
  const a = Math.abs(Math.round(mins));
  const body = a >= 60 ? `${Math.floor(a / 60)}h ${String(a % 60).padStart(2, '0')}m` : `${a}m`;
  return `${mins < 0 ? '−' : '+'}${body}`;
};

export function SleepWindowChart({
  days,
  mode = 'average',
  targetStart = '23:30',
  targetEnd = '07:30',
  bucket = 'day',
}: {
  /** Already sliced to the page's selected span — newest day last. */
  days: DailyRecord[];
  /** Draw one row per week or month instead of per night. */
  bucket?: Bucket;
  /** 'average' plots your own mean bed/wake; 'target' plots a fixed goal window. */
  mode?: 'average' | 'target';
  targetStart?: string;
  targetEnd?: string;
}) {
  const reg = useMemo(() => sleepRegularity(days), [days]);
  const typical = useMemo(() => typicalSleepWindow(days), [days]);
  // Drawn at the card's true width: a fixed 960-wide drawing needed 640px, so a phone had to
  // scroll sideways to reach the wake times.
  const box = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setBoxW(el.clientWidth);
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.some((d) => d.sleep)]);
  const narrow = boxW > 0 && boxW < 600;

  const useAvg = mode === 'average' && typical !== null;
  const winA = useAvg ? fold(typical!.bedMean) : fold(toMin(targetStart));
  const winB = useAvg ? fold(typical!.wakeMean) : fold(toMin(targetEnd));
  const sdA = useAvg ? typical!.bedSdMin : 0;
  const sdB = useAvg ? typical!.wakeSdMin : 0;
  const lineColor = useAvg ? '#818cf8' : '#34d399';
  const labelA = useAvg ? `${narrow ? 'bed' : 'avg bed'} ${formatClock(typical!.bedMean)}` : `${targetStart} target`;
  const labelB = useAvg ? `${narrow ? 'wake' : 'avg wake'} ${formatClock(typical!.wakeMean)}` : targetEnd;

  // Rows render newest-first, matching the nights list beside this chart.
  const rows = useMemo(() => (bucket === 'day' ? [...days].reverse() : bucketRows(days, bucket)), [days, bucket]);
  const rowLabel = (date: string) => (bucket === 'day' ? formatCivil(date) : bucketLabel(date, bucket));
  const unitName = bucket === 'day' ? 'night' : bucket;
  const nights = rows.filter((d) => d.sleep);

  // ── adaptive geometry
  const n = rows.length;
  const dense = n > 40;
  const mid = n > 16 && !dense;
  const ROW = dense ? 7 : mid ? 15 : 27;
  const BAR = dense ? 4 : mid ? 8 : 11;
  const labelEvery = dense ? 7 : mid ? 3 : 1;
  // The right-hand column (time asleep, bedtime against your average) only fits a wide card.
  const showRight = !dense && !mid && !narrow;

  // ── time axis auto-range around the data and the window lines
  const [axisA, axisB] = useMemo(() => {
    let lo = winA - sdA;
    let hi = winB + sdB;
    for (const d of nights) {
      const s = d.sleep!;
      lo = Math.min(lo, fold(s.bedtimeMin));
      hi = Math.max(hi, fold(s.bedtimeMin) + (s.minutesInBed || 1));
    }
    return [Math.floor(lo / 60) * 60 - 60, Math.ceil(hi / 60) * 60 + 60];
  }, [nights, winA, winB, sdA, sdB]);
  const SPAN = axisB - axisA;

  const PL = narrow ? 46 : 58;
  const PR = showRight ? 128 : narrow ? 10 : 16;
  const PT = 26;
  const PB = 26;
  const W = boxW || 960;
  const IW = W - PL - PR;
  const H = PT + PB + n * ROW;
  const x = (m: number) => PL + ((m - axisA) / SPAN) * IW;
  // Hour labels every two hours, or every four when two-hour labels would crowd.
  const hourStep = (120 / SPAN) * IW < 44 ? 240 : 120;
  // A line's label sits beside it, switching sides rather than running off the card.
  const lineLabel = (m: number, text: string, side: 'before' | 'after') => {
    const w = text.length * 5.6;
    const before = side === 'before' ? x(m) - 6 - w >= 2 : x(m) + 6 + w > W - 2;
    return { x: before ? x(m) - 6 : x(m) + 6, anchor: (before ? 'end' : 'start') as 'start' | 'end' };
  };

  if (!nights.length) {
    return (
      <Card>
        <CardHead domain="sleep" title="Sleep window" hint="No recorded nights in this span." />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 sm:gap-6 px-5 pt-4 pb-1">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-zinc-100 tracking-tight flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/10 ring-2 ring-indigo-500/25" />
            Sleep window
          </h3>
          <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed max-w-none sm:max-w-md">
            {bucket === 'day'
              ? 'One bar per night, bed to wake, coloured by stage.'
              : `One bar per ${unitName}: its typical bedtime and time in bed, coloured by average stage.`}{' '}
            {useAvg
              ? `The dashed lines are your average bedtime and wake time over these ${typical!.nights} nights, shaded by how much they vary.`
              : `The band is your target window, ${targetStart} → ${targetEnd}.`}{' '}
            Empty rows are {unitName}s with no record.
          </p>
        </div>

        {/* ── Sleep Regularity Index, computed over exactly these days ── */}
        <div className="text-left sm:text-right shrink-0 w-full sm:w-auto sm:max-w-[280px] pt-3 sm:pt-0 border-t border-zinc-800/60 sm:border-t-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Sleep regularity
          </div>
          {reg ? (
            <>
              <div className="flex sm:block items-baseline gap-2.5 sm:gap-0 mt-0.5 sm:mt-0">
                <div className="text-[16px] sm:text-[19px] font-bold tracking-wide" style={{ color: REG_COPY[reg.band].color }}>
                  {REG_COPY[reg.band].label}
                </div>
                <div className="text-[22px] sm:text-[27px] font-bold text-zinc-50 tabular-nums leading-tight">
                  {reg.score}
                  <span className="text-[13px] font-medium text-zinc-500">/100</span>
                </div>
              </div>
              <p className="text-[10.5px] text-zinc-500 mt-1.5 leading-relaxed">
                {REG_COPY[reg.band].text} Scored from how often you're asleep or awake at the same clock
                times on back-to-back days ({reg.pairs} pairs of nights).
              </p>
            </>
          ) : (
            <p className="text-[10.5px] text-zinc-500 mt-1.5 leading-relaxed">
              Needs five back-to-back recorded nights in this span.
            </p>
          )}
        </div>
      </div>

      <div ref={box} className="mx-3 mb-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: 'auto' }} role="img"
          aria-label={useAvg ? 'Sleep sessions against your average sleep window' : `Sleep sessions against the ${targetStart}–${targetEnd} target window`}>
          {/* window band between the two lines */}
          <rect x={x(winA)} y={PT - 8} width={x(winB) - x(winA)} height={H - PT - PB + 16}
            fill={lineColor} opacity={0.05} />

          {/* ± spread shading around each average line */}
          {useAvg && (
            <>
              <rect x={x(winA - sdA)} y={PT - 8} width={x(winA + sdA) - x(winA - sdA)}
                height={H - PT - PB + 16} fill={lineColor} opacity={0.06} />
              <rect x={x(winB - sdB)} y={PT - 8} width={x(winB + sdB) - x(winB - sdB)}
                height={H - PT - PB + 16} fill={lineColor} opacity={0.06} />
            </>
          )}

          {([[winA, labelA, 'before'], [winB, labelB, 'after']] as const).map(([m, lbl, side]) => {
            const at = lineLabel(m, lbl, side);
            return (
              <g key={lbl}>
                <line x1={x(m)} x2={x(m)} y1={PT - 8} y2={H - PB + 8}
                  stroke={lineColor} strokeWidth={1.2} strokeDasharray="4 4" opacity={0.85} />
                <text x={at.x} y={PT - 12} textAnchor={at.anchor} fontSize={10} fill={lineColor} opacity={0.95}>
                  {lbl}
                </text>
              </g>
            );
          })}

          {/* hour grid */}
          {Array.from({ length: Math.floor(SPAN / hourStep) + 1 }, (_, i) => axisA + i * hourStep).map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={PT - 4} y2={H - PB + 4}
                stroke={m % 1440 === 0 ? '#2c2c32' : '#1c1c20'} strokeWidth={m % 1440 === 0 ? 1.2 : 1} />
              <text x={x(m)} y={H - PB + 16} textAnchor="middle" fontSize={9.5} fill="#52525b">
                {String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:00
              </text>
            </g>
          ))}

          {/* rows */}
          {rows.map((d, i) => {
            const cy = PT + i * ROW + ROW / 2;
            const y = cy - BAR / 2;
            const label = i % labelEvery === 0 || i === n - 1;
            const s = d.sleep;
            const rowEls: React.ReactNode[] = [];

            if (label) {
              rowEls.push(
                <text key="lbl" x={PL - 10} y={cy + 3} textAnchor="end"
                  fontSize={dense ? 8.5 : 10.5} fill="#9ca0a8">
                  {rowLabel(d.date)}
                </text>,
              );
            }
            if (!dense) {
              rowEls.push(<line key="grid" x1={PL} x2={W - PR} y1={cy} y2={cy} stroke="#141417" strokeWidth={1} />);
            }

            if (s) {
              const b = fold(s.bedtimeMin);
              const w = b + Math.max(1, s.minutesInBed);
              const clipId = `swc-${d.date}`;
              const total =
                s.stages
                  ? s.stages.deep + s.stages.rem + s.stages.light + s.stages.awake
                  : 0;

              rowEls.push(
                <g key="bar">
                  <defs>
                    <clipPath id={clipId}>
                      <rect x={x(b)} y={y} width={x(w) - x(b)} height={BAR} rx={BAR / 2} />
                    </clipPath>
                  </defs>
                  <g clipPath={`url(#${clipId})`}>
                    {s.stages && total > 0 ? (
                      (() => {
                        let cursor = x(b);
                        return STAGE_FILL.map(([k, color]) => {
                          const wpx = (s.stages![k] / total) * (x(w) - x(b));
                          if (wpx <= 0) return null;
                          const el = (
                            <rect key={k} x={cursor} y={y} width={wpx + 0.5} height={BAR} fill={color}>
                              <title>{`${bucket === 'day' ? formatCivil(d.date) : bucketLabel(d.date, bucket, 'full')} · ${k} ${s.stages![k]} min${bucket === 'day' ? '' : ' a night'}`}</title>
                            </rect>
                          );
                          cursor += wpx;
                          return el;
                        });
                      })()
                    ) : (
                      // Un-staged night: honest plain fill rather than invented stages.
                      <rect x={x(b)} y={y} width={x(w) - x(b)} height={BAR} fill="#818cf8" opacity={0.75} />
                    )}
                  </g>
                </g>,
              );

              if (showRight) {
                rowEls.push(
                  <text key="dur" x={W - PR + 12} y={cy + 3.5} fontSize={10.5} fill="#d4d6db" fontWeight={500}>
                    {fmtDuration(s.minutesAsleep)}
                  </text>,
                );
                if (useAvg) {
                  // This night's bedtime against your own average, fold-aware.
                  const dev = fold(s.bedtimeMin) - winA;
                  if (Math.abs(dev) >= 10) {
                    rowEls.push(
                      <text key="dev" x={W - PR + 66} y={cy + 3.5} fontSize={9} fill="#6b6f78">
                        {signed(dev)} bed
                      </text>,
                    );
                  }
                }
              }
            }

            return <g key={d.date}>{rowEls}</g>;
          })}
        </svg>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 pb-4">
        {STAGE_FILL.map(([k, color]) => (
          <span key={k} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
            {k}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          <i className="w-3 h-2.5 rounded-[2px] border border-dashed"
            style={{ borderColor: useAvg ? '#818cf8aa' : '#34d399aa' }} />
          {useAvg
            ? `avg window ${formatClock(typical!.bedMean)}–${formatClock(typical!.wakeMean)}`
            : `target ${targetStart}–${targetEnd}`}
        </span>
      </div>
    </Card>
  );
}
