import React from 'react';
import { type Band, type Comparison, stats, type Point } from '../pipeline/derive';

/**
 * Design tokens and primitives.
 *
 * One rule drives the whole visual system: **colour encodes domain, never
 * decoration.** Movement is emerald, sleep is indigo, heart is rose, body is teal,
 * data-quality is amber. A number's colour tells you which part of your life it
 * describes, so the eye can navigate a dense screen without reading every label.
 *
 * Good/bad is carried by the *delta*, not by the metric's colour — otherwise a
 * green resting heart rate and a green step count would mean opposite things.
 */

export const DOMAIN = {
  movement: { text: 'text-emerald-400', bg: 'bg-emerald-500/10', ring: 'ring-emerald-500/25', hex: '#34d399', dim: '#065f46' },
  sleep: { text: 'text-indigo-400', bg: 'bg-indigo-500/10', ring: 'ring-indigo-500/25', hex: '#818cf8', dim: '#3730a3' },
  cardio: { text: 'text-rose-400', bg: 'bg-rose-500/10', ring: 'ring-rose-500/25', hex: '#fb7185', dim: '#881337' },
  body: { text: 'text-teal-300', bg: 'bg-teal-500/10', ring: 'ring-teal-500/25', hex: '#5eead4', dim: '#115e59' },
  data: { text: 'text-amber-400', bg: 'bg-amber-500/10', ring: 'ring-amber-500/25', hex: '#fbbf24', dim: '#78350f' },
  wellbeing: { text: 'text-violet-400', bg: 'bg-violet-500/10', ring: 'ring-violet-500/25', hex: '#a78bfa', dim: '#4c1d95' },
} as const;

export type DomainKey = keyof typeof DOMAIN;

export const AXIS = '#52525b';
export const GRID = '#27272a';

// ────────────────────────────────────────────────────────────────── layout

export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: React.ReactNode;
  className?: string;
  as?: any;
}) {
  return (
    <Tag className={`bg-zinc-900/70 border border-zinc-800 rounded-2xl ${className}`}>{children}</Tag>
  );
}

export function CardHead({
  title,
  hint,
  right,
  domain,
}: {
  title: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  domain?: DomainKey;
}) {
  return (
    <div className="px-5 pt-4 pb-3">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-[13px] font-semibold text-zinc-100 tracking-tight flex items-center gap-2 min-w-0">
          {domain && <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${DOMAIN[domain].bg} ring-2 ${DOMAIN[domain].ring}`} />}
          <span className="truncate">{title}</span>
        </h3>
        {right && <div className="shrink-0 text-[11px] text-zinc-500">{right}</div>}
      </div>
      {hint && <div className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">{hint}</div>}
    </div>
  );
}

export const Label = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span className={`text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500 ${className}`}>
    {children}
  </span>
);

// ─────────────────────────────────────────────────────────────────── values

/**
 * The em-dash is load-bearing. A metric with no observation shows "—", never 0,
 * and never last week's number silently carried forward.
 */
export function Value({
  value,
  unit,
  size = 'md',
  tone = 'text-zinc-50',
  digits = 0,
}: {
  value: number | string | null | undefined;
  unit?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: string;
  digits?: number;
}) {
  const cls = {
    sm: 'text-base',
    md: 'text-2xl',
    lg: 'text-[32px]',
    xl: 'text-[44px]',
  }[size];
  const shown =
    value === null || value === undefined || value === ''
      ? '—'
      : typeof value === 'number'
        ? value.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
        : value;
  const missing = shown === '—';
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className={`${cls} font-semibold tracking-tight ${missing ? 'text-zinc-600' : tone}`}>
        {shown}
      </span>
      {unit && !missing && <span className="text-[11px] font-medium text-zinc-500">{unit}</span>}
    </span>
  );
}

const BAND_COPY: Record<Band, { label: string; cls: string }> = {
  'far-below': { label: 'well below usual', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/20' },
  below: { label: 'below usual', cls: 'text-sky-300/90 bg-sky-500/[0.07] border-sky-500/15' },
  typical: { label: 'in your usual range', cls: 'text-zinc-400 bg-zinc-800/60 border-zinc-700/60' },
  above: { label: 'above usual', cls: 'text-amber-300/90 bg-amber-500/[0.07] border-amber-500/15' },
  'far-above': { label: 'well above usual', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
};

/**
 * Where the latest reading sits against its own 28-day history. Deliberately
 * says "above usual" rather than "good" — for HRV that's good, for resting heart
 * rate it isn't, and the app shouldn't pretend to know which you want.
 *
 * `partial` marks a day still in progress: half a day's steps against whole
 * days always reads "below usual", so it gets no verdict yet.
 */
export function BandPill({ c, invert = false, partial = false }: { c: Comparison; invert?: boolean; partial?: boolean }) {
  if (partial) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500">so far today</span>
    );
  }
  if (!c.band || c.n < 8) {
    return (
      <span className="text-[10px] px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500">
        {c.n === 0 ? 'no history' : `baseline needs ${8 - c.n} more days`}
      </span>
    );
  }
  const copy = BAND_COPY[c.band];
  return (
    <span
      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${copy.cls}`}
      title={
        `latest ${fmtNum(c.value)} · 28-day typical ${fmtNum(c.baseline)} ± ${fmtNum(c.spread)}` +
        ` · z=${c.z?.toFixed(2)} · from ${c.n} days`
      }
    >
      {copy.label}
    </span>
  );
}

