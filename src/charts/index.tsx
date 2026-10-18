export * from './SleepWindowChart';

import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { CivilDate } from '../lib/date';
import { lastIndexWithValue, rollingMean, values, type Point } from '../pipeline/derive';
import { niceScale } from '../lib/scale';
import { meanWindowFor, type Bucket } from '../pipeline/aggregate';
import { AXIS, GRID, fmtDuration, fmtNum } from '../ui/primitives';
import { rulerStep } from '../ui/DayRuler';
import type { DailyRecord, SleepSession } from '../types/health';
import { names, numberFormat, t, type MessageKey } from '../i18n';
import { bucketLabel, formatCivil, formatClock, meanLabel, weekdayLetter } from '../i18n/format';

/**
 * Charts.
 *
 * The single most important behaviour here: **a day with no observation is a gap,
 * not a zero.** Recharts draws a break when a value is `null` and
 * `connectNulls` is false, which is exactly right — the four missing nights in
 * mid-July should look like missing nights, not like four nights of no sleep.
 */

/** Axis ticks, in the note size. SVG text can't read the CSS type tokens, so the size is written out. */
const TICK = { fill: AXIS, fontSize: 10 } as const;

const tooltipStyle = {
  backgroundColor: '#09090b',
  border: '1px solid #27272a',
  borderRadius: 10,
  fontSize: 'var(--text-caption)',
  padding: '8px 10px',
} as const;

interface ChartRow {
  date: CivilDate;
  label: string;
  /** Tooltip heading: the day, or "Week of 5 Oct 2026" / "Oct 2026" when grouped. */
  full: string;
  wd: string;
  value: number | null;
  mean?: number | null;
  [k: string]: unknown;
}

function toRows(s: Point[], meanWindow?: number, bucket: Bucket = 'day'): ChartRow[] {
  const mean = meanWindow ? rollingMean(s, meanWindow, Math.ceil(meanWindow / 2)) : null;
  // The average ends at the last reading: a day with nothing recorded yet, usually today, has no
  // average of its own, and carrying the line on would draw a value nobody measured.
  const last = lastIndexWithValue(s);
  return s.map((p, i) => ({
    date: p.date,
    ...labels(p.date, bucket),
    wd: weekdayLetter(p.date),
    value: p.value,
    mean: mean ? (i <= last ? mean[i].value : null) : undefined,
  }));
}

/** Axis label and tooltip heading for a point: a day, or the week/month it stands for. */
function labels(date: CivilDate, bucket: Bucket) {
  return bucket === 'day'
    ? { label: formatCivil(date), full: formatCivil(date) }
    : { label: bucketLabel(date, bucket), full: bucketLabel(date, bucket, 'full') };
}

/** Recharts passes the axis label; show the row's full heading instead. */
const tooltipHeading = (label: unknown, payload: readonly any[] | undefined) => payload?.[0]?.payload?.full ?? String(label ?? '');

/** A tooltip's value with its unit, when it has one: "52 bpm". */
const reading = (value: string, unit?: string) => (unit ? t('charts.tooltip.value', { value, unit }) : value);

/** A tick with every decimal it has, in the language's decimal mark: "0.25", "97.5". A scale's −0 reads "0", not "-0". */
const tickNumber = (v: number) => numberFormat({ maximumFractionDigits: 20 }).format(v === 0 ? 0 : v);

/**
 * Y-axis ticks: thousands as "18k" or "4.5k". The axis column is about 28px wide, so a full
 * "18,000" lost its first digits and read as "000".
 */
export const axisTick = (v: number) =>
  Math.abs(v) >= 1000 ? t('format.thousands', { value: tickNumber(Number((v / 1000).toFixed(2))) }) : tickNumber(v);

/** Sparse x-axis labels: roughly one per week, always including the last day. */
function tickInterval(n: number): number {
  if (n <= 10) return 0;
  return Math.max(1, Math.floor(n / 8));
}

/** Daily bars up to a month get a ruler on their day axis; past that the bars are too narrow to tick. */
const RULER_MAX = 31;

/** Whether a bar chart's day axis is a ruler: daily bars, too many to date one by one, at most a month. */
const isRuler = (n: number, bucket: Bucket) => bucket === 'day' && n > 10 && n <= RULER_MAX;

/**
 * One tick of the day ruler, as a ruler marks millimetres: a short line under every day's bar and a
 * longer one with the date under every few, counted back from the latest, so each date sits under
 * its own bar and the newest is always dated.
 */
