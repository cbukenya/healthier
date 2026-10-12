import React, { useId, useState } from 'react';
import { BATTERY_TIERS, batteryTier, type Readiness, type ReadinessPart } from '../pipeline/derive';

interface BodyBatteryProps {
  /** Null when readiness can't be computed yet (too little history). */
  score: number | null;
  parts: Readiness['parts'];
  confidence: Readiness['confidence'];
  label: string;
  missing: string[];
  calibrating: string[];
  className?: string;
}

/** One colour per tier; the thresholds themselves live in BATTERY_TIERS. */
export const TIER_STYLE: Record<(typeof BATTERY_TIERS)[number]['tag'], { text: string; hex: string; name: string }> = {
  CHARGED: { text: 'text-emerald-500', hex: '#10b981', name: 'Charged' },
  BALANCED: { text: 'text-lime-300', hex: '#bef264', name: 'Balanced' },
  LOW: { text: 'text-amber-500', hex: '#f59e0b', name: 'Low' },
  DRAINED: { text: 'text-rose-500', hex: '#f43f5e', name: 'Drained' },
};

const list = (items: string[], joiner: string) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`;

/** A tier's top score: the next tier's floor less one. */
const tierMax = (i: number) => (i === 0 ? 100 : BATTERY_TIERS[i - 1].min - 1);

/** The tag, its colour and the line saying what the score stands on; shared by both layouts. */
function batteryText({ score, confidence, missing, calibrating }: Pick<BodyBatteryProps, 'score' | 'confidence' | 'missing' | 'calibrating'>) {
  // Too little data is not the same as being drained.
  const tier = score === null ? null : batteryTier(score);
  const basis = [
    score !== null ? `${confidence[0].toUpperCase()}${confidence.slice(1)} confidence` : null,
    missing.length && score !== null ? `no ${list(missing, 'or')} last night` : null,
    calibrating.length ? `${list(calibrating, 'and')} calibrating to a new device` : null,
  ].filter(Boolean).join(' · ');
  return {
    tier,
    tag: tier ? `[${tier.tag}]` : '[NO DATA]',
    color: tier ? TIER_STYLE[tier.tag].text : 'text-zinc-500',
    basis,
  };
}

const TOP = 9;
const BOTTOM = 462;
const yOf = (level: number) => BOTTOM - (level / 100) * (BOTTOM - TOP);

function BodyShape() {
  return (
    <>
      <circle cx="120" cy="36" r="27"/>
      <rect x="107" y="54" width="26" height="24" rx="9"/>
      <path d="M84,90 C84,77 95,72 104,72 L136,72 C145,72 156,77 156,90 L152,184 C151,198 155,212 156,230 C157,250 146,260 120,260 C94,260 83,250 84,230 C85,212 89,198 88,184 Z"/>
      <rect x="69"  y="79" width="18" height="192" rx="9"   transform="rotate(10 78 87)"/>
      <rect x="153" y="79" width="18" height="192" rx="9"   transform="rotate(-10 162 87)"/>
      <rect x="88"  y="238" width="27" height="214" rx="13" transform="rotate(2 101 246)"/>
      <rect x="125" y="238" width="27" height="214" rx="13" transform="rotate(-2 139 246)"/>
      <rect x="68"  y="446" width="44" height="16" rx="8" transform="rotate(-5 106 454)"/>
      <rect x="128" y="446" width="44" height="16" rx="8" transform="rotate(5 134 454)"/>
    </>
  );
}

/**
 * The figure filled to the score, with the stages as a rail beside it, each band at its true
 * height and the current one lit. `labelled` names each stage and its range; the small phone
 * figure leaves that to the text beside it and draws the rail heavier to stay legible.
 */
function BatteryFigure({ score, labelled, className }: { score: number | null; labelled: boolean; className?: string }) {
  // Both layouts are in the page at once, so their gradient and clip ids must not collide.
  const id = useId().replace(/[^\w-]/g, '');
  const tier = score === null ? null : batteryTier(score);
  const level = score ?? 0;
  const fillY = yOf(level);
  const fillHeight = (level / 100) * (BOTTOM - TOP);
  // The figure's gradient: each stage's colour at the middle of its band, blending across the thresholds.
  const gradientStops = BATTERY_TIERS.map((t, i) => ({
    tag: t.tag,
    offset: (t.min + (i === 0 ? 100 : BATTERY_TIERS[i - 1].min)) / 200,
  })).reverse();
  const rail = labelled ? { x: 240, width: 8, tickX: 235, tickWidth: 18, tickHeight: 3 } : { x: 236, width: 12, tickX: 229, tickWidth: 26, tickHeight: 5 };

  return (
    <svg
      viewBox={labelled ? '0 0 470 480' : '16 0 250 480'}
      role="img"
      aria-label={tier ? `Body battery at ${score}, in the ${TIER_STYLE[tier.tag].name} stage` : 'Body battery, no score yet'}
      className={className}
    >
      <defs>
        <linearGradient id={`${id}-charge`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor={TIER_STYLE.DRAINED.hex}/>
          {gradientStops.map((s) => <stop key={s.tag} offset={s.offset} stopColor={TIER_STYLE[s.tag].hex}/>)}
          <stop offset="1" stopColor={TIER_STYLE.CHARGED.hex}/>
        </linearGradient>

        <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="8"/>
        </filter>

        <clipPath id={`${id}-body`}>
          <BodyShape />
        </clipPath>

        <clipPath id={`${id}-level`}>
          <rect x="20" y={fillY} width="200" height={fillHeight}/>
        </clipPath>
      </defs>

      <g filter={`url(#${id}-glow)`} opacity="0.4">
        <g clipPath={`url(#${id}-body)`}>
          <g clipPath={`url(#${id}-level)`}>
            <rect x="20" y="9" width="200" height="453" fill={`url(#${id}-charge)`}/>
          </g>
        </g>
      </g>

      <g fill="#1b1b1f">
        <BodyShape />
      </g>

      <g clipPath={`url(#${id}-body)`}>
        <g clipPath={`url(#${id}-level)`}>
          <rect x="20" y="9" width="200" height="453" fill={`url(#${id}-charge)`}/>
        </g>
        <rect x="20" y={fillY - 1} width="200" height="2" fill="#ffffff" opacity={level > 0 && level < 100 ? 0.35 : 0}/>
      </g>

      {BATTERY_TIERS.map((t, i) => {
        const max = i === 0 ? 100 : BATTERY_TIERS[i - 1].min;
        const top = yOf(max);
        const bottom = yOf(t.min);
        const centre = (top + bottom) / 2;
        const style = TIER_STYLE[t.tag];
        const on = tier?.tag === t.tag;
        return (
          <g key={t.tag}>
            <rect
              x={rail.x} width={rail.width} rx={rail.width / 2} fill={style.hex} opacity={on ? 1 : 0.22}
              y={top + (max === 100 ? 0 : 0.75)}
              height={bottom - top - (max === 100 ? 0 : 0.75) - (t.min === 0 ? 0 : 0.75)}
            />
            {labelled && (
              <>
                <text className="font-bold text-[18px]" x="264" y={centre - 2} fill={on ? style.hex : '#71717a'}>{style.name}</text>
                <text className="tabular-nums text-[13.5px]" x="264" y={centre + 17} fill={on ? '#9ca0a8' : '#52525b'}>
                  {t.min} – {tierMax(i)}
                </text>
              </>
            )}
          </g>
        );
      })}
      {score !== null && (
        <g>
          <line
            x1="210" y1={fillY} x2={rail.tickX - 1} y2={fillY} strokeLinecap="round" stroke="#52525b"
            strokeDasharray={labelled ? '1.5 5' : '4 8'} strokeWidth={labelled ? 1.5 : 3}
          />
          <rect x={rail.tickX} y={fillY - rail.tickHeight / 2} width={rail.tickWidth} height={rail.tickHeight} rx={rail.tickHeight / 2} fill="#f4f4f5" />
        </g>
      )}
    </svg>
  );
}

