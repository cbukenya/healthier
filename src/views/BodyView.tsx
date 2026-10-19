import React, { useMemo, useState } from 'react';
import { ChevronDown, Ruler, User, Weight } from 'lucide-react';
import { daysBetween } from '../lib/date';
import { formatCivilLong, formatNumber } from '../i18n/format';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import {
  bodyComposition, latestBody, series, values, weightTrend, type BodyComposition, type CompositionPair,
} from '../pipeline/derive';
import { Spark, TrendChart } from '../charts';
import { Card, CardHead, DOMAIN, EmptyState, Label, Row, Value, fmtNum } from '../ui/primitives';
import { Tile } from '../ui/Tile';
import { ChartChips } from '../ui/ChartChips';
import type { SyncResult } from '../pipeline/sync';
import type { Gender } from '../pipeline/registry';
import { bucketForSeries, groupSeries } from '../pipeline/aggregate';
import { SpanSelector, spanSummaryTitle, useSpan } from '../ui/span';
import { useHistory } from '../hooks/useHistory';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import type { IntradayDays } from '../pipeline/labs';

const LEAN_HEX = DOMAIN.body.hex;
const FAT_HEX = 'var(--amber-400)';

type BodyChart = 'weight' | 'fat' | 'composition';

/** A number at a fixed count of decimals, so 108.0 kg doesn't read as 108. */
const fixed = (v: number, digits = 1) => formatNumber(v, digits);

/** A weight with its unit, "108.0 kg". */
const kgText = (v: number) => `${fixed(v)} ${t('units.kg')}`;

/** A share with its unit, "39.1%". */
const percentText = (v: number) => `${fixed(v)}${t('units.percent')}`;

/** A change in a neutral voice, "↓ 1.7 kg": whether up or down is welcome is the person's call, not the app's. */
function changeText(delta: number, unit: string, digits = 1): string {
  const shown = Number(Math.abs(delta).toFixed(digits));
  const arrow = shown === 0 ? '' : delta > 0 ? '↑ ' : '↓ ';
  return `${arrow}${fixed(shown, digits)}${unit ? ` ${unit}` : ''}`;
}

/** How long ago a weigh-in was: weigh-ins are occasional, so its age matters. */
function ago(days: number): string {
  if (days <= 0) return t('body.latest.ago.today');
  if (days === 1) return t('body.latest.ago.yesterday');
  if (days < 14) return t('body.latest.ago.days', { count: days });
  if (days < 60) return t('body.latest.ago.weeks', { count: Math.round(days / 7) });
  return t('body.latest.ago.months', { count: Math.round(days / 30.4) });
}

