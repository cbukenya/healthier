import React, { useMemo, useState } from 'react';
import { ChevronDown, Ruler, User, Weight } from 'lucide-react';
import { daysBetween, formatCivilLong } from '../lib/date';
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
import { SpanSelector, spanName, useSpan } from '../ui/span';
import { useHistory } from '../hooks/useHistory';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import type { IntradayDays } from '../pipeline/labs';

const LEAN_HEX = DOMAIN.body.hex;
const FAT_HEX = '#fbbf24';

type BodyChart = 'weight' | 'fat' | 'composition';

/** A number at a fixed count of decimals, so 108.0 kg doesn't read as 108. */
const fixed = (v: number, digits = 1) => v.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A change in a neutral voice, "↓ 1.7 kg": whether up or down is welcome is the person's call, not the app's. */
function changeText(delta: number, unit: string, digits = 1): string {
  const shown = Number(Math.abs(delta).toFixed(digits));
  const arrow = shown === 0 ? '' : delta > 0 ? '↑ ' : '↓ ';
  return `${arrow}${fixed(shown, digits)}${unit ? ` ${unit}` : ''}`;
}

/** How long ago a weigh-in was: weigh-ins are occasional, so its age matters. */
function ago(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30.4)} months ago`;
}

export function BodyView({ data, onGender, clock, intraday }: {
  data: SyncResult;
  /** Saves the person's gender; absent in demo mode, where it lasts as long as the page. */
  onGender?: (gender: Gender | null) => Promise<void>;
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
  const [gender, setGender] = useState<Gender | null>(data.profile.gender ?? null);

  // The newest readings, whatever span is on screen: long history once it has loaded, else the window.
  const all = history.days ?? data.days;
  const body = useMemo(() => latestBody(all), [all]);
  const today = data.days.at(-1)?.date ?? null;
  const heightCm = data.profile.heightCm;
  const bmi = (kg: number) => (heightCm ? kg / (heightCm / 100) ** 2 : null);

  const chooseGender = (next: Gender | null) => {
    const before = gender;
    setGender(next);
    onGender?.(next).catch((err) => {
      console.error('Failed to save gender:', err);
      setGender(before);
    });
  };

  const { latest, previous } = body;
  const profile = (
    <ProfileTile
      age={data.profile.age ?? null}
      heightCm={heightCm}
      gender={gender}
      onGender={chooseGender}
      className={`col-span-2 ${latest ? 'lg:col-span-1 lg:order-2' : 'lg:col-span-3'}`}
    />
  );

  if (!latest) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-3">{profile}</div>
        <Card>
          <EmptyState
            title={history.loading ? 'Loading history…' : 'No weigh-ins yet'}
            detail="Weight and body fat come from manual entries or smart scales."
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
      <CardHead domain="body" title={`${spanName(spanState)} summary`} />
      <div className="px-5 pb-4 md:pb-5">
        <Row dense={!wide} label="Weigh-ins">{weighIns.length || (spanState.loading ? 'Loading…' : `None in these ${window.length} days`)}</Row>
        {trend && <Row dense={!wide} label="Trend">{changeText(trend.kgPerWeek, 'kg a week', 2)}</Row>}
        {highest && (
          <Row dense={!wide} label="Highest">
            {fixed(highest.value)} kg<span className="text-zinc-500"> · {formatCivilLong(highest.date)}</span>
          </Row>
        )}
        {lowest && (
          <Row dense={!wide} label="Lowest">
            {fixed(lowest.value)} kg<span className="text-zinc-500"> · {formatCivilLong(lowest.date)}</span>
          </Row>
        )}
        {weighIns.length >= 2 && (
          <Row dense={!wide} label="First to last">{changeText(weighIns[weighIns.length - 1].value - weighIns[0].value, 'kg')}</Row>
        )}
      </div>
    </Card>
  );
  const weightCard = (
    <Card className="lg:col-span-8">
      <CardHead
        domain="body"
        title="Weight"
        hint="Each dot is a weigh-in; dashed lines join readings with a gap between them."
        right={latestInSpan && <span>latest <span className={DOMAIN.body.text}>{fixed(latestInSpan.value)} kg</span></span>}
      />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(weightWin, weightBucket)} bucket={weightBucket} color={DOMAIN.body.hex} height={wide ? 240 : 210} unit="kg" format={(v) => fmtNum(v, 1)} meanWindow={null} />
      </div>
    </Card>
  );
  const fatCard = everFat && (
    <Card>
      <CardHead domain="body" title="Body fat" right={latestFat !== undefined && <span>latest <span className="text-zinc-300">{fixed(latestFat)}%</span></span>} />
      <div className="px-2 pb-3">
        <TrendChart series={groupSeries(fatWin, fatBucket)} bucket={fatBucket} color="#a1a1aa" height={160} unit="%" format={(v) => fmtNum(v, 1)} meanWindow={null} />
      </div>
    </Card>
  );
  const compCard = everPaired && <CompositionTrend comp={comp} />;
  const charts: { key: BodyChart; label: string; card: React.ReactNode }[] = [
    { key: 'weight', label: 'Weight', card: weightCard },
    ...(fatCard ? [{ key: 'fat' as const, label: 'Body fat', card: fatCard }] : []),
    ...(compCard ? [{ key: 'composition' as const, label: 'Composition', card: compCard }] : []),
  ];
  const shownChart = charts.find((c) => c.key === chart) ?? charts[0];

  return (
    <div className="space-y-3">
      {/* Who you are and the newest readings, whatever span is chosen below. On wide screens, profile, weight and BMI share a row. */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-3">
        {profile}
        <div className="col-span-2 lg:col-span-3 lg:order-1 flex items-baseline justify-between gap-2 px-1">
          <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Latest readings</h2>
          <span className="text-[11px] text-zinc-500">
            from {formatCivilLong(latest.date)} · <span className={daysOld > 14 ? 'text-amber-400' : undefined}>{ago(daysOld)}</span>
          </span>
        </div>
        <div className="min-w-0 lg:order-3 grid">
          <Tile
            label="Weight"
            icon={<Weight size={14} className={DOMAIN.body.text} />}
            value={<Value value={latest.value} size="md" digits={1} unit="kg" />}
            chart={body.weighIns.length > 1 && <Spark series={body.weighIns} color={DOMAIN.body.hex} height={28} />}
            rows={[['From previous', previous && changeText(latest.value - previous.value, 'kg')]]}
          />
        </div>
        <div className="min-w-0 lg:order-4 grid">
          <Tile
            label="BMI"
            icon={<Ruler size={14} className={DOMAIN.body.text} />}
            value={<Value value={latestBmi} size="md" digits={1} />}
            chart={latestBmi !== null && body.weighIns.length > 1 && <Spark series={bmiTrail} color={DOMAIN.body.hex} height={28} />}
            rows={[['From previous', previous && latestBmi !== null && changeText(latestBmi - bmi(previous.value)!, '')]]}
            empty={latestBmi === null ? 'Needs your height, which comes from Google Health.' : null}
          />
        </div>
      </div>

      {body.composition && <CompositionNow now={body.composition} before={body.previousComposition} />}

      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Your body over time</h2>
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
          {charts.length > 1 && <ChartChips label="Chart" options={charts} value={shownChart.key} onChange={setChart} />}
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
  const label = 'text-[9.5px] font-semibold uppercase tracking-[0.14em] text-zinc-500 lg:text-[12px] lg:font-normal lg:normal-case lg:tracking-normal';
  const value = 'text-[17px] lg:text-[18px] font-semibold text-zinc-50 tabular-nums';
  return (
    <section aria-label="Profile" className={`min-w-0 bg-[#0c0c0e] border border-[#1e1e22] rounded-[18px] p-3.5 lg:p-4 flex flex-col gap-2.5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <Label>Profile</Label>
        <User size={14} className="text-zinc-400" />
      </div>
      <dl className="grid grid-cols-3 lg:grid-cols-1 gap-2 lg:flex-1 lg:content-around">
        <div className={fact}>
          <dt className={label}>Age</dt>
          <dd className={value} title={age === null ? 'From your Google Health profile' : undefined}>{age ?? '—'}</dd>
        </div>
        <div className={fact}>
          <dt className={label}>Gender</dt>
          <dd className="relative inline-flex items-center self-start lg:self-auto">
            <select
              aria-label="Gender"
              value={gender ?? ''}
              onChange={(e) => onGender((e.target.value || null) as Gender | null)}
              className={`appearance-none bg-transparent py-0.5 pr-4 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ${value} ${gender ? '' : '!text-zinc-500'}`}
            >
              <option value="" className="bg-zinc-900 text-zinc-300">Not set</option>
              <option value="female" className="bg-zinc-900 text-zinc-100">Female</option>
              <option value="male" className="bg-zinc-900 text-zinc-100">Male</option>
              <option value="other" className="bg-zinc-900 text-zinc-100">Other</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute right-0 text-zinc-500" />
          </dd>
        </div>
        <div className={fact}>
          <dt className={label}>Height</dt>
          <dd className={value}>
            {heightCm ? <>{fmtNum(heightCm, 1)} <span className="text-[11px] font-medium text-zinc-500">cm</span></> : '—'}
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
        <h2 className="text-[15px] font-semibold text-zinc-50">Body composition</h2>
        <span className="text-[12px] text-zinc-500">{formatCivilLong(now.date)}</span>
      </div>
      <div className="flex items-end justify-between gap-4">
        <Part label="Lean mass" color={LEAN_HEX} kg={now.leanKg} pct={leanPct} />
        <Part label="Body fat" color={FAT_HEX} kg={now.fatKg} pct={now.fatPct} end />
      </div>
      <div
        role="img"
        aria-label={`${fixed(now.leanKg)} kg lean mass, ${fixed(leanPct)} percent; ${fixed(now.fatKg)} kg body fat, ${fixed(now.fatPct)} percent`}
        className="flex h-3 md:h-3.5 rounded-full overflow-hidden gap-0.5"
      >
        <div style={{ width: `${leanPct}%`, background: LEAN_HEX }} />
        <div className="flex-1" style={{ background: FAT_HEX }} />
      </div>
      {before && (
        <div className="-mt-1 flex justify-between gap-4 text-[11.5px] text-zinc-500">
          <span>{changeText(now.leanKg - before.leanKg, 'kg')} from previous</span>
          <span>{changeText(now.fatKg - before.fatKg, 'kg')} from previous</span>
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
        <span className="text-[24px] md:text-[30px] leading-tight font-semibold text-zinc-50 tabular-nums">{fixed(kg)}</span>
        <span className="text-[12px] md:text-[13px] text-zinc-500"> kg</span>
        <span className="hidden md:inline text-[13px] text-zinc-400"> · {fixed(pct)}%</span>
      </div>
      <div className="md:hidden text-[12px] text-zinc-400">{fixed(pct)}%</div>
    </div>
  );
}

/** How the span's weight trend splits between fat and lean, from weigh-ins the scale paired with body fat. */
function CompositionTrend({ comp }: { comp: BodyComposition | null }) {
  if (!comp) {
    return (
      <Card className="flex flex-col">
        <CardHead domain="body" title="Composition trend" hint="From weigh-ins where the scale also measured body fat." />
        <p className="px-5 pb-5 flex-1 flex items-center justify-center text-center text-[11px] text-zinc-600 min-h-[120px]">
          Needs four of them across at least four weeks of this span.
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
        title="Composition trend"
        hint={`From weigh-ins where the scale also measured body fat.${comp.rejectedForSource > 0 ? ` ${comp.rejectedForSource} skipped for mixing devices.` : ''}`}
        right={`${comp.pairs} paired readings · ${comp.spanDays} days`}
      />
      <div className="px-5 pb-5 flex-1 flex flex-col gap-3">
        <div>
          <Label>Weight trend</Label>
          <div className="mt-1 text-[22px] font-semibold text-zinc-50 tabular-nums">
            {changeText(weight, '', 2)} <span className="text-[12px] font-normal text-zinc-500">kg a week</span>
          </div>
        </div>
        {leanShare !== null && (
          <div role="img" aria-label={`Lean mass is ${Math.round(leanShare)} percent of the change, fat ${100 - Math.round(leanShare)} percent`} className="flex h-3 rounded-full overflow-hidden gap-0.5">
            <div style={{ width: `${leanShare}%`, background: LEAN_HEX }} />
            <div className="flex-1" style={{ background: FAT_HEX }} />
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[12px] text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: LEAN_HEX }} />
            Lean <span className="font-semibold text-zinc-100">{changeText(lean, '', 2)}</span> kg a week
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px]" style={{ background: FAT_HEX }} />
            Fat <span className="font-semibold text-zinc-100">{changeText(fat, '', 2)}</span> kg a week
          </span>
        </div>
        <p className="mt-auto text-[10.5px] leading-relaxed text-zinc-500">
          Scale body fat is approximate, so its trend on the same scale says more than any one reading.
        </p>
      </div>
    </Card>
  );
}