/** Contributors in order of how far each moved the score, either way. */
const byImpact = (parts: ReadinessPart[]) => [...parts].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

/**
 * One contributor: its name with its evidence underneath, a bar out from the centre line, and the
 * points it added or took. `large` sizes it for the desktop card.
 */
function ContributorRow({ part, maxAbs, large = false }: { part: ReadinessPart; maxAbs: number; large?: boolean }) {
  const pos = part.contribution >= 0;
  return (
    <div className={`grid items-center border-t border-[#18181b] ${large ? 'grid-cols-[minmax(0,1fr)_minmax(96px,140px)_56px] gap-4 py-3' : 'grid-cols-[minmax(0,1fr)_72px_40px] gap-2.5 py-[9px]'}`}>
      <div className="min-w-0">
        <div className={`${large ? 'text-[17px]' : 'text-[14px]'} text-[#d4d6db]`}>{part.label}</div>
        <div className={`mt-px ${large ? 'text-[14px]' : 'text-[12px]'} leading-[1.4] text-[#6b6f78]`}>{part.detail}</div>
      </div>
      <div className={`relative ${large ? 'h-[10px]' : 'h-1.5'}`}>
        <div className={`absolute left-1/2 ${large ? '-top-[7px] -bottom-[7px] w-[1.5px]' : '-top-[5px] -bottom-[5px] w-px'} bg-[#3f3f46]`} />
        <div
          className={`absolute top-0 h-full rounded-full transition-all duration-700 ${pos ? 'bg-[#22c55e]' : 'bg-[#f43f5e]'}`}
          style={{ width: `${(Math.abs(part.contribution) / maxAbs) * 45}%`, ...(pos ? { left: '50%' } : { right: '50%' }) }}
        />
      </div>
      <span className={`${large ? 'text-[17px]' : 'text-[14px]'} font-semibold text-right tabular-nums ${pos ? 'text-[#22c55e]' : 'text-[#f43f5e]'}`}>
        {pos ? '+' : '−'}{Math.abs(part.contribution).toFixed(1)}
      </span>
    </div>
  );
}

