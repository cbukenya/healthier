import React from 'react';
import type { SyncResult } from '../pipeline/sync';
import {
  completedIntradayDays, dipping, entropyShift, illnessDates, nocturnalTachycardia, sdbScreen, calculateOffSignals,
  type IntradayDays,
} from '../pipeline/labs';

/**
 * 🧪 Labs — the screening family's home.
 *
 * Screening, not diagnosis: four multi-week pattern detectors that run over
 * every sync and should say "nothing" most of the time. The empty state is a
 * live status board — every card shows the real numbers it is watching — and
 * the fired state confines the rose treatment to the innermost callout, the
 * one paragraph that actually states the finding. Titles lead with the
 * technical term (this is the room where the white coats hang); the plain
 * gloss follows in a dim parenthetical. Visual spec: the two approved mocks.
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
    r.status === 'pattern' ? <Badge kind="alert">Pattern · {r.firedCount} of 5 flags</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {r.nightsInWindow} of 20 nights</Badge>
        : <Badge kind="monitor">Monitoring · no pattern</Badge>;

  return (
    <LabCard
      title="Sleep-disordered breathing screen" gloss="breathing during sleep" badge={badge}
      footer="Built from signals recorded every night — oxygen level, stage transitions, and breathing rate."
    >
      <Explainer>
        Five independent night signals tend to move together when breathing is disturbed during
        sleep: oxygen variability, low-oxygen nights, arousals, breathing rate, and time awake.
        A pattern here means <b className="text-zinc-300">at least three, drifting together, for weeks</b> — never one bad night.
      </Explainer>
      <Stats items={[
        { k: 'Nights', v: r.nightsInWindow },
        { k: 'Arousals', v: r.stats.arousalsPerHourTypical !== null ? `${r.stats.arousalsPerHourTypical}/h` : '—', sub: 'usual' },
      ]} />
      {r.status !== 'pattern' ? (
        <EmptyEvidence>
          A pattern would appear here as the flags that drove it, night by night.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting'
              ? `Still collecting — ${r.nightsInWindow} nights recorded so far.`
              : `None in these ${r.nightsInWindow} nights.`}
          </b>{' '}
          That is this data's view — not an all-clear: wrist sensors can miss quiet apnea.
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
          <Callout lead={`${r.firedCount} signals drifting together for weeks`}>
            — a pattern often seen with breathing-affected sleep. This is a screen, not a finding:
            worth a conversation with a doctor. Also shown as a Key Insight.
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

function DipCard({ data, intraday }: { data: SyncResult; intraday: IntradayDays }) {
  const sick = illnessDates(data.days);
  const r = dipping(data.days, intraday as any);
  const latestNonRem = [...data.days].reverse().find((d) => d.nonRemHr !== null)?.nonRemHr ?? null;
  const latestRhr = [...data.days].reverse().find((d) => d.restingHr !== null)?.restingHr ?? null;
  const day7 = r.nights.slice(-7);
  const dayMean = day7.length ? Math.round(day7.reduce((a: number, n: any) => a + n.dayMean, 0) / day7.length) : null;
  const nightMean = day7.length ? Math.round(day7.reduce((a: number, n: any) => a + n.nightMean, 0) / day7.length) : null;

  const badge =
    r.status === 'pattern' ? <Badge kind="alert">Pattern · {r.riser ? 'riser' : 'blunted dip'}</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {r.daysCollected} of {r.daysWanted} days</Badge>
        : <Badge kind="monitor">Monitoring · {r.category ?? 'no pattern'}</Badge>;

  return (
    <LabCard
      title="Nocturnal HR dipping" gloss="overnight heart-rate dip" badge={badge}
      footer="Daytime samples collect automatically with each daily sync — no separate step. Day/night ratio ≤ 0.90 is the normal-dip line in the ambulatory-monitoring literature."
    >
      <Explainer>
        Heart rate should fall roughly <b className="text-zinc-300">10–20% during sleep</b> versus daytime. In long
        cohort studies, a dip that stays blunted for weeks — not one odd night — tracks with
        cardiovascular strain. One late meal can blunt one night; only the pattern matters.
      </Explainer>
      <Stats items={[
        { k: 'Daytime HR (7d)', v: dayMean !== null ? `${dayMean} bpm` : '—' },
        { k: 'Sleeping HR', v: nightMean !== null ? `${nightMean} bpm` : latestNonRem !== null ? `${latestNonRem} bpm` : '—', sub: nightMean === null && latestNonRem !== null ? 'non-REM' : undefined },
        { k: 'Median dip', v: r.medianDipPct !== null ? `${r.medianDipPct}%` : '—', sub: '30 days' },
        { k: 'Nights under 10%', v: r.measurableNights ? `${r.nightsUnder10} of ${r.measurableNights}` : '—' },
      ]} />
      {r.status === 'collecting' ? (
        <EmptyEvidence>
          The night side is already tracking{latestNonRem !== null ? <> (sleeping non-REM HR <b className="text-zinc-500">{latestNonRem} bpm</b>{latestRhr !== null ? `, resting ${latestRhr}` : ''})</> : null}. Daytime detail
          collects by itself — each daily sync adds one day,{' '}
          <b className="text-zinc-500">{r.daysCollected} of {r.daysWanted} collected</b> — then dip % and the
          dipper / non-dipper corridors light up here. No action needed.
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
              <span>Riser &lt; 0%</span><span>Non-dipper 0–10%</span><span>Dipper 10–20%</span><span>&gt; 20%</span>
            </div>
          </div>
          {r.status === 'pattern' ? (
            <Callout lead={`${r.nightsUnder10} of the last ${r.measurableNights} measurable nights dipped under 10%`}>
              — persistent, not a one-off.{r.excludedIllnessNights > 0 ? ` ${r.excludedIllnessNights} illness-flag night${r.excludedIllnessNights > 1 ? 's were' : ' was'} excluded before making that call, and single` : ' Single'} blunted
              nights (late meal, alcohol, heat) never count on their own. In long cohort studies a dip
              that stays this flat tracks with cardiovascular strain — a reasonable thing to mention at a check-up.
            </Callout>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
              {r.measurableNights} measurable nights so far — median dip {r.medianDipPct}%, inside the{' '}
              {r.category} range. The screen stays quiet unless the multi-week pattern flattens.
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
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · needs 14 nights</Badge>
        : <Badge kind="monitor">Monitoring · steady</Badge>;

  const W = 470; const H = 74;
  const xs = (i: number, n: number) => 4 + i * ((W - 8) / Math.max(1, n - 1));
  const lo = Math.min(...r.recent.map((p: any) => p.value), (r.baselineMedian ?? 2.5) - 3 * (r.baselineSd ?? 0.1));
  const hi = Math.max(...r.recent.map((p: any) => p.value), (r.baselineMedian ?? 2.5) + 3 * (r.baselineSd ?? 0.1));
  const ys = (v: number) => H - 8 - ((v - lo) / Math.max(0.001, hi - lo)) * (H - 18);

  return (
    <LabCard
      title="RR-interval entropy" gloss="heart rhythm structure" badge={badge}
      footer="Computed on-device from true beat-to-beat intervals — the one field in this API derived from rhythm-level data."
    >
      <Explainer>
        Each night the device distills the exact spacing between heartbeats into one number — how{' '}
        <b className="text-zinc-300">structured versus erratic</b> the rhythm's texture was. The absolute value has no
        standard meaning, so this screen tracks only one thing: a{' '}
        <b className="text-zinc-300">sustained shift against your own baseline</b>.
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
          A multi-night shift would appear here with the nights that drove it, phrased as exactly
          what it is: a change in texture, worth mentioning to a doctor if it persists.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting' ? 'Still collecting nights.' : `No shift in ${r.steadyNights} nights.`}
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
          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            <span className="text-[9px] font-semibold tracking-[0.12em] uppercase text-zinc-600">Same nights, cross-checked:</span>
            {r.crossChecks.map((c: any) => (
              <span key={c.label}
                className={`text-[10px] px-2 py-0.5 rounded-full border ${c.steady ? 'text-emerald-300 border-emerald-400/25' : 'text-amber-300 border-amber-400/30'}`}>
                {c.label} {c.steady ? 'steady' : 'moved'}
              </span>
            ))}
          </div>
          <Callout lead={`The night-time texture of your heartbeat spacing has sat clearly outside your baseline for ${r.shiftNights} nights`}>
            {r.crossChecks.every((c: any) => c.steady) ? ' — while everything else stayed ordinary.' : '.'} This
            number also moves with mundane things: illness, alcohol, rough sleep. It is not a diagnosis of
            anything. If it persists with nothing in your life to explain it, it becomes a specific, dated
            observation worth showing a doctor.
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
    r.status === 'events' ? <Badge kind="alert">{r.events.length} event{r.events.length > 1 ? 's' : ''} · {r.nightsScanned} nights</Badge>
      : r.status === 'collecting' ? <Badge kind="collect">Collecting · {collected} of 7 days</Badge>
        : <Badge kind="monitor">Monitoring · 0 events</Badge>;

  return (
    <LabCard
      title="Nocturnal tachycardia" gloss="high heart rate during sleep" badge={badge}
      footer="Uses the detailed overnight heart-rate samples already synced for the sleep charts."
    >
      <Explainer>
        Flags stretches of sleep where heart rate holds <b className="text-zinc-300">above 100 bpm for ten minutes or
        more</b>. Ordinary spikes — dreams, rolling over, a hot room — don't count. Genuinely rare, and
        worth showing a doctor when it recurs.
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
          Events would list here with <b className="text-zinc-500">date · duration · peak · sleep stage</b>.{' '}
          <b className="text-zinc-500">
            {r.status === 'collecting'
              ? `Whole-night detail collects by itself — ${collected} of 7 days so far.`
              : `None in ${r.nightsScanned} nights.`}
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
          <Callout lead={r.events.length > 1 ? `${r.events.length} events in ${r.nightsScanned} nights.` : 'One event.'}>
            Isolated ones happen — fever, alcohol, vivid dreams. Recurring ones are exactly the kind of
            specific, timestamped thing a doctor can work with.
          </Callout>
        </Evidence>
      )}
    </LabCard>
  );
}


function SystemStrainCard({ data }: { data: SyncResult }) {
  const latestOffSignals = data.days.length > 28 ? calculateOffSignals(data.days, data.days.length - 1) : 0;
  
  let label = 'Baseline';
  let badgeKind: 'monitor' | 'collect' | 'alert' = 'monitor';
  let badgeText = 'Monitoring · normal';
  
  if (latestOffSignals === 2) {
    label = 'Elevated';
    badgeKind = 'collect';
    badgeText = 'Elevated strain';
  } else if (latestOffSignals >= 3) {
    label = 'High';
    badgeKind = 'alert';
    badgeText = 'High strain';
  }
  
  return (
    <LabCard
      title="System Strain Radar" gloss="physiological deviations" badge={<Badge kind={badgeKind}>{badgeText}</Badge>}
      footer="Monitors your resting heart rate, respiratory rate, temperature, and HRV for simultaneous deviations. Multiple signals drifting together can indicate physical exhaustion, poor recovery, or an emerging illness. Note: This is an exploratory physiological tracker, not a medical diagnostic tool."
    >
      <Explainer>
        A single metric can bounce around due to a late meal or a warm room. When <b className="text-zinc-300">multiple core systems</b> deviate at the same time, it's a much stronger signal of systemic strain.
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
  const badge = events.length > 0 ? <Badge kind="alert">Alert · {events.length} events</Badge> : <Badge kind="monitor">Monitoring · clear</Badge>;

  return (
    <LabCard
      title="Irregular Rhythm Notifications" gloss="FDA-cleared AFib detection" badge={badge}
      footer="Displays FDA-cleared AFib detector alerts synced directly from your compatible device. We do not calculate these; we only display the validated device's output."
    >
      <Explainer>
        Some devices actively monitor your pulse in the background for rhythms suggestive of Atrial Fibrillation. This panel simply surfaces any official alerts triggered by your device's own cleared algorithm.
      </Explainer>
      {events.length === 0 ? (
        <EmptyEvidence>
          Any confirmed notifications would appear here with their dates. None found in your history.
        </EmptyEvidence>
      ) : (
        <Evidence>
          {events.map((e) => (
            <div key={e.date} className="flex items-baseline gap-3 py-1.5 border-t border-zinc-800/60 first:border-t-0 text-[11.5px]">
              <span className="text-zinc-200 font-semibold">{fmtDate(e.date)}</span>
              <span className="text-rose-300 font-semibold">{e.irn} notification{e.irn! > 1 ? 's' : ''}</span>
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
          Screening, not diagnosis. These analyses run across your synced data, looking for{' '}
          <b className="text-zinc-300">multi-week patterns worth discussing with a healthcare professional</b>. When a notable pattern or anomaly surfaces, it appears here with full evidence and context.
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
