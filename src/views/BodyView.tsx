import React, { useState } from 'react';
import { formatCivil } from '../lib/date';
import { bodyComposition, stats, values, series, weightTrend, windowShift } from '../pipeline/derive';
import { TrendChart } from '../charts';
import { Card, CardHead, DOMAIN, Delta, EmptyState, Label, Row, Segmented, Value, fmtNum } from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';
import { bucketForSeries, groupSeries } from '../pipeline/aggregate';
import { SpanSelector, useSpan } from '../ui/span';

export function BodyView({ data }: { data: SyncResult }) {
  const days = data.days;
  const spanState = useSpan(data, '90');
  const window = spanState.days;

  const weightWin = series(window, (d) => d.weightKg);
  const fatWin = series(window, (d) => d.bodyFatPct);
  
  const weightValues = values(weightWin);
  const recorded = weightValues.length;
  
  const latestWeight = weightWin.filter(p => p.value !== null).at(-1);

  // Weigh-ins are sparse: keep every reading on the chart unless there are too many to show.
  const weightBucket = bucketForSeries(weightWin, window.length);
  const fatBucket = bucketForSeries(fatWin, window.length);

  if (!recorded) {
    return (
      <Card>
        <EmptyState
          title={spanState.loading ? 'Loading history…' : 'No body measurements in this span'}
          detail="Weight and body fat come from manual entries or smart scales. Older readings may be in a longer span."
        />
        <div className="flex justify-center pb-5">
          <SpanSelector state={spanState} />
        </div>
      </Card>
    );
  }

  // Theil–Sen, not OLS: hand-logged weight series are sparse and a single bad
  // scale reading should not tilt the headline trend. Same rule as the weight
  // insight: at least three readings spanning three weeks, or no trend at all.
  const trend = weightTrend(weightWin);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
        <Card className="lg:col-span-1">
          <div className="px-4 py-4">
            <Label>Latest weight</Label>
            <div className="mt-2">
              <Value value={latestWeight?.value ?? null} size="lg" unit="kg" />
            </div>
            <p className="text-[10px] text-zinc-500 mt-2">
              {latestWeight ? formatCivil(latestWeight.date) : 'No data'}
            </p>
          </div>
        </Card>
        <Card className="lg:col-span-1">
          <div className="px-4 py-4">
            <Label>Weekly trend</Label>
            <div className="mt-2">
              {/* Neutral on purpose: whether up or down is welcome is the person's call, not the app's. */}
              <Value value={trend ? Math.abs(trend.kgPerWeek) : null} size="lg" unit="kg/wk" digits={2} />
            </div>
            <p className="text-[10px] text-zinc-500 mt-2">
              {trend
                ? `${trend.kgPerWeek < 0 ? 'Down' : trend.kgPerWeek > 0 ? 'Up' : 'Flat'} across ${trend.readings} readings over ${trend.spanDays} days.`
                : 'A trend needs 3 readings spanning 3 weeks.'}
            </p>
          </div>
        </Card>
        <Card className="lg:col-span-2">
          <div className="px-4 py-4">
            <Label>Profile</Label>
            <div className="mt-3 space-y-0">
              <Row label="Height">
                {data.profile.heightCm ? `${fmtNum(data.profile.heightCm, 1)} cm` : '—'}
              </Row>
              <Row label="BMI">
                {latestWeight?.value && data.profile.heightCm 
                  ? fmtNum(latestWeight.value / Math.pow(data.profile.heightCm / 100, 2), 1)
                  : '—'}
              </Row>
            </div>
          </div>
        </Card>
      </div>

      {/* Core trends */}
      <div className="flex items-center justify-between px-1">
        <h2 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          Your body over time
        </h2>
        <SpanSelector state={spanState} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card className="lg:col-span-4">
          <CardHead title="Body summary" hint={`${recorded} readings in this window.`} />
          <div className="px-5 pb-5">
            <Row label="High">{fmtNum(stats(weightValues)?.max, 1)} kg</Row>
            <Row label="Low">{fmtNum(stats(weightValues)?.min, 1)} kg</Row>
            <Row label="Window change">
              <Delta value={windowShift(weightWin, 1).delta} digits={1} suffix="kg" />
            </Row>
          </div>
        </Card>
        <Card className="lg:col-span-8">
          <CardHead
            domain="body"
            title="Weight trend"
            hint="Hand-logged series are sparse; dashed lines connect readings separated by gaps."
          />
          <div className="px-2 pb-3">
            <TrendChart series={groupSeries(weightWin, weightBucket)} bucket={weightBucket} color={DOMAIN.body.hex} height={240} unit="kg" format={(v) => fmtNum(v, 1)} meanWindow={null} />
          </div>
        </Card>
      </div>
      
      {values(fatWin).length > 0 && (
        <Card>
          <CardHead domain="body" title="Body fat" />
          <div className="px-2 pb-3">
            <TrendChart series={groupSeries(fatWin, fatBucket)} bucket={fatBucket} color="#a1a1aa" height={160} unit="%" format={(v) => fmtNum(v, 1)} meanWindow={null} />
          </div>
        </Card>
      )}

      {(() => {
        // Is weight change *fat* change? Weight and fat% are separate lines
        // above; the decomposition is the insight. Pairing math + Theil–Sen
        // (robust for sparse manual logs); silent below 4 pairs / 28 days.
        const comp = bodyComposition(window);
        if (!comp) return null;
        const fmtSlope = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} kg/wk`;
        return (
          <Card>
            <CardHead
              domain="body"
              title="Composition"
              hint={`${comp.pairs} paired readings across ${comp.spanDays} days — each weight matched to one fat% reading from the same device within a day.${comp.rejectedForSource > 0 ? ` ${comp.rejectedForSource} pair${comp.rejectedForSource > 1 ? 's' : ''} skipped for mixing devices.` : ''}`}
            />
            <div className="px-5 pb-5">
              <Row label="Weight trend">{fmtSlope(comp.weightKgPerWeek)}</Row>
              <Row label="≈ Fat mass">{fmtSlope(comp.fatKgPerWeek)}</Row>
              <Row label="≈ Lean mass">{fmtSlope(comp.leanKgPerWeek)}</Row>
              <Row label={`Latest split (${formatCivil(comp.latest.date)})`}>
                {comp.latest.fatKg} kg fat · {comp.latest.leanKg} kg lean
              </Row>
              <p className="text-[10px] text-zinc-500 mt-3 leading-relaxed">
                Scale body-fat runs on bioimpedance: ±3–5 points absolute and it swings with hydration,
                so the split is approximate and the trend — measured on the same scale — is the part
                worth reading.
              </p>
            </div>
          </Card>
        );
      })()}
    </div>
  );
}
