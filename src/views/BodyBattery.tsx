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
 * One colour per tier: for This week's bars (fill), for the charge that fills the figure and its
 * rail (body, the same in both themes) and for the tier's name beside it and by the title (ink, the
 * same colour in dark, a shade darker in light so it reads on white). Also its name and the
 * figure's label for a screen reader (a whole sentence per tier, so a language can inflect the name
 * in it); the thresholds themselves live in BATTERY_TIERS.
 */
export const TIER_STYLE: Record<(typeof BATTERY_TIERS)[number]['tag'], { fill: string; body: string; ink: string; name: MessageKey; figure: MessageKey }> = {
  CHARGED: { fill: 'var(--charge-charged)', body: 'var(--figure-charged)', ink: 'var(--figure-ink-charged)', name: 'today.battery.tiers.charged.name', figure: 'today.battery.tiers.charged.figure' },
  BALANCED: { fill: 'var(--charge-balanced)', body: 'var(--figure-balanced)', ink: 'var(--figure-ink-balanced)', name: 'today.battery.tiers.balanced.name', figure: 'today.battery.tiers.balanced.figure' },
  LOW: { fill: 'var(--charge-low)', body: 'var(--figure-low)', ink: 'var(--figure-ink-low)', name: 'today.battery.tiers.low.name', figure: 'today.battery.tiers.low.figure' },
  DRAINED: { fill: 'var(--charge-drained)', body: 'var(--figure-drained)', ink: 'var(--figure-ink-drained)', name: 'today.battery.tiers.drained.name', figure: 'today.battery.tiers.drained.figure' },
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

/** The tier, a note when there's no score, and the line saying what the score stands on; shared by both layouts. */
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
    // The tier by the title, in its own colour; before there's a score, a grey note instead.
    status: tier
      ? { text: t(TIER_STYLE[tier.tag].name), color: TIER_STYLE[tier.tag].ink }
      : { text: t('today.battery.noData'), color: 'var(--color-zinc-500)' },
    basis,
  };
}

/**
 * The tier by the title, in capitals and its colour, after a dot of the same colour: • BALANCED.
 * The dot sits halfway up the capitals (DM Sans's are 0.7em tall), not halfway up a lower-case x.
 */
