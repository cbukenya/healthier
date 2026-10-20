import React, { useState } from 'react';
import { Activity, Droplet, Heart, Wind } from 'lucide-react';
import { formatCivilLong } from '../i18n/format';
import { t } from '../i18n';
import { rich } from '../i18n/react';
import {
  BASELINE_DAYS, BASELINE_MIN_READINGS, compareToBaseline, series, stats, values, windowShift, NOISE_FLOOR,
  type Comparison, type Point,
} from '../pipeline/derive';
import { DivergingBars, RangeBandChart, Spark, TrendChart } from '../charts';
import { BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Value, fmtNum } from '../ui/primitives';
import { Tile } from '../ui/Tile';
import { ChartChips } from '../ui/ChartChips';
import type { SyncResult } from '../pipeline/sync';
import { groupRange, groupSeries } from '../pipeline/aggregate';
import { emptyRecord } from '../pipeline/normalize';
import { SpanSelector, useSpan } from '../ui/span';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { InsightsCarousel } from '../components/InsightsCarousel';
import { usePageInsights, type Clock } from '../hooks/usePageInsights';
import { useCycle } from '../hooks/useCycle';
import type { IntradayDays } from '../pipeline/labs';
import type { DailyRecord } from '../types/health';
import { HeartRateCard } from './HeartRateCard';

const spo2Of = (d: DailyRecord) => (d.spo2 ? { avg: d.spo2.avg, low: d.spo2.ciLower, high: d.spo2.ciUpper } : null);

const BREATHING_HEX = 'var(--purple-500)';
const SPO2_HEX = 'var(--sky-500)';
const VO2_HEX = 'var(--teal-500)';

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