export function BodyView({ data, gender, onGender, clock, intraday }: {
  data: SyncResult;
  /** The person's gender, kept by the app so Today's figure follows a change at once. */
  gender: Gender | null;
  onGender: (gender: Gender | null) => void;
  clock?: Clock;
  intraday?: IntradayDays;
}) {
  const insights = usePageInsights(data, 'body', clock, intraday);
  const spanState = useSpan(data, '90');
  const window = spanState.days;
  const history = useHistory();
  // A phone shows one chart at a time behind chips; wider screens show them all.
  const wide = useMediaQuery('(min-width: 768px)');
  const [chart, setChart] = useState<BodyChart>('weight');

  // The newest readings, whatever span is on screen: long history once it has loaded, else the window.
  const all = history.days ?? data.days;
  const body = useMemo(() => latestBody(all), [all]);
  const today = data.days.at(-1)?.date ?? null;
  const heightCm = data.profile.heightCm;
  const bmi = (kg: number) => (heightCm ? kg / (heightCm / 100) ** 2 : null);

  const { latest, previous } = body;
  const profile = (
    <ProfileTile
      age={data.profile.age ?? null}
      heightCm={heightCm}
      gender={gender}
      onGender={onGender}
      className={`col-span-2 ${latest ? 'lg:col-span-1 lg:order-2' : 'lg:col-span-3'}`}
    />
  );

  if (!latest) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-3">{profile}</div>
        <Card>
          <EmptyState
            title={history.loading ? t('body.empty.loading') : t('body.empty.title')}
            detail={t('body.empty.detail')}
          />
        </Card>
      </div>
    );
  }

  const daysOld = today ? daysBetween(latest.date, today) : 0;
  const latestBmi = bmi(latest.value);
  const bmiTrail = body.weighIns.map((p) => ({ date: p.date, value: p.value === null ? null : bmi(p.value) }));

  // The span in numbers and charts. Weigh-ins are sparse: keep every reading unless there are too many to show.
  const weightWin = series(window, (d) => d.weightKg);
  const fatWin = series(window, (d) => d.bodyFatPct);
  const weighIns = weightWin.filter((p): p is { date: string; value: number } => p.value !== null);
  const trend = weightTrend(weightWin);
  const comp = bodyComposition(window);
  const highest = weighIns.reduce<(typeof weighIns)[number] | null>((a, p) => (!a || p.value > a.value ? p : a), null);
  const lowest = weighIns.reduce<(typeof weighIns)[number] | null>((a, p) => (!a || p.value < a.value ? p : a), null);
  const weightBucket = bucketForSeries(weightWin, window.length);
  const fatBucket = bucketForSeries(fatWin, window.length);
  // Which charts exist depends on what the person has ever recorded, so a quiet span shows them empty rather than hiding them.
  const everFat = all.some((d) => d.bodyFatPct !== null);
  const everPaired = body.composition !== null;
  const latestInSpan = weighIns.at(-1);
  const latestFat = values(fatWin).at(-1);

  const summaryCard = (
    <Card className="lg:col-span-4">
      <CardHead domain="body" title={spanSummaryTitle(spanState)} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label={t('body.summary.weighIns')}>
          {weighIns.length || (spanState.loading ? t('body.summary.loading') : t('body.summary.none', { count: window.length }))}
        </Row>
        {trend && <Row dense={!wide} label={t('body.summary.trend')}>{t('body.summary.trendValue', { change: changeText(trend.kgPerWeek, '', 2) })}</Row>}
        {highest && (
          <Row dense={!wide} label={t('body.summary.highest')}>
            {kgText(highest.value)}<span className="text-zinc-500"> · {formatCivilLong(highest.date)}</span>
          </Row>
        )}
        {lowest && (
          <Row dense={!wide} label={t('body.summary.lowest')}>
            {kgText(lowest.value)}<span className="text-zinc-500"> · {formatCivilLong(lowest.date)}</span>
          </Row>
        )}
        {weighIns.length >= 2 && (
          <Row dense={!wide} label={t('body.summary.firstToLast')}>{changeText(weighIns[weighIns.length - 1].value - weighIns[0].value, t('units.kg'))}</Row>
        )}
      </div>
    </Card>
  );
  const weightCard = (
    <Card className="lg:col-span-8">
      <CardHead
        domain="body"
        title={t('body.weightChart.title')}
        hint={t('body.weightChart.hint')}
        right={latestInSpan && (
          <span>
            {rich('body.weightChart.latest', {
              weight: kgText(latestInSpan.value),
              value: (w) => <span className={DOMAIN.body.text}>{w}</span>,
            })}
          </span>
        )}
      />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(weightWin, weightBucket)} bucket={weightBucket} color={DOMAIN.body.hex} height={wide ? 240 : 210} unit={t('units.kg')} format={(v) => fmtNum(v, 1)} meanWindow={null} />
      </div>
    </Card>
  );
  const fatCard = everFat && (
    <Card>
      <CardHead
        domain="body"
        title={t('body.fatChart.title')}
        right={latestFat !== undefined && (
          <span>
            {rich('body.fatChart.latest', { fat: percentText(latestFat), value: (w) => <span className="text-zinc-300">{w}</span> })}
          </span>
        )}
      />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(fatWin, fatBucket)} bucket={fatBucket} color="var(--color-zinc-400)" height={160} unit={t('units.percent')} format={(v) => fmtNum(v, 1)} meanWindow={null} />
      </div>
    </Card>
  );
  const compCard = everPaired && <CompositionTrend comp={comp} />;
  const charts: { key: BodyChart; label: string; card: React.ReactNode }[] = [
    { key: 'weight', label: t('body.chips.weight'), card: weightCard },
    ...(fatCard ? [{ key: 'fat' as const, label: t('body.chips.fat'), card: fatCard }] : []),
    ...(compCard ? [{ key: 'composition' as const, label: t('body.chips.composition'), card: compCard }] : []),
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      {/* Who you are and the newest readings, whatever span is chosen below. On wide screens, profile, weight and BMI share a row. */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-3">
        {profile}
        <div className="min-w-0 lg:order-3 grid">
          <Tile
            label={t('body.latest.weight.label')}
            icon={<Weight size={14} className={DOMAIN.body.text} />}
            value={<Value value={latest.value} size="md" digits={1} unit={t('units.kg')} />}
            chart={body.weighIns.length > 1 && <Spark series={body.weighIns} color={DOMAIN.body.hex} height={28} />}
            rows={[[t('body.latest.weight.fromPrevious'), previous && changeText(latest.value - previous.value, t('units.kg'))]]}
            // Weigh-ins are occasional: one more than two weeks old says when it was.
            note={daysOld > 14 ? t('body.latest.from', { date: formatCivilLong(latest.date), ago: ago(daysOld) }) : null}
          />
        </div>
        <div className="min-w-0 lg:order-4 grid">
          <Tile
            label={t('body.latest.bmi.label')}
            icon={<Ruler size={14} className={DOMAIN.body.text} />}
            value={<Value value={latestBmi} size="md" digits={1} />}
            chart={latestBmi !== null && body.weighIns.length > 1 && <Spark series={bmiTrail} color={DOMAIN.body.hex} height={28} />}
            rows={[[t('body.latest.bmi.fromPrevious'), previous && latestBmi !== null && changeText(latestBmi - bmi(previous.value)!, '')]]}
            empty={latestBmi === null ? t('body.latest.bmi.needsHeight') : null}
          />
        </div>
      </div>

      {body.composition && <CompositionNow now={body.composition} before={body.previousComposition} />}

      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-page-ink">{t('body.overTime.title')}</h2>
        <SpanSelector state={spanState} />
      </div>

      {wide ? (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            {summaryCard}
            {weightCard}
          </div>
          {(fatCard || compCard) && (
            <div className={`grid grid-cols-1 ${fatCard && compCard ? 'lg:grid-cols-2' : ''} gap-3`}>
              {fatCard}
              {compCard}
            </div>
          )}
        </>
      ) : (
        <>
          {summaryCard}
          {charts.length > 1 && <ChartChips label={t('body.chips.label')} options={charts} value={shownChart.key} onChange={setChart} />}
          {shownChart.card}
        </>
      )}

      <InsightsCarousel observations={insights} page="body" />
    </div>
  );
}