export function BodyBattery({ score, parts, confidence, label, missing, calibrating, className = '' }: BodyBatteryProps) {
  const z = batteryText({ score, confidence, missing, calibrating });
  const cautions = parts.filter((p) => p.note);

  const maxAbs = Math.max(...parts.map(p => Math.abs(p.contribution)), 1);

  return (
    <div className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[28px] p-[30px_24px] md:p-[44px_48px_40px] w-full max-w-[920px] mx-auto ${className}`}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(300px,440px)] gap-3 items-start">
        <div>
          <h1 className="text-[28px] md:text-[34px] font-bold tracking-[-0.02em] flex items-baseline gap-3 flex-wrap text-[#f4f4f5]">
            Body battery <span className={`text-[21px] font-bold tracking-[0.02em] ${z.color}`}>{z.tag}</span>
          </h1>
          <p className="mt-[18px] text-[18.5px] leading-[1.55] text-[#9ca0a8] max-w-[30ch]">
            Composed from HRV, resting heart rate, holistic sleep score & architecture against your personal 28-day baselines, and multi-day ACWR training load.
          </p>
          <div className="mt-[30px] inline-block bg-[#17171a] rounded-[20px] px-[30px] pt-[10px] pb-[14px]">
            <div className="flex items-baseline gap-1">
              <span className="text-[64px] md:text-[84px] font-bold tracking-[-0.03em] tabular-nums leading-[1.1] text-[#f4f4f5]">
                {score ?? '—'}
              </span>
              <span className="text-[17px] text-[#9ca0a8]">
                / 100
              </span>
            </div>
          </div>
          <div className="mt-[18px] text-[29px] font-bold tracking-[-0.01em] text-[#f4f4f5]">
            {label}
          </div>
          {z.basis && <p className="mt-2 text-[14px] text-[#6b6f78]">{z.basis}</p>}
        </div>

        <div className="w-full max-w-[340px] md:max-w-none mx-auto md:mx-0 mt-2 md:mt-0">
          <BatteryFigure score={score} labelled className="w-full h-auto block" />
        </div>
      </div>

      {parts.length > 0 && (
        <div className="mt-[26px]">
          <div className="text-[13px] font-semibold tracking-[0.22em] uppercase text-[#6b6f78] mb-2">
            How it was reached
          </div>
          {byImpact(parts).map((p) => <ContributorRow key={p.label} part={p} maxAbs={maxAbs} large />)}
        </div>
      )}

      {cautions.map((p) => (
        <p key={p.label} className="mt-4 text-[15px] text-amber-300/80 leading-[1.5]">{p.note}</p>
      ))}
    </div>
  );
}

/** Contributors a phone shows before "Show all". */
const TOP_CONTRIBUTORS = 3;

/** The battery on a phone: the score beside a small figure, then the contributors that moved it most. */
export function BodyBatteryCompact({ score, parts, confidence, label, missing, calibrating, className = '' }: BodyBatteryProps) {
  const [showAll, setShowAll] = useState(false);
  const z = batteryText({ score, confidence, missing, calibrating });
  const cautions = parts.filter((p) => p.note);
  const ranked = byImpact(parts);
  const shown = showAll ? ranked : ranked.slice(0, TOP_CONTRIBUTORS);
  const maxAbs = Math.max(...parts.map((p) => Math.abs(p.contribution)), 1);

  return (
    <section aria-label="Body battery" className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[24px] p-5 flex flex-col gap-4 ${className}`}>
      <h1 className="flex items-baseline gap-2.5 flex-wrap text-[22px] font-bold tracking-[-0.02em] text-[#f4f4f5]">
        Body battery <span className={`text-[14px] font-bold tracking-[0.02em] ${z.color}`}>{z.tag}</span>
      </h1>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-baseline gap-1 bg-[#17171a] rounded-2xl px-3.5 pt-1 pb-2">
            {/* A full 100 is the one three-digit score; a size down keeps it inside its column on narrow phones. */}
            <span className={`${score === 100 ? 'text-[44px]' : 'text-[56px]'} font-bold leading-[1.05] tracking-[-0.03em] tabular-nums text-[#f4f4f5]`}>{score ?? '—'}</span>
            <span className="text-[13px] text-[#9ca0a8] whitespace-nowrap">/ 100</span>
          </div>
          <div className="mt-2.5 text-[18px] font-bold leading-[1.25] text-[#f4f4f5]">{label}</div>
          {z.basis && <p className="mt-1.5 text-[12px] leading-[1.45] text-[#6b6f78]">{z.basis}</p>}
        </div>
        {/* The figure and its rail on the right, as on desktop, with each stage's range beside its band. */}
        <div className="flex items-stretch gap-1.5">
          <BatteryFigure score={score} labelled={false} className="w-[84px] h-auto shrink-0 block" />
          <div aria-hidden="true" className="relative w-[60px]">
            {BATTERY_TIERS.map((t, i) => {
              const centre = (yOf(i === 0 ? 100 : BATTERY_TIERS[i - 1].min) + yOf(t.min)) / 2;
              const style = TIER_STYLE[t.tag];
              const on = z.tier?.tag === t.tag;
              return (
                <div key={t.tag} className="absolute left-0 -translate-y-1/2 leading-[1.2]" style={{ top: `${(centre / 480) * 100}%` }}>
                  <div className="text-[12px] font-bold" style={{ color: on ? style.hex : '#71717a' }}>{style.name}</div>
                  <div className="text-[10.5px] tabular-nums" style={{ color: on ? '#9ca0a8' : '#52525b' }}>{t.min}–{tierMax(i)}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {parts.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#6b6f78] mb-1">How it was reached</div>
          {shown.map((p) => <ContributorRow key={p.label} part={p} maxAbs={maxAbs} />)}
          {parts.length > TOP_CONTRIBUTORS && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              aria-expanded={showAll}
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[#27272a] text-[13px] text-[#a1a1aa] hover:text-zinc-100 hover:bg-zinc-900 transition-colors"
            >
              {showAll ? `Show the top ${TOP_CONTRIBUTORS}` : `Show all ${parts.length} contributors`}
            </button>
          )}
        </div>
      )}

      {cautions.map((p) => (
        <p key={p.label} className="text-[12.5px] leading-[1.5] text-amber-300/80">{p.note}</p>
      ))}
    </section>
  );
}
