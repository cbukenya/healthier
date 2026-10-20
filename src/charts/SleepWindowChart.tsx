import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n';
import { bucketLabel, formatCivil, formatClock, formatDuration, formatMinutes } from '../i18n/format';
import { sleepRegularity, typicalSleepWindow } from '../pipeline/derive';
import { groupNights, type Bucket } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { Card, CardHead, fmtDuration, tint } from '../ui/primitives';
import type { DailyRecord, SleepSession } from '../types/health';

/**
 * Sleep window: one row per calendar day, bars positioned at real clock time,
 * filled by stage share, judged against YOUR OWN typical window.
 *
 * The two vertical lines are not a preset target: they are the circular mean
 * of your actual bedtimes and wake times over exactly the days shown, with a
 * shaded ± one circular-SD band around each. Change the page's 14/30/90
 * selector and the lines move with it — the chart describes the schedule you
 * keep, not the one you wish you kept. With fewer than three nights there's
 * nothing to average, so the nights are drawn without lines rather than
 * against a made-up target.
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
  ['deep', 'var(--stage-deep)'],
  ['rem', 'var(--stage-rem)'],
  ['light', 'var(--stage-light)'],
  ['awake', 'var(--stage-awake)'],
];

/** The stages' names, the same set the hypnogram and every sleep card use. */
const STAGE_LABELS = {
  deep: 'sleep.stages.deep',
  rem: 'sleep.stages.rem',
  light: 'sleep.stages.light',
  awake: 'sleep.stages.awake',
} as const satisfies Record<(typeof STAGE_FILL)[number][0], MessageKey>;

const REG_COPY: Record<string, { label: MessageKey; color: string; text: MessageKey }> = {
  excellent: { label: 'sleep.window.regularity.bands.excellent.label', color: 'var(--green-500)', text: 'sleep.window.regularity.bands.excellent.text' },
  good: { label: 'sleep.window.regularity.bands.good.label', color: 'var(--emerald-300)', text: 'sleep.window.regularity.bands.good.text' },
  bad: { label: 'sleep.window.regularity.bands.bad.label', color: 'var(--yellow-500)', text: 'sleep.window.regularity.bands.bad.text' },
  critical: { label: 'sleep.window.regularity.bands.critical.label', color: 'var(--rose-500)', text: 'sleep.window.regularity.bands.critical.text' },
};

/** Fold a minutes-of-day onto an 18:00-anchored evening→next-noon line. */
const EVENING = 18 * 60;
const fold = (m: number) => (m >= EVENING ? m : m + 1440);

const signed = (mins: number) =>
  Math.abs(Math.round(mins)) >= 60 ? formatDuration(mins, { signed: true }) : formatMinutes(mins, { signed: true });

