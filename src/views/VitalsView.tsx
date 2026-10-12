import React, { useState } from 'react';
import { Activity, Droplet, Heart, Wind } from 'lucide-react';
import { formatCivil, formatCivilLong, formatClock } from '../lib/date';
import {
  compareToBaseline, series, stats, values, windowShift, NOISE_FLOOR,
  type Comparison, type Point,
} from '../pipeline/derive';
import { DivergingBars, IntradayTrace, RangeBandChart, Spark, TrendChart } from '../charts';
import { BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Value, fmtNum } from '../ui/primitives';
import { Tile } from '../ui/Tile';
import { ChartChips } from '../ui/ChartChips';
import type { SyncResult } from '../pipeline/sync';
import { groupRange, groupSeries } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { SpanSelector, useSpan } from '../ui/span';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { DailyRecord, IntradaySample } from '../types/health';

const spo2Of = (d: DailyRecord) => (d.spo2 ? { avg: d.spo2.avg, low: d.spo2.ciLower, high: d.spo2.ciUpper } : null);

const BREATHING_HEX = '#a855f7';
const SPO2_HEX = '#0ea5e9';
const VO2_HEX = '#14b8a6';

/** A comparison's usual range, for the band behind a trend line. */
const usual = (c: Comparison) => (c.baseline !== null && c.spread !== null ? { centre: c.baseline, spread: c.spread } : null);
const latestOf = (s: Point[]) => [...s].reverse().find((p) => p.value !== null)?.value ?? null;
const meanOf = (s: Point[]) => stats(values(s))?.mean ?? null;
/** The selected span's last week against its first, once it holds two weeks of readings. */
const spanChange = (s: Point[]) => (values(s).length >= 14 ? windowShift(s, 7).delta : null);

type MetricKey = 'hrv' | 'rhr' | 'resp' | 'spo2' | 'temp' | 'vo2';

interface Metric {
  key: MetricKey;
  /** Its name on a phone's chip. */
  chip: string;
  title: string;
  color: string;
  latest: string | null;
  average: string | null;
  change?: React.ReactNode;
  hint: string;
  chart: React.ReactNode;
}

