import React, { useState } from 'react';
import { formatCivil } from '../lib/date';
import { bodyComposition, slopePerDay, stats, theilSen, values, series, windowShift } from '../pipeline/derive';
import { TrendChart } from '../charts';
import { Card, CardHead, DOMAIN, Delta, EmptyState, Label, Row, Segmented, Value, fmtNum } from '../ui/primitives';
import type { SyncResult } from '../pipeline/sync';

export function BodyView({ data }: { data: SyncResult }) {
  const days = data.days;
  const [span, setSpan] = useState<'30' | '90' | '365'>('90');
  
  const windowDays = Number(span);
  const window = days.slice(-Math.min(days.length, windowDays));

  const weightWin = series(window, (d) => d.weightKg);
  const fatWin = series(window, (d) => d.bodyFatPct);
  
  const weightValues = values(weightWin);
  const recorded = weightValues.length;
  
  const latestWeight = weightWin.filter(p => p.value !== null).at(-1);

  if (!recorded) {
    return (
      <Card>
        <EmptyState title="No body measurements" detail="Weight and body fat come from manual entries or smart scales." />
      </Card>
    );
  }

  // Theil–Sen, not OLS: hand-logged weight series are sparse and a single bad
  // scale reading should not tilt the headline trend.
  const weightPairs = weightWin
    .map((p, i) => (p.value === null ? null : { x: i, y: p.value }))
    .filter((v): v is { x: number; y: number } => v !== null);
  const slope = theilSen(weightPairs) ?? slopePerDay(weightWin);
  const weeklyChange = slope !== null ? slope * 7 : null;

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
              <Value 
                value={weeklyChange !== null ? Math.abs(weeklyChange) : null} 
                size="lg" 
                unit="kg/wk" 
                digits={2} 
                tone={weeklyChange !== null && weeklyChange < 0 ? "text-emerald-400" : "text-amber-400"}
              />
            </div>
            <p className="text-[10px] text-zinc-500 mt-2">
              {weeklyChange !== null 
                ? (weeklyChange < 0 ? 'Trending down.' : 'Trending up.') 
                : 'Not enough data for trend.'}
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
        <Segmented value={span} onChange={setSpan} size="sm" options={[{ id: '30', label: '30d' }, { id: '90', label: '90d' }, { id: '365', label: '365d' }]} />
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
            <TrendChart series={weightWin} color={DOMAIN.body.hex} height={240} unit="kg" format={(v) => fmtNum(v, 1)} meanWindow={null} />
          </div>
        </Card>
      </div>
      
      {values(fatWin).length > 0 && (
        <Card>
          <CardHead domain="body" title="Body fat" />
          <div className="px-2 pb-3">
            <TrendChart series={fatWin} color="#a1a1aa" height={160} unit="%" format={(v) => fmtNum(v, 1)} meanWindow={null} />
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