export function SleepWindowChart({
  days,
  bucket = 'day',
}: {
  /** Already sliced to the page's selected span — newest day last. */
  days: DailyRecord[];
  /** Draw one row per week or month instead of per night. */
  bucket?: Bucket;
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

  // Your average window, once there are three nights to average.
  const winA = typical ? fold(typical.bedMean) : null;
  const winB = typical ? fold(typical.wakeMean) : null;
  const sdA = typical?.bedSdMin ?? 0;
  const sdB = typical?.wakeSdMin ?? 0;
  const lineColor = 'var(--indigo-400)';

  // Rows render newest-first, matching the nights list beside this chart.
  const rows = useMemo(() => (bucket === 'day' ? [...days].reverse() : bucketRows(days, bucket)), [days, bucket]);
  const rowLabel = (date: string) => (bucket === 'day' ? formatCivil(date) : bucketLabel(date, bucket));
  const nights = rows.filter((d) => d.sleep);

  // ── adaptive geometry
  const n = rows.length;
  const dense = n > 40;
  const mid = n > 16 && !dense;
  const ROW = dense ? 7 : mid ? 15 : 27;
  const BAR = dense ? 4 : mid ? 8 : 11;
  const labelEvery = dense ? 7 : mid ? 3 : 1;
  // Up to a month of nights dated every third row, a ruler marks every night beside the labels.
  const ruler = bucket === 'day' && mid && n <= 31;
  // The right-hand column (time asleep, bedtime against your average) only fits a wide card.
  const showRight = !dense && !mid && !narrow;

  // ── time axis auto-range around the data and the window lines
  const [axisA, axisB] = useMemo(() => {
    let lo = winA === null ? Infinity : winA - sdA;
    let hi = winB === null ? -Infinity : winB + sdB;
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
        <CardHead title={t('sleep.window.title')} hint={t('sleep.window.empty')} />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 sm:gap-6 px-5 pt-4 pb-1">
        <div className="min-w-0">
          <h3 className="card-title-detail text-zinc-50">{t('sleep.window.title')}</h3>
          <p className="text-caption text-zinc-500 mt-1 leading-relaxed max-w-none sm:max-w-md">
            {t('sleep.window.bars', { bucket })}{' '}
            {typical ? t('sleep.window.lines', { count: typical.nights }) : t('sleep.window.noLines')}{' '}
            {t('sleep.window.emptyRows', { bucket })}
          </p>
        </div>

        {/* ── Sleep Regularity Index, computed over exactly these days ── */}
        <div className="text-left sm:text-right shrink-0 w-full sm:w-auto sm:max-w-[280px] pt-3 sm:pt-0 border-t border-zinc-800/60 sm:border-t-0">
          <div className="text-eyebrow uppercase text-zinc-500">
            {t('sleep.window.regularity.title')}
          </div>
          {reg ? (
            <>
              <div className="flex sm:block items-baseline gap-2.5 sm:gap-0 mt-0.5 sm:mt-0">
                <div className="text-tag sm:text-tag-lg" style={{ color: REG_COPY[reg.band].color }}>
                  {t(REG_COPY[reg.band].label)}
                </div>
                <div className="font-display text-number-sm sm:text-number-md text-zinc-50 tabular-nums leading-tight">
                  {reg.score}
                  <span className="font-sans text-body-sm font-medium text-zinc-500">/100</span>
                </div>
              </div>
              <p className="text-note text-zinc-500 mt-1.5 leading-relaxed">
                {t(REG_COPY[reg.band].text)} {t('sleep.window.regularity.basis', { count: reg.pairs })}
              </p>
            </>
          ) : (
            <p className="text-note text-zinc-500 mt-1.5 leading-relaxed">
              {t('sleep.window.regularity.needsNights')}
            </p>
          )}
        </div>
      </div>

      <div ref={box} className="mx-3 mb-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: 'auto' }} role="img"
          aria-label={typical ? t('sleep.window.chart') : t('sleep.window.chartNoAverage')}>
          {typical && winA !== null && winB !== null && (
            <>
              {/* window band between the two lines */}
              <rect x={x(winA)} y={PT - 8} width={x(winB) - x(winA)} height={H - PT - PB + 16}
                fill={lineColor} opacity={0.05} />

              {/* ± spread shading around each average line */}
              <rect x={x(winA - sdA)} y={PT - 8} width={x(winA + sdA) - x(winA - sdA)}
                height={H - PT - PB + 16} fill={lineColor} opacity={0.06} />
              <rect x={x(winB - sdB)} y={PT - 8} width={x(winB + sdB) - x(winB - sdB)}
                height={H - PT - PB + 16} fill={lineColor} opacity={0.06} />

              {([
                [winA, t(narrow ? 'sleep.window.averageBedNarrow' : 'sleep.window.averageBed', { time: formatClock(typical.bedMean) }), 'before'],
                [winB, t(narrow ? 'sleep.window.averageWakeNarrow' : 'sleep.window.averageWake', { time: formatClock(typical.wakeMean) }), 'after'],
              ] as const).map(([m, lbl, side]) => {
                const at = lineLabel(m, lbl, side);
                return (
                  <g key={side}>
                    <line x1={x(m)} x2={x(m)} y1={PT - 8} y2={H - PB + 8}
                      stroke={lineColor} strokeWidth={1.2} strokeDasharray="4 4" opacity={0.85} />
                    <text x={at.x} y={PT - 12} textAnchor={at.anchor} fontSize={10} fill={lineColor} opacity={0.95}>
                      {lbl}
                    </text>
                  </g>
                );
              })}
            </>
          )}

          {/* hour grid */}
          {Array.from({ length: Math.floor(SPAN / hourStep) + 1 }, (_, i) => axisA + i * hourStep).map((m) => (
            <g key={m}>
              <line x1={x(m)} x2={x(m)} y1={PT - 4} y2={H - PB + 4}
                stroke={m % 1440 === 0 ? 'var(--rule-strong)' : 'var(--rule)'} strokeWidth={m % 1440 === 0 ? 1.2 : 1} />
              <text x={x(m)} y={H - PB + 16} textAnchor="middle" fontSize={9.5} fill="var(--color-zinc-600)">
                {formatClock(m)}
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
                  fontSize={dense ? 8.5 : 10.5} fill="var(--color-zinc-400)">
                  {rowLabel(d.date)}
                </text>,
              );
            }
            if (ruler) {
              rowEls.push(
                <line key="tick" x1={PL - (label ? 7 : 4)} x2={PL - 1} y1={cy} y2={cy} strokeWidth={1}
                  stroke={i === 0 ? 'var(--color-zinc-400)' : label ? 'var(--color-zinc-600)' : 'var(--color-zinc-700)'} />,
              );
            }
            if (!dense) {
              rowEls.push(<line key="grid" x1={PL} x2={W - PR} y1={cy} y2={cy} stroke="var(--rule-faint)" strokeWidth={1} />);
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
                              <title>
                                {t('sleep.window.stage', {
                                  bucket,
                                  date: bucket === 'day' ? formatCivil(d.date) : bucketLabel(d.date, bucket, 'full'),
                                  stage: t(STAGE_LABELS[k]),
                                  minutes: s.stages![k],
                                })}
                              </title>
                            </rect>
                          );
                          cursor += wpx;
                          return el;
                        });
                      })()
                    ) : (
                      // Un-staged night: honest plain fill rather than invented stages.
                      <rect x={x(b)} y={y} width={x(w) - x(b)} height={BAR} fill="var(--indigo-400)" opacity={0.75} />
                    )}
                  </g>
                </g>,
              );

              if (showRight) {
                rowEls.push(
                  <text key="dur" x={W - PR + 12} y={cy + 3.5} fontSize={10.5} fill="var(--color-zinc-300)" fontWeight={500}>
                    {fmtDuration(s.minutesAsleep)}
                  </text>,
                );
                if (winA !== null) {
                  // This night's bedtime against your own average, fold-aware.
                  const dev = fold(s.bedtimeMin) - winA;
                  if (Math.abs(dev) >= 10) {
                    rowEls.push(
                      <text key="dev" x={W - PR + 66} y={cy + 3.5} fontSize={9} fill="var(--color-zinc-500)">
                        {t('sleep.window.bedOffset', { offset: signed(dev) })}
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
          <span key={k} className="flex items-center gap-1.5 text-note uppercase tracking-wider text-zinc-500">
            <i className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
            {t(STAGE_LABELS[k])}
          </span>
        ))}
        {typical && (
          <span className="flex items-center gap-1.5 text-note uppercase tracking-wider text-zinc-500">
            <i className="w-3 h-2.5 rounded-[2px] border border-dashed" style={{ borderColor: tint('var(--indigo-400)', 67) }} />
            {t('sleep.window.averageWindow', { bed: formatClock(typical.bedMean), wake: formatClock(typical.wakeMean) })}
          </span>
        )}
      </div>
    </Card>
  );
}