/** Signed change, with the caller declaring which direction is welcome. */
export function Delta({
  value,
  unit = '',
  goodWhen = 'up',
  digits = 1,
  suffix,
}: {
  value: number | null;
  unit?: string;
  goodWhen?: 'up' | 'down' | 'neither';
  digits?: number;
  suffix?: string;
}) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-[11px] text-zinc-600">no comparison</span>;
  }
  const up = value > 0;
  const good = goodWhen === 'neither' ? null : goodWhen === 'up' ? up : !up;
  const tone =
    Math.abs(value) < 1e-9
      ? 'text-zinc-500'
      : good === null
        ? 'text-zinc-400'
        : good
          ? 'text-emerald-400'
          : 'text-rose-400';
  return (
    <span className={`text-[11px] font-medium tabular-nums ${tone}`}>
      {up ? '↑' : value < 0 ? '↓' : ''} {Math.abs(value).toFixed(digits)}
      {unit}
      {suffix ? <span className="text-zinc-500 font-normal"> {suffix}</span> : null}
    </span>
  );
}

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString('en-GB');

export const fmtDuration = (mins: number | null | undefined) => {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return '—';
  const sign = mins < 0 ? '−' : '';
  const m = Math.abs(Math.round(mins));
  return `${sign}${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

// ────────────────────────────────────────────────────────────────── states

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-[13px] text-zinc-300 font-medium">{title}</p>
      {detail && <p className="text-[11.5px] text-zinc-500 mt-1.5 max-w-sm mx-auto leading-relaxed">{detail}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div className="inline-flex bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`${size === 'sm' ? 'px-2 py-[3px] text-[10px]' : 'px-2.5 py-1 text-[11px]'} rounded-[6px] font-medium transition-colors ${
            value === o.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Thin progress bar for goal-shaped metrics. */
export function Meter({ pct, color, className = '' }: { pct: number | null; color: string; className?: string }) {
  const w = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className={`h-1 rounded-full bg-zinc-800 overflow-hidden ${className}`}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode; key?: React.Key }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-zinc-800/60 last:border-0">
      <span className="text-[11.5px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-200 tabular-nums text-right">{children}</span>
    </div>
  );
}

export function NavButton({
  active,
  onClick,
  icon,
  label,
  color,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-xl text-[11px] font-medium transition-all ${
        active 
          ? 'bg-zinc-800 text-white' 
          : `hover:bg-zinc-800/50 ${color || 'text-zinc-400 hover:text-zinc-200'}`
      }`}
    >
      {icon && <span className={active ? color || 'text-zinc-200' : 'opacity-70'}>{icon}</span>}
      {label}
    </button>
  );
}

export function CardSummary({ 
  data,
  vals, // For backwards compatibility during transition
  color, 
  unit = '', 
  digits = 1,
  format,
  showMean = true,
  isSleep = false
}: { 
  data?: Point[] | number[];
  vals?: number[];
  color: string; 
  unit?: string; 
  digits?: number;
  format?: (v: number) => string;
  showMean?: boolean;
  isSleep?: boolean;
}) {
  const source = data || vals;
  if (!source || source.length === 0) return null;
  
  const isPoints = typeof source[0] === 'object' && source[0] !== null;
  const numbers = isPoints 
    ? (source as Point[]).map(p => p.value).filter((v): v is number => v !== null)
    : (source as number[]).filter((v): v is number => v !== null);
    
  const latestDate = isPoints 
    ? (source as Point[]).filter(p => p.value !== null).pop()?.date
    : undefined;
  // Span series end on the user's today, so the latest reading is today's when it sits on the last day.
  const lastDate = isPoints ? (source as Point[])[source.length - 1].date : undefined;

  const st = stats(numbers);
  const latest = numbers.length > 0 ? numbers[numbers.length - 1] : null;
  if (!st || latest === null) return null;
  
  const unitStr = unit ? ` ${unit}` : '';
  const fmt = format || ((v: number) => fmtNum(v, digits));
  
  const isToday = latestDate !== undefined && latestDate === lastDate;
  const latestLabel = isToday ? (isSleep ? 'last night: ' : 'today: ') : 'latest: ';
  
  return (
    <div className="flex items-center gap-3 text-[11px] font-medium leading-tight justify-end">
      {showMean && (
        <div>
          <span className="text-zinc-500">avg: </span>
          <span style={{ color }}>{fmt(st.mean)}</span>
          <span className="text-zinc-500">{unitStr}</span>
        </div>
      )}
      <div>
        <span className="text-zinc-500">{latestLabel}</span>
        <span style={{ color }}>{fmt(latest)}</span>
        <span className="text-zinc-500">{unitStr}</span>
      </div>
    </div>
  );
}