/** Age, gender and height. Gender is the person's to set: Google Health doesn't provide it. */
function ProfileTile({ age, heightCm, gender, onGender, className = '' }: {
  age: number | null;
  heightCm: number | null;
  gender: Gender | null;
  onGender: (gender: Gender | null) => void;
  className?: string;
}) {
  // A phone lines the three up side by side; a wide screen stacks them, label by value.
  const fact = 'flex flex-col gap-0.5 lg:flex-row lg:items-baseline lg:justify-between lg:gap-2';
  const label = 'text-eyebrow-sm uppercase text-zinc-500 lg:text-detail lg:font-normal lg:normal-case lg:tracking-normal';
  const value = 'font-display text-number-xs text-zinc-50 tabular-nums';
  return (
    <section aria-label={t('body.profile.title')} className={`min-w-0 bg-card border border-card-edge rounded-[18px] p-3.5 lg:p-4 flex flex-col gap-2.5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <Label>{t('body.profile.title')}</Label>
        <User size={14} className="text-zinc-400" />
      </div>
      <dl className="grid grid-cols-3 lg:grid-cols-1 gap-2 lg:flex-1 lg:content-around">
        <div className={fact}>
          <dt className={label}>{t('body.profile.age')}</dt>
          <dd className={value} title={age === null ? t('body.profile.ageSource') : undefined}>{age ?? '—'}</dd>
        </div>
        <div className={fact}>
          <dt className={label}>{t('body.profile.gender')}</dt>
          <dd className="relative inline-flex items-center self-start lg:self-auto">
            <select
              aria-label={t('body.profile.gender')}
              value={gender ?? ''}
              onChange={(e) => onGender((e.target.value || null) as Gender | null)}
              className={`appearance-none bg-transparent py-0.5 pr-4 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ${value} ${gender ? '' : '!text-zinc-500'}`}
            >
              <option value="" className="bg-zinc-900 text-zinc-300">{t('body.profile.genders.unset')}</option>
              <option value="female" className="bg-zinc-900 text-zinc-100">{t('body.profile.genders.female')}</option>
              <option value="male" className="bg-zinc-900 text-zinc-100">{t('body.profile.genders.male')}</option>
              <option value="other" className="bg-zinc-900 text-zinc-100">{t('body.profile.genders.other')}</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute right-0 text-zinc-500" />
          </dd>
        </div>
        <div className={fact}>
          <dt className={label}>{t('body.profile.height')}</dt>
          <dd className={value}>
            {heightCm ? <>{fmtNum(heightCm, 1)} <span className="font-sans text-caption font-medium text-zinc-500">{t('units.cm')}</span></> : '—'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** The newest weigh-in that came with a body-fat reading: lean and fat, in kg and share, and their change from the one before. */
function CompositionNow({ now, before }: { now: CompositionPair; before: CompositionPair | null }) {
  const leanPct = 100 - now.fatPct;
  return (
    <Card className="px-[18px] pt-4 pb-[18px] md:px-6 flex flex-col gap-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-title text-zinc-50">{t('body.composition.title')}</h2>
        <span className="text-detail text-zinc-500">{formatCivilLong(now.date)}</span>
      </div>
      <div className="flex items-end justify-between gap-4">
        <Part label={t('body.composition.lean')} color={LEAN_HEX} kg={now.leanKg} pct={leanPct} />
        <Part label={t('body.composition.fat')} color={FAT_HEX} kg={now.fatKg} pct={now.fatPct} end />
      </div>
      <div
        role="img"
        aria-label={t('body.composition.bar', {
          lean: kgText(now.leanKg),
          leanShare: fixed(leanPct),
          fat: kgText(now.fatKg),
          fatShare: fixed(now.fatPct),
        })}
        className="flex h-3 md:h-3.5 rounded-full overflow-hidden gap-0.5"
      >
        <div style={{ width: `${leanPct}%`, background: LEAN_HEX }} />
        <div className="flex-1" style={{ background: FAT_HEX }} />
      </div>
      {before && (
        <div className="-mt-1 flex justify-between gap-4 text-caption text-zinc-500">
          <span>{t('body.composition.fromPrevious', { change: changeText(now.leanKg - before.leanKg, t('units.kg')) })}</span>
          <span>{t('body.composition.fromPrevious', { change: changeText(now.fatKg - before.fatKg, t('units.kg')) })}</span>
        </div>
      )}
    </Card>
  );
}

function Part({ label, color, kg, pct, end = false }: { label: string; color: string; kg: number; pct: number; end?: boolean }) {
  return (
    <div className={end ? 'text-right' : undefined}>
      <div className={`flex items-center gap-1.5 ${end ? 'justify-end flex-row-reverse' : ''}`}>
        <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
        <Label>{label}</Label>
      </div>
      <div className="mt-1.5 whitespace-nowrap">
        <span className="font-display text-number md:text-number-lg leading-tight text-zinc-50 tabular-nums">{fixed(kg)}</span>
        <span className="text-detail md:text-body-sm text-zinc-500"> {t('units.kg')}</span>
        <span className="hidden md:inline text-body-sm text-zinc-400"> · {percentText(pct)}</span>
      </div>
      <div className="md:hidden text-detail text-zinc-400">{percentText(pct)}</div>
    </div>
  );
}

/** How the span's weight trend splits between fat and lean, from weigh-ins the scale paired with body fat. */
function CompositionTrend({ comp }: { comp: BodyComposition | null }) {
  if (!comp) {
    return (
      <Card className="flex flex-col">
        <CardHead domain="body" title={t('body.compositionTrend.title')} hint={t('body.compositionTrend.hint', { skipped: 0 })} />
        <p className="px-5 pb-5 flex-1 flex items-center justify-center text-center text-caption text-zinc-600 min-h-[120px]">
          {t('body.compositionTrend.needsMore')}
        </p>
      </Card>
    );
  }
  const { weightKgPerWeek: weight, leanKgPerWeek: lean, fatKgPerWeek: fat } = comp;
  // A share of the change only reads when lean and fat both move the way the weight does.
  const sameWay = weight !== 0 && Math.sign(lean) === Math.sign(weight) && Math.sign(fat) === Math.sign(weight);
  const leanShare = sameWay ? (Math.abs(lean) / (Math.abs(lean) + Math.abs(fat))) * 100 : null;
  return (
    <Card className="flex flex-col">
      <CardHead
        domain="body"
        title={t('body.compositionTrend.title')}
        hint={t('body.compositionTrend.hint', { skipped: comp.rejectedForSource })}
        right={t('body.compositionTrend.readings', { pairs: comp.pairs, days: comp.spanDays })}
      />
      <div className="px-5 pb-5 flex-1 flex flex-col gap-3">
        <div>
          <Label>{t('body.compositionTrend.weight')}</Label>
          <div className="mt-1 font-display text-number-sm text-zinc-50 tabular-nums">
            {rich('body.compositionTrend.weightValue', {
              change: changeText(weight, '', 2),
              unit: (w) => <span className="font-sans text-detail font-normal text-zinc-500">{w}</span>,
            })}
          </div>
        </div>
        {leanShare !== null && (
          <div
            role="img"
            aria-label={t('body.compositionTrend.shareBar', { lean: Math.round(leanShare), fat: 100 - Math.round(leanShare) })}
            className="flex h-3 rounded-full overflow-hidden gap-0.5"
          >
            <div style={{ width: `${leanShare}%`, background: LEAN_HEX }} />
            <div className="flex-1" style={{ background: FAT_HEX }} />
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-detail text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: LEAN_HEX }} />
            {rich('body.compositionTrend.lean', { change: changeText(lean, '', 2), b: (w) => <span className="font-semibold text-zinc-100">{w}</span> })}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: FAT_HEX }} />
            {rich('body.compositionTrend.fat', { change: changeText(fat, '', 2), b: (w) => <span className="font-semibold text-zinc-100">{w}</span> })}
          </span>
        </div>
        <p className="mt-auto text-note leading-relaxed text-zinc-500">
          {t('body.compositionTrend.note')}
        </p>
      </div>
    </Card>
  );
}