function RulerTick({ x, y, index, payload, n }: { x: number; y: number; index: number; payload: { value: string }; n: number }) {
  const dated = (n - 1 - index) % rulerStep(n) === 0;
  const latest = index === n - 1;
  return (
    <g transform={`translate(${x},${y})`}>
      <line y1={1} y2={dated ? 7 : 4} stroke={latest ? '#a1a1aa' : dated ? AXIS : '#3f3f46'} strokeWidth={1} />
      {dated && (
        <text y={19} textAnchor="middle" fill={latest ? '#a1a1aa' : AXIS} fontSize={TICK.fontSize} fontWeight={latest ? 600 : 400}>
          {payload.value}
        </text>
      )}
    </g>
  );
}

/** A bar chart's day axis: the ruler while it applies, else sparse labels. */
function dayAxis(n: number, bucket: Bucket) {
  return isRuler(n, bucket)
    ? { interval: 0, tick: (p: any) => <RulerTick {...p} n={n} />, height: 30 }
    : { interval: tickInterval(n), tick: TICK, dy: 6 };
}

// ─────────────────────────────────────────────────────────── trend (line)

export function TrendChart({
  series,
  color,
  unit,
  height = 180,
  meanWindow: meanWindowProp,
  domain,
  baseline: baselineProp,
  format = (v: number) => fmtNum(v),
  area = true,
  bucket = 'day',
}: {
  series: Point[];
  color: string;
  unit?: string;
  height?: number;
  /** Rolling-mean length in points; defaults to suit the bucket. Null turns it off. */
  meanWindow?: number | null;
  domain?: [number | 'auto', number | 'auto'];
  /** Draws the typical band, so a point can be read against its own history. */
  baseline?: { centre: number; spread: number } | null;
  format?: (v: number) => string;
  area?: boolean;
  /** Set when the series has been grouped into weeks or months. */
  bucket?: Bucket;
}) {
  const meanWindow = meanWindowProp === undefined ? meanWindowFor(bucket) : meanWindowProp;
  // The band describes recent days ("your usual"); drawn across a year of weekly
  // averages it would claim to describe the whole year.
  const baseline = bucket === 'day' ? baselineProp : null;
  const rows = useMemo(() => toRows(series, meanWindow ?? undefined, bucket), [series, meanWindow, bucket]);
  const n = rows.length;
  const id = useMemo(() => `g${Math.random().toString(36).slice(2, 8)}`, []);
  const known = values(series).length;
  // The axis covers the readings and the usual band. Left to itself, Recharts sized the axis to the
  // readings alone and then dropped the band entirely whenever it reached past them.
  const ticks = useMemo(() => {
    const v = values(series);
    if (domain || !v.length) return null;
    const edges = baseline ? [baseline.centre - baseline.spread, baseline.centre + baseline.spread] : [];
    return niceScale(Math.min(...v, ...edges), Math.max(...v, ...edges));
  }, [series, domain, baseline?.centre, baseline?.spread]);
  if (!known) return <NoSeries height={height} />;

  /**
   * Sparse series need different treatment, and getting this wrong loses data
   * silently: a line segment needs two *adjacent* non-null points, so four weight
   * readings weeks apart drew literally nothing with dots turned off.
   *
   * Below 60% coverage we mark every reading with a dot and join them with a
   * dashed line — dots are measurements, the dash is acknowledged interpolation.
   * Monotone smoothing is also dropped here, since it overshoots wildly when
   * points are far apart.
   */
  const sparse = known / Math.max(1, n) < 0.6;
  const curve = sparse ? 'linear' : 'monotone';
  const showMean = !!meanWindow && !sparse;

  return (
    <div>
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        {baseline && (
          <ReferenceArea
            y1={baseline.centre - baseline.spread}
            y2={baseline.centre + baseline.spread}
            ifOverflow="extendDomain"
            {...({ fill: '#a1a1aa', fillOpacity: 0.06, stroke: 'none' } as any)}
          />
        )}
        {baseline && <ReferenceLine y={baseline.centre} ifOverflow="extendDomain" stroke="#71717a" strokeDasharray="3 3" strokeWidth={1} />}
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          interval={tickInterval(n)}
          tick={TICK}
          dy={6}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={TICK}
          tickFormatter={axisTick}
          domain={domain ?? (ticks ? [ticks[0], ticks[ticks.length - 1]] : ['auto', 'auto'])}
          ticks={ticks ?? undefined}
          width={52}
        />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => [
            v === null ? t('charts.tooltip.notRecorded') : reading(format(Number(v)), unit),
            name === 'mean' && meanWindow ? meanLabel(bucket, meanWindow) : t('charts.trend.series', { bucket }),
          ]}
        />
        {area && !sparse && (
          <Area
            type={curve} dataKey="value" stroke="none" fill={`url(#${id})`}
            connectNulls={false} isAnimationActive={false}
          />
        )}
        {/* Dashed connector between distant readings — drawn under the dots. */}
        {sparse && (
          <Line
            type="linear" dataKey="value" stroke={color} strokeWidth={1.2}
            strokeDasharray="4 4" strokeOpacity={0.5}
            dot={false} connectNulls isAnimationActive={false}
          />
        )}
        <Line
          type={curve} dataKey="value" stroke={color}
          strokeWidth={sparse ? 0 : meanWindow ? 1 : 1.8}
          strokeOpacity={sparse ? 0 : meanWindow ? 0.45 : 1}
          dot={sparse ? { r: 3, fill: color, stroke: 'none' } : false}
          connectNulls={false} isAnimationActive={false}
        />
        {showMean && (
          <Line
            type={curve} dataKey="mean" stroke={color} strokeWidth={2.4}
            dot={false} connectNulls={false} isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
    {/* A key, so the thin line, the thick one and the band each say what they are. */}
    {(showMean || baseline) && (
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 text-note text-zinc-500">
        {showMean && (
          <>
            <span className="flex items-center gap-1.5">
              <i className="block w-3.5 h-px" style={{ background: color, opacity: 0.6 }} />
              {t('charts.trend.legend.each', { bucket })}
            </span>
            <span className="flex items-center gap-1.5">
              <i className="block w-3.5 h-[2.5px] rounded-full" style={{ background: color }} />
              {t('charts.trend.legend.average', { bucket, count: meanWindow })}
            </span>
          </>
        )}
        {baseline && (
          <span className="flex items-center gap-1.5">
            <i className="block w-3.5 h-2 rounded-sm bg-zinc-400/20" />
            {t('charts.trend.legend.usualRange')}
          </span>
        )}
      </div>
    )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── bar series

export function BarSeries({
  series,
  color,
  unit,
  goal,
  height = 180,
  format = (v: number) => fmtNum(v, 0),
  bucket = 'day',
}: {
  series: Point[];
  color: string;
  unit?: string;
  goal?: number;
  height?: number;
  format?: (v: number) => string;
  /** Set when the series has been grouped; bars are then averages per day. */
  bucket?: Bucket;
}) {
  const rows = useMemo(() => toRows(series, undefined, bucket), [series, bucket]);
  if (!values(series).length) return <NoSeries height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: goal !== undefined ? 28 : isRuler(rows.length, bucket) ? 16 : 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        {goal !== undefined && (
          <ReferenceLine
            y={goal} stroke="#a1a1aa" strokeDasharray="4 3" strokeWidth={1}
            label={{ value: axisTick(goal), position: 'right', fill: AXIS, fontSize: 9 }}
          />
        )}
        <XAxis dataKey="label" axisLine={false} tickLine={false} {...dayAxis(rows.length, bucket)} />
        <YAxis axisLine={false} tickLine={false} tick={TICK} tickFormatter={axisTick} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any) => [
            v === null ? t('charts.tooltip.notRecorded') : reading(format(Number(v)), unit),
            bucket === 'day' ? '' : t('charts.bars.averagePerDay'),
          ]}
        />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell
              key={i}
              fill={color}
              fillOpacity={goal !== undefined && r.value !== null ? (r.value >= goal ? 0.95 : 0.42) : 0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ────────────────────────────────────────────────────── stacked intensity

export function StackedBars({
  days,
  keys,
  height = 190,
  unit,
  bucket = 'day',
}: {
  days: DailyRecord[];
  keys: { key: string; label: string; color: string; get: (d: DailyRecord) => number | null }[];
  height?: number;
  unit?: string;
  bucket?: Bucket;
}) {
  const rows = useMemo(
    () =>
      days.map((d) => {
        const row: any = labels(d.date, bucket);
        let any = false;
        for (const k of keys) {
          const v = k.get(d);
          row[k.key] = v;
          if (v !== null) any = true;
        }
        row.__any = any;
        return row;
      }),
    [days, keys, bucket],
  );
  if (!rows.some((r) => r.__any)) return <NoSeries height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: isRuler(rows.length, bucket) ? 16 : 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} {...dayAxis(rows.length, bucket)} />
        <YAxis axisLine={false} tickLine={false} tick={TICK} tickFormatter={axisTick} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => {
            const k = keys.find((x) => x.key === name);
            return [v === null ? '—' : reading(fmtNum(Number(v), 0), unit), k?.label ?? name ?? ''];
          }}
        />
        {keys.map((k, i) => (
          <Bar
            key={k.key} dataKey={k.key} stackId="a" fill={k.color}
            radius={i === keys.length - 1 ? [3, 3, 0, 0] : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ────────────────────────────────────────────────── range band (SpO2 etc.)

export function RangeBandChart({
  days,
  color,
  height = 180,
  get,
  unit = t('units.percent'),
  domain,
  bucket = 'day',
}: {
  days: DailyRecord[];
  color: string;
  height?: number;
  get: (d: DailyRecord) => { avg: number; low: number | null; high: number | null } | null;
  unit?: string;
  domain?: [number, number];
  /** When grouped, each row is a week/month: average of averages, lowest low, highest high. */
  bucket?: Bucket;
}) {
  const rows = useMemo(
    () =>
      days.map((d) => {
        const v = get(d);
        const hasBand = v?.low !== null && v?.low !== undefined && v?.high !== null && v?.high !== undefined;
        return {
          ...labels(d.date, bucket),
          // A two-element dataKey draws a true range area. The earlier version
          // stacked two areas, which forced the y-axis to include zero and made a
          // 93–99% band look like a flat line pinned to the top of the chart.
          band: hasBand ? [v!.low as number, v!.high as number] : null,
          avg: v?.avg ?? null,
          low: v?.low ?? null,
          high: v?.high ?? null,
        };
      }),
    [days, get, bucket],
  );
  if (!rows.some((r) => r.avg !== null)) return <NoSeries height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={TICK} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={TICK} tickFormatter={axisTick} domain={domain ?? ['auto', 'auto']} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => {
            if (name === 'band') {
              return Array.isArray(v)
                ? [t('charts.tooltip.range', { low: fmtNum(v[0]), high: fmtNum(v[1]), unit }), t('charts.range.band', { bucket })]
                : ([null, null] as any);
            }
            const map: Record<string, MessageKey> = { avg: 'charts.range.average', low: 'charts.range.low', high: 'charts.range.high' };
            const key = map[String(name)];
            return [v === null ? '—' : t('charts.tooltip.valueSymbol', { value: fmtNum(Number(v)), unit }), key ? t(key, { bucket }) : name ?? ''];
          }}
        />
        <Area
          dataKey="band" stroke="none" fill={color} fillOpacity={0.18}
          isAnimationActive={false} connectNulls={false}
        />
        <Line dataKey="avg" stroke={color} strokeWidth={1.9} dot={false} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ──────────────────────────────────────────── diverging (temp deviation)

export function DivergingBars({
  series,
  height = 170,
  unit = t('units.celsius'),
  posColor = '#fb7185',
  negColor = '#818cf8',
  bucket = 'day',
}: {
  series: Point[];
  height?: number;
  unit?: string;
  posColor?: string;
  negColor?: string;
  bucket?: Bucket;
}) {
  const rows = useMemo(() => toRows(series, undefined, bucket), [series, bucket]);
  if (!values(series).length) return <NoSeries height={height} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={TICK} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={TICK} tickFormatter={axisTick} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any) => [
            v === null
              ? t('charts.tooltip.notRecorded')
              : t('charts.tooltip.valueSymbol', { value: `${v > 0 ? '+' : ''}${fmtNum(Number(v), 2)}`, unit }),
            t('charts.diverging.series', { bucket }),
          ]}
        />
        <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
          {rows.map((r, i) => (
            <Cell key={i} fill={(r.value ?? 0) >= 0 ? posColor : negColor} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─────────────────────────────────────────────────────────────── hypnogram

const STAGE_STYLE = {
  awake: { row: 0, label: 'sleep.stages.awake', color: '#d8b48a' },
  rem: { row: 1, label: 'sleep.stages.rem', color: '#a78bfa' },
  light: { row: 2, label: 'sleep.stages.light', color: '#818cf8' },
  deep: { row: 3, label: 'sleep.stages.deep', color: '#4338ca' },
} as const satisfies Record<string, { row: number; label: MessageKey; color: string }>;

/**
 * Hand-drawn SVG rather than a chart library: a hypnogram is a step function
 * across four ordered categories, which no generic chart type expresses well.
 * Rows run awake → deep so downward reads as deeper, matching sleep-lab convention.
 *
 * Drawn at its true pixel width: a fixed 1000-unit viewBox shrank the whole
 * drawing to fit, so on a phone the bars were a few pixels tall and the stage
 * names unreadable.
 */
export function Hypnogram({ session, height = 200 }: { session: SleepSession; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const uid = useId().replace(/[^\w-]/g, '');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const segs = session.segments;
  if (!segs.length) {
    return (
      <div className="px-5 pb-5">
        <p className="text-caption text-zinc-500">{t('charts.hypnogram.noTimeline')}</p>
      </div>
    );
  }
  const total = segs.reduce((a, s) => a + s.durationMin, 0);
  const PL = 46, PR = 6, PT = 16, PB = 26;
  const w = Math.max(0, W - PL - PR);
  const rowH = (height - PT - PB) / 4;
  const barH = Math.round(rowH * 0.62);
  const x = (min: number) => PL + (min / total) * w;
  const rowY = (stage: keyof typeof STAGE_STYLE) => PT + STAGE_STYLE[stage].row * rowH + rowH / 2;

  // Consecutive pieces of one stage draw as a single block.
  const runs: { stage: keyof typeof STAGE_STYLE; from: number; to: number; clockMin: number }[] = [];
  for (const sg of segs) {
    const last = runs[runs.length - 1];
    if (last && last.stage === sg.stage && Math.abs(last.to - sg.offsetMin) < 0.5) last.to = sg.offsetMin + sg.durationMin;
    else runs.push({ stage: sg.stage, from: sg.offsetMin, to: sg.offsetMin + sg.durationMin, clockMin: sg.clockMin });
  }
  // Each change of stage is a thin link that sits flush inside the end of one block and the start
  // of the next, whose touching corners are square, so block, link and block join without a seam.
  // The outer corners stay rounded. Blocks are at least MIN_W wide, so a one-minute stage still
  // shows; the extra width pushes the next block along until a longer one absorbs it.
  const LINK = 1.25, MIN_W = 5, RADIUS = 6;
  const linked = (i: number) => i > 0 && Math.abs(runs[i - 1].to - runs[i].from) < 0.5;
  const laid: { x0: number; x1: number }[] = [];
  runs.forEach((r, i) => {
    const x0 = linked(i) ? laid[i - 1].x1 - LINK : x(r.from);
    laid.push({ x0, x1: Math.min(PL + w, Math.max(x(r.to), x0 + MIN_W)) });
  });
  const above = (a: keyof typeof STAGE_STYLE, b: keyof typeof STAGE_STYLE) => STAGE_STYLE[a].row < STAGE_STYLE[b].row;
  /** A block's outline, square at the corners a link leaves from or arrives at. */
  const blockPath = (i: number) => {
    const r = runs[i];
    const { x0, x1 } = laid[i];
    const y0 = rowY(r.stage) - barH / 2;
    const y1 = y0 + barH;
    const rad = Math.min(RADIUS, (x1 - x0) / 2, barH / 2);
    const prev = linked(i) ? runs[i - 1].stage : null;
    const next = i + 1 < runs.length && linked(i + 1) ? runs[i + 1].stage : null;
    const tl = prev && above(prev, r.stage) ? 0 : rad;
    const bl = prev && !above(prev, r.stage) ? 0 : rad;
    const tr = next && above(next, r.stage) ? 0 : rad;
    const br = next && !above(next, r.stage) ? 0 : rad;
    const arc = (rr: number, ex: number, ey: number) => (rr ? `A${rr},${rr} 0 0 1 ${ex},${ey}` : '');
    return [
      `M${x0 + tl},${y0}`, `H${x1 - tr}`, arc(tr, x1, y0 + tr),
      `V${y1 - br}`, arc(br, x1 - br, y1),
      `H${x0 + bl}`, arc(bl, x0, y1 - bl),
      `V${y0 + tl}`, arc(tl, x0 + tl, y0), 'Z',
    ].join(' ');
  };

  // An hour label wherever there's room for one; every other hour on a long night on a phone.
  const startClock = segs[0].clockMin;
  const hourStep = (60 / total) * w < 44 ? 120 : 60;
  const hourTicks: number[] = [];
  for (let m = (60 - (startClock % 60)) % 60; m < total; m += 60) {
    if ((startClock + m) % hourStep === 0) hourTicks.push(m);
  }

  return (
    <div className="px-3 pb-2">
      <div ref={box} style={{ height }}>
        {W > 0 && (
          <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} className="block" role="img"
            aria-label={t('charts.hypnogram.label', { duration: fmtDuration(session.minutesAsleep) })}>
            <defs>
              {runs.map((r, i) => {
                if (!linked(i)) return null;
                const prev = runs[i - 1];
                const down = above(prev.stage, r.stage);
                return (
                  <linearGradient key={i} id={`${uid}-t${i}`} gradientUnits="userSpaceOnUse" x1={0} x2={0}
                    y1={rowY(prev.stage) + (down ? barH / 2 : -barH / 2)} y2={rowY(r.stage) + (down ? -barH / 2 : barH / 2)}>
                    <stop offset="0" stopColor={STAGE_STYLE[prev.stage].color} />
                    <stop offset="1" stopColor={STAGE_STYLE[r.stage].color} />
                  </linearGradient>
                );
              })}
            </defs>
            {Object.entries(STAGE_STYLE).map(([k, st]) => {
              const y = PT + st.row * rowH + rowH / 2;
              return (
                <g key={k}>
                  <line x1={PL} x2={W - PR} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
                  <text x={PL - 10} y={y + 3.5} textAnchor="end" fontSize={10.5} fill={AXIS}>{t(st.label)}</text>
                </g>
              );
            })}
            {/* Links first; each block covers the part of its links that runs inside it. */}
            {runs.map((r, i) => {
              if (!linked(i)) return null;
              const ya = rowY(runs[i - 1].stage);
              const yb = rowY(r.stage);
              return (
                <rect key={i} x={laid[i - 1].x1 - LINK} width={LINK} y={Math.min(ya, yb)} height={Math.abs(yb - ya)}
                  fill={`url(#${uid}-t${i})`} />
              );
            })}
            {runs.map((r, i) => {
              const st = STAGE_STYLE[r.stage];
              return (
                <path key={i} d={blockPath(i)} fill={st.color}>
                  <title>
                    {t('charts.hypnogram.block', { stage: t(st.label), minutes: Math.round(r.to - r.from), time: formatClock(r.clockMin) })}
                  </title>
                </path>
              );
            })}
            {session.shortAwakeningsMin.map((m, i) => (
              <line key={i} x1={x(m)} x2={x(m)} y1={PT - 12} y2={PT - 4} stroke="#e4e4e7" strokeWidth={1.6} strokeLinecap="round">
                <title>{t('charts.hypnogram.awakening', { time: formatClock(segs[0].clockMin + m) })}</title>
              </line>
            ))}
            {hourTicks.map((m) => (
              <g key={m}>
                <line x1={x(m)} x2={x(m)} y1={height - PB + 2} y2={height - PB + 6} stroke={GRID} />
                <text x={x(m)} y={height - PB + 19} textAnchor="middle" fontSize={10.5} fill={AXIS}>
                  {formatClock(startClock + m)}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}

export function StageLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 pb-4">
      {Object.values(STAGE_STYLE).map((s) => (
        <span key={s.label} className="flex items-center gap-1.5 text-note uppercase tracking-wider text-zinc-500">
          <i className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
          {t(s.label)}
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-note uppercase tracking-wider text-zinc-500">
        <i className="w-[2px] h-3 bg-zinc-200" /> {t('charts.stageLegend.briefAwakening')}
      </span>
    </div>
  );
}

/** Horizontal stage-composition bar, used per night in the sleep list. */
export function StageBar({ session, height = 14 }: { session: SleepSession; height?: number }) {
  const st = session.stages;
  if (!st) return <div className="h-3.5 rounded bg-zinc-800" />;
  const total = st.deep + st.light + st.rem + st.awake || 1;
  const parts: [keyof typeof STAGE_STYLE, number][] = [
    ['deep', st.deep], ['light', st.light], ['rem', st.rem], ['awake', st.awake],
  ];
  return (
    <div className="flex rounded overflow-hidden bg-zinc-800" style={{ height }}>
      {parts.map(([k, v]) =>
        v > 0 ? (
          <div
            key={k}
            style={{ width: `${(v / total) * 100}%`, background: STAGE_STYLE[k].color }}
            title={t('charts.stageBar.title', { stage: t(STAGE_STYLE[k].label), minutes: v })}
          />
        ) : null,
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────── weekday profile

export function WeekdayProfile({
  data,
  color,
  format = (v: number) => fmtNum(v, 0),
  className = 'h-[112px]',
}: {
  data: { weekday: number; mean: number | null; n: number }[];
  color: string;
  format?: (v: number) => string;
  /** Its height; pass a flex-1 to let it fill a stretched card. */
  className?: string;
}) {
  // Monday-first reads better for weekly habits than the JS Sunday-first order.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const letters = names('format.weekdaysNarrow');
  const full = names('format.weekdays');
  const max = Math.max(...data.map((d) => d.mean ?? 0), 1);
  return (
    <div className={`flex items-end gap-1.5 px-5 pb-5 ${className}`}>
      {order.map((wd) => {
        const d = data.find((x) => x.weekday === wd)!;
        const h = d.mean === null ? 0 : (d.mean / max) * 100;
        return (
          <div key={wd} className="flex-1 flex flex-col items-center h-full"
            title={
              d.mean === null
                ? t('charts.weekday.noData', { weekday: full[wd], count: d.n })
                : t('charts.weekday.tooltip', { weekday: full[wd], value: format(d.mean), count: d.n })
            }>
            <span className="text-micro text-zinc-500 tabular-nums mb-1">
              {d.mean === null ? '' : format(d.mean)}
            </span>
            {/* The bar needs its own flex-1 track: a percentage height on a flex
                item resolves against the item's own box, not the row, so every
                bar previously rendered the same height regardless of value. */}
            <div className="flex-1 w-full flex items-end">
              <div
                className="w-full rounded-t-[3px]"
                style={{ height: `${h}%`, minHeight: h > 0 ? 3 : 0, background: color, opacity: 0.8 }}
              />
            </div>
            <span className="text-note text-zinc-500 mt-1.5">{letters[wd]}</span>
          </div>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────── sparkline

export function Spark({
  series,
  color,
  height = 26,
  width = 120,
  baseline,
}: {
  series: Point[];
  color: string;
  height?: number;
  width?: number;
  /** Your usual range, shaded behind the line: centre ± spread, as the full charts shade it. */
  baseline?: { centre: number; spread: number } | null;
}) {
  const v = series.map((p) => p.value);
  const known = v.filter((x): x is number => x !== null);
  if (known.length < 2) return <div style={{ height }} />;
  const band = baseline ? { lo: baseline.centre - baseline.spread, hi: baseline.centre + baseline.spread } : null;
  // The scale takes in the band too, so a line that stays above or below it shows that it does.
  const lo = Math.min(...known, ...(band ? [band.lo] : []));
  const hi = Math.max(...known, ...(band ? [band.hi] : []));
  const y = (val: number) => height - 2 - ((val - lo) / (hi - lo || 1)) * (height - 4);
  const x = (i: number) => (i / (v.length - 1 || 1)) * width;

  const paths: string[] = [];
  let cur: string[] = [];
  v.forEach((val, i) => {
    if (val === null) {
      if (cur.length > 1) paths.push(cur.join(' '));
      cur = [];
    } else {
      cur.push(`${cur.length ? 'L' : 'M'}${x(i).toFixed(1)} ${y(val).toFixed(1)}`);
    }
  });
  if (cur.length > 1) paths.push(cur.join(' '));

  const lastIdx = v.length - 1 - [...v].reverse().findIndex((x) => x !== null);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {band && (
        <>
          <title>{t('charts.spark.usualRange')}</title>
          <rect x={0} y={y(band.hi)} width={width} height={Math.max(0, y(band.lo) - y(band.hi))} fill="#a1a1aa" opacity={0.12} />
        </>
      )}
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" opacity={0.85} />
      ))}
      {v[lastIdx] !== null && v[lastIdx] !== undefined && (
        <circle cx={x(lastIdx)} cy={y(v[lastIdx] as number)} r={1.9} fill={color} />
      )}
    </svg>
  );
}

// ────────────────────────────────────────────────────────── intraday trace

function NoSeries({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-caption text-zinc-600" style={{ height }}>
      {t('charts.empty')}
    </div>
  );
}