function TierWord({ status, className = '' }: { status: { text: string; color: string }; className?: string }) {
  return (
    <span
      className={`font-sans text-tag uppercase before:content-[''] before:inline-block before:size-1.5 before:mr-1.5 before:rounded-full before:bg-current before:align-[calc(0.35em_-_3px)] ${className}`}
      style={{ color: status.color }}
    >
      {status.text}
    </span>
  );
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
          <stop offset="0" stopColor={TIER_STYLE.DRAINED.body}/>
          {gradientStops.map((s) => <stop key={s.tag} offset={s.offset} stopColor={TIER_STYLE[s.tag].body}/>)}
          <stop offset="1" stopColor={TIER_STYLE.CHARGED.body}/>
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

      <path d={body} fill="var(--figure)" />

      <g clipPath={`url(#${id}-body)`}>
        <g clipPath={`url(#${id}-level)`}>
          <rect x="20" y="9" width="200" height="453" fill={`url(#${id}-charge)`}/>
        </g>
        <rect x="20" y={fillY - 1} width="200" height="2" fill="var(--figure-level)" opacity={level > 0 && level < 100 ? 0.35 : 0}/>
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
              x={rail.x} width={rail.width} rx={rail.width / 2} fill={style.body} opacity={on ? 1 : 0.22}
              y={top + (max === 100 ? 0 : 0.75)}
              height={bottom - top - (max === 100 ? 0 : 0.75) - (stage.min === 0 ? 0 : 0.75)}
            />
            {labelled && (
              <>
                <text fontSize={18} fontWeight={700} x="264" y={centre - 2} fill={on ? style.ink : 'var(--color-zinc-500)'}>{t(style.name)}</text>
                <text className="tabular-nums" fontSize={13.5} x="264" y={centre + 17} fill={on ? 'var(--color-zinc-400)' : 'var(--color-zinc-600)'}>
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
            x1="210" y1={fillY} x2={rail.tickX - 1} y2={fillY} strokeLinecap="round" stroke="var(--color-zinc-600)"
            strokeDasharray={labelled ? '1.5 5' : '4 8'} strokeWidth={labelled ? 1.5 : 3}
          />
          <rect x={rail.tickX} y={fillY - rail.tickHeight / 2} width={rail.tickWidth} height={rail.tickHeight} rx={rail.tickHeight / 2} fill="var(--color-zinc-100)" />
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
    <div className={`grid items-center border-t border-faint ${large ? 'grid-cols-[minmax(0,1fr)_minmax(96px,140px)_56px] gap-4 py-3' : 'grid-cols-[minmax(0,1fr)_72px_40px] gap-2.5 py-[9px]'}`}>
      <div className="min-w-0">
        <div className={`${large ? 'text-body-lg' : 'text-body'} text-zinc-300`}>{part.label}</div>
        <div className={`mt-px ${large ? 'text-body' : 'text-detail'} text-zinc-500`}>{part.detail}</div>
      </div>
      <div className={`relative ${large ? 'h-[10px]' : 'h-1.5'}`}>
        <div className={`absolute left-1/2 ${large ? '-top-[7px] -bottom-[7px] w-[1.5px]' : '-top-[5px] -bottom-[5px] w-px'} bg-zinc-700`} />
        <div
          className={`absolute top-0 h-full rounded-full transition-all duration-700 ${pos ? 'bg-(--green-500)' : 'bg-(--rose-500)'}`}
          style={{ width: `${(Math.abs(part.contribution) / maxAbs) * 45}%`, ...(pos ? { left: '50%' } : { right: '50%' }) }}
        />
      </div>
      <span className={`${large ? 'text-body-lg' : 'text-body'} font-semibold text-right tabular-nums ${pos ? 'text-(--green-500)' : 'text-(--rose-500)'}`}>
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
    <div className={`bg-card border border-card-edge rounded-[28px] p-[30px_24px] md:p-[44px_48px_40px] w-full max-w-[920px] mx-auto ${className}`}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(280px,1fr)_minmax(300px,440px)] gap-3 items-start">
        <div>
          {/* A card title, as This week's is, with the tier to its right. */}
          <h1 className="card-title-detail flex items-baseline gap-3 flex-wrap text-zinc-50">
            {t('today.battery.title')}
            <TierWord status={z.status} />
          </h1>
          <p className="mt-[18px] text-lead text-zinc-400 max-w-[30ch]">
            {t('today.battery.composition', { days: BASELINE_DAYS })}
          </p>
          <div className="mt-[30px] inline-block bg-panel-raised rounded-[20px] px-[30px] pt-[10px] pb-[14px]">
            <div className="flex items-baseline gap-1">
              <span className="font-display text-number-3xl tabular-nums text-zinc-100">
                {score ?? '—'}
              </span>
              <span className="text-body-lg text-zinc-400">
                {t('today.battery.outOf')}
              </span>
            </div>
          </div>
          <div className="mt-[18px] font-display text-headline-lg text-zinc-100">
            {label}
          </div>
          {z.basis && <p className="mt-2 text-body text-zinc-500">{z.basis}</p>}
        </div>

        <div className="w-full max-w-[340px] md:max-w-none mx-auto md:mx-0 mt-2 md:mt-0">
          <BatteryFigure score={score} gender={gender} labelled className="w-full h-auto block" />
        </div>
      </div>

      {parts.length > 0 && (
        <div className="mt-[26px]">
          <Contributors heading="text-eyebrow-lg uppercase text-zinc-500 mb-2">
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
    <section aria-label={t('today.battery.title')} className={`bg-card border border-card-edge rounded-[24px] p-5 flex flex-col gap-4 ${className}`}>
      {/* A card title, as This week's is, with the tier under it. */}
      <div>
        <h1 className="card-title-detail text-zinc-50">{t('today.battery.title')}</h1>
        <TierWord status={z.status} className="block mt-0.5" />
      </div>

      {/* Always side by side, never the figure under the score: the score keeps the room it needs and the figure shrinks into what's left. */}
      <div className="flex items-center gap-2.5">
        <div className="flex-1">
          {/* The number steps down a size on narrower phones, again under 360px, and once more for a full 100. */}
          <div className="inline-flex items-baseline gap-1 bg-panel-raised rounded-2xl px-3 min-[380px]:px-3.5 pt-1 pb-2">
            <span
              className={`font-display ${score === 100 ? 'text-number-md min-[360px]:text-number-lg min-[380px]:text-number-xl' : 'text-number-lg min-[360px]:text-number-xl min-[380px]:text-number-2xl'} tabular-nums text-zinc-100`}
            >
              {score ?? '—'}
            </span>
            <span className="text-body-sm text-zinc-400 whitespace-nowrap">{t('today.battery.outOf')}</span>
          </div>
          <div className="mt-2.5 font-display text-headline-sm min-[380px]:text-headline text-zinc-100">{label}</div>
          {z.basis && <p className="mt-1.5 text-detail text-zinc-500">{z.basis}</p>}
        </div>
        {/* The figure and its rail on the right, as on desktop, with each stage's range beside its band; under 320px, where the figure is too short for two lines a stage, just the names. */}
        <div className="flex items-stretch gap-1 min-w-0">
          <BatteryFigure score={score} gender={gender} labelled={false} className="w-[104px] min-w-10 h-auto block" />
          <div aria-hidden="true" className="relative w-[56px] shrink-0">
            {BATTERY_TIERS.map((stage, i) => {
              const centre = (yOf(i === 0 ? 100 : BATTERY_TIERS[i - 1].min) + yOf(stage.min)) / 2;
              const style = TIER_STYLE[stage.tag];
              const on = z.tier?.tag === stage.tag;
              return (
                <div key={stage.tag} className="absolute left-0 -translate-y-1/2 leading-tight" style={{ top: `${(centre / 480) * 100}%` }}>
                  <div className="text-detail leading-tight font-bold" style={{ color: on ? style.ink : 'var(--color-zinc-500)' }}>{t(style.name)}</div>
                  <div className="hidden min-[320px]:block text-note leading-tight tabular-nums" style={{ color: on ? 'var(--color-zinc-400)' : 'var(--color-zinc-600)' }}>
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
