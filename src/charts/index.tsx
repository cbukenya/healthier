export * from './SleepWindowChart';

import React, { useMemo } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatCivil, formatClock, weekdayLetter, type CivilDate } from '../lib/date';
import { rollingMean, values, type Point } from '../pipeline/derive';
import { bucketLabel, bucketStart, meanLabel, meanWindowFor, type Bucket } from '../pipeline/aggregate';
import { AXIS, GRID, fmtDuration, fmtNum } from '../ui/primitives';
import type { DailyRecord, SleepSession } from '../types/health';

/**
 * Charts.
 *
 * The single most important behaviour here: **a day with no observation is a gap,
 * not a zero.** Recharts draws a break when a value is `null` and
 * `connectNulls` is false, which is exactly right — the four missing nights in
 * mid-July should look like missing nights, not like four nights of no sleep.
 */

const tooltipStyle = {
  backgroundColor: '#09090b',
  border: '1px solid #27272a',
  borderRadius: 10,
  fontSize: 11,
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
  return s.map((p, i) => ({
    date: p.date,
    ...labels(p.date, bucket),
    wd: weekdayLetter(p.date),
    value: p.value,
    mean: mean ? mean[i].value : undefined,
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

/** Sparse x-axis labels: roughly one per week, always including the last day. */
function tickInterval(n: number): number {
  if (n <= 10) return 0;
  return Math.max(1, Math.floor(n / 8));
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

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
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
            {...({ fill: '#a1a1aa', fillOpacity: 0.06, stroke: 'none' } as any)}
          />
        )}
        {baseline && <ReferenceLine y={baseline.centre} stroke="#71717a" strokeDasharray="3 3" strokeWidth={1} />}
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          interval={tickInterval(n)}
          tick={{ fill: AXIS, fontSize: 10 }}
          dy={6}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fill: AXIS, fontSize: 10 }}
          domain={domain ?? ['auto', 'auto']}
          width={52}
        />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => [
            v === null ? 'not recorded' : `${format(Number(v))}${unit ? ` ${unit}` : ''}`,
            name === 'mean' && meanWindow ? meanLabel(bucket, meanWindow) : bucket === 'day' ? 'reading' : `${bucket}ly average`,
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
        {meanWindow && !sparse && (
          <Line
            type={curve} dataKey="mean" stroke={color} strokeWidth={2.4}
            dot={false} connectNulls={false} isAnimationActive={false}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
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
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        {goal !== undefined && (
          <ReferenceLine
            y={goal} stroke="#a1a1aa" strokeDasharray="4 3" strokeWidth={1}
            label={{ value: format(goal), position: 'right', fill: AXIS, fontSize: 9 }}
          />
        )}
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={{ fill: AXIS, fontSize: 10 }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS, fontSize: 10 }} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any) => [
            v === null ? 'not recorded' : `${format(Number(v))}${unit ? ` ${unit}` : ''}`,
            bucket === 'day' ? '' : 'average per day',
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
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={{ fill: AXIS, fontSize: 10 }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS, fontSize: 10 }} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => {
            const k = keys.find((x) => x.key === name);
            return [v === null ? '—' : `${fmtNum(Number(v), 0)}${unit ? ` ${unit}` : ''}`, k?.label ?? name ?? ''];
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
  unit = '%',
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
  const period = bucket === 'day' ? 'nightly' : `${bucket}'s`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={{ fill: AXIS, fontSize: 10 }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS, fontSize: 10 }} domain={domain ?? ['auto', 'auto']} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600, marginBottom: 2 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any, name?: string | number) => {
            if (name === 'band') {
              return Array.isArray(v) ? [`${fmtNum(v[0])}–${fmtNum(v[1])}${unit}`, `${period} range`] : ([null, null] as any);
            }
            const map: Record<string, string> = { avg: 'average', low: `${period} low`, high: `${period} high` };
            return [v === null ? '—' : `${fmtNum(Number(v))}${unit}`, map[String(name)] ?? name ?? ''];
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
  unit = '°C',
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
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={tickInterval(rows.length)} tick={{ fill: AXIS, fontSize: 10 }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS, fontSize: 10 }} width={52} />
        <Tooltip
          contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }}
          labelStyle={{ color: '#e4e4e7', fontWeight: 600 }}
          labelFormatter={tooltipHeading}
          formatter={(v: any) => [
            v === null ? 'not recorded' : `${v > 0 ? '+' : ''}${fmtNum(Number(v), 2)}${unit}`,
            bucket === 'day' ? 'vs baseline' : `${bucket}ly average vs baseline`,
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
  awake: { row: 0, label: 'Awake', color: '#d8b48a' },
  rem: { row: 1, label: 'REM', color: '#a78bfa' },
  light: { row: 2, label: 'Light', color: '#818cf8' },
  deep: { row: 3, label: 'Deep', color: '#4338ca' },
} as const;

/**
 * Hand-drawn SVG rather than a chart library: a hypnogram is a step function
 * across four ordered categories, which no generic chart type expresses well.
 * Rows run awake → deep so downward reads as deeper, matching sleep-lab convention.
 */
export function Hypnogram({ session, height = 172 }: { session: SleepSession; height?: number }) {
  const segs = session.segments;
  if (!segs.length) {
    return (
      <div className="px-5 pb-5">
        <p className="text-[11.5px] text-zinc-500">
          This night has stage totals but no segment timeline, so there's no hypnogram to draw.
        </p>
      </div>
    );
  }
  const total = segs.reduce((a, s) => a + s.durationMin, 0);
  const PL = 46, PR = 12, PT = 16, PB = 26;
  const W = 1000; // viewBox width; scales to the container
  const w = W - PL - PR;
  const rowH = (height - PT - PB) / 4;
  const x = (min: number) => PL + (min / total) * w;

  const hourTicks: number[] = [];
  const startClock = segs[0].clockMin;
  for (let m = (60 - (startClock % 60)) % 60; m < total; m += 60) hourTicks.push(m);

  return (
    <div className="px-3 pb-2">
      <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }} role="img"
        aria-label={`Sleep stages, ${fmtDuration(session.minutesAsleep)} asleep`}>
        {Object.entries(STAGE_STYLE).map(([k, st]) => {
          const y = PT + st.row * rowH + rowH / 2;
          return (
            <g key={k}>
              <line x1={PL} x2={W - PR} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={PL - 8} y={y + 3.5} textAnchor="end" fontSize={10} fill={AXIS}>{st.label}</text>
            </g>
          );
        })}
        {segs.map((s, i) => {
          const st = STAGE_STYLE[s.stage];
          const y = PT + st.row * rowH + rowH / 2 - 6;
          const bw = Math.max(1.5, (s.durationMin / total) * w);
          const prev = i > 0 ? segs[i - 1] : null;
          return (
            <g key={i}>
              {prev && (
                <line
                  x1={x(s.offsetMin)} x2={x(s.offsetMin)}
                  y1={PT + STAGE_STYLE[prev.stage].row * rowH + rowH / 2}
                  y2={y + 6}
                  stroke={st.color} strokeWidth={1} opacity={0.35}
                />
              )}
              <rect x={x(s.offsetMin)} y={y} width={bw} height={12} rx={2} fill={st.color}>
                <title>{`${st.label} · ${Math.round(s.durationMin)} min · from ${formatClock(s.clockMin)}`}</title>
              </rect>
            </g>
          );
        })}
        {session.shortAwakeningsMin.map((m, i) => (
          <line key={i} x1={x(m)} x2={x(m)} y1={PT - 6} y2={PT + 1} stroke="#e4e4e7" strokeWidth={1.6}>
            <title>{`Brief awakening at ${formatClock(segs[0].clockMin + m)}`}</title>
          </line>
        ))}
        {hourTicks.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={height - PB + 2} y2={height - PB + 6} stroke={GRID} />
            <text x={x(m)} y={height - PB + 18} textAnchor="middle" fontSize={10} fill={AXIS}>
              {formatClock(startClock + m)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function StageLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-5 pb-4">
      {Object.values(STAGE_STYLE).map((s) => (
        <span key={s.label} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
          <i className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        <i className="w-[2px] h-3 bg-zinc-200" /> brief awakening
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
            title={`${STAGE_STYLE[k].label} ${v} min`}
          />
        ) : null,
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────── coverage grid

/**
 * One cell per day per stream. This is the chart that would have made the old
 * bugs obvious on day one: a stream returning nothing looks completely different
 * from a stream returning zeros.
 */
export function CoverageGrid({
  rows,
  dates,
  bucket = 'day',
}: {
  rows: { dataType: string; label: string; days: boolean[]; observed: number; total: number }[];
  dates: CivilDate[];
  /**
   * Day: one cell per day, recorded or not. Week/month: one cell per bucket,
   * shaded by the share of its days that have a reading.
   */
  bucket?: Bucket;
}) {
  // Cell boundaries: index ranges into `dates`, one per day or per bucket.
  const cells = useMemo(() => {
    const out: { date: CivilDate; from: number; to: number }[] = [];
    dates.forEach((d, i) => {
      const key = bucketStart(d, bucket);
      const last = out[out.length - 1];
      if (last && last.date === key) last.to = i;
      else out.push({ date: key, from: i, to: i });
    });
    return out;
  }, [dates, bucket]);

  const labels = useMemo(() => {
    const out = cells.map((_, i) => coverageLabel(cells, i, bucket));
    // The first column is labelled so the grid never starts unnamed, unless the next label is right beside it.
    const next = out.findIndex((l, i) => i > 0 && l !== null);
    if (cells.length > 31 && next > 0 && next < 4) out[0] = null;
    return out;
  }, [cells, bucket]);
  const gap = cells.length > 120 ? 'gap-0' : 'gap-[1.5px]';

  return (
    <div className="overflow-x-auto px-5 pb-5">
      <div className="min-w-[560px]">
        {/* Column labels share the cells' flex layout, so each sits exactly over its column. */}
        <div className="flex gap-2 mb-1.5">
          <span className="w-[144px] shrink-0" />
          <div className={`flex flex-1 ${gap} h-11`}>
            {cells.map((c, i) => (
              <span key={c.date} className="flex-1 min-w-0 flex items-end justify-center">
                {labels[i] && (
                  <span className="text-[9.5px] leading-none text-zinc-500 whitespace-nowrap [writing-mode:vertical-rl] rotate-180">
                    {labels[i]}
                  </span>
                )}
              </span>
            ))}
          </div>
          <span className="w-[52px] shrink-0" />
        </div>
        {rows.map((r) => (
          <div key={r.dataType} className="flex items-center gap-2 mb-[3px]">
            <span className="w-[144px] shrink-0 text-[11px] text-zinc-400 truncate" title={r.dataType}>
              {r.label}
            </span>
            <div className={`flex flex-1 ${gap}`}>
              {cells.map((c) => {
                const total = c.to - c.from + 1;
                let recorded = 0;
                for (let i = c.from; i <= c.to; i++) if (r.days[i]) recorded++;
                const when = bucket === 'day' ? dates[c.from] : bucketLabel(c.date, bucket, 'full');
                const detail = bucket === 'day' ? (recorded ? 'recorded' : 'no data') : `${recorded}/${total} days recorded`;
                return (
                  <span
                    key={c.date}
                    title={`${when} · ${r.label} · ${detail}`}
                    className={`flex-1 h-3.5 rounded-[1.5px] ${recorded ? 'bg-emerald-500' : 'bg-zinc-800'}`}
                    // A full bucket matches a recorded day; partial ones fade with their share.
                    style={recorded ? { opacity: 0.25 + 0.45 * (recorded / total) } : undefined}
                  />
                );
              })}
            </div>
            <span className="w-[52px] shrink-0 text-right text-[10.5px] text-zinc-500 tabular-nums">
              {r.observed}/{r.total}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Which coverage columns get a date label: every day up to a month, Mondays up
 * to ~4 months, the first week of each month for weekly cells, and months (or
 * years, past three years) for monthly ones.
 */
function coverageLabel(cells: { date: CivilDate }[], i: number, bucket: Bucket): string | null {
  const c = cells[i];
  const prev = cells[i - 1];
  if (bucket === 'day') {
    if (cells.length <= 31) return formatCivil(c.date);
    return i === 0 || weekdayLetter(c.date) === 'M' ? formatCivil(c.date) : null;
  }
  if (bucket === 'week') return !prev || prev.date.slice(0, 7) !== c.date.slice(0, 7) ? bucketLabel(c.date, 'month') : null;
  if (cells.length <= 36) return bucketLabel(c.date, 'month');
  return i === 0 || c.date.slice(5, 7) === '01' ? c.date.slice(0, 4) : null;
}

// ─────────────────────────────────────────────────────── weekday profile

export function WeekdayProfile({
  data,
  color,
  format = (v: number) => fmtNum(v, 0),
}: {
  data: { weekday: number; mean: number | null; n: number }[];
  color: string;
  format?: (v: number) => string;
}) {
  // Monday-first reads better for weekly habits than the JS Sunday-first order.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const full = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const max = Math.max(...data.map((d) => d.mean ?? 0), 1);
  return (
    <div className="flex items-end gap-1.5 px-5 pb-5 h-[112px]">
      {order.map((wd) => {
        const d = data.find((x) => x.weekday === wd)!;
        const h = d.mean === null ? 0 : (d.mean / max) * 100;
        return (
          <div key={wd} className="flex-1 flex flex-col items-center h-full"
            title={`${full[wd]} · ${d.mean === null ? 'no data' : format(d.mean)} · ${d.n} days`}>
            <span className="text-[9.5px] text-zinc-500 tabular-nums mb-1">
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
            <span className="text-[10px] text-zinc-500 mt-1.5">{names[wd]}</span>
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
          <title>Shaded: your usual range</title>
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

export function IntradayTrace({
  samples,
  color,
  height = 140,
}: {
  samples: { minutesOfDay: number; value: number; iso: string }[];
  color: string;
  height?: number;
}) {
  if (samples.length < 5) return <NoSeries height={height} />;

  // Apply a moving average for smoothing
  const windowSize = 6;
  const smoothedSamples = [];
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - windowSize + 1); j <= i; j++) {
      sum += samples[j].value;
      count++;
    }
    smoothedSamples.push({ ...samples[i], value: Math.round(sum / count) });
  }

  const rows = smoothedSamples.map((s) => ({ label: formatClock(s.minutesOfDay), value: s.value }));
  const gradientId = `gradient-${color.replace('#', '')}`;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.6} />
            <stop offset="95%" stopColor={color} stopOpacity={0.0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" axisLine={false} tickLine={false} interval={Math.floor(rows.length / 6)} tick={{ fill: AXIS, fontSize: 10 }} dy={6} />
        <YAxis axisLine={false} tickLine={false} tick={{ fill: AXIS, fontSize: 10 }} domain={['auto', 'auto']} width={52} />
        <Tooltip contentStyle={tooltipStyle} itemStyle={{ color: '#a1a1aa' }} labelStyle={{ color: '#e4e4e7', fontWeight: 600 }} formatter={(v: any) => [`${v} bpm`, '']} cursor={{ stroke: '#52525b', strokeWidth: 1, strokeDasharray: '4 4', fill: 'transparent' }} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradientId})`} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function NoSeries({ height }: { height: number }) {
  return (
    <div className="flex items-center justify-center text-[11px] text-zinc-600" style={{ height }}>
      Nothing recorded in this window
    </div>
  );
}
