import React from 'react';
import type { SyncResult } from '../pipeline/sync';
import {
  completedIntradayDays, dipping, entropyShift, nocturnalTachycardia, sdbScreen, calculateOffSignals,
  type IntradayDays,
} from '../pipeline/labs';

/**
 * 🧪 Labs: experimental views of multi-week patterns in wearable data.
 *
 * Wording rule for this file: describe what was observed, against the person's
 * own usual range, with everyday explanations. Never name a condition, never
 * present a card as screening, detection or an all-clear, and suggest a
 * clinician only alongside symptoms. Healthier is a wellness tool, not a
 * medical device (see the README's intended-purpose statement).
 *
 * Each card shows the real numbers it is watching even when quiet; the rose
 * treatment is confined to the one callout that states what was seen.
 */

const fmtClock = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

// ── shared chrome ─────────────────────────────────────────────────────────

function Badge({ kind, children }: { kind: 'monitor' | 'collect' | 'alert'; children: React.ReactNode }) {
  const cls =
    kind === 'alert'
      ? 'text-rose-300 border-rose-500/40 bg-rose-500/10'
      : kind === 'collect'
        ? 'text-amber-300 border-amber-400/30 bg-amber-400/5'
        : 'text-emerald-300 border-emerald-400/25 bg-emerald-400/5';
  return (
    <span className={`shrink-0 text-[9px] font-bold tracking-[0.14em] uppercase px-2.5 py-1 rounded-full border ${cls}`}>
      {children}
    </span>
  );
}

function LabCard({
  title, gloss, badge, children, footer,
}: {
  title: string; gloss: string; badge: React.ReactNode; children: React.ReactNode; footer: string;
}) {
  return (
    <section className="bg-[#0c0c0e] border border-zinc-800/80 rounded-2xl p-5 flex flex-col min-h-[300px]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[14.5px] font-semibold text-zinc-100 tracking-tight">
          {title}
          <span className="ml-2 text-[10.5px] font-medium text-zinc-500">({gloss})</span>
        </h3>
        {badge}
      </div>
      <div className="flex-1 flex flex-col">{children}</div>
      <p className="mt-3 text-[9.5px] leading-relaxed text-zinc-600">{footer}</p>
    </section>
  );
}

function Explainer({ children }: { children: React.ReactNode }) {
  return <p className="mt-2.5 text-[11.5px] leading-relaxed text-zinc-400">{children}</p>;
}