export function VitalsView({ data, clock, intraday }: { data: SyncResult; clock?: Clock; intraday?: IntradayDays }) {
  const days = data.days;
  const insights = usePageInsights(data, 'vitals', clock, intraday);
  const { judged } = useCycle();
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
  const hrvCmp = compareToBaseline(hrvAll, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
  const rhrCmp = compareToBaseline(rhrAll, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);
  const respCmp = compareToBaseline(respAll, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.respiratoryRate);
  const spo2Cmp = compareToBaseline(spo2All, BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.spo2);
  // With cycle tracking on, the same readings judged against this part of the cycle.
  const hrvCycle = judged && compareToBaseline(series(judged, (d) => d.hrv), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.hrv);
  const rhrCycle = judged && compareToBaseline(series(judged, (d) => d.restingHr), BASELINE_DAYS, BASELINE_MIN_READINGS, NOISE_FLOOR.restingHr);

  if (!values(rhrAll).length) {
    return (
      <Card>
        <EmptyState title={t('vitals.empty.title')} detail={t('vitals.empty.detail')} />
      </Card>
    );
  }

  // A tile's date note, when its reading isn't today's.
  const from = (date?: string) => (date && date !== today ? t('vitals.latest.from', { date: formatCivilLong(date) }) : null);

  // ── The trends: everything follows the span selector.
  const hrvWin = series(window, (d) => d.hrv);
  const rhrWin = series(window, (d) => d.restingHr);
  const respWin = series(window, (d) => d.respiratoryRate);
  const spo2Win = series(window, (d) => d.spo2?.avg ?? null);
  const tempWin = series(window, (d) => d.skinTempDeviationC);
  const vo2Win = series(window, (d) => d.vo2Max);
  const unit = (v: number | null, u: string, digits = 1) => (v === null ? null : `${fmtNum(v, digits)}${u}`);
  const signedC = (v: number | null) => (v === null ? null : `${v > 0 ? '+' : ''}${fmtNum(v, 2)} ${t('units.celsius')}`);
  const rhrChange = spanChange(rhrWin);
  const vo2Change = spanChange(vo2Win);

  const metrics: Metric[] = [
    {
      key: 'hrv', chip: t('vitals.trends.hrv.chip'), title: t('vitals.trends.hrv.title'), color: DOMAIN.cardio.hex,
      latest: unit(latestOf(hrvWin), ` ${t('units.ms')}`), average: unit(meanOf(hrvWin), ` ${t('units.ms')}`),
      hint: t('vitals.trends.hrv.hint'),
      chart: (
        <TrendChart
          series={groupSeries(hrvWin, bucket)} bucket={bucket} color={DOMAIN.cardio.hex} height={200} unit={t('units.ms')} area={false}
          baseline={usual(hrvCmp)}
        />
      ),
    },
    {
      key: 'rhr', chip: t('vitals.trends.restingHr.chip'), title: t('vitals.trends.restingHr.title'), color: DOMAIN.cardio.hex,
      latest: unit(latestOf(rhrWin), ` ${t('units.bpm')}`, 0), average: unit(meanOf(rhrWin), ` ${t('units.bpm')}`),
      change: rhrChange !== null && (
        <Delta value={rhrChange} goodWhen="down" digits={1} unit={` ${t('units.bpm')}`} phrase="vitals.trends.change" />
      ),
      hint: t('vitals.trends.restingHr.hint'),
      chart: (
        <TrendChart
          series={groupSeries(rhrWin, bucket)} bucket={bucket} color={DOMAIN.cardio.hex} height={200} unit={t('units.bpm')} area={false}
          baseline={usual(rhrCmp)}
        />
      ),
    },
    {
      key: 'resp', chip: t('vitals.trends.breathing.chip'), title: t('vitals.trends.breathing.title'), color: BREATHING_HEX,
      latest: unit(latestOf(respWin), ` ${t('units.perMinute')}`), average: unit(meanOf(respWin), ` ${t('units.perMinute')}`),
      hint: t('vitals.trends.breathing.hint'),
      chart: (
        <TrendChart
          series={groupSeries(respWin, bucket)} bucket={bucket} color={BREATHING_HEX} unit={t('units.perMinute')} height={180} area={false}
          format={(v) => fmtNum(v, 1)} baseline={usual(respCmp)}
        />
      ),
    },
    {
      key: 'spo2', chip: t('vitals.trends.bloodOxygen.chip'), title: t('vitals.trends.bloodOxygen.title'), color: SPO2_HEX,
      latest: unit(latestOf(spo2Win), t('units.percent')), average: unit(meanOf(spo2Win), t('units.percent')),
      hint: t('vitals.trends.bloodOxygen.hint'),
      chart: <RangeBandChart days={spo2Days} bucket={bucket} get={spo2Of} color={SPO2_HEX} height={180} domain={[85, 100]} />,
    },
    {
      key: 'temp', chip: t('vitals.trends.skinTemp.chip'), title: t('vitals.trends.skinTemp.title'), color: DOMAIN.cardio.hex,
      latest: signedC(latestOf(tempWin)), average: signedC(meanOf(tempWin)),
      hint: t('vitals.trends.skinTemp.hint'),
      chart: <div className="pt-2"><DivergingBars series={groupSeries(tempWin, bucket)} bucket={bucket} /></div>,
    },
    {
      key: 'vo2', chip: t('vitals.trends.vo2Max.chip'), title: t('vitals.trends.vo2Max.title'), color: VO2_HEX,
      latest: unit(latestOf(vo2Win), ''), average: unit(meanOf(vo2Win), ''),
      change: vo2Change !== null && <Delta value={vo2Change} goodWhen="up" digits={1} phrase="vitals.trends.change" />,
      hint: t('vitals.trends.vo2Max.hint'),
      // The estimate changes in steps; a rolling average would draw a gradual climb that never happened.
      chart: <TrendChart series={groupSeries(vo2Win, bucket)} bucket={bucket} color={VO2_HEX} height={180} meanWindow={null} format={(v) => fmtNum(v, 1)} />,
    },
  ];
  const shown = wide ? metrics : metrics.filter((m) => m.key === picked);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3">
        {/* The latest readings first, then today's heart rate. */}
        <div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            <Tile
              label={t('vitals.latest.hrv.label')}
              icon={<Activity size={14} className={DOMAIN.cardio.text} />}
              value={<Value value={hrvCmp.value} size="md" unit={t('units.ms')} />}
              pill={hrvCmp.value !== null && <BandPill c={hrvCmp} cycle={hrvCycle} />}
              chart={hrvCmp.value !== null && <Spark series={hrvAll.slice(-28)} color={DOMAIN.cardio.hex} height={28} baseline={usual(hrvCmp)} />}
              rows={[[t('vitals.latest.usual'), hrvCmp.baseline !== null && `${fmtNum(hrvCmp.baseline, 0)} ${t('units.ms')}`]]}
              empty={hrvCmp.value === null ? t('vitals.latest.hrv.empty') : null}
              note={from(hrvCmp.date)}
            />
            <Tile
              label={t('vitals.latest.restingHr.label')}
              icon={<Heart size={14} className={DOMAIN.cardio.text} />}
              value={<Value value={rhrCmp.value} size="md" unit={t('units.bpm')} />}
              pill={rhrCmp.value !== null && <BandPill c={rhrCmp} cycle={rhrCycle} />}
              chart={rhrCmp.value !== null && <Spark series={rhrAll.slice(-28)} color={DOMAIN.cardio.hex} height={28} baseline={usual(rhrCmp)} />}
              rows={[[t('vitals.latest.usual'), rhrCmp.baseline !== null && `${fmtNum(rhrCmp.baseline, 0)} ${t('units.bpm')}`]]}
              note={from(rhrCmp.date)}
            />
            <Tile
              label={t('vitals.latest.breathing.label')}
              icon={<Wind size={14} style={{ color: BREATHING_HEX }} />}
              value={<Value value={respCmp.value} size="md" digits={1} unit={t('units.perMinute')} />}
              pill={respCmp.value !== null && <BandPill c={respCmp} />}
              chart={respCmp.value !== null && <Spark series={respAll.slice(-28)} color={BREATHING_HEX} height={28} baseline={usual(respCmp)} />}
              rows={[[t('vitals.latest.usual'), respCmp.baseline !== null && `${fmtNum(respCmp.baseline)} ${t('units.perMinute')}`]]}
              empty={respCmp.value === null ? t('vitals.latest.breathing.empty') : null}
              note={from(respCmp.date)}
            />
            <Tile
              label={t('vitals.latest.bloodOxygen.label')}
              icon={<Droplet size={14} style={{ color: SPO2_HEX }} />}
              value={<Value value={spo2Cmp.value} size="md" digits={1} unit={t('units.percent')} />}
              pill={spo2Cmp.value !== null && <BandPill c={spo2Cmp} />}
              chart={spo2Cmp.value !== null && <Spark series={spo2All.slice(-28)} color={SPO2_HEX} height={28} baseline={usual(spo2Cmp)} />}
              rows={[[t('vitals.latest.usual'), spo2Cmp.baseline !== null && `${fmtNum(spo2Cmp.baseline)}${t('units.percent')}`]]}
              empty={spo2Cmp.value === null ? t('vitals.latest.bloodOxygen.empty') : null}
              note={from(spo2Cmp.date)}
            />
          </div>
        </div>

        {data.heartRateSamples.length > 0 && (
          <HeartRateCard samples={data.heartRateSamples} days={days} wide={wide} />
        )}
      </div>

      <div className="flex items-center justify-between px-1">
        <h2 className="text-section uppercase text-page-ink">
          {t('vitals.trends.title')}
        </h2>
        <SpanSelector state={spanState} />
      </div>

      {!wide && (
        <ChartChips label={t('vitals.trends.chips.label')} options={metrics.map((m) => ({ key: m.key, label: m.chip }))} value={picked} onChange={setPicked} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {shown.map((m) => (
          <Card key={m.key}>
            <CardHead
              title={m.title}
              right={m.latest && <span>{rich('vitals.trends.latest', { value: <span className="font-medium" style={{ color: m.color }}>{m.latest}</span> })}</span>}
              hint={
                <>
                  {(m.average || m.change) && (
                    <span className="block text-zinc-400">
                      {m.average && t('vitals.trends.average', { days: window.length, value: m.average })}
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

      <InsightsCarousel observations={insights} page="vitals" />
    </div>
  );
}
