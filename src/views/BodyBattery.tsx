import React, { useId } from 'react';
import { BASELINE_DAYS, BATTERY_TIERS, batteryTier, type Readiness, type ReadinessPart, type ReadinessSignal } from '../pipeline/derive';
import { t, type MessageKey } from '../i18n';
import { formatFixed, formatList } from '../i18n/format';
import { Contributors } from '../ui/primitives';
import type { Gender } from '../pipeline/registry';
import { silhouette } from './silhouettes';

interface BodyBatteryProps {
  /** Null when readiness can't be computed yet (too little history). */
  score: number | null;
  parts: Readiness['parts'];
  confidence: Readiness['confidence'];
  label: string;
  missing: Readiness['missing'];
  calibrating: Readiness['calibrating'];
  /** Picks the figure: a woman's for female, else a man's. */
  gender: Gender | null;
  className?: string;
}

/**
 * One colour per tier, with its name, its badge and the figure's label for a screen reader (a whole
 * sentence per tier, so a language can inflect the name in it); the thresholds themselves live in BATTERY_TIERS.
 */
export const TIER_STYLE: Record<(typeof BATTERY_TIERS)[number]['tag'], { text: string; hex: string; name: MessageKey; badge: MessageKey; figure: MessageKey }> = {
  CHARGED: { text: 'text-emerald-500', hex: '#10b981', name: 'today.battery.tiers.charged.name', badge: 'today.battery.tiers.charged.tag', figure: 'today.battery.tiers.charged.figure' },
  BALANCED: { text: 'text-lime-300', hex: '#bef264', name: 'today.battery.tiers.balanced.name', badge: 'today.battery.tiers.balanced.tag', figure: 'today.battery.tiers.balanced.figure' },
  LOW: { text: 'text-amber-500', hex: '#f59e0b', name: 'today.battery.tiers.low.name', badge: 'today.battery.tiers.low.tag', figure: 'today.battery.tiers.low.figure' },
  DRAINED: { text: 'text-rose-500', hex: '#f43f5e', name: 'today.battery.tiers.drained.name', badge: 'today.battery.tiers.drained.tag', figure: 'today.battery.tiers.drained.figure' },
};

/** What the line under the score says about its confidence. */
const CONFIDENCE = {
  low: 'today.battery.confidence.low',
  medium: 'today.battery.confidence.medium',
  high: 'today.battery.confidence.high',
} as const satisfies Record<Readiness['confidence'], MessageKey>;

/** What it calls each core signal with no reading: "no HRV or sleep last night". */
const MISSING_SIGNALS = {
  hrv: 'today.battery.missingSignals.hrv',
  restingHr: 'today.battery.missingSignals.restingHr',
  sleep: 'today.battery.missingSignals.sleep',
} as const satisfies Record<ReadinessSignal, MessageKey>;

/** What it calls each one calibrating to a new device: names of their own, so a language can fit them to this sentence. */
const CALIBRATING_SIGNALS = {
  hrv: 'today.battery.calibratingSignals.hrv',
  restingHr: 'today.battery.calibratingSignals.restingHr',
} as const satisfies Record<Readiness['calibrating'][number], MessageKey>;

/** A tier's top score: the next tier's floor less one. */
const tierMax = (i: number) => (i === 0 ? 100 : BATTERY_TIERS[i - 1].min - 1);

/** The tag, its colour and the line saying what the score stands on; shared by both layouts. */
function batteryText({ score, confidence, missing, calibrating }: Pick<BodyBatteryProps, 'score' | 'confidence' | 'missing' | 'calibrating'>) {
  // Too little data is not the same as being drained.
  const tier = score === null ? null : batteryTier(score);
  const basis = [
    score !== null ? t(CONFIDENCE[confidence]) : null,
    missing.length && score !== null
      ? t('today.battery.missing', { count: missing.length, signals: formatList(missing.map((s) => t(MISSING_SIGNALS[s])), 'or') })
      : null,
    calibrating.length
      ? t('today.battery.calibrating', { count: calibrating.length, signals: formatList(calibrating.map((s) => t(CALIBRATING_SIGNALS[s]))) })
      : null,
  ].filter(Boolean).join(' · ');
  return {
    tier,
    tag: t(tier ? TIER_STYLE[tier.tag].badge : 'today.battery.noData'),
    color: tier ? TIER_STYLE[tier.tag].text : 'text-zinc-500',
    basis,
  };
}

const TOP = 9;
const BOTTOM = 462;
const yOf = (level: number) => BOTTOM - (level / 100) * (BOTTOM - TOP);

/**
 * The figure filled to the score, with the stages as a rail beside it, each band at its true
 * height and the current one lit. `labelled` names each stage and its range; the small phone
 * figure leaves that to the text beside it and draws the rail heavier to stay legible.
 */