function Stats({ items }: { items: { k: string; v: React.ReactNode; sub?: string }[] }) {
  return (
    <div className="mt-3.5 flex flex-wrap gap-x-5 gap-y-1.5 px-3 py-2.5 rounded-xl bg-[#111114] border border-zinc-800/60">
      {items.map((it) => (
        <div key={it.k} className="flex flex-col gap-0.5">
          <span className="text-[9px] font-semibold tracking-[0.12em] uppercase text-zinc-600">{it.k}</span>
          <span className="text-[12.5px] font-semibold text-zinc-200 tabular-nums">
            {it.v}
            {it.sub && <span className="ml-1 text-[10px] font-medium text-zinc-500">{it.sub}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyEvidence({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex-1 min-h-[64px] border-[1.5px] border-dashed border-zinc-800 rounded-xl grid place-items-center p-4">
      <p className="text-[11px] leading-relaxed text-zinc-600 text-center max-w-md">{children}</p>
    </div>
  );
}

function Evidence({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex-1 rounded-xl border border-zinc-800 bg-[#101013] p-3.5">{children}</div>
  );
}

/** The one element that carries the alert treatment: the finding itself. */
function Callout({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <div
      className="mt-2.5 rounded-[10px] border px-3.5 py-3 text-[11px] leading-relaxed text-zinc-300"
      style={{
        borderColor: 'rgba(244,63,94,.22)',
        backgroundColor: '#141114',
        backgroundImage: 'radial-gradient(140% 140% at 100% 100%, rgba(244,63,94,.30) 0%, rgba(244,63,94,.09) 45%, rgba(244,63,94,0) 72%)',
      }}
    >
      <b className="text-rose-300 font-semibold">{lead}</b> {children}
    </div>
  );
}

// ── card 1 · SDB screen ───────────────────────────────────────────────────

function SdbCard({ data }: { data: SyncResult }) {
  const r = sdbScreen(data.days);
  const badge =
    r.status === 'pattern' ? <Badge kind="alert">{r.firedCount} nights · last 14</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {r.nightsInWindow} of {r.nightsWanted} nights</Badge>
        : <Badge kind="monitor">No pattern</Badge>;

  return (
    <LabCard
      title="Night breathing & oxygen" gloss="how your night signals move together" badge={badge}
      footer="Uses nightly average oxygen saturation, breathing rate and time awake as your device reports them. Wrist sensors miss a lot during sleep, so a quiet card doesn't rule anything out."
    >
      <Explainer>
        Compares each night's average oxygen, breathing rate and time awake with your own usual
        range. A night counts when <b className="text-zinc-300">two of them are off together</b>, and a pattern needs
        several such nights in the last two weeks — never one bad night.
      </Explainer>
      <Stats items={[
        { k: 'Nights', v: r.nightsInWindow },
        { k: 'Arousals', v: r.stats.arousalsPerHourTypical !== null ? `${r.stats.arousalsPerHourTypical}/h` : '—', sub: 'usual' },
      ]} />
      {r.status !== 'pattern' ? (
        <EmptyEvidence>
          The nights behind a pattern would list here.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting'
              ? `Still collecting — ${r.nightsInWindow} nights recorded so far.`
              : 'None in the last 14 nights.'}
          </b>
        </EmptyEvidence>
      ) : (
        <Evidence>
          {r.flags.map((f: any) => (
            <div key={f.id} className="flex items-baseline gap-2.5 py-1.5 border-t border-zinc-800/60 first:border-t-0 text-[11px]">
              <span className={`text-[8px] ${f.fired ? 'text-rose-400' : 'text-zinc-700'}`}>●</span>
              <span className={`min-w-[140px] ${f.fired ? 'text-zinc-200 font-semibold' : 'text-zinc-500'}`}>{f.label}</span>
              <span className={f.fired ? 'text-zinc-400 tabular-nums' : 'text-zinc-600 tabular-nums'}>{f.detail}</span>
            </div>
          ))}
          <Callout lead={`On ${r.firedCount} of the last 14 nights, two or more of these were outside your usual range together.`}>
            A cold, alcohol, a stuffy or hot room, altitude or a late meal can all do this. If you also
            snore heavily, wake unrefreshed or feel very sleepy during the day, that's worth raising
            with a clinician.
          </Callout>
        </Evidence>
      )}
    </LabCard>
  );
}

// ── card 2 · dipping ──────────────────────────────────────────────────────

function corridorLeft(dip: number): number {
  // Zones: riser −10..0 → 0–28% · non-dipper 0–10 → 28–56% · dipper 10–20 → 56–86% · 20–30 → 86–100%.
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (dip < 0) return clamp(((dip + 10) / 10) * 28, 0, 28);
  if (dip < 10) return 28 + (dip / 10) * 28;
  if (dip < 20) return 56 + ((dip - 10) / 10) * 30;
  return clamp(86 + ((dip - 20) / 10) * 14, 86, 100);
}

/** Neutral names for where the median drop sits; the blood-pressure terms (dipper, riser…) don't transfer to heart rate. */
const DROP_LABEL: Record<string, string> = {
  dipper: 'Typical drop',
  'extreme dipper': 'Large drop',
  'non-dipper': 'Small drop',
  riser: 'Higher at night',
};

function DipCard({ data, intraday }: { data: SyncResult; intraday: IntradayDays }) {
  // Leaves out nights with several signals off, exactly as the insight does.
  const r = dipping(data.days, intraday);
  const latestNonRem = [...data.days].reverse().find((d) => d.nonRemHr !== null)?.nonRemHr ?? null;
  const latestRhr = [...data.days].reverse().find((d) => d.restingHr !== null)?.restingHr ?? null;
  const day7 = r.nights.slice(-7);
  const dayMean = day7.length ? Math.round(day7.reduce((a: number, n: any) => a + n.dayMean, 0) / day7.length) : null;
  const nightMean = day7.length ? Math.round(day7.reduce((a: number, n: any) => a + n.nightMean, 0) / day7.length) : null;

  const badge =
    r.status === 'pattern' ? <Badge kind="alert">{r.riser ? 'Higher at night' : 'Smaller drop'}</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {r.daysCollected} of {r.daysWanted} days</Badge>
        : <Badge kind="monitor">{DROP_LABEL[r.category] ?? 'No pattern'}</Badge>;

  return (
    <LabCard
      title="Day-to-night heart rate" gloss="how much it drops while you sleep" badge={badge}
      footer="Daytime is the 08:00–20:00 average of your minute-level heart rate; night is your non-REM sleeping heart rate. A 10% drop is a night/day ratio of 0.90. The 10% and 20% lines come from overnight blood-pressure research and are only a rough guide for heart rate."
    >
      <Explainer>
        Heart rate usually drops during sleep compared with the daytime, often by{' '}
        <b className="text-zinc-300">10–20%</b>. This tracks your own drop over the last 30 days. Late meals,
        alcohol, heat, evening exercise and illness all shift it from night to night, so only a
        multi-week change is shown.
      </Explainer>
      <Stats items={[
        { k: 'Daytime HR (7d)', v: dayMean !== null ? `${dayMean} bpm` : '—' },
        { k: 'Sleeping HR', v: nightMean !== null ? `${nightMean} bpm` : latestNonRem !== null ? `${latestNonRem} bpm` : '—', sub: nightMean === null && latestNonRem !== null ? 'non-REM' : undefined },
        { k: 'Median drop', v: r.medianDipPct !== null ? `${r.medianDipPct}%` : '—', sub: '30 days' },
        { k: 'Nights under 10%', v: r.measurableNights ? `${r.nightsUnder10} of ${r.measurableNights}` : '—' },
      ]} />
      {r.status === 'collecting' ? (
        <EmptyEvidence>
          The night side is already tracking{latestNonRem !== null ? <> (sleeping non-REM HR <b className="text-zinc-500">{latestNonRem} bpm</b>{latestRhr !== null ? `, resting ${latestRhr}` : ''})</> : null}. Daytime detail
          collects by itself — each daily sync adds one day,{' '}
          <b className="text-zinc-500">{r.daysCollected} of {r.daysWanted} collected</b> — then your drop and where
          it sits on the bands below appear here. No action needed.
        </EmptyEvidence>
      ) : (
        <Evidence>
          <div className="relative pt-[17px] mt-1">
            {r.medianDipPct !== null && (
              <span
                className="absolute top-0 -translate-x-1/2 text-[9px] font-bold tracking-[0.1em] text-zinc-50 whitespace-nowrap"
                style={{ left: `${corridorLeft(r.medianDipPct)}%` }}
              >
                YOU · {r.medianDipPct}%
              </span>
            )}
            <div className="relative h-2.5 rounded-md overflow-hidden flex">
              <div className="shrink-0 basis-[28%] bg-rose-500/30" />
              <div className="shrink-0 basis-[28%] bg-amber-400/30" />
              <div className="shrink-0 basis-[30%] bg-emerald-400/30" />
              <div className="flex-1 bg-emerald-400/10" />
              {r.medianDipPct !== null && (
                <div className="absolute -top-1 w-[2.5px] h-4 bg-zinc-50 rounded-sm" style={{ left: `${corridorLeft(r.medianDipPct)}%` }} />
              )}
            </div>
            <div className="flex justify-between mt-1.5 text-[9px] uppercase tracking-[0.06em] text-zinc-600">
              <span>Rise &lt; 0%</span><span>Small 0–10%</span><span>Typical 10–20%</span><span>Large &gt; 20%</span>
            </div>
          </div>
          {r.status === 'pattern' ? (
            <Callout lead={`${r.nightsUnder10} of the last ${r.measurableNights} measured nights dropped less than 10%.`}>
              {r.excludedIllnessNights > 0
                ? `${r.excludedIllnessNights} night${r.excludedIllnessNights > 1 ? 's' : ''} with several signals off at once ${r.excludedIllnessNights > 1 ? 'were' : 'was'} left out. `
                : ''}
              Single nights never count on their own. Late meals, alcohol, heat, evening exercise and a
              busy schedule all reduce the drop. If it persists for weeks alongside symptoms, you could
              mention it to a clinician.
            </Callout>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
              {r.measurableNights} measured nights so far — median drop {r.medianDipPct}%
              {DROP_LABEL[r.category] ? ` (${DROP_LABEL[r.category].toLowerCase()})` : ''}. This card stays
              quiet unless a multi-week change appears.
            </p>
          )}
        </Evidence>
      )}
    </LabCard>
  );
}

// ── card 3 · entropy ──────────────────────────────────────────────────────

function EntropyCard({ data }: { data: SyncResult }) {
  const r = entropyShift(data.days);
  const badge =
    r.status === 'shift' ? <Badge kind="alert">Shift · {r.shiftNights} nights</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · needs about 3 weeks</Badge>
        : <Badge kind="monitor">Steady</Badge>;

  const W = 470; const H = 74;
  const xs = (i: number, n: number) => 4 + i * ((W - 8) / Math.max(1, n - 1));
  const lo = Math.min(...r.recent.map((p: any) => p.value), (r.baselineMedian ?? 2.5) - 3 * (r.baselineSd ?? 0.1));
  const hi = Math.max(...r.recent.map((p: any) => p.value), (r.baselineMedian ?? 2.5) + 3 * (r.baselineSd ?? 0.1));
  const ys = (v: number) => H - 8 - ((v - lo) / Math.max(0.001, hi - lo)) * (H - 18);

  return (
    <LabCard
      title="HRV entropy" gloss="a nightly HRV metric from your device" badge={badge}
      footer="A number your device computes each night from the intervals between heartbeats. It has no standard scale and is not a measure of heart rhythm, so only changes against your own baseline are shown."
    >
      <Explainer>
        Each night your device summarises how variable the spacing between heartbeats was as a
        single number. Its absolute value has no standard meaning, so this tracks one thing only: a{' '}
        <b className="text-zinc-300">sustained change against your own baseline</b>.
      </Explainer>
      <Stats items={[
        { k: 'Last night', v: r.lastNight ?? '—' },
        { k: 'Your baseline', v: r.baselineMedian ?? '—', sub: r.baselineSd !== null ? `± ${r.baselineSd}` : undefined },
        r.status === 'shift'
          ? { k: 'Shifted for', v: `${r.shiftNights} nights` }
          : { k: 'Steady for', v: `${r.steadyNights} nights` },
      ]} />
      {r.status !== 'shift' ? (
        <EmptyEvidence>
          A multi-night change would appear here with the nights behind it.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting' ? 'Still collecting nights.' : `No sustained change in ${r.steadyNights} nights.`}
          </b>
        </EmptyEvidence>
      ) : (
        <Evidence>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
            {r.baselineMedian !== null && r.baselineSd !== null && (
              <>
                <rect x="0" y={ys(r.baselineMedian + r.baselineSd)} width={W}
                  height={Math.max(2, ys(r.baselineMedian - r.baselineSd) - ys(r.baselineMedian + r.baselineSd))}
                  fill="#34d399" opacity="0.07" />
                <line x1="0" x2={W} y1={ys(r.baselineMedian)} y2={ys(r.baselineMedian)}
                  stroke="#34d399" strokeWidth="1" strokeDasharray="3 4" opacity="0.4" />
              </>
            )}
            {r.recent.map((p: any, i: number) => (
              <circle key={p.date} cx={xs(i, r.recent.length)} cy={ys(p.value)} r="2.6"
                fill={p.shifted ? '#fb7185' : '#4b4f58'} />
            ))}
          </svg>
          <Callout lead={`Outside your usual range on ${r.shiftNights} recent nights.`}>
            This metric moves with everyday things: a cold, alcohol, poor sleep, hard training, stress.
            It doesn't indicate any condition on its own.
          </Callout>
        </Evidence>
      )}
    </LabCard>
  );
}

// ── card 4 · tachycardia ──────────────────────────────────────────────────

function TachyCard({ data, intraday }: { data: SyncResult; intraday: IntradayDays }) {
  const r = nocturnalTachycardia(data.days, intraday);
  const collected = completedIntradayDays(intraday).length;
  const longest = r.events.reduce((a, e) => Math.max(a, e.durationMin), 0);
  const badge =
    r.status === 'events' ? <Badge kind="alert">{r.events.length} stretch{r.events.length > 1 ? 'es' : ''} · {r.nightsScanned} nights</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {collected} of 7 days</Badge>
        : <Badge kind="monitor">None found</Badge>;

  return (
    <LabCard
      title="High heart rate during sleep" gloss="one-minute averages above 100 bpm" badge={badge}
      footer="Uses the one-minute heart-rate averages synced from your watch. Wrist readings during sleep can be noisy, and movement or waking raises them."
    >
      <Explainer>
        Lists stretches of recorded sleep where your heart rate stayed <b className="text-zinc-300">above 100 bpm for
        ten minutes or more</b>. Fever, alcohol, vivid dreams, waking and movement can all do this.
      </Explainer>
      <Stats items={[
        { k: 'Nights scanned', v: r.nightsScanned },
        { k: 'Events', v: r.events.length },
        r.status === 'events'
          ? { k: 'Longest', v: `${longest} min`, sub: `peak ${Math.max(...r.events.map((e) => e.peakBpm))}` }
          : { k: 'Highest sustained', v: r.highestSustained ? `${r.highestSustained.bpm} bpm` : '—', sub: r.highestSustained ? `${r.highestSustained.minutes} min` : undefined },
      ]} />
      {r.status !== 'events' ? (
        <EmptyEvidence>
          Stretches would list here with <b className="text-zinc-500">date · duration · peak · sleep stage</b>.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting'
              ? `Whole-night detail collects by itself — ${collected} of 7 days so far.`
              : `None in ${r.nightsScanned} nights with enough heart-rate data.`}
          </b>
        </EmptyEvidence>
      ) : (
        <Evidence>
          {r.events.slice(-6).reverse().map((e) => (
            <div key={`${e.date}-${e.startMin}-${e.peakBpm}`} className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3 py-2 border-t border-zinc-800/60 first:border-t-0 text-[11.5px]">
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="text-zinc-200 font-semibold min-w-[76px]">{fmtDate(e.date)}</span>
                <span className="text-zinc-400 tabular-nums">{fmtClock(e.startMin)} → {fmtClock(e.endMin)} · {e.durationMin} min</span>
                {e.sleepWindow && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/90 text-zinc-300 border border-zinc-700/60 font-medium">
                    {e.sleepWindow}
                  </span>
                )}
                {e.stage && !['Night sleep', 'Sleep', 'Nap'].includes(e.stage) && (
                  <span className="text-[10px] text-zinc-400">
                    {e.stage}
                  </span>
                )}
              </div>
              <span className="text-rose-300 font-semibold tabular-nums whitespace-nowrap ml-auto">peak {e.peakBpm} bpm</span>
            </div>
          ))}
          <Callout lead={r.events.length > 1 ? `${r.events.length} stretches in ${r.nightsScanned} nights.` : 'One stretch.'}>
            Occasional ones are common. If you notice palpitations, chest pain, dizziness or
            breathlessness, seek medical care.
          </Callout>
        </Evidence>
      )}
    </LabCard>
  );
}


/** At least two of the four inputs, recorded on the latest day and on enough earlier days to have a usual range. */
function hasStrainInputs(days: SyncResult['days']): boolean {
  const latest = days[days.length - 1];
  if (!latest || days.length <= 28) return false;
  const recent = days.slice(-29, -1);
  const usable = (get: (d: SyncResult['days'][number]) => number | null) =>
    get(latest) !== null && recent.filter((d) => get(d) !== null).length >= 8;
  return [
    usable((d) => d.restingHr),
    usable((d) => d.respiratoryRate),
    usable((d) => d.hrvDeepSleep ?? d.hrv),
    usable((d) => d.skinTempDeviationC),
  ].filter(Boolean).length >= 2;
}

function SystemStrainCard({ data }: { data: SyncResult }) {
  const enough = hasStrainInputs(data.days);
  const latestOffSignals = enough ? calculateOffSignals(data.days, data.days.length - 1) : 0;

  let label = 'Baseline';
  let badgeKind: 'monitor' | 'collect' | 'alert' = 'monitor';
  let badgeText = enough ? 'Baseline' : 'Not enough data';
  if (!enough) {
    label = '';
    badgeKind = 'collect';
  } else if (latestOffSignals === 2) {
    label = 'Elevated';
    badgeKind = 'collect';
    badgeText = 'Elevated · 2 signals off';
  } else if (latestOffSignals >= 3) {
    label = 'High';
    badgeKind = 'alert';
    badgeText = `High · ${latestOffSignals} signals off`;
  }

  return (
    <LabCard
      title="System Strain Radar" gloss="physiological deviations" badge={<Badge kind={badgeKind}>{badgeText}</Badge>}
      footer="Counts how many of resting heart rate, breathing rate, skin temperature and HRV are outside your usual range on the latest day. Several at once often follows hard training, short sleep, alcohol, heat or travel, or feeling under the weather."
    >
      <Explainer>
        One metric can move because of a late meal or a warm room. When <b className="text-zinc-300">several move at
        once</b>, it's a clearer sign that something changed: often recovery, sometimes a cold coming on.
      </Explainer>
      <div className="flex items-center justify-around py-6 mt-2">
        <div className="flex flex-col items-center gap-3 relative">
          <div className={`w-5 h-5 rounded-full border-2 transition-all ${label === 'Baseline' ? 'bg-emerald-500/20 border-emerald-500 ring-4 ring-emerald-500/10' : 'bg-zinc-800/50 border-zinc-700/50'}`} />
          <span className={`text-[11.5px] font-medium tracking-wide ${label === 'Baseline' ? 'text-zinc-200' : 'text-zinc-600'}`}>Baseline</span>
        </div>
        <div className="flex flex-col items-center gap-3 relative">
          <div className={`w-5 h-5 rounded-full border-2 transition-all ${label === 'Elevated' ? 'bg-amber-500/20 border-amber-500 ring-4 ring-amber-500/10' : 'bg-zinc-800/50 border-zinc-700/50'}`} />
          <span className={`text-[11.5px] font-medium tracking-wide ${label === 'Elevated' ? 'text-zinc-200' : 'text-zinc-600'}`}>Elevated</span>
        </div>
        <div className="flex flex-col items-center gap-3 relative">
          <div className={`w-5 h-5 rounded-full border-2 transition-all ${label === 'High' ? 'bg-rose-500/20 border-rose-500 ring-4 ring-rose-500/10' : 'bg-zinc-800/50 border-zinc-700/50'}`} />
          <span className={`text-[11.5px] font-medium tracking-wide ${label === 'High' ? 'text-zinc-200' : 'text-zinc-600'}`}>High</span>
        </div>
      </div>
    </LabCard>
  );
}

function IrnCard({ data }: { data: SyncResult }) {
  const events = data.days.filter((d) => d.irn && d.irn > 0);
  const stream = data.meta.streams.find((s) => s.dataType === 'irregular-rhythm-notification');
  const synced = !!stream && stream.status !== 'skipped' && stream.status !== 'unauthorized' && stream.status !== 'error';
  const badge = events.length > 0
    ? <Badge kind="collect">{events.length} day{events.length > 1 ? 's' : ''} with notifications</Badge>
    : <Badge kind="collect">{synced ? 'None synced' : 'Not synced'}</Badge>;

  return (
    <LabCard
      title="Irregular rhythm notifications" gloss="reported by your device" badge={badge}
      footer="Shows notifications your device reported to Google Health. This app does not analyse heart rhythm. For anything your device flags, follow its maker's guidance and talk to a clinician."
    >
      <Explainer>
        Some devices can notify you about an irregular heart rhythm. Any notifications they synced
        appear here with their dates.
      </Explainer>
      {events.length === 0 ? (
        <EmptyEvidence>
          {synced
            ? "No notifications were synced. That doesn't mean your rhythm was checked: many devices look only occasionally, or not at all."
            : "This data isn't shared with Healthier (its permission wasn't granted, or the last sync couldn't read it)."}
        </EmptyEvidence>
      ) : (
        <Evidence>
          {events.map((e) => (
            <div key={e.date} className="flex items-baseline gap-3 py-1.5 border-t border-zinc-800/60 first:border-t-0 text-[11.5px]">
              <span className="text-zinc-200 font-semibold">{fmtDate(e.date)}</span>
              <span className="text-zinc-300 font-semibold">{e.irn} notification{e.irn! > 1 ? 's' : ''}</span>
            </div>
          ))}
        </Evidence>
      )}
    </LabCard>
  );
}

// ── tab ───────────────────────────────────────────────────────────────────

export function LabsView({ data, intraday = {} }: { data: SyncResult; intraday?: IntradayDays }) {
  return (
    <div>
      <header className="px-1 pb-5">
        <p className="text-[12.5px] leading-relaxed text-zinc-500 max-w-3xl">
          Experimental views of <b className="text-zinc-300">multi-week patterns in your wearable data</b>, each against
          your own usual range. Healthier is not a medical device: these cards don't detect, screen for
          or rule out any condition, and a quiet card isn't an all-clear. If you have symptoms or
          concerns, talk to a clinician.
        </p>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SdbCard data={data} />
        <SystemStrainCard data={data} />
        <IrnCard data={data} />
        <DipCard data={data} intraday={intraday} />
        <EntropyCard data={data} />
        <TachyCard data={data} intraday={intraday} />
      </div>
    </div>
  );
}