export function VitalsView({ data }: { data: SyncResult }) {
  const days = data.days;
  const today = days.at(-1)?.date ?? null;
  const spanState = useSpan(data, '30');
  const { days: window, bucket } = spanState;
  // A phone shows one trend at a time behind chips; wider screens show them all.
  const wide = useMediaQuery('(min-width: 768px)');
  const [picked, setPicked] = useState<MetricKey>('hrv');

  // Grouped spans: the week's average SpO₂, with its lowest low and highest high.
  const spo2Days = bucket === 'day'
    ? window
    : groupRange(window, bucket, spo2Of).map((g) => ({
        ...emptyRecord(g.date),
        spo2: g.value && { avg: g.value.avg, ciLower: g.value.low, ciUpper: g.value.high, rollingAvgSd: null },
      }));

  // The latest readings, each against its last four weeks: the same comparisons Today makes.
  const hrvAll = series(days, (d) => d.hrv);
  const rhrAll = series(days, (d) => d.restingHr);
  const respAll = series(days, (d) => d.respiratoryRate);
  const spo2All = series(days, (d) => d.spo2?.avg ?? null);
  const hrvCmp = compareToBaseline(hrvAll, 28, 8, NOISE_FLOOR.hrv);
  const rhrCmp = compareToBaseline(rhrAll, 28, 8, NOISE_FLOOR.restingHr);
  const respCmp = compareToBaseline(respAll, 28, 8, NOISE_FLOOR.respiratoryRate);
  const spo2Cmp = compareToBaseline(spo2All, 28, 8, NOISE_FLOOR.spo2);

  if (!values(rhrAll).length) {
    return (
      <Card>
        <EmptyState title="No vitals data in this window" detail="Metrics come from the health_metrics_and_measurements scope." />
      </Card>
    );
  }

  let last24hSamples = data.heartRateSamples;
  if (data.heartRateSamples && data.heartRateSamples.length > 0) {
    const latestMs = Date.parse(data.heartRateSamples.at(-1)!.iso);
    if (!isNaN(latestMs)) {
      last24hSamples = data.heartRateSamples.filter((s) => Date.parse(s.iso) >= latestMs - 24 * 60 * 60 * 1000);
    }
  }

  // A tile's date note, when its reading isn't today's.
  const from = (date?: string) => (date && date !== today ? `From ${formatCivilLong(date)}` : null);

  // ── The trends: everything follows the span selector.
  const hrvWin = series(window, (d) => d.hrv);
  const rhrWin = series(window, (d) => d.restingHr);
  const respWin = series(window, (d) => d.respiratoryRate);
  const spo2Win = series(window, (d) => d.spo2?.avg ?? null);
  const tempWin = series(window, (d) => d.skinTempDeviationC);
  const vo2Win = series(window, (d) => d.vo2Max);
  const unit = (v: number | null, u: string, digits = 1) => (v === null ? null : `${fmtNum(v, digits)}${u}`);
  const signedC = (v: number | null) => (v === null ? null : `${v > 0 ? '+' : ''}${fmtNum(v, 2)} °C`);
  const rhrChange = spanChange(rhrWin);
  const vo2Change = spanChange(vo2Win);

  const metrics: Metric[] = [
    {
      key: 'hrv', chip: 'HRV', title: 'HRV', color: DOMAIN.cardio.hex,
      latest: unit(latestOf(hrvWin), ' ms'), average: unit(meanOf(hrvWin), ' ms'),
      hint: 'A night outside your usual range is unusual for you, in either direction.',
      chart: (
        <TrendChart
          series={groupSeries(hrvWin, bucket)} bucket={bucket} color={DOMAIN.cardio.hex} height={200} unit="ms" area={false}
          baseline={usual(hrvCmp)}
        />
      ),
    },
    {
      key: 'rhr', chip: 'Resting HR', title: 'Resting heart rate', color: DOMAIN.cardio.hex,
      latest: unit(latestOf(rhrWin), ' bpm', 0), average: unit(meanOf(rhrWin), ' bpm'),
      change: rhrChange !== null && (
        <Delta value={rhrChange} goodWhen="down" digits={1} unit=" bpm" suffix="from the first week to the last" />
      ),
      hint: 'Nights above your usual range often follow hard training, alcohol, heat, short sleep or a cold coming on.',
      chart: (
        <TrendChart
          series={groupSeries(rhrWin, bucket)} bucket={bucket} color={DOMAIN.cardio.hex} height={200} unit="bpm" area={false}
          baseline={usual(rhrCmp)}
        />
      ),
    },
    {
      key: 'resp', chip: 'Breathing', title: 'Breathing rate', color: BREATHING_HEX,
      latest: unit(latestOf(respWin), ' /min'), average: unit(meanOf(respWin), ' /min'),
      hint: 'Breaths per minute, averaged over the night.',
      chart: (
        <TrendChart
          series={groupSeries(respWin, bucket)} bucket={bucket} color={BREATHING_HEX} unit="/min" height={180} area={false}
          format={(v) => fmtNum(v, 1)} baseline={usual(respCmp)}
        />
      ),
    },
    {
      key: 'spo2', chip: 'Blood oxygen', title: 'Blood oxygen', color: SPO2_HEX,
      latest: unit(latestOf(spo2Win), '%'), average: unit(meanOf(spo2Win), '%'),
      hint: 'Each night’s average, inside its low-to-high range. Most wearables treat 95% and up as normal.',
      chart: <RangeBandChart days={spo2Days} bucket={bucket} get={spo2Of} color={SPO2_HEX} height={180} domain={[85, 100]} />,
    },
    {
      key: 'temp', chip: 'Skin temp', title: 'Skin temperature', color: DOMAIN.cardio.hex,
      latest: signedC(latestOf(tempWin)), average: signedC(meanOf(tempWin)),
      hint: 'Change from your own baseline, in °C. Only the shift matters, not the reading itself.',
      chart: <div className="pt-2"><DivergingBars series={groupSeries(tempWin, bucket)} bucket={bucket} /></div>,
    },
    {
      key: 'vo2', chip: 'VO₂ max', title: 'Cardio fitness', color: VO2_HEX,
      latest: unit(latestOf(vo2Win), ''), average: unit(meanOf(vo2Win), ''),
      change: vo2Change !== null && <Delta value={vo2Change} goodWhen="up" digits={1} suffix="from the first week to the last" />,
      hint: 'Your watch’s VO₂ max estimate. It moves slowly, over weeks.',
      // The estimate changes in steps; a rolling average would draw a gradual climb that never happened.
      chart: <TrendChart series={groupSeries(vo2Win, bucket)} bucket={bucket} color={VO2_HEX} height={180} meanWindow={null} format={(v) => fmtNum(v, 1)} />,
    },
  ];
  const shown = wide ? metrics : metrics.filter((m) => m.key === picked);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3">
        {/* Desktop leads with the tiles; a phone leads with today's heart rate. */}
        <div className="order-2 md:order-1 space-y-2.5">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Latest readings</h2>
            <span className="text-[11px] text-zinc-500">against your last 4 weeks</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            <Tile
              label="HRV"
              icon={<Activity size={14} className={DOMAIN.cardio.text} />}
              value={<Value value={hrvCmp.value} size="md" unit="ms" />}
              pill={hrvCmp.value !== null && <BandPill c={hrvCmp} />}
              chart={hrvCmp.value !== null && <Spark series={hrvAll.slice(-28)} color={DOMAIN.cardio.hex} height={28} baseline={usual(hrvCmp)} />}
              rows={[['Usual', hrvCmp.baseline !== null && `${fmtNum(hrvCmp.baseline, 0)} ms`]]}
              empty={hrvCmp.value === null ? 'No HRV readings yet' : null}
              note={from(hrvCmp.date)}
            />
            <Tile
              label="Resting HR"
              icon={<Heart size={14} className={DOMAIN.cardio.text} />}
              value={<Value value={rhrCmp.value} size="md" unit="bpm" />}
              pill={rhrCmp.value !== null && <BandPill c={rhrCmp} />}
              chart={rhrCmp.value !== null && <Spark series={rhrAll.slice(-28)} color={DOMAIN.cardio.hex} height={28} baseline={usual(rhrCmp)} />}
              rows={[['Usual', rhrCmp.baseline !== null && `${fmtNum(rhrCmp.baseline, 0)} bpm`]]}
              note={from(rhrCmp.date)}
            />
            <Tile
              label="Breathing"
              icon={<Wind size={14} style={{ color: BREATHING_HEX }} />}
              value={<Value value={respCmp.value} size="md" digits={1} unit="/min" />}
              pill={respCmp.value !== null && <BandPill c={respCmp} />}
              chart={respCmp.value !== null && <Spark series={respAll.slice(-28)} color={BREATHING_HEX} height={28} baseline={usual(respCmp)} />}
              rows={[['Usual', respCmp.baseline !== null && `${fmtNum(respCmp.baseline)} /min`]]}
              empty={respCmp.value === null ? 'No breathing readings yet' : null}
              note={from(respCmp.date)}
            />
            <Tile
              label="Blood oxygen"
              icon={<Droplet size={14} style={{ color: SPO2_HEX }} />}
              value={<Value value={spo2Cmp.value} size="md" digits={1} unit="%" />}
              pill={spo2Cmp.value !== null && <BandPill c={spo2Cmp} />}
              chart={spo2Cmp.value !== null && <Spark series={spo2All.slice(-28)} color={SPO2_HEX} height={28} baseline={usual(spo2Cmp)} />}
              rows={[['Usual', spo2Cmp.baseline !== null && `${fmtNum(spo2Cmp.baseline)}%`]]}
              empty={spo2Cmp.value === null ? 'No blood oxygen readings yet' : null}
              note={from(spo2Cmp.date)}
            />
          </div>
        </div>

        {last24hSamples.length > 0 && <HeartRateCard samples={last24hSamples} tall={wide} className="order-1 md:order-2" />}
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your vitals over time
        </h2>
        <SpanSelector state={spanState} />
      </div>

      {!wide && (
        <ChartChips label="Metric" options={metrics.map((m) => ({ key: m.key, label: m.chip }))} value={picked} onChange={setPicked} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {shown.map((m) => (
          <Card key={m.key}>
            <CardHead
              domain="cardio"
              title={m.title}
              right={m.latest && <span>latest <span className="font-medium" style={{ color: m.color }}>{m.latest}</span></span>}
              hint={
                <>
                  {(m.average || m.change) && (
                    <span className="block text-zinc-400">
                      {m.average && `${window.length}-day average ${m.average}`}
                      {m.average && m.change && ' · '}
                      {m.change}
                    </span>
                  )}
                  <span className="block mt-1">{m.hint}</span>
                </>
              }
            />
            <div className="px-2 pb-3">{m.chart}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** The last 24 hours of heart rate: its lowest, average and highest, then the trace. */
function HeartRateCard({ samples, tall, className = '' }: { samples: IntradaySample[]; tall: boolean; className?: string }) {
  const bpm = samples.map((s) => s.value);
  const last = samples[samples.length - 1];
  const stat = (label: string, v: number) => (
    <div>
      <dt className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-[18px] font-semibold text-zinc-50 tabular-nums">
        {v} <span className="text-[11px] font-medium text-zinc-500">bpm</span>
      </dd>
    </div>
  );
  return (
    <Card className={className}>
      <div className="px-5 pt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-zinc-100 tracking-tight flex items-center gap-2">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${DOMAIN.cardio.bg} ring-2 ${DOMAIN.cardio.ring}`} />
            Heart rate
          </h3>
          <p className="text-[11px] text-zinc-500 mt-1.5">
            {formatCivil(last.date)} · last 24 hours · {samples.length.toLocaleString('en-GB')} readings, the latest at {formatClock(last.minutesOfDay)}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-6">
          {stat('Lowest', Math.min(...bpm))}
          {stat('Average', Math.round(bpm.reduce((a, b) => a + b, 0) / bpm.length))}
          {stat('Highest', Math.max(...bpm))}
        </dl>
      </div>
      <div className="px-2 pt-2 pb-3">
        <IntradayTrace samples={samples} color={DOMAIN.cardio.hex} height={tall ? 190 : 150} />
      </div>
    </Card>
  );
}
