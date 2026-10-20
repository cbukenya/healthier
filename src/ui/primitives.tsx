import React, { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { BASELINE_DAYS, BASELINE_MIN_READINGS, type Band, type Comparison, stats, type Point } from '../pipeline/derive';
import { t, type MessageKey, type Values } from '../i18n';
import { rich } from '../i18n/react';
import { durationPieces, formatDuration, formatFixed, formatNumber, formatRounded } from '../i18n/format';

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
 *
 * Each domain's classes come from Tailwind's palette; its `hex` is the colour its charts
 * and figures draw in, a variable from src/theme.css.
 */

export const DOMAIN = {
  movement: { text: 'text-emerald-400', hex: 'var(--emerald-400)' },
  sleep: { text: 'text-indigo-400', hex: 'var(--indigo-400)' },
  cardio: { text: 'text-rose-400', hex: 'var(--rose-400)' },
  body: { text: 'text-teal-300', hex: 'var(--teal-300)' },
  data: { text: 'text-amber-400', hex: 'var(--amber-400)' },
  wellbeing: { text: 'text-violet-400', hex: 'var(--violet-400)' },
  cycle: { text: 'text-pink-400', hex: 'var(--pink-400)' },
} as const;

/**
 * Effort, from light to peak: the body battery's colours the other way up (charged green for an
 * easy minute, drained rose for a peak one). The heart rate zones and the intensity mix share
 * them, so Light, Moderate and Vigorous look the same on both.
 */
export const EFFORT = {
  light: 'var(--emerald-500)',
  moderate: 'var(--lime-300)',
  vigorous: 'var(--amber-500)',
  peak: 'var(--rose-500)',
} as const;

/** A colour at a share of its strength, over whatever is behind it: tint('var(--rose-500)', 30). */
export const tint = (colour: string, percent: number) => `color-mix(in srgb, ${colour} ${percent}%, transparent)`;

export const AXIS = 'var(--color-zinc-600)';
export const GRID = 'var(--color-zinc-800)';

// ────────────────────────────────────────────────────────────────── layout

export function Card({
  children,
  className = '',
  as: Tag = 'section',
  label,
}: {
  children: React.ReactNode;
  className?: string;
  as?: any;
  /** A name for the card when nothing in it names it. */
  label?: string;
}) {
  return (
    <Tag aria-label={label} className={`bg-card border border-card-edge rounded-2xl ${className}`}>{children}</Tag>
  );
}

export function CardHead({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="px-5 pt-4 pb-3">
      {/* A summary that doesn't fit beside the title moves under it, rather than cutting the title short. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <h3 className="card-title-detail text-zinc-50 min-w-0 truncate">{title}</h3>
        {right && <div className="shrink-0 text-caption text-zinc-500">{right}</div>}
      </div>
      {hint && <div className="text-caption text-zinc-500 mt-1.5 leading-relaxed">{hint}</div>}
    </div>
  );
}

export const Label = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <span className={`text-eyebrow uppercase text-zinc-500 ${className}`}>
    {children}
  </span>
);

/**
 * What a score was reached from, under "Contributors" wherever a score lists them. From md up the
 * list always shows under the heading, styled to its card by `heading`; on a phone it folds under
 * the same eyebrow with an arrow on the right, the way Labs folds "How it works", closed until tapped.
 */
export function Contributors({
  heading = 'text-eyebrow uppercase text-zinc-500 mb-1',
  children,
}: {
  heading?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="md:hidden w-full cursor-pointer flex items-center justify-between min-h-11 border-t border-zinc-800/80 text-eyebrow uppercase text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        {t('ui.contributors')}
        <ChevronDown size={14} aria-hidden className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className={`hidden md:block ${heading}`}>{t('ui.contributors')}</div>
      <div id={id} className={open ? undefined : 'hidden md:block'}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── values

/** How the h and m of a duration in a big figure are set: small and grey, like "steps". */
export const DURATION_UNIT = 'font-sans text-unit font-medium text-zinc-400';

/**
 * A duration such as "5h 32m" with its h and m set as units, the way "steps" sits beside
 * a step count. Anything else comes back as it was.
 */
export function withUnits(shown: string, unitClass: string): React.ReactNode {
  const pieces = durationPieces(shown);
  if (!pieces) return shown;
  return <>{pieces.map((p, i) => (p.unit ? <span key={i} className={unitClass}>{p.text}</span> : p.text))}</>;
}

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
    sm: 'text-number-xs',
    md: 'text-number',
    lg: 'text-number-lg leading-normal',
    xl: 'text-number-xl leading-normal',
  }[size];
  const shown =
    value === null || value === undefined || value === ''
      ? '—'
      : typeof value === 'number'
        ? formatNumber(value, digits)
        : value;
  const missing = shown === '—';
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <span className={`font-display ${cls} ${missing ? 'text-zinc-600' : tone}`}>
        {withUnits(shown, DURATION_UNIT)}
      </span>
      {unit && !missing && <span className="text-caption font-medium text-zinc-500">{unit}</span>}
    </span>
  );
}

const BAND_COPY: Record<Band, { label: MessageKey; cls: string }> = {
  'far-below': { label: 'ui.band.farBelow', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/20' },
  below: { label: 'ui.band.below', cls: 'text-sky-300/90 bg-sky-500/[0.07] border-sky-500/15' },
  typical: { label: 'ui.band.typical', cls: 'text-zinc-400 bg-zinc-800/60 border-zinc-700/60' },
  above: { label: 'ui.band.above', cls: 'text-amber-300/90 bg-amber-500/[0.07] border-amber-500/15' },
  'far-above': { label: 'ui.band.farAbove', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
};

/**
 * Where the latest reading sits against its own 28-day history. Deliberately
 * says "above usual" rather than "good" — for HRV that's good, for resting heart
 * rate it isn't, and the app shouldn't pretend to know which you want.
 *
 * `partial` marks a day still in progress: half a day's steps against whole
 * days always reads "below usual", so it gets no verdict yet.
 *
 * `cycle` is the same reading judged with cycle tracking on (see cycleAdjusted): when it's
 * inside the usual range there, the pill says the reading is usual for this part of the cycle
 * instead of calling it unusual. The numbers shown stay the real ones.
 */
export function BandPill({
  c, invert = false, partial = false, cycle = null,
}: { c: Comparison; invert?: boolean; partial?: boolean; cycle?: Comparison | null }) {
  if (partial) {
    return (
      <span className="text-note px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500">{t('ui.band.soFarToday')}</span>
    );
  }
  // A night from another device with too few of its own to judge against: shown, without a verdict.
  if (c.source !== undefined && (!c.band || c.n < BASELINE_MIN_READINGS)) return null;
  if (!c.band || c.n < BASELINE_MIN_READINGS) {
    return (
      <span className="text-note px-2 py-0.5 rounded-full border border-zinc-800 text-zinc-500">
        {c.n === 0 ? t('ui.band.noHistory') : t('ui.band.needsDays', { count: BASELINE_MIN_READINGS - c.n })}
      </span>
    );
  }
  const copy = c.band !== 'typical' && cycle?.band === 'typical' && cycle.date === c.date
    ? { label: 'ui.band.cycle' as const, cls: 'text-pink-300/90 bg-pink-500/[0.07] border-pink-500/15' }
    : BAND_COPY[c.band];
  return (
    <span
      className={`text-note px-2 py-0.5 rounded-full border font-medium ${copy.cls}`}
      title={t('ui.band.detail', {
        value: fmtNum(c.value),
        days: BASELINE_DAYS,
        baseline: fmtNum(c.baseline),
        spread: fmtNum(c.spread),
        z: c.z === null ? undefined : formatFixed(c.z, 2),
        count: c.n,
      })}
    >
      {t(copy.label)}
    </span>
  );
}

/**
 * Signed change, with the caller declaring which direction is welcome. `phrase` says it in a
 * sentence: a message with the change as {change} and the words after it set muted,
 * "{change}<muted> vs the week before</muted>", so a language can put them in its own order.
 */
export function Delta({
  value,
  unit = '',
  goodWhen = 'up',
  digits = 1,
  phrase,
  values,
}: {
  value: number | null;
  unit?: string;
  goodWhen?: 'up' | 'down' | 'neither';
  digits?: number;
  phrase?: MessageKey;
  values?: Values;
}) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-caption text-zinc-600">{t('ui.delta.none')}</span>;
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
  const change = (
    <>
      {up ? '↑' : value < 0 ? '↓' : ''} {formatNumber(Math.abs(value), digits)}
      {unit}
    </>
  );
  return (
    <span className={`text-caption font-medium tabular-nums ${tone}`}>
      {phrase ? rich(phrase, { ...values, change, muted: (w) => <span className="text-zinc-500 font-normal">{w}</span> }) : change}
    </span>
  );
}

export const fmtNum = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : formatRounded(v, digits);

export const fmtDuration = (mins: number | null | undefined) =>
  mins === null || mins === undefined || !Number.isFinite(mins) ? '—' : formatDuration(mins);

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
      <p className="text-body-sm text-zinc-300 font-medium">{title}</p>
      {detail && <p className="text-caption text-zinc-500 mt-1.5 max-w-sm mx-auto leading-relaxed">{detail}</p>}
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
          className={`${size === 'sm' ? 'px-2 py-[3px] text-note' : 'px-2.5 py-1 text-caption'} rounded-[6px] font-medium transition-colors ${
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

/** A label and its value on one line; `dense` packs rows tight, without dividers, for small tiles. */
export function Row({ label, children, dense = false }: { label: string; children: React.ReactNode; dense?: boolean; key?: React.Key }) {
  return (
    <div className={`flex items-baseline justify-between ${dense ? 'gap-3 py-0.5' : 'gap-4 py-2 border-b border-zinc-800/60 last:border-0'}`}>
      <span className="text-caption text-zinc-500">{label}</span>
      <span className="text-detail text-zinc-200 tabular-nums text-right">{children}</span>
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
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      // Phones fit every section in one row of finger-sized icons and name only the open one.
      className={`shrink-0 flex items-center justify-center gap-1.5 md:gap-2 h-10 md:h-auto ${active ? 'px-3' : 'w-[38px] md:w-auto'} md:px-3 md:py-1.5 rounded-xl text-body-sm md:text-caption font-medium transition-all ${
        active 
          ? 'bg-zinc-800 text-white' 
          : `hover:bg-zinc-800/50 ${color || 'text-zinc-400 hover:text-zinc-200'}`
      }`}
    >
      {icon && (
        <span className={`flex ${active ? `[&>svg]:size-4 ${color || 'text-zinc-200'}` : '[&>svg]:size-[18px] md:opacity-70'} md:[&>svg]:size-3.5`}>
          {icon}
        </span>
      )}
      <span className={active ? '' : 'hidden md:inline'}>{label}</span>
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
  const latestLabel = t(isToday ? (isSleep ? 'ui.summary.lastNight' : 'ui.summary.today') : 'ui.summary.latest');
  
  return (
    <div className="flex items-center gap-3 text-caption font-medium leading-tight justify-end">
      {showMean && (
        <div>
          <span className="text-zinc-500">{t('ui.summary.average')} </span>
          <span style={{ color }}>{fmt(st.mean)}</span>
          <span className="text-zinc-500">{unitStr}</span>
        </div>
      )}
      <div>
        <span className="text-zinc-500">{latestLabel} </span>
        <span style={{ color }}>{fmt(latest)}</span>
        <span className="text-zinc-500">{unitStr}</span>
      </div>
    </div>
  );
}

