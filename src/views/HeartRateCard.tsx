import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CivilDate } from '../lib/date';
import { formatCivil, formatCivilRange } from '../i18n/format';
import { t, type MessageKey } from '../i18n';
import {
  DAY, HOUR, MINUTE, ZONE_NAMES, byDay, hourly, lowerBound, tickStep, visibleRuns, wallClock, wallDate, wallTimes,
  zoneOf, zoneStarts, zoneStops, type Pt,
} from '../charts/heartRate';
import type { DailyRecord, HeartRateZones, IntradaySample } from '../types/health';
import { Card, DOMAIN, EFFORT } from '../ui/primitives';

const ZONE_COLORS = [EFFORT.light, EFFORT.moderate, EFFORT.vigorous, EFFORT.peak] as const;

/** The zoom buttons; pinching, ctrl and the wheel, and the strip's edges zoom in between. */
const SPANS: { label: MessageKey; ms: number }[] = [
  { label: 'vitals.heartRate.zoom.threeDays', ms: 3 * DAY },
  { label: 'vitals.heartRate.zoom.twentyFourHours', ms: DAY },
  { label: 'vitals.heartRate.zoom.sixHours', ms: 6 * HOUR },
  { label: 'vitals.heartRate.zoom.twoHours', ms: 2 * HOUR },
  { label: 'vitals.heartRate.zoom.thirtyMinutes', ms: 30 * MINUTE },
];
const MIN_SPAN = 15 * MINUTE;
const MAX_SPAN = 7 * DAY;
const STRIP_H = 34;

/** An element's width, kept current as it resizes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** What's in view: how long, and where it ends; `to` is null while the view follows the latest reading. */
interface View {
  span: number;
  to: number | null;
}

/**
 * Minute heart rate across the window, coloured by the day's zones as it moves through them:
 * light, moderate, vigorous and peak, each day by the zones Google set for it, never an average
 * of several days'. The figures above it describe exactly what's in view.
 *
 * Only the minutes in view are drawn, at most two to a pixel, so drawing costs the same at any
 * zoom; the readings themselves are held once, as two compact arrays.
 *
 * It opens on the last 24 hours. Drag it, or the strip of every day under it, to move through
 * the window; zoom with the buttons, a pinch, ctrl and the wheel, or the strip's edges. On the
 * keyboard, the arrows move and plus and minus zoom.
 */