function BatteryFigure({ score, gender, labelled, className }: {
  score: number | null;
  gender: Gender | null;
  labelled: boolean;
  className?: string;
}) {
  // Both layouts are in the page at once, so their gradient and clip ids must not collide.
  const id = useId().replace(/[^\w-]/g, '');
  const body = silhouette(gender);
  const tier = score === null ? null : batteryTier(score);
  const level = score ?? 0;
  const fillY = yOf(level);
  const fillHeight = (level / 100) * (BOTTOM - TOP);
  // The figure's gradient: each stage's colour at the middle of its band, blending across the thresholds.
  const gradientStops = BATTERY_TIERS.map((stage, i) => ({
    tag: stage.tag,
    offset: (stage.min + (i === 0 ? 100 : BATTERY_TIERS[i - 1].min)) / 200,
  })).reverse();
  const rail = labelled ? { x: 240, width: 8, tickX: 235, tickWidth: 18, tickHeight: 3 } : { x: 236, width: 12, tickX: 229, tickWidth: 26, tickHeight: 5 };

  return (
    <svg
      viewBox={labelled ? '0 0 470 480' : '16 0 250 480'}
      role="img"
      aria-label={tier ? t(TIER_STYLE[tier.tag].figure, { score }) : t('today.battery.figure.empty')}
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
          <path d={body} />
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

      <path d={body} fill="#1b1b1f" />

      <g clipPath={`url(#${id}-body)`}>
        <g clipPath={`url(#${id}-level)`}>
          <rect x="20" y="9" width="200" height="453" fill={`url(#${id}-charge)`}/>
        </g>
        <rect x="20" y={fillY - 1} width="200" height="2" fill="#ffffff" opacity={level > 0 && level < 100 ? 0.35 : 0}/>
      </g>

      {BATTERY_TIERS.map((stage, i) => {
        const max = i === 0 ? 100 : BATTERY_TIERS[i - 1].min;
        const top = yOf(max);
        const bottom = yOf(stage.min);
        const centre = (top + bottom) / 2;
        const style = TIER_STYLE[stage.tag];
        const on = tier?.tag === stage.tag;
        return (
          <g key={stage.tag}>
            <rect
              x={rail.x} width={rail.width} rx={rail.width / 2} fill={style.hex} opacity={on ? 1 : 0.22}
              y={top + (max === 100 ? 0 : 0.75)}
              height={bottom - top - (max === 100 ? 0 : 0.75) - (stage.min === 0 ? 0 : 0.75)}
            />
            {labelled && (
              <>
                <text fontSize={18} fontWeight={700} x="264" y={centre - 2} fill={on ? style.hex : '#71717a'}>{t(style.name)}</text>
                <text className="tabular-nums" fontSize={13.5} x="264" y={centre + 17} fill={on ? '#9ca0a8' : '#52525b'}>
                  {t('today.battery.range', { min: stage.min, max: tierMax(i) })}
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
        <div className={`${large ? 'text-body-lg' : 'text-body'} text-[#d4d6db]`}>{part.label}</div>
        <div className={`mt-px ${large ? 'text-body' : 'text-detail'} text-[#6b6f78]`}>{part.detail}</div>
      </div>
      <div className={`relative ${large ? 'h-[10px]' : 'h-1.5'}`}>
        <div className={`absolute left-1/2 ${large ? '-top-[7px] -bottom-[7px] w-[1.5px]' : '-top-[5px] -bottom-[5px] w-px'} bg-[#3f3f46]`} />
        <div
          className={`absolute top-0 h-full rounded-full transition-all duration-700 ${pos ? 'bg-[#22c55e]' : 'bg-[#f43f5e]'}`}
          style={{ width: `${(Math.abs(part.contribution) / maxAbs) * 45}%`, ...(pos ? { left: '50%' } : { right: '50%' }) }}
        />
      </div>
      <span className={`${large ? 'text-body-lg' : 'text-body'} font-semibold text-right tabular-nums ${pos ? 'text-[#22c55e]' : 'text-[#f43f5e]'}`}>
        {pos ? '+' : '−'}{formatFixed(Math.abs(part.contribution), 1)}
      </span>
    </div>
  );
}

export function BodyBattery({ score, parts, confidence, label, missing, calibrating, gender, className = '' }: BodyBatteryProps) {
  const z = batteryText({ score, confidence, missing, calibrating });
  const cautions = parts.filter((p) => p.note);

  const maxAbs = Math.max(...parts.map(p => Math.abs(p.contribution)), 1);

  return (
    <div className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[28px] p-[30px_24px] md:p-[44px_48px_40px] w-full max-w-[920px] mx-auto ${className}`}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(300px,440px)] gap-3 items-start">
        <div>
          <h1 className="font-display text-display-lg flex items-baseline gap-3 flex-wrap text-[#f4f4f5]">
            {t('today.battery.title')} <span className={`font-sans text-tag-lg ${z.color}`}>{z.tag}</span>
          </h1>
          <p className="mt-[18px] text-lead text-[#9ca0a8] max-w-[30ch]">
            {t('today.battery.composition', { days: BASELINE_DAYS })}
          </p>
          <div className="mt-[30px] inline-block bg-[#17171a] rounded-[20px] px-[30px] pt-[10px] pb-[14px]">
            <div className="flex items-baseline gap-1">
              <span className="font-display text-number-3xl tabular-nums text-[#f4f4f5]">
                {score ?? '—'}
              </span>
              <span className="text-body-lg text-[#9ca0a8]">
                {t('today.battery.outOf')}
              </span>
            </div>
          </div>
          <div className="mt-[18px] font-display text-headline-lg text-[#f4f4f5]">
            {label}
          </div>
          {z.basis && <p className="mt-2 text-body text-[#6b6f78]">{z.basis}</p>}
        </div>

        <div className="w-full max-w-[340px] md:max-w-none mx-auto md:mx-0 mt-2 md:mt-0">
          <BatteryFigure score={score} gender={gender} labelled className="w-full h-auto block" />
        </div>
      </div>

      {parts.length > 0 && (
        <div className="mt-[26px]">
          <Contributors heading="text-eyebrow-lg uppercase text-[#6b6f78] mb-2">
            {byImpact(parts).map((p) => <ContributorRow key={p.id} part={p} maxAbs={maxAbs} large />)}
          </Contributors>
        </div>
      )}

      {cautions.map((p) => (
        <p key={p.id} className="mt-4 text-body text-amber-300/80">{p.note}</p>
      ))}
    </div>
  );
}

/** The battery on a phone: the score beside a small figure, then its contributors, folded until tapped. */
export function BodyBatteryCompact({ score, parts, confidence, label, missing, calibrating, gender, className = '' }: BodyBatteryProps) {
  const z = batteryText({ score, confidence, missing, calibrating });
  const cautions = parts.filter((p) => p.note);
  const maxAbs = Math.max(...parts.map((p) => Math.abs(p.contribution)), 1);

  return (
    <section aria-label={t('today.battery.title')} className={`bg-[#0c0c0e] border border-[#1e1e22] rounded-[24px] p-5 flex flex-col gap-4 ${className}`}>
      <h1 className="flex items-baseline gap-2.5 flex-wrap font-display text-display text-[#f4f4f5]">
        {t('today.battery.title')} <span className={`font-sans text-tag ${z.color}`}>{z.tag}</span>
      </h1>

      {/* Side by side from 360px; the narrowest phones stack the figure under the score instead of shrinking it. */}
      <div className="grid grid-cols-1 min-[360px]:grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5">
        <div className="min-w-0">
          {/* The figure takes the room it needs, so the number steps down a size on narrower phones, and once more for a full 100. */}
          <div className="inline-flex items-baseline gap-1 bg-[#17171a] rounded-2xl px-3 min-[380px]:px-3.5 pt-1 pb-2">
            <span
              className={`font-display ${score === 100 ? 'text-number-lg min-[380px]:text-number-xl' : 'text-number-xl min-[380px]:text-number-2xl'} tabular-nums text-[#f4f4f5]`}
            >
              {score ?? '—'}
            </span>
            <span className="text-body-sm text-[#9ca0a8] whitespace-nowrap">{t('today.battery.outOf')}</span>
          </div>
          <div className="mt-2.5 font-display text-headline-sm min-[380px]:text-headline text-[#f4f4f5]">{label}</div>
          {z.basis && <p className="mt-1.5 text-detail text-[#6b6f78]">{z.basis}</p>}
        </div>
        {/* The figure and its rail on the right, as on desktop, with each stage's range beside its band. */}
        <div className="flex items-stretch gap-1 justify-self-center min-[360px]:justify-self-auto">
          <BatteryFigure score={score} gender={gender} labelled={false} className="w-[104px] h-auto shrink-0 block" />
          <div aria-hidden="true" className="relative w-[56px]">
            {BATTERY_TIERS.map((stage, i) => {
              const centre = (yOf(i === 0 ? 100 : BATTERY_TIERS[i - 1].min) + yOf(stage.min)) / 2;
              const style = TIER_STYLE[stage.tag];
              const on = z.tier?.tag === stage.tag;
              return (
                <div key={stage.tag} className="absolute left-0 -translate-y-1/2 leading-tight" style={{ top: `${(centre / 480) * 100}%` }}>
                  <div className="text-detail leading-tight font-bold" style={{ color: on ? style.hex : '#71717a' }}>{t(style.name)}</div>
                  <div className="text-note leading-tight tabular-nums" style={{ color: on ? '#9ca0a8' : '#52525b' }}>
                    {t('today.battery.rangeNarrow', { min: stage.min, max: tierMax(i) })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {parts.length > 0 && (
        <Contributors>
          {byImpact(parts).map((p) => <ContributorRow key={p.id} part={p} maxAbs={maxAbs} />)}
        </Contributors>
      )}

      {cautions.map((p) => (
        <p key={p.id} className="text-detail text-amber-300/80">{p.note}</p>
      ))}
    </section>
  );
}
