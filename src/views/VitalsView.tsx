import React, { useState } from 'react';
import { todayCivil } from '../lib/date';
import { formatCivil } from '../lib/date';
import { compareToBaseline, periodShift, series, stats, values, windowShift } from '../pipeline/derive';
import { DivergingBars, IntradayTrace, RangeBandChart, TrendChart } from '../charts';
import {
  BandPill, Card, CardHead, DOMAIN, Delta, EmptyState, Label, Row, Segmented, Value, fmtNum, CardSummary,
} from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';

export function VitalsView({ data }: { data: SyncResult }) {
  const days = data.days;
  const [span, setSpan] = useState<'14' | '30' | '90'>('30');
  const window = days.slice(-Number(span));

  const rhrAll = series(days, (d) => d.restingHr);
  const hrvAll = series(days, (d) => d.hrv);
  const hrvWin = series(window, (d) => d.hrv);
  const rhrWin = series(window, (d) => d.restingHr);
  const respWin = series(window, (d) => d.respiratoryRate);
  const tempWin = series(window, (d) => d.skinTempDeviationC);
  const vo2Win = series(window, (d) => d.vo2Max);

  const vo2All = series(days, (d) => d.vo2Max);
  const rhrCmp = compareToBaseline(rhrAll);
  const hrvCmp = compareToBaseline(hrvAll);
  const vo2Cmp = compareToBaseline(vo2All);

  const rhrRecorded = values(rhrAll).length;
  if (!rhrRecorded) {
    return (
      <Card>
        <EmptyState title="No vitals data in this window" detail="Metrics come from the health_metrics_and_measurements scope." />
      </Card>
    );
  }

  const latestTemp = tempWin.filter((p) => p.value !== null).at(-1);

  let last24hSamples = data.heartRateSamples;
  if (data.heartRateSamples && data.heartRateSamples.length > 0) {
    const latestMs = Date.parse(data.heartRateSamples.at(-1)!.iso);
    if (!isNaN(latestMs)) {
      last24hSamples = data.heartRateSamples.filter((s) => Date.parse(s.iso) >= latestMs - 24 * 60 * 60 * 1000);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <StatCard label="Heart rate variability" value={hrvCmp.value} unit="ms" cmp={hrvCmp} />
        <StatCard label="Resting heart rate" value={rhrCmp.value} unit="bpm" cmp={rhrCmp} />
        <StatCard label="Cardio fitness (VO₂ max)" value={vo2Cmp.value} unit="" cmp={vo2Cmp} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card className={data.heartRateSamples.length > 0 ? "lg:col-span-4" : "lg:col-span-12"}>
          <CardHead title="Vitals summary" hint={`${rhrRecorded} recorded days of ${days.length}.`} />
          <div className="px-5 pb-5">
            <Row label="Typical HRV">{fmtNum(stats(values(hrvAll))?.median, 0)} ms</Row>
            <Row label="Typical RHR">{fmtNum(stats(values(rhrAll))?.median, 0)} bpm</Row>
            <Row label="RHR 14d shift">
              <Delta value={periodShift(rhrAll, 14).delta} goodWhen="down" digits={1} suffix="bpm" />
            </Row>
            <Row label="VO₂max trend">
              <Delta value={windowShift(vo2Win, 14).delta} goodWhen="up" digits={1} />
            </Row>
          </div>
        </Card>
        {last24hSamples.length > 0 && (
          <Card className="lg:col-span-8">
            <CardHead
              domain="cardio"
              title="Intraday heart rate"
              hint={`The most recent ${last24hSamples.length} samples (up to 24 hours). This is a point-in-time snapshot, not a whole day.`}
                            right={
                <span className="text-[10px] text-zinc-500">
                  {formatCivil(last24hSamples[0].date)}
                </span>
              }
            />
            <div className="px-2 pb-3">
              <IntradayTrace samples={last24hSamples} color={DOMAIN.cardio.hex} height={160} />
            </div>
          </Card>
        )}
      </div>

      {/* Core trends */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your vitals over time
        </h2>
        <Segmented value={span} onChange={setSpan} size="sm" options={[{ id: '14', label: '14d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }]} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead
            domain="cardio"
            title="HRV baseline"
            hint="The grey band is 1.5× MAD around your 28-day median. Readings above it mean readiness; readings below mean load."
            right={<CardSummary data={hrvWin} color={DOMAIN.cardio.hex} unit="ms" />}
          />
          <div className="px-2 pb-3">
            <TrendChart
              series={hrvWin} color={DOMAIN.cardio.hex} height={200} unit="ms" area={false}
              baseline={hrvCmp.baseline ? { centre: hrvCmp.baseline, spread: hrvCmp.spread! } : null}
            />
          </div>
        </Card>
        <Card>
          <CardHead
            domain="cardio"
            title="RHR baseline"
            hint="For resting heart rate, lower is better. A spike above the grey band often precedes feeling ill."
            right={<CardSummary data={rhrWin} color={DOMAIN.cardio.hex} unit="bpm" />}
          />
          <div className="px-2 pb-3">
            <TrendChart
              series={rhrWin} color={DOMAIN.cardio.hex} height={200} unit="bpm" area={false}
              baseline={rhrCmp.baseline ? { centre: rhrCmp.baseline, spread: rhrCmp.spread! } : null}
            />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead
            domain="cardio"
            title="Blood oxygen"
            hint="The nightly average (line) inside the min/max envelope (shaded). Most wearables consider >95% normal."
            right={<CardSummary data={series(window, d => d.spo2?.avg ?? null)} color="#0ea5e9" unit="%" showMean={false} />}
          />
          <div className="px-2 pb-3">
            <RangeBandChart days={window} get={(d) => d.spo2 ? { avg: d.spo2.avg, low: d.spo2.ciLower, high: d.spo2.ciUpper } : null} color="#0ea5e9" height={170} domain={[85, 100]} />
          </div>
        </Card>
        <Card>
          <CardHead
            domain="cardio"
            title="Skin temperature"
            hint="Deviation from your rolling baseline. Absolute skin temp is highly dependent on sensor placement, so only the shift matters."
            right={<CardSummary 
              data={tempWin} 
              color={latestTemp?.value && latestTemp.value > 0 ? '#fb7185' : '#818cf8'} 
              unit="°C" 
              format={(v) => (v > 0 ? '+' : '') + fmtNum(v, 2)} 
              showMean={false}
            />}
          />
          <div className="px-2 pb-3 pt-2">
            <DivergingBars series={tempWin} />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <CardHead domain="cardio" title="Breathing rate" hint="Overnight average." right={<CardSummary data={respWin} color="#a855f7" unit="/min" />} />
          <div className="px-2 pb-3">
            <TrendChart series={respWin} color="#a855f7" unit="/min" height={150} format={(v) => fmtNum(v, 1)} />
          </div>
        </Card>
        <Card>
          <CardHead domain="cardio" title="Cardio fitness" hint="VO₂max estimate." right={<CardSummary data={vo2Win} color="#14b8a6" />} />
          <div className="px-2 pb-3">
            <TrendChart series={vo2Win} color="#14b8a6" height={150} format={(v) => fmtNum(v, 1)} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit, cmp }: { label: string; value: number | null; unit: string; cmp: ReturnType<typeof compareToBaseline> }) {
  const isToday = cmp.date === todayCivil();
  return (
    <Card>
      <div className="px-4 py-4">
        <Label>{label} <span className="text-[9px] font-normal lowercase tracking-normal">({isToday ? 'today' : 'latest'})</span></Label>
        <div className="mt-2"><Value value={value} size="lg" unit={unit} /></div>
        <div className="mt-2"><BandPill c={cmp} /></div>
      </div>
    </Card>
  );
}