export function HeartRateCard({ samples, days, wide, className = '' }: {
  /** Every minute of heart rate in the window, oldest first. */
  samples: IntradaySample[];
  /** The window's days, for each day's zones. */
  days: DailyRecord[];
  wide: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ts = useMemo(() => wallTimes(samples), [samples]);
  const vs = useMemo(() => Uint8Array.from(samples, (s) => Math.min(255, Math.max(0, s.value))), [samples]);
  const first = ts[0];
  const end = ts[ts.length - 1] + MINUTE;
  const range = Math.max(end - first, MIN_SPAN);

  // A day's zones, or the nearest earlier day's when Google hasn't sent its own yet.
  const zonesFor = useMemo(() => {
    const known = days.filter((d) => d.hrZones).map((d) => [d.date, d.hrZones!] as const);
    return (date: CivilDate): HeartRateZones | null => {
      let found: HeartRateZones | null = null;
      for (const [d, z] of known) {
        if (d > date) break;
        found = z;
      }
      return found ?? known[0]?.[1] ?? null;
    };
  }, [days]);
  const hasZones = days.some((d) => d.hrZones);

  // A steady bpm scale while the view moves: every reading in the window, in twenties.
  const [lo, hi] = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of vs) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const l = Math.max(20, Math.floor((min - 5) / 20) * 20);
    return [l, Math.max(l + 60, Math.ceil((max + 5) / 20) * 20)];
  }, [vs]);

  const [view, setView] = useState<View>({ span: DAY, to: null });
  const longest = Math.max(MIN_SPAN, Math.min(MAX_SPAN, range));
  const span = Math.min(Math.max(view.span, MIN_SPAN), longest);
  const to = view.to === null ? end : Math.min(end, Math.max(first + span, view.to));
  const from = to - span;
  const following = to >= end;

  /** Show `sp` long from `f`, kept inside the window; reaching the end follows the latest reading again. */
  const show = (f: number, sp: number) => {
    const s = Math.min(Math.max(sp, MIN_SPAN), longest);
    const left = Math.max(first, Math.min(f, end - s));
    setView({ span: s, to: left + s >= end - MINUTE / 2 ? null : left + s });
  };
  const live = useRef({ from, span, show });
  live.current = { from, span, show };

  const H = wide ? 210 : 170;
  const [plotRef, plotW] = useWidth<HTMLDivElement>();
  const [stripRef, stripW] = useWidth<HTMLDivElement>();
  const x = (t: number) => ((t - from) / span) * plotW;
  const y = (v: number) => ((hi - v) / (hi - lo)) * H;

  // The line, day by day for each day's zones, and the grey shading under it.
  const { area, lines } = useMemo(() => {
    if (!plotW) return { area: '', lines: [] as { date: CivilDate; d: string }[] };
    const runs = visibleRuns(ts, vs, from, to, plotW);
    const px = (p: Pt) => `${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    return {
      area: runs.map((r) => `M${x(r[0].t).toFixed(1)} ${H}L${r.map(px).join('L')}L${x(r[r.length - 1].t).toFixed(1)} ${H}Z`).join(''),
      lines: byDay(runs).map((c) => ({ date: c.date, d: `M${c.points.map(px).join('L')}` })),
    };
    // x and y follow from, span, plotW, lo, hi and H.
  }, [ts, vs, from, to, span, plotW, lo, hi, H]);

  // The days in view, for midnights, zone lines and gradients.
  const viewDays = useMemo(() => {
    const out: { date: CivilDate; start: number }[] = [];
    for (let t = Math.floor(from / DAY) * DAY; t < to; t += DAY) out.push({ date: wallDate(t), start: t });
    return out;
  }, [from, to]);

  const grid: number[] = [];
  for (let v = lo; v <= hi; v += 20) grid.push(v);

  const ticks: { t: number; label: string; midnight: boolean }[] = [];
  if (plotW) {
    const step = tickStep(span, plotW);
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
      const midnight = t % DAY === 0;
      ticks.push({ t, label: midnight ? formatCivil(wallDate(t)) : wallClock(t), midnight });
    }
  }

  // The figures above the chart: exactly what's in view.
  const a = lowerBound(ts, from);
  const b = lowerBound(ts, to);
  let low = Infinity;
  let high = -Infinity;
  let sum = 0;
  for (let i = a; i < b; i++) {
    if (vs[i] < low) low = vs[i];
    if (vs[i] > high) high = vs[i];
    sum += vs[i];
  }
  const count = b - a;
  const dates = count
    ? wallDate(ts[a]) === wallDate(ts[b - 1]) ? formatCivil(wallDate(ts[a])) : formatCivilRange(wallDate(ts[a]), wallDate(ts[b - 1]))
    : formatCivil(wallDate(from));
  const subtitle = t('vitals.heartRate.subtitle', {
    view: following ? 'now' : 'past',
    dates,
    count,
    time: wallClock(ts[ts.length - 1]),
  });
  const stats = count ? [low, Math.round(sum / count), high] : [null, null, null];

  // Hover, or a tap: the reading nearest the pointer.
  const [hoverT, setHoverT] = useState<number | null>(null);
  const hovered = useMemo(() => {
    if (hoverT === null || !ts.length) return null;
    const i = lowerBound(ts, hoverT);
    const j = i > 0 && (i === ts.length || hoverT - ts[i - 1] < ts[i] - hoverT) ? i - 1 : i;
    return Math.abs(ts[j] - hoverT) <= 3 * MINUTE && ts[j] >= from && ts[j] <= to ? j : null;
  }, [hoverT, ts, from, to]);

  // Gestures on the chart: one finger or the mouse drags, two fingers pinch.
  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<
    | { kind: 'pan'; x: number; from: number; moved: boolean }
    | { kind: 'pinch'; dist: number; span: number; at: number; k: number }
    | null
  >(null);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, e.clientX);
    if (pointers.current.size === 1) {
      gesture.current = { kind: 'pan', x: e.clientX, from, moved: false };
    } else if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      const k = ((p + q) / 2 - rect.left) / rect.width;
      gesture.current = { kind: 'pinch', dist: Math.max(10, Math.abs(p - q)), span, at: from + k * span, k };
      setHoverT(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
    const g = gesture.current;
    if (g?.kind === 'pinch' && pointers.current.size >= 2) {
      const [p, q] = [...pointers.current.values()];
      const sp = Math.min(Math.max(g.span * (g.dist / Math.max(10, Math.abs(p - q))), MIN_SPAN), longest);
      show(g.at - g.k * sp, sp);
      return;
    }
    if (g?.kind === 'pan') {
      if (Math.abs(e.clientX - g.x) > 3) {
        g.moved = true;
        setHoverT(null);
      }
      if (g.moved) show(g.from - ((e.clientX - g.x) / rect.width) * span, span);
      return;
    }
    if (e.pointerType === 'mouse') setHoverT(from + ((e.clientX - rect.left) / rect.width) * span);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    // A tap that didn't move shows the reading under it.
    if (g?.kind === 'pan' && !g.moved) {
      const rect = e.currentTarget.getBoundingClientRect();
      setHoverT(from + ((e.clientX - rect.left) / rect.width) * span);
    }
    if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      gesture.current = { kind: 'pan', x: p, from, moved: true };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  // Ctrl and the wheel (a trackpad pinch) zoom around the pointer; a sideways swipe moves.
  // Up and down stay with the page, so scrolling past the chart still scrolls.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { from: f, span: sp, show: go } = live.current;
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey) {
        e.preventDefault();
        const k = (e.clientX - rect.left) / rect.width;
        const next = sp * Math.exp(e.deltaY * 0.01);
        go(f + k * sp - k * next, next);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        go(f + (e.deltaX / rect.width) * sp, sp);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [plotRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (dt: number) => show(from + dt, span);
    const zoom = (f: number) => show(from + (span - span * f) / 2, span * f);
    const keys: Record<string, () => void> = {
      ArrowLeft: () => move(-span / 4),
      ArrowRight: () => move(span / 4),
      '+': () => zoom(0.5),
      '=': () => zoom(0.5),
      '-': () => zoom(2),
      End: () => setView({ span, to: null }),
    };
    const act = keys[e.key];
    if (act) {
      e.preventDefault();
      act();
    }
  };

  // The strip: every day in the window, hour by hour, with the view as a window to drag.
  const hours = useMemo(() => hourly(ts, vs), [ts, vs]);
  const sx = (t: number) => ((t - first) / range) * stripW;
  const sy = (v: number) => 3 + ((hi - v) / (hi - lo)) * (STRIP_H - 6);
  const mini = useMemo(() => {
    if (!stripW) return '';
    let d = '';
    hours.forEach((p, i) => {
      d += `${i === 0 || p.t - hours[i - 1].t > HOUR ? 'M' : 'L'}${sx(p.t).toFixed(1)} ${sy(p.v).toFixed(1)}`;
    });
    return d;
  }, [hours, stripW, first, range, lo, hi]);
  const stripDays = useMemo(() => {
    if (!stripW) return [];
    const every = [1, 2, 7, 14].find((n) => ((n * DAY) / range) * stripW >= 56) ?? 28;
    const out: { t: number; label: string }[] = [];
    const lastMidnight = Math.floor((end - 1) / DAY) * DAY;
    for (let t = lastMidnight, n = 0; t > first; t -= DAY, n++) {
      // A date needs room to its right, or it would run off the strip.
      if (n % every === 0 && sx(t) + 44 <= stripW) out.push({ t, label: formatCivil(wallDate(t)) });
    }
    return out;
  }, [stripW, first, end, range]);
  const winL = sx(from);
  const winW = Math.max(8, sx(to) - sx(from));
  const strip = useRef<{ mode: 'move' | 'left' | 'right'; x: number; from: number; to: number } | null>(null);
  const onStripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const handles = winW > 28;
    let mode: 'move' | 'left' | 'right' = 'move';
    let f = from;
    if (handles && Math.abs(px - winL) <= 10) mode = 'left';
    else if (handles && Math.abs(px - (winL + winW)) <= 10) mode = 'right';
    else if (px < winL || px > winL + winW) {
      f = Math.max(first, Math.min(end - span, first + (px / rect.width) * range - span / 2));
      show(f, span);
    }
    strip.current = { mode, x: e.clientX, from: f, to: f + span };
  };
  const onStripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = strip.current;
    if (!s) return;
    const dt = ((e.clientX - s.x) / e.currentTarget.getBoundingClientRect().width) * range;
    if (s.mode === 'move') show(s.from + dt, s.to - s.from);
    else if (s.mode === 'left') show(s.from + dt, s.to - (s.from + dt));
    else show(s.from, s.to + dt - s.from);
  };
  const onStripUp = () => {
    strip.current = null;
  };

  const lastZones = zonesFor(wallDate(to - 1));
  const guides = hasZones;
  const multiDay = viewDays.length > 1;
  const hover = hovered === null ? null : {
    left: x(ts[hovered]),
    top: y(vs[hovered]),
    zones: zonesFor(wallDate(ts[hovered])),
    v: vs[hovered],
    t: ts[hovered],
  };

  const stat = (label: string, v: number | null) => (
    <div>
      <dt className="text-eyebrow-sm uppercase text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-display text-number-xs text-zinc-50 tabular-nums">
        {v ?? '—'} <span className="font-sans text-caption font-medium text-zinc-500">{t('units.bpm')}</span>
      </dd>
    </div>
  );

  return (
    <Card className={className}>
      <div className="px-5 pt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h3 className="font-display text-title-sm text-zinc-100 flex items-center gap-2">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${DOMAIN.cardio.bg} ring-2 ${DOMAIN.cardio.ring}`} />
            {t('vitals.heartRate.title')}
          </h3>
          <p className="text-caption text-zinc-500 mt-1.5 tabular-nums">{subtitle}</p>
        </div>
        {/* Spread across a phone; side by side beside the title on wider screens. */}
        <dl className="w-full md:w-auto flex justify-between md:grid md:grid-cols-3 md:gap-6">
          {stat(t('vitals.heartRate.stats.lowest'), stats[0])}
          {stat(t('vitals.heartRate.stats.average'), stats[1])}
          {stat(t('vitals.heartRate.stats.highest'), stats[2])}
        </dl>
      </div>

      <div className="px-5 pt-3.5 flex flex-wrap items-center gap-2.5">
        <div role="group" aria-label={t('vitals.heartRate.zoom.label')} className="inline-flex bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5">
          {SPANS.filter((o) => o.ms <= longest).map((o) => {
            const on = Math.abs(span - o.ms) < MINUTE;
            return (
              <button
                key={o.label}
                type="button"
                aria-pressed={on}
                onClick={() => (following ? show(end - o.ms, o.ms) : show(from + span / 2 - o.ms / 2, o.ms))}
                className={`min-h-9 md:min-h-0 px-2.5 py-1 rounded-[6px] text-caption font-medium transition-colors ${on ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {t(o.label)}
              </button>
            );
          })}
        </div>
        {!following && (
          <button
            type="button"
            onClick={() => setView({ span, to: null })}
            className="min-h-9 md:min-h-0 px-2.5 py-1 rounded-lg border border-zinc-800 text-caption font-medium text-zinc-300 hover:bg-zinc-900 transition-colors"
          >
            {t('vitals.heartRate.backToNow')}
          </button>
        )}
      </div>

      <div className={`pt-4 pl-12 md:pl-[52px] ${guides ? 'pr-10 md:pr-12' : 'pr-5'}`}>
        <div
          ref={plotRef}
          role="img"
          tabIndex={0}
          aria-label={t('vitals.heartRate.chart', { summary: subtitle, count, lowest: stats[0], average: stats[1], highest: stats[2] })}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && !gesture.current) setHoverT(null);
          }}
          className="relative touch-pan-y select-none cursor-grab active:cursor-grabbing rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-600"
          style={{ height: H }}
        >
          {grid.map((v) => (
            <span
              key={v}
              aria-hidden="true"
              className="absolute -left-10 w-7 -translate-y-1/2 text-right text-note leading-none text-zinc-500 tabular-nums"
              style={{ top: y(v) }}
            >
              {v}
            </span>
          ))}
          {guides && lastZones && zoneStarts(lastZones).map((bpm, k) => (bpm > lo && bpm < hi ? (
            <span
              key={k}
              aria-hidden="true"
              className="absolute -right-9 w-7 -translate-y-1/2 text-note leading-none tabular-nums"
              style={{ top: y(bpm), color: ZONE_COLORS[k + 1] }}
            >
              {bpm}
            </span>
          ) : null))}

          {plotW > 0 && (
            <svg width={plotW} height={H} className="absolute inset-0 overflow-visible" aria-hidden="true">
              <defs>
                <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#a1a1aa" stopOpacity={0.3} />
                  <stop offset="1" stopColor="#a1a1aa" stopOpacity={0} />
                </linearGradient>
                {[...new Set([...viewDays.map((d) => d.date), ...lines.map((l) => l.date)])].map((date) => (
                  <linearGradient key={date} id={`${uid}-${date}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
                    {zoneStops(zonesFor(date), lo, hi, ZONE_COLORS, DOMAIN.cardio.hex).map((s, i) => (
                      <stop key={i} offset={s.offset} stopColor={s.color} />
                    ))}
                  </linearGradient>
                ))}
              </defs>

              {grid.map((v) => (
                <line key={v} x1={0} x2={plotW} y1={y(v)} y2={y(v)} stroke="#27272a" strokeDasharray="2 4" />
              ))}
              {viewDays.filter((d) => d.start > from).map((d) => (
                <line key={d.date} x1={x(d.start)} x2={x(d.start)} y1={0} y2={H} stroke="#3f3f46" />
              ))}
              {/* Where each zone starts that day, faint, in the zone's colour. */}
              {guides && viewDays.map((d) => {
                const z = zonesFor(d.date);
                if (!z) return null;
                const x0 = Math.max(0, x(d.start));
                const x1 = Math.min(plotW, x(d.start + DAY));
                return zoneStarts(z).map((bpm, k) => (bpm > lo && bpm < hi ? (
                  <line
                    key={`${d.date}-${k}`} x1={x0} x2={x1} y1={y(bpm)} y2={y(bpm)}
                    stroke={ZONE_COLORS[k + 1]} strokeOpacity={0.45} strokeDasharray="3 3"
                  />
                ) : null));
              })}

              <path d={area} fill={`url(#${uid}-area)`} />
              {lines.map((l, i) => (
                <path key={i} d={l.d} fill="none" stroke={`url(#${uid}-${l.date})`} strokeWidth={1} strokeLinejoin="round" strokeLinecap="round" />
              ))}

              {hover && (
                <>
                  <line x1={hover.left} x2={hover.left} y1={0} y2={H} stroke="#52525b" strokeDasharray="3 3" />
                  <circle
                    cx={hover.left} cy={hover.top} r={4} stroke="#18181b" strokeWidth={2}
                    fill={hover.zones ? ZONE_COLORS[zoneOf(hover.v, hover.zones)] : DOMAIN.cardio.hex}
                  />
                </>
              )}
            </svg>
          )}

          {hover && (
            <div
              aria-hidden="true"
              className="absolute -top-2 -translate-x-1/2 -translate-y-full px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-caption text-zinc-200 whitespace-nowrap tabular-nums pointer-events-none"
              style={{ left: Math.min(plotW - 70, Math.max(70, hover.left)) }}
            >
              {t('vitals.heartRate.tooltip', {
                span: multiDay ? 'days' : 'day',
                zoned: hover.zones ? 'yes' : 'no',
                date: formatCivil(wallDate(hover.t)),
                time: wallClock(hover.t),
                bpm: hover.v,
                zone: hover.zones ? t(ZONE_NAMES[zoneOf(hover.v, hover.zones)]) : undefined,
              })}
            </div>
          )}
        </div>

        <div aria-hidden="true" className="relative h-[18px] mt-1.5">
          {ticks.map((t) => (
            <span
              key={t.t}
              className={`absolute -translate-x-1/2 whitespace-nowrap text-note tabular-nums ${t.midnight ? 'font-semibold text-zinc-300' : 'text-zinc-500'}`}
              style={{ left: x(t.t) }}
            >
              {t.label}
            </span>
          ))}
        </div>

        <div
          ref={stripRef}
          onPointerDown={onStripDown}
          onPointerMove={onStripMove}
          onPointerUp={onStripUp}
          onPointerCancel={onStripUp}
          className="relative mt-2 touch-pan-y select-none cursor-grab rounded-md bg-[#0c0c0e]"
          style={{ height: STRIP_H }}
        >
          {stripW > 0 && (
            <svg width={stripW} height={STRIP_H} className="absolute inset-0" aria-hidden="true">
              {stripDays.map((d) => (
                <line key={d.t} x1={sx(d.t)} x2={sx(d.t)} y1={0} y2={STRIP_H} stroke="#27272a" />
              ))}
              <path d={mini} fill="none" stroke="#71717a" strokeWidth={1} />
            </svg>
          )}
          {stripDays.map((d) => (
            <span key={d.t} aria-hidden="true" className="absolute top-[3px] pl-1 text-micro leading-none text-zinc-500 whitespace-nowrap" style={{ left: sx(d.t) }}>
              {d.label}
            </span>
          ))}
          <div aria-hidden="true" className="absolute inset-y-0 left-0 rounded-l-md bg-black/60" style={{ width: winL }} />
          <div aria-hidden="true" className="absolute inset-y-0 right-0 rounded-r-md bg-black/60" style={{ width: Math.max(0, stripW - winL - winW) }} />
          <div aria-hidden="true" className="absolute -inset-y-px rounded-md border border-zinc-400" style={{ left: winL, width: winW }}>
            {winW > 28 && (
              <>
                <span className="absolute -left-1 top-1/2 h-[18px] w-1.5 -translate-y-1/2 rounded-full bg-zinc-200" />
                <span className="absolute -right-1 top-1/2 h-[18px] w-1.5 -translate-y-1/2 rounded-full bg-zinc-200" />
              </>
            )}
          </div>
        </div>
      </div>

      {hasZones && (
        <div className="px-5 pt-3.5 pb-4">
          <ul className="flex flex-wrap gap-x-[18px] gap-y-1.5">
            {ZONE_NAMES.map((name, k) => (
              <li key={name} className="flex items-center gap-1.5 text-caption text-zinc-300">
                <span className="size-2 rounded-full" style={{ background: ZONE_COLORS[k] }} />
                {t(name)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-caption text-zinc-500">{t('vitals.heartRate.zonesSource')}</p>
        </div>
      )}
      {!hasZones && <div className="pb-4" />}
    </Card>
  );
}
