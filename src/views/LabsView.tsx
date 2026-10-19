import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronRight, CircleCheck, CircleDashed, Clock, Eye, Info } from 'lucide-react';
import type { SyncResult } from '../pipeline/sync';
import {
  completedIntradayDays, dipping, entropyShift, illnessDates, nocturnalTachycardia, sdbScreen, strainToday,
  type DipCategory, type EntropyShift, type IntradayDays, type NightTrace, type SdbNight, type StrainKey, type StrainSignal, type StrainToday,
  type TachycardiaEvent,
} from '../pipeline/labs';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useCycle } from '../hooks/useCycle';
import { t, type MessageKey } from '../i18n';
import { rich, type Wrap } from '../i18n/react';
import { capitalize, formatCivil, formatCivilLong, formatClock, formatFixed, formatList, formatRounded } from '../i18n/format';
import { tint } from '../ui/primitives';

/**
 * 🧪 Labs: experimental views of multi-week patterns in wearable data.
 *
 * Wording rule for this file's words (under `labs` in src/locales/en-US.json):
 * describe what was observed, against the person's own usual range, with
 * everyday explanations. Never name a condition, never present a card as
 * screening, detection or an all-clear, and suggest a clinician only alongside
 * symptoms. Healthier is a wellness tool, not a medical device (see the
 * README's intended-purpose statement).
 *
 * Every card answers first, with a status and one line, then draws the data it
 * watches even when quiet, so a card with nothing to report still shows what it
 * looks at. Until it finds something, a Watches / Lights up box says what it
 * looks for; once it does, the callout says what was seen and the box steps
 * aside. The rose treatment is confined to findings. Phones get one tile per
 * lab that opens in place; wider screens get glance tiles above the cards. Each
 * tile carries a cut-down copy of its card's picture.
 */

type Days = SyncResult['days'];
type LabKey = 'sdb' | 'strain' | 'irn' | 'dip' | 'entropy' | 'tachy';
type Tone = 'quiet' | 'wait' | 'found' | 'neutral';
type Mark = 'quiet' | 'collecting' | 'waiting' | 'reported' | 'unsynced' | 'none' | 'notice' | 'found';

interface Lab {
  key: LabKey;
  title: string;
  gloss: string;
  tone: Tone;
  mark: Mark;
  chip: string;
  /** The status line on the phone tiles and the desktop glance tiles. */
  glance: string;
  /** Something was found: its callout says what, so the Watches / Lights up box steps aside. */
  found: boolean;
  /** The card's picture, cut down to sit under the status line of a tile. */
  graph: React.ReactNode;
  parts: React.ReactNode;
}

// SVG fills, in the Tailwind colours around them.
const HEX = { zinc800: 'var(--color-zinc-800)', zinc500: 'var(--color-zinc-500)', zinc400: 'var(--color-zinc-400)', zinc50: 'var(--color-zinc-50)', amber: 'var(--amber-400)', rose: 'var(--rose-400)', emerald: 'var(--emerald-400)' };

// ── what each card watches, and how it works ──────────────────────────────

/** In the pipeline's own terms (src/pipeline/labs.ts). */
const SPEC: Record<LabKey, { watch: MessageKey; light: MessageKey }> = {
  sdb: { watch: 'labs.sdb.watch', light: 'labs.sdb.light' },
  strain: { watch: 'labs.strain.watch', light: 'labs.strain.light' },
  irn: { watch: 'labs.irn.watch', light: 'labs.irn.light' },
  dip: { watch: 'labs.dip.watch', light: 'labs.dip.light' },
  entropy: { watch: 'labs.entropy.watch', light: 'labs.entropy.light' },
  tachy: { watch: 'labs.tachy.watch', light: 'labs.tachy.light' },
};

const em: Wrap = (w) => <b className="text-zinc-300 font-semibold">{w}</b>;
const HOW: Record<LabKey, { explainer: MessageKey; extra?: MessageKey; footer: MessageKey }> = {
  sdb: { explainer: 'labs.sdb.how.explainer', footer: 'labs.sdb.how.footer' },
  strain: { explainer: 'labs.strain.how.explainer', extra: 'labs.strain.how.extra', footer: 'labs.strain.how.footer' },
  irn: { explainer: 'labs.irn.how.explainer', footer: 'labs.irn.how.footer' },
  dip: { explainer: 'labs.dip.how.explainer', footer: 'labs.dip.how.footer' },
  entropy: { explainer: 'labs.entropy.how.explainer', footer: 'labs.entropy.how.footer' },
  tachy: { explainer: 'labs.tachy.how.explainer', footer: 'labs.tachy.how.footer' },
};

// ── shared chrome ─────────────────────────────────────────────────────────

const CHIP: Record<Tone, string> = {
  quiet: 'text-emerald-300 border-emerald-400/25 bg-emerald-400/5',
  wait: 'text-amber-300 border-amber-400/30 bg-amber-400/5',
  found: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  neutral: 'text-zinc-300 border-zinc-400/30 bg-zinc-400/5',
};
const GLANCE: Record<Tone, string> = { quiet: 'text-emerald-300', wait: 'text-amber-300', found: 'text-rose-300', neutral: 'text-zinc-300' };

function StatusIcon({ mark, size = 18 }: { mark: Mark; size?: number }) {
  switch (mark) {
    case 'quiet': return <CircleCheck size={size} aria-hidden className="shrink-0 text-emerald-400" />;
    case 'collecting': return <CircleDashed size={size} aria-hidden className="shrink-0 text-amber-400" />;
    case 'waiting': return <Clock size={size} aria-hidden className="shrink-0 text-amber-400" />;
    case 'reported': return <Bell size={size} aria-hidden className="shrink-0 text-amber-400" />;
    case 'unsynced': return <BellOff size={size} aria-hidden className="shrink-0 text-amber-400" />;
    case 'none': return <Bell size={size} aria-hidden className="shrink-0 text-zinc-400" />;
    case 'notice':
    case 'found':
      return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className={`shrink-0 ${mark === 'found' ? 'text-rose-400' : 'text-amber-400'}`}>
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
        </svg>
      );
  }
}

function Chip({ lab }: { lab: Lab }) {
  return (
    <span className={`shrink-0 whitespace-nowrap text-eyebrow-sm leading-3 font-bold uppercase px-2.5 py-1 rounded-full border ${CHIP[lab.tone]}`}>
      {lab.chip}
    </span>
  );
}

function Answer({ text, sub }: { text: string; sub?: string }) {
  return (
    <div>
      <p className="font-display text-headline leading-snug text-zinc-50">{text}</p>
      {sub && <p className="mt-1 text-caption leading-normal text-zinc-400">{sub}</p>}
    </div>
  );
}

/** `label` says the progress in words, such as "3 of 21 nights". */
function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={label}
        className="flex-1 grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => <span key={i} className={`h-1.5 rounded-full ${i < done ? 'bg-amber-400' : 'bg-zinc-800'}`} />)}
      </div>
      <span className="text-caption text-amber-300 whitespace-nowrap tabular-nums">{label}</span>
    </div>
  );
}

function Collecting({ text, done, total, progress, note }: { text: string; done: number; total: number; progress: string; note: string }) {
  return (
    <div>
      <p className="font-display text-headline leading-snug text-zinc-50">{text}</p>
      <div className="mt-2"><Progress done={done} total={total} label={progress} /></div>
      <p className="mt-1.5 text-caption leading-normal text-zinc-500">{note}</p>
    </div>
  );
}

type Stat = [label: string, value: React.ReactNode, sub?: string];

function Stats({ items }: { items: Stat[] }) {
  return (
    <div className="flex flex-wrap gap-x-[22px] gap-y-2">
      {items.map(([k, v, sub], i) => (
        <div key={i}>
          <div className="text-eyebrow-sm leading-3 uppercase text-zinc-500">{k}</div>
          <div className="mt-0.5 text-body-sm leading-tight font-semibold text-zinc-200 tabular-nums">
            {v}
            {sub && <span className="ml-1 text-note font-medium text-zinc-500">{sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Keys({ items }: { items: [React.ReactNode, string][] }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-note text-zinc-500">
      {items.map(([swatch, label], i) => <span key={i} className="flex items-center gap-1.5">{swatch}{label}</span>)}
    </div>
  );
}

const Swatch = ({ className }: { className: string }) => <span className={`w-2 h-2 rounded-[2px] ${className}`} />;
const Dot = ({ className }: { className: string }) => <span className={`w-[7px] h-[7px] rounded-full ${className}`} />;

/** The two ends of a graph's period, with an optional label between them. */
function Ends({ left, right, mid, compact = false }: { left: string; right: string; mid?: string; compact?: boolean }) {
  return (
    <div className={`${compact ? 'mt-[5px]' : 'mt-1.5'} flex justify-between gap-2 text-note leading-tight text-zinc-600`}>
      <span>{left}</span>
      {mid && <span className="text-zinc-500">{mid}</span>}
      <span>{right}</span>
    </div>
  );
}

function DayList({ rows, dot }: { rows: [string, string][]; dot: string }) {
  return (
    <div>
      {rows.map(([day, what]) => (
        <div key={day} className="flex items-center justify-between gap-3 py-[7px] border-t border-zinc-800/60 text-detail">
          <span className="flex items-center gap-2 font-semibold text-zinc-200"><span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{day}</span>
          <span className="text-zinc-400">{what}</span>
        </div>
      ))}
    </div>
  );
}

/** The one element that carries the alert treatment: what was seen, its first sentence set bold by `lead`. */
function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[10px] border px-3.5 py-3 text-caption leading-normal text-zinc-300"
      style={{
        borderColor: tint('var(--rose-500)', 22),
        backgroundColor: 'var(--alert-ground)',
        backgroundImage: `radial-gradient(140% 140% at 100% 100%, ${tint('var(--rose-500)', 30)} 0%, ${tint('var(--rose-500)', 9)} 45%, transparent 72%)`,
      }}
    >
      {children}
    </div>
  );
}

/** A callout's lead: the sentence that says what was seen. */
const lead: Wrap = (w) => <b className="text-rose-300 font-semibold">{w}</b>;

function DeviceNote() {
  return (
    <p className="rounded-[10px] border border-zinc-800/80 bg-panel px-3 py-2.5 text-caption leading-normal text-zinc-300">
      {rich('labs.irn.reported.note', { b: (w) => <b className="font-semibold text-zinc-50">{w}</b> })}
    </p>
  );
}

function Spec({ k }: { k: LabKey }) {
  const { watch, light } = SPEC[k];
  const b: Wrap = (w) => <b className="font-semibold text-zinc-100">{w}</b>;
  return (
    <div className="flex flex-col gap-2 px-3 py-[11px] rounded-xl border border-rule bg-panel">
      <p className="flex gap-2 text-caption leading-normal text-zinc-400">
        <Eye size={13} aria-hidden className="shrink-0 mt-[3px]" />
        <span>{rich(watch, { b })}</span>
      </p>
      <p className="flex gap-2 text-caption leading-normal text-zinc-400">
        <span className="shrink-0 w-[13px] h-[13px] mt-[3px] grid place-items-center">
          <span className={`w-[7px] h-[7px] rounded-full ${k === 'irn' ? 'bg-zinc-600' : 'bg-rose-400'}`} />
        </span>
        <span>{rich(light, { b })}</span>
      </p>
    </div>
  );
}

function HowItWorks({ k }: { k: LabKey }) {
  const { explainer, extra, footer } = HOW[k];
  return (
    <details className="group/how mt-auto border-t border-zinc-800/80">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center justify-between min-h-11 text-detail font-medium text-zinc-400 hover:text-zinc-200 transition-colors">
        {t('labs.howItWorks')}
        <ChevronDown size={14} aria-hidden className="transition-transform group-open/how:rotate-180" />
      </summary>
      <p className="text-caption leading-relaxed text-zinc-400">{rich(explainer, { b: em })}</p>
      {extra && <p className="mt-2 text-caption leading-relaxed text-zinc-400">{t(extra)}</p>}
      <p className="mt-2 pb-1 text-note leading-relaxed text-zinc-500">{t(footer)}</p>
    </details>
  );
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ── card 1 · breathing during sleep ───────────────────────────────────────

const SDB_SIGNALS = [['oxygen', 'labs.sdb.signals.oxygen'], ['breathing', 'labs.sdb.signals.breathing'], ['awake', 'labs.sdb.signals.awake']] as const;
const offCount = (n: SdbNight) => Number(n.oxygen) + Number(n.breathing) + Number(n.awake);
/** Which two signals a night had off together, or all three. */
const offPair = (n: SdbNight) => (offCount(n) === 3 ? 'all' : !n.awake ? 'oxygenBreathing' : !n.breathing ? 'oxygenAwake' : 'breathingAwake');

function SdbGrid({ nights, judged }: { nights: SdbNight[]; judged: boolean }) {
  if (!nights.length) return null;
  const fired = nights.filter((n) => offCount(n) >= 2).length;
  const aria = judged
    ? t('labs.sdb.grid.judged', { count: nights.length, fired })
    : t('labs.sdb.grid.unjudged', { measured: nights.filter((n) => n.measured).length, count: nights.length });
  const dashed = <Swatch className="border border-dashed border-zinc-700" />;
  return (
    <div role="img" aria-label={aria}>
      <div className="grid items-center gap-y-[7px]" style={{ gridTemplateColumns: `74px repeat(${nights.length}, minmax(0, 1fr))` }}>
        {SDB_SIGNALS.map(([k, label]) => (
          <React.Fragment key={k}>
            <span className="text-caption leading-tight text-zinc-400">{t(label)}</span>
            {nights.map((n) => (
              <span
                key={n.date}
                className={`justify-self-center w-[11px] h-[11px] rounded-[3px] ${
                  !n.measured ? 'border border-dashed border-zinc-700'
                    : judged && n[k] ? (offCount(n) >= 2 ? 'bg-rose-400' : 'bg-amber-400')
                      : 'bg-zinc-800'}`}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="pl-[74px]"><Ends left={formatCivil(nights[0].date)} right={formatCivil(nights[nights.length - 1].date)} /></div>
      <div className="mt-2">
        <Keys items={judged
          ? [
            [<Swatch className="bg-amber-400" />, t('labs.sdb.grid.keys.off')],
            [<Swatch className="bg-rose-400" />, t('labs.sdb.grid.keys.together')],
            [dashed, t('labs.sdb.grid.keys.unmeasured')],
          ]
          : [[<Swatch className="bg-zinc-800" />, t('labs.sdb.grid.keys.unjudged')], [dashed, t('labs.sdb.grid.keys.unmeasured')]]}
        />
      </div>
    </div>
  );
}

/** The tile's version of the grid: one bar a night, coloured by its worst. */
function SdbBars({ nights }: { nights: SdbNight[] }) {
  if (!nights.length) return null;
  return (
    <div aria-hidden>
      <div className="flex gap-[3px] h-[18px]">
        {nights.map((n) => (
          <span
            key={n.date}
            className={`flex-1 rounded-[3px] ${
              !n.measured ? 'border border-dashed border-zinc-700'
                : offCount(n) >= 2 ? 'bg-rose-400' : offCount(n) === 1 ? 'bg-amber-400' : 'bg-zinc-800'}`}
          />
        ))}
      </div>
      <Ends compact left={formatCivil(nights[0].date)} right={formatCivil(nights[nights.length - 1].date)} />
    </div>
  );
}

function sdbLab(days: Days): Lab {
  const r = sdbScreen(days);
  const base = { key: 'sdb' as const, title: t('labs.sdb.title'), gloss: t('labs.sdb.gloss'), graph: <SdbBars nights={r.nights} /> };
  const fired = r.nights.filter((n) => offCount(n) >= 2);
  const singles = r.nights.filter((n) => offCount(n) === 1);
  const arousals = r.stats.arousalsPerHourTypical;
  const stats = (
    <Stats items={[
      [t('labs.sdb.stats.nights'), r.nightsInWindow, t('labs.sdb.stats.window')],
      [t('labs.sdb.stats.arousals'), arousals !== null ? t('labs.sdb.stats.perHour', { value: formatRounded(arousals, 1) }) : '—'],
    ]} />
  );

  if (r.status === 'collecting') {
    const collected = Math.min(r.beforeNights, r.beforeWanted) + Math.min(r.testedNights, r.testedWanted);
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: t('labs.sdb.collecting.chip'),
      glance: t('labs.sdb.collecting.glance', { done: collected, total: r.nightsWanted }), found: false,
      parts: (
        <>
          <Collecting
            text={t('labs.sdb.collecting.text')} done={collected} total={r.nightsWanted}
            progress={t('labs.sdb.collecting.progress', { done: collected, total: r.nightsWanted })}
            note={t('labs.sdb.collecting.note')}
          />
          <SdbGrid nights={r.nights} judged={false} />
          {stats}
        </>
      ),
    };
  }

  if (r.status === 'pattern') {
    const chip = t('labs.sdb.pattern.chip', { count: r.firedCount });
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={t('labs.sdb.pattern.text', { count: r.firedCount })} />
          <SdbGrid nights={r.nights} judged />
          <DayList dot="bg-rose-400" rows={fired.map((n) => [formatCivilLong(n.date), t('labs.sdb.pattern.signalsOff', { signals: offPair(n) })])} />
          <Callout>{rich('labs.sdb.pattern.callout', { count: r.firedCount, b: lead })}</Callout>
          {stats}
        </>
      ),
    };
  }

  const sub = fired.length
    ? t('labs.sdb.quiet.fired', { count: fired.length })
    : singles.length === 1
      ? t('labs.sdb.quiet.single', { signal: SDB_SIGNALS.find(([k]) => singles[0][k])![0], date: formatCivil(singles[0].date) })
      : singles.length > 1
        ? t('labs.sdb.quiet.singles', { count: singles.length })
        : t('labs.sdb.quiet.none');
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: t('labs.sdb.quiet.chip'), glance: t('labs.sdb.quiet.glance'), found: false,
    parts: (
      <>
        <Answer text={t('labs.sdb.quiet.text')} sub={sub} />
        <SdbGrid nights={r.nights} judged />
        {stats}
      </>
    ),
  };
}

// ── card 2 · system strain ────────────────────────────────────────────────

const STRAIN_NAME: Record<StrainKey, MessageKey> = {
  restingHr: 'labs.strain.signals.restingHr.name', breathing: 'labs.strain.signals.breathing.name',
  hrv: 'labs.strain.signals.hrv.name', skinTemp: 'labs.strain.signals.skinTemp.name',
};
const STRAIN_WORDS: Record<StrainKey, MessageKey> = {
  restingHr: 'labs.strain.signals.restingHr.inText', breathing: 'labs.strain.signals.breathing.inText',
  hrv: 'labs.strain.signals.hrv.inText', skinTemp: 'labs.strain.signals.skinTemp.inText',
};
const STRAIN_DIR: Record<StrainKey, 'above' | 'below'> = { restingHr: 'above', breathing: 'above', hrv: 'below', skinTemp: 'above' };

/** Each tile says only how its signal stands today; which way counts as off is in "How it works". */
function StrainTiles({ signals, rose }: { signals: StrainSignal[]; rose: boolean }) {
  // The label names all four in order, each as "resting HR off" or the like.
  const today = Object.fromEntries(signals.map((s) => [s.key, t('labs.strain.tiles.status', { signal: t(STRAIN_WORDS[s.key]), status: s.status })]));
  return (
    <div role="img" aria-label={t('labs.strain.tiles.aria', today)} className="grid grid-cols-2 gap-2">
      {signals.map((s) => {
        const off = s.status === 'off';
        return (
          <div key={s.key} className={`rounded-xl border px-[11px] py-[9px] ${off ? (rose ? 'border-rose-500/40' : 'border-amber-400/35') : 'border-zinc-800/80'}`}>
            <div className="flex items-center justify-between gap-1.5">
              <span className="text-detail font-semibold text-zinc-200">{t(STRAIN_NAME[s.key])}</span>
              <span className={`shrink-0 w-2 h-2 rounded-full ${
                s.status === 'none' ? 'border-[1.5px] border-zinc-600' : off ? (rose ? 'bg-rose-400' : 'bg-amber-400') : 'bg-emerald-400/70'}`}
              />
            </div>
            <div className={`mt-0.5 text-note ${off ? (rose ? 'text-rose-300' : 'text-amber-300') : 'text-zinc-500'}`}>
              {off ? t('labs.strain.tiles.off', { direction: STRAIN_DIR[s.key] }) : s.status === 'in' ? t('labs.strain.tiles.in') : t('labs.strain.tiles.none')}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const LEVELS = [
  { key: 'baseline', name: 'labs.strain.scale.baseline', label: 'labs.strain.scale.baselineRange', bar: 'bg-emerald-400 rounded-l', today: 'text-emerald-400 text-left', align: 'text-left' },
  { key: 'elevated', name: 'labs.strain.scale.elevated', label: 'labs.strain.scale.elevatedRange', bar: 'bg-amber-400', today: 'text-amber-400 text-center', align: 'text-center' },
  { key: 'high', name: 'labs.strain.scale.high', label: 'labs.strain.scale.highRange', bar: 'bg-rose-500 rounded-r', today: 'text-rose-400 text-right', align: 'text-right' },
] as const;

/** The stages; on a tile, just their names, with today's in bold. */
function StrainScale({ level, compact = false }: { level: StrainToday['level']; compact?: boolean }) {
  return (
    <div
      role={compact ? undefined : 'img'}
      aria-hidden={compact || undefined}
      aria-label={compact ? undefined : level
        ? t('labs.strain.scale.aria', { level })
        : t('labs.strain.scale.ariaEmpty')}
    >
      {level && !compact && (
        <div className="grid grid-cols-3 mb-1 text-eyebrow-sm font-bold">
          {LEVELS.map((l) => <span key={l.key} className={l.today}>{l.key === level ? t('labs.strain.scale.today') : ''}</span>)}
        </div>
      )}
      <div className={`grid grid-cols-3 ${compact ? 'gap-[3px]' : 'gap-1'}`}>
        {LEVELS.map((l) => <span key={l.key} className={`${compact ? 'h-1.5' : 'h-2'} ${l.bar} ${l.key === level ? 'opacity-65' : 'opacity-20'}`} />)}
      </div>
      <div className={`${compact ? 'mt-[5px] text-note leading-tight text-zinc-600' : 'mt-1.5 text-note text-zinc-500'} grid grid-cols-3`}>
        {LEVELS.map((l) => (
          <span key={l.key} className={`${l.align} ${l.key === level ? 'font-semibold text-zinc-200' : ''}`}>{t(compact ? l.name : l.label)}</span>
        ))}
      </div>
    </div>
  );
}

/** `cycleDays`: with cycle tracking on, the days judged against the person's own cycle (see cycleAdjusted). */
function strainLab(days: Days, cycleDays: Days | null): Lab {
  const r = strainToday(days, cycleDays);
  const base = { key: 'strain' as const, title: t('labs.strain.title'), gloss: t('labs.strain.gloss'), graph: <StrainScale level={r.level} compact /> };
  const rose = r.level === 'high';
  const off = r.signals.filter((s) => s.status === 'off');
  const offWords = formatList(off.map((s) => t(STRAIN_WORDS[s.key])));
  const picture = (
    <>
      <StrainTiles signals={r.signals} rose={rose} />
      <StrainScale level={r.level} />
      {r.explained.length > 0 && (
        <p className="text-caption leading-normal text-zinc-400">
          {t('labs.strain.cycle', { signals: capitalize(formatList(r.explained.map((k) => t(STRAIN_WORDS[k])))), count: r.explained.length })}
        </p>
      )}
    </>
  );

  if (r.status === 'collecting') {
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: t('labs.strain.collecting.chip'), glance: t('labs.strain.collecting.glance'), found: false,
      parts: <><Answer text={t('labs.strain.collecting.text')} sub={t('labs.strain.collecting.sub')} />{picture}</>,
    };
  }
  if (r.status === 'waiting') {
    return {
      ...base, tone: 'wait', mark: 'waiting', chip: t('labs.strain.waiting.chip'), glance: t('labs.strain.waiting.text'), found: false,
      parts: (
        <>
          <Answer
            text={t('labs.strain.waiting.text')}
            sub={r.arrived === 0 ? t('labs.strain.waiting.none') : t('labs.strain.waiting.some')}
          />
          {picture}
        </>
      ),
    };
  }
  if (r.level === 'high') {
    const chip = t('labs.strain.high.chip', { count: r.off });
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={t('labs.strain.high.text', { count: r.off })} />
          {picture}
          <Callout>{rich('labs.strain.high.callout', { signals: capitalize(offWords), b: lead })}</Callout>
        </>
      ),
    };
  }
  if (r.level === 'elevated') {
    return {
      ...base, tone: 'wait', mark: 'notice', chip: t('labs.strain.elevated.chip'), glance: t('labs.strain.elevated.chip'), found: true,
      parts: (
        <>
          <Answer
            text={t('labs.strain.elevated.text')}
            sub={t('labs.strain.elevated.sub', { signals: capitalize(offWords) })}
          />
          {picture}
        </>
      ),
    };
  }
  const judged = r.signals.filter((s) => s.status !== 'none').length;
  const sub = r.off === 1
    ? t('labs.strain.baseline.one', { signal: off[0].key })
    : judged === 4 ? t('labs.strain.baseline.allIn') : t('labs.strain.baseline.someIn', { count: judged });
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: t('labs.strain.baseline.chip'), glance: t('labs.strain.baseline.glance', { count: r.off }), found: false,
    parts: <><Answer text={t('labs.strain.baseline.text')} sub={sub} />{picture}</>,
  };
}

// ── card 3 · irregular rhythm notifications ───────────────────────────────

function IrnStrip({ days, ghost = false, compact = false }: { days: Days; ghost?: boolean; compact?: boolean }) {
  if (!days.length) return null;
  const marked = days.filter((d) => d.irn && d.irn > 0);
  const h = compact ? 16 : 20;
  const aria = ghost
    ? t('labs.irn.strip.ghost')
    : marked.length
      ? t('labs.irn.strip.marked', { count: days.length, dates: formatList(marked.map((d) => formatCivil(d.date))) })
      : t('labs.irn.strip.none', { count: days.length });
  return (
    <div role={compact ? undefined : 'img'} aria-hidden={compact || undefined} aria-label={compact ? undefined : aria}>
      <div className="relative">
        <svg viewBox={`0 0 ${days.length * 10} ${h}`} preserveAspectRatio="none" width="100%" height={h} className={`block ${ghost ? 'opacity-30' : ''}`}>
          {days.map((d, i) => (!ghost && d.irn && d.irn > 0
            ? <rect key={d.date} x={i * 10} y={0} width={6.5} height={h} rx={1} fill={HEX.amber} />
            : <rect key={d.date} x={i * 10} y={h * 0.3} width={6.5} height={h * 0.4} rx={1} fill={HEX.zinc800} />))}
        </svg>
        {ghost && <span className="absolute inset-0 flex items-center justify-center text-note text-zinc-400">{t('labs.irn.strip.notSynced')}</span>}
      </div>
      <Ends compact={compact} left={formatCivil(days[0].date)} right={t('labs.irn.strip.today')} />
    </div>
  );
}

function irnLab(data: SyncResult): Lab {
  const days = data.days;
  const events = days.filter((d) => d.irn && d.irn > 0);
  const stream = data.meta.streams.find((s) => s.dataType === 'irregular-rhythm-notification');
  const synced = !!stream && stream.status !== 'skipped' && stream.status !== 'unauthorized' && stream.status !== 'error';
  const base = { key: 'irn' as const, title: t('labs.irn.title'), gloss: t('labs.irn.gloss') };

  if (events.length) {
    const text = t('labs.irn.reported.text', { count: events.length });
    return {
      ...base, tone: 'wait', mark: 'reported', chip: t('labs.irn.reported.chip'), glance: text, found: true, graph: <IrnStrip days={days} compact />,
      parts: (
        <>
          <Answer text={text} />
          <IrnStrip days={days} />
          <DayList dot="bg-amber-400" rows={events.map((e) => [formatCivilLong(e.date), t('labs.irn.reported.count', { count: e.irn! })])} />
          <DeviceNote />
        </>
      ),
    };
  }
  if (!synced) {
    return {
      ...base, tone: 'wait', mark: 'unsynced', chip: t('labs.irn.unsynced.chip'), glance: t('labs.irn.unsynced.chip'), found: false,
      graph: <IrnStrip days={days} ghost compact />,
      parts: <><Answer text={t('labs.irn.unsynced.text')} sub={t('labs.irn.unsynced.sub')} /><IrnStrip days={days} ghost /></>,
    };
  }
  return {
    ...base, tone: 'neutral', mark: 'none', chip: t('labs.irn.none.chip'), glance: t('labs.irn.none.chip'), found: false, graph: <IrnStrip days={days} compact />,
    parts: <><Answer text={t('labs.irn.none.text')} sub={t('labs.irn.none.sub', { count: days.length })} /><IrnStrip days={days} /></>,
  };
}

// ── card 4 · day-to-night heart rate ──────────────────────────────────────

function corridorLeft(dip: number): number {
  // Zones: riser −10..0 → 0–28% · non-dipper 0–10 → 28–56% · dipper 10–20 → 56–86% · 20–30 → 86–100%.
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  if (dip < 0) return clamp(((dip + 10) / 10) * 28, 0, 28);
  if (dip < 10) return 28 + (dip / 10) * 28;
  if (dip < 20) return 56 + ((dip - 10) / 10) * 30;
  return clamp(86 + ((dip - 20) / 10) * 14, 86, 100);
}

/** Neutral names for where the median drop sits; the blood-pressure terms (dipper, riser…) don't transfer to heart rate. */
const DROP_LABEL: Record<DipCategory, MessageKey> = {
  dipper: 'labs.dip.drop.typical',
  'extreme-dipper': 'labs.dip.drop.large',
  'non-dipper': 'labs.dip.drop.small',
  riser: 'labs.dip.drop.higher',
  none: 'labs.dip.drop.none',
};

function Corridor({ median, rose = false, compact = false }: { median: number | null; rose?: boolean; compact?: boolean }) {
  const left = median === null ? null : corridorLeft(median);
  return (
    <div
      role={compact ? undefined : 'img'}
      aria-hidden={compact || undefined}
      aria-label={compact ? undefined : median === null
        ? t('labs.dip.corridor.ariaEmpty')
        : t('labs.dip.corridor.aria', { median })}
    >
      {left === null && !compact && <p className="mb-1.5 text-note text-zinc-500">{t('labs.dip.corridor.empty')}</p>}
      <div className={`relative ${left === null ? '' : compact ? 'pt-[15px]' : 'pt-[17px]'}`}>
        {left !== null && (
          <span
            className={`absolute top-0 -translate-x-1/2 text-micro ${compact ? '' : 'leading-3'} font-bold tracking-widest whitespace-nowrap ${rose ? 'text-rose-300' : 'text-zinc-50'}`}
            style={{ left: `${Math.min(Math.max(left, 9), 91)}%` }}
          >
            {t('labs.dip.corridor.you', { median })}
          </span>
        )}
        <div className={`${compact ? 'h-2 rounded' : 'h-2.5 rounded-md'} overflow-hidden flex ${left === null ? 'opacity-60' : ''}`}>
          <div className="shrink-0 basis-[28%] bg-rose-500/30" />
          <div className="shrink-0 basis-[28%] bg-amber-400/30" />
          <div className="shrink-0 basis-[30%] bg-emerald-400/30" />
          <div className="flex-1 bg-emerald-400/10" />
        </div>
        {left !== null && (
          <span
            className={`absolute ${compact ? 'top-3 h-3.5' : 'top-[13px] h-[18px]'} w-[3px] -ml-[1.5px] rounded-sm ${rose ? 'bg-rose-300' : 'bg-zinc-50'}`}
            style={{ left: `${left}%` }}
          />
        )}
        <div className={`${compact ? 'mt-[5px] tracking-normal' : 'mt-1.5 tracking-wider'} text-micro flex justify-between uppercase text-zinc-600`}>
          <span>{t('labs.dip.corridor.rise')}</span><span>{t('labs.dip.corridor.small')}</span>
          <span>{t('labs.dip.corridor.typical')}</span><span>{t('labs.dip.corridor.large')}</span>
        </div>
      </div>
    </div>
  );
}

function dipLab(days: Days, intraday: IntradayDays, judged: Days | null): Lab {
  // Leaves out nights with several signals off, exactly as the insight does, and with cycle
  // tracking on, judged against the person's own cycle as the insight judges them.
  const r = dipping(days, intraday, illnessDates(days, judged));
  const base = { key: 'dip' as const, title: t('labs.dip.title'), gloss: t('labs.dip.gloss') };
  const latestNonRem = [...days].reverse().find((d) => d.nonRemHr !== null)?.nonRemHr ?? null;
  const latestRhr = [...days].reverse().find((d) => d.restingHr !== null)?.restingHr ?? null;
  const day7 = r.nights.slice(-7);
  const dayMean = day7.length ? Math.round(day7.reduce((a, n) => a + n.dayMean, 0) / day7.length) : null;
  const nightMean = day7.length ? Math.round(day7.reduce((a, n) => a + n.nightMean, 0) / day7.length) : null;
  const bpm = (value: number) => t('labs.dip.stats.bpm', { value });
  const daytime: Stat = [t('labs.dip.stats.daytime'), dayMean !== null ? bpm(dayMean) : '—', t('labs.dip.stats.daytimeWindow')];
  const sleeping: Stat = nightMean !== null
    ? [t('labs.dip.stats.sleeping'), bpm(nightMean)]
    : [t('labs.dip.stats.sleeping'), latestNonRem !== null ? bpm(latestNonRem) : '—', latestNonRem !== null ? t('labs.dip.stats.nonRem') : undefined];
  const median = r.medianDipPct;

  if (r.status === 'collecting' || median === null) {
    const done = Math.min(r.daysCollected, r.daysWanted);
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: t('labs.dip.collecting.chip'),
      glance: t('labs.dip.collecting.glance', { done: r.daysCollected, total: r.daysWanted }), found: false,
      graph: <Corridor median={null} compact />,
      parts: (
        <>
          <Collecting
            text={t('labs.dip.collecting.text')} done={done} total={r.daysWanted}
            progress={t('labs.dip.collecting.progress', { done, total: r.daysWanted })}
            note={latestNonRem !== null ? t('labs.dip.collecting.noteTracking') : t('labs.dip.collecting.note')}
          />
          <Corridor median={null} />
          <Stats items={[
            sleeping, ...(latestRhr !== null ? [[t('labs.dip.stats.resting'), bpm(latestRhr)] as Stat] : []), daytime,
            [t('labs.dip.stats.median'), '—', t('labs.dip.stats.medianPending')],
          ]} />
        </>
      ),
    };
  }

  const stats = (
    <Stats items={[
      daytime, sleeping,
      [t('labs.dip.stats.median'), t('labs.dip.stats.medianValue', { value: median }), t('labs.dip.stats.medianWindow')],
      [t('labs.dip.stats.under'), t('labs.dip.stats.underValue', { count: r.nightsUnder10, total: r.measurableNights })],
    ]} />
  );

  if (r.status === 'pattern') {
    const chip = r.riser ? t('labs.dip.pattern.higher') : t('labs.dip.pattern.smaller');
    const text = median < 0
      ? t('labs.dip.answer.higher', { value: -median })
      : median === 0 ? t('labs.dip.answer.flat') : t('labs.dip.answer.drops', { value: median });
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: r.riser ? chip : t('labs.dip.pattern.glance', { median }), found: true,
      graph: <Corridor median={median} rose compact />,
      parts: (
        <>
          <Answer text={text} />
          <Corridor median={median} rose />
          <Callout>
            {rich('labs.dip.pattern.callout', { under: r.nightsUnder10, measured: r.measurableNights, excluded: r.excludedIllnessNights, b: lead })}
          </Callout>
          {stats}
        </>
      ),
    };
  }

  const label = t(DROP_LABEL[r.category]);
  const band = r.category === 'extreme-dipper' ? 'large' : 'typical';
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: label, glance: t('labs.dip.quiet.glance', { label, median }), found: false,
    graph: <Corridor median={median} compact />,
    parts: (
      <>
        <Answer
          text={t('labs.dip.answer.drops', { value: median })}
          sub={t('labs.dip.quiet.sub', { band, under: r.nightsUnder10, measured: r.measurableNights })}
        />
        <Corridor median={median} />
        {stats}
      </>
    ),
  };
}

// ── card 5 · HRV entropy ──────────────────────────────────────────────────

/** The last nights of a shift in rose, a night outside on its own in amber, the latest in white. */
function entropyFill(r: EntropyShift, i: number): string {
  if (r.status === 'shift' && i >= r.recent.length - r.shiftNights) return HEX.rose;
  if (r.recent[i].shifted) return HEX.amber;
  return i === r.recent.length - 1 ? HEX.zinc50 : HEX.zinc400;
}

function entropyScale(r: EntropyShift, top: number, bottom: number) {
  const vals = r.recent.map((p) => p.value);
  const band = r.usualLow !== null && r.usualHigh !== null;
  const pad = band ? (r.usualHigh! - r.usualLow!) / 4 : 0.1;
  const lo = band ? Math.min(...vals, r.usualLow! - pad) : Math.min(...vals) - pad;
  const hi = band ? Math.max(...vals, r.usualHigh! + pad) : Math.max(...vals) + pad;
  return (v: number) => top + ((hi - v) / (hi - lo || 1)) * (bottom - top);
}

function EntropyPlot({ r, compact = false }: { r: EntropyShift; compact?: boolean }) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const pts = r.recent;
  if (!pts.length) {
    return compact
      ? <div aria-hidden className="h-[28px] border-t border-dashed border-zinc-700 mt-3.5" />
      : <p className="text-caption text-zinc-500">{t('labs.entropy.plot.empty')}</p>;
  }
  const H = compact ? 28 : 66;
  const band = r.usualLow !== null && r.usualHigh !== null && r.baselineMedian !== null;
  const y = compact ? entropyScale(r, 3, H - 3) : entropyScale(r, 6, H - 8);
  const inset = compact ? 4 : 8;
  const x = (i: number) => (pts.length === 1 ? W / 2 : inset + i * ((W - 2 * inset) / (pts.length - 1)));
  const alone = pts.some((_, i) => entropyFill(r, i) === HEX.amber);
  const aria = band
    ? t('labs.entropy.plot.aria', { count: pts.length, low: formatFixed(r.usualLow!, 2), high: formatFixed(r.usualHigh!, 2) })
    : t('labs.entropy.plot.ariaCollecting', { count: pts.length });
  return (
    <div aria-hidden={compact || undefined}>
      <div ref={ref} style={{ height: H }}>
        {W > 0 && (
          <svg width={W} height={H} role={compact ? undefined : 'img'} aria-label={compact ? undefined : aria} className="block">
            {band && (
              <>
                <rect x={0} y={y(r.usualHigh!)} width={W} height={y(r.usualLow!) - y(r.usualHigh!)} rx={compact ? 3 : 4} fill={HEX.emerald} opacity={compact ? 0.12 : 0.08} />
                {!compact && <line x1={0} x2={W} y1={y(r.baselineMedian!)} y2={y(r.baselineMedian!)} stroke={HEX.emerald} strokeOpacity={0.4} strokeDasharray="3 4" />}
              </>
            )}
            {pts.map((p, i) => (
              <circle key={p.date} cx={x(i)} cy={y(p.value)} r={i === pts.length - 1 ? (compact ? 3.2 : 4) : (compact ? 2.4 : 3)} fill={entropyFill(r, i)} />
            ))}
          </svg>
        )}
      </div>
      <Ends compact={compact} left={formatCivil(pts[0].date)} right={formatCivil(pts[pts.length - 1].date)} />
      {!compact && (
        <div className="mt-1.5">
          <Keys items={band
            ? [
              [<span className="w-3.5 h-2 rounded-[2px] bg-emerald-400/15" />, t('labs.entropy.plot.keys.range')],
              [<Dot className="bg-zinc-50" />, t('labs.entropy.plot.keys.latest')],
              ...(alone ? [[<Dot className="bg-amber-400" />, t('labs.entropy.plot.keys.alone')] as [React.ReactNode, string]] : []),
              ...(r.status === 'shift' ? [[<Dot className="bg-rose-400" />, t('labs.entropy.plot.keys.row')] as [React.ReactNode, string]] : []),
            ]
            : [
              [<Dot className="bg-zinc-400" />, t('labs.entropy.plot.keys.soFar')],
              [<Dot className="bg-zinc-50" />, t('labs.entropy.plot.keys.latest')],
              [<span className="w-3.5 h-2 rounded-[2px] border border-dashed border-zinc-700" />, t('labs.entropy.plot.keys.pending')],
            ]}
          />
        </div>
      )}
    </div>
  );
}

function entropyLab(days: Days): Lab {
  const r = entropyShift(days);
  const base = { key: 'entropy' as const, title: t('labs.entropy.title'), gloss: t('labs.entropy.gloss'), graph: <EntropyPlot r={r} compact /> };
  const fmt = (v: number | null) => (v === null ? '—' : formatFixed(v, 2));
  const stats: Stat[] = [
    [t('labs.entropy.stats.latest'), fmt(r.lastNight)],
    [t('labs.entropy.stats.baseline'), fmt(r.baselineMedian)],
    [
      t('labs.entropy.stats.range'),
      r.usualLow !== null && r.usualHigh !== null ? t('labs.entropy.stats.rangeValue', { low: fmt(r.usualLow), high: fmt(r.usualHigh) }) : '—',
    ],
  ];

  if (r.status === 'collecting') {
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: t('labs.entropy.collecting.chip'), glance: t('labs.entropy.collecting.glance'), found: false,
      parts: (
        <>
          <Answer text={t('labs.entropy.collecting.text')} sub={t('labs.entropy.collecting.sub')} />
          <EntropyPlot r={r} />
          <Stats items={stats} />
        </>
      ),
    };
  }
  if (r.status === 'shift') {
    const chip = t('labs.entropy.shift.chip', { count: r.shiftNights });
    const below = r.recent[r.recent.length - 1].side < 0;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={t('labs.entropy.shift.text', { side: below ? 'below' : 'above', count: r.shiftNights })} />
          <EntropyPlot r={r} />
          <Callout>{rich('labs.entropy.shift.callout', { count: r.shiftNights, b: lead })}</Callout>
          <Stats items={[...stats, [t('labs.entropy.stats.shifted'), t('labs.entropy.stats.shiftedValue', { count: r.shiftNights })]]} />
        </>
      ),
    };
  }
  const alone = r.recent.filter((p) => p.shifted).length;
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: t('labs.entropy.steady.chip'), glance: t('labs.entropy.steady.glance', { count: r.steadyNights }), found: false,
    parts: (
      <>
        <Answer
          text={t('labs.entropy.steady.text', { count: r.steadyNights })}
          sub={alone ? t('labs.entropy.steady.sub', { count: alone }) : undefined}
        />
        <EntropyPlot r={r} />
        <Stats items={stats} />
      </>
    ),
  };
}

// ── card 6 · high heart rate during sleep ─────────────────────────────────

/** 40 bpm at the bottom of an h-unit box and 120 at the top, so 100 bpm sits a quarter of the way down. */
const bpmY = (bpm: number, h = 40) => h - ((Math.min(Math.max(bpm, 40), 120) - 40) / 80) * h;

/** Polylines through the trace, broken wherever readings are more than five minutes apart. */
function traceLines(trace: NightTrace, xOf: (min: number) => number, yOf: (bpm: number) => number, from = -Infinity, to = Infinity): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let prev: number | null = null;
  for (const p of trace.points) {
    if (p.min < from || p.min > to) continue;
    if (prev !== null && p.min - prev > 5) {
      if (current.length > 1) lines.push(current.join(' '));
      current = [];
    }
    current.push(`${xOf(p.min).toFixed(1)},${yOf(p.bpm).toFixed(1)}`);
    prev = p.min;
  }
  if (current.length > 1) lines.push(current.join(' '));
  return lines;
}

function NightTraceChart({ trace, compact = false }: { trace: NightTrace; compact?: boolean }) {
  const H = compact ? 22 : 40;
  const X = (min: number) => (min / trace.durationMin) * 1000;
  const Y = (bpm: number) => bpmY(bpm, H);
  const what = trace.isNap ? 'nap' : 'night';
  return (
    <div aria-hidden={compact || undefined}>
      <svg
        viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" width="100%" height={H} className={`block ${compact ? 'rounded' : 'rounded-md'} bg-panel-raised`}
        role={compact ? undefined : 'img'}
        aria-label={compact ? undefined : t('labs.tachy.trace.aria', { kind: what, date: formatCivilLong(trace.date), count: trace.stretches.length })}
      >
        {trace.stretches.map((s, i) => (
          <rect key={i} x={X(s.from)} y={0} width={Math.max(X(s.to) - X(s.from), 3)} height={H} fill={HEX.rose} opacity={0.14} />
        ))}
        <line x1={0} x2={1000} y1={Y(100)} y2={Y(100)} stroke={HEX.rose} strokeOpacity={0.45} strokeDasharray={compact ? '3 3' : '4 4'} vectorEffect="non-scaling-stroke" />
        {traceLines(trace, X, Y).map((pts, i) => (
          <polyline key={i} points={pts} fill="none" stroke={HEX.zinc500} strokeWidth={compact ? 1.1 : 1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        ))}
        {trace.stretches.flatMap((s, i) => traceLines(trace, X, Y, s.from, s.to).map((pts, j) => (
          <polyline key={`${i}-${j}`} points={pts} fill="none" stroke={HEX.rose} strokeWidth={compact ? 1.6 : 2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        )))}
      </svg>
      <Ends
        compact={compact} left={formatClock(trace.bedtimeMin)}
        mid={t('labs.tachy.trace.mid', { kind: what, date: formatCivilLong(trace.date) })} right={formatClock(trace.wakeMin)}
      />
      {!compact && (
        <div className="mt-2">
          <Keys items={[
            [<span className="w-3.5 border-t border-dashed border-rose-400/60" />, t('labs.tachy.trace.keys.line')],
            [<span className="w-3.5 h-0.5 rounded-full bg-zinc-500" />, t('labs.tachy.trace.keys.hr')],
            ...(trace.stretches.length
              ? [[<span className="w-3.5 h-0.5 rounded-full bg-rose-400" />, t('labs.tachy.trace.keys.above')] as [React.ReactNode, string]]
              : []),
          ]} />
        </div>
      )}
    </div>
  );
}

function EmptyNight({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role={compact ? undefined : 'img'}
      aria-hidden={compact || undefined}
      aria-label={compact ? undefined : t('labs.tachy.empty.aria')}
    >
      <div className={`relative ${compact ? 'h-[22px] rounded' : 'h-10 rounded-md'} bg-panel-raised`}>
        <span className={`absolute inset-x-0 ${compact ? 'top-1.5' : 'top-[10px]'} border-t border-dashed border-rose-400/45`} />
        {!compact && (
          <>
            <span className="absolute right-1.5 top-0 text-micro leading-none text-zinc-400">{t('labs.tachy.empty.line')}</span>
            <span className="absolute inset-x-0 top-[17px] text-center text-note text-zinc-600">{t('labs.tachy.empty.hint')}</span>
          </>
        )}
      </div>
      <Ends compact={compact} left={t('labs.tachy.empty.asleep')} right={t('labs.tachy.empty.woke')} />
    </div>
  );
}

const STAGE_NAME: Record<NonNullable<TachycardiaEvent['stage']>, MessageKey> = {
  deep: 'labs.tachy.events.stages.deep',
  rem: 'labs.tachy.events.stages.rem',
  light: 'labs.tachy.events.stages.light',
};

function EventRows({ events }: { events: TachycardiaEvent[] }) {
  return (
    <div>
      {events.map((e) => (
        <div key={`${e.date}-${e.startMin}-${e.peakBpm}`} className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3 py-2 border-t border-zinc-800/60 text-caption">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-zinc-200 font-semibold min-w-[76px]">{formatCivilLong(e.date)}</span>
            <span className="text-zinc-400 tabular-nums">
              {t('labs.tachy.events.time', { from: formatClock(e.startMin), to: formatClock(e.endMin), minutes: e.durationMin })}
            </span>
            {e.sleepWindow && (
              <span className="text-note px-1.5 py-0.5 rounded bg-zinc-800/90 text-zinc-300 border border-zinc-700/60 font-medium">{e.sleepWindow}</span>
            )}
            {e.stage && <span className="text-note text-zinc-400">{t(STAGE_NAME[e.stage])}</span>}
          </div>
          <span className="text-rose-300 font-semibold tabular-nums whitespace-nowrap ml-auto">{t('labs.tachy.events.peak', { bpm: e.peakBpm })}</span>
        </div>
      ))}
    </div>
  );
}

function tachyLab(days: Days, intraday: IntradayDays): Lab {
  const r = nocturnalTachycardia(days, intraday);
  const base = { key: 'tachy' as const, title: t('labs.tachy.title'), gloss: t('labs.tachy.gloss') };
  const trace = r.trace;

  if (r.status === 'collecting' || !trace) {
    const collected = Math.min(completedIntradayDays(intraday).length, 7);
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: t('labs.tachy.collecting.chip'), glance: t('labs.tachy.collecting.glance', { done: collected }), found: false,
      graph: <EmptyNight compact />,
      parts: (
        <>
          <Collecting
            text={t('labs.tachy.collecting.text')} done={collected} total={7}
            progress={t('labs.tachy.collecting.progress', { done: collected, total: 7 })}
            note={collected >= 7 ? t('labs.tachy.collecting.waiting') : t('labs.tachy.collecting.note')}
          />
          <EmptyNight />
          <Stats items={[[t('labs.tachy.stats.nights'), r.nightsScanned], [t('labs.tachy.stats.stretches'), r.events.length]]} />
        </>
      ),
    };
  }

  const graph = <NightTraceChart trace={trace} compact />;
  if (r.status === 'events') {
    const n = r.events.length;
    const longest = r.events.reduce((a, e) => Math.max(a, e.durationMin), 0);
    const peak = Math.max(...r.events.map((e) => e.peakBpm));
    const chip = t('labs.tachy.events.chip', { count: n, nights: r.nightsScanned });
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true, graph,
      parts: (
        <>
          <Answer text={t('labs.tachy.events.text', { count: n, nights: r.nightsScanned })} />
          <NightTraceChart trace={trace} />
          <EventRows events={r.events.slice(-6).reverse()} />
          <Callout>{rich('labs.tachy.events.callout', { count: n, nights: r.nightsScanned, b: lead })}</Callout>
          <Stats items={[
            [t('labs.tachy.stats.nights'), r.nightsScanned], [t('labs.tachy.stats.stretches'), n],
            [t('labs.tachy.stats.longest'), t('labs.tachy.stats.longestValue', { minutes: longest }), t('labs.tachy.stats.peak', { bpm: peak })],
          ]} />
        </>
      ),
    };
  }
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: t('labs.tachy.none.chip'), glance: t('labs.tachy.none.glance', { count: r.nightsScanned }), found: false, graph,
    parts: (
      <>
        <Answer text={t('labs.tachy.none.text')} sub={t('labs.tachy.none.sub', { count: r.nightsScanned })} />
        <NightTraceChart trace={trace} />
        <Stats items={[[t('labs.tachy.stats.nights'), r.nightsScanned], [t('labs.tachy.stats.stretches'), 0]]} />
      </>
    ),
  };
}

// ── page ──────────────────────────────────────────────────────────────────

function Intro({ wide = false }: { wide?: boolean }) {
  return (
    <header className={`px-1 ${wide ? 'max-w-3xl' : ''}`}>
      <p className="text-body leading-normal text-zinc-400">
        {rich('labs.intro.lead', { b: (w) => <b className="font-semibold text-zinc-50">{w}</b> })}
      </p>
      <p className="mt-2 flex gap-2 text-caption leading-relaxed text-page-ink">
        <Info size={14} aria-hidden className="shrink-0 mt-px text-zinc-400" />
        <span>{t('labs.intro.disclaimer')}</span>
      </p>
    </header>
  );
}

function Legend() {
  const items: [Mark, MessageKey][] = [
    ['quiet', 'labs.legend.quiet'], ['collecting', 'labs.legend.collecting'], ['reported', 'labs.legend.reported'], ['found', 'labs.legend.found'],
  ];
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 py-2.5 text-note text-page-ink">
      {items.map(([mark, label]) => <span key={mark} className="flex items-center gap-1.5"><StatusIcon mark={mark} size={12} />{t(label)}</span>)}
    </div>
  );
}

/** Icon, title and status line: the head of every tile. */
function TileHead({ lab, chevron, center = false }: { lab: Lab; chevron: React.ReactNode; center?: boolean }) {
  return (
    <span className={`flex gap-3 ${center ? 'items-center' : ''}`}>
      <span className={`flex ${center ? '' : 'self-start'}`}><StatusIcon mark={lab.mark} /></span>
      <span className="flex-1 min-w-0">
        <span className="block font-display text-title-sm leading-snug text-zinc-100">{lab.title}</span>
        <span className={`block mt-0.5 text-caption leading-snug ${GLANCE[lab.tone]}`}>{lab.glance}</span>
      </span>
      {chevron}
    </span>
  );
}

function LabCard({ lab }: { lab: Lab }) {
  return (
    <section id={`lab-${lab.key}`} aria-label={lab.title} className="scroll-mt-20 min-w-0 bg-card border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <h3 className="font-display text-title leading-tight text-zinc-100">{lab.title}</h3>
          <p className="mt-[3px] text-caption text-zinc-500">{lab.gloss}</p>
        </div>
        <Chip lab={lab} />
      </div>
      {lab.parts}
      {!lab.found && <Spec k={lab.key} />}
      <HowItWorks k={lab.key} />
    </section>
  );
}

/** A phone tile: the glance and its graph closed; the whole card, in the same tile, open. */
function LabRow({ lab }: { lab: Lab }) {
  return (
    <details className="group bg-card border border-zinc-800/80 rounded-2xl px-3.5">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer block py-3.5">
        <TileHead
          lab={lab} center
          chevron={<ChevronDown size={14} aria-hidden className="shrink-0 text-zinc-600 transition-transform group-open:rotate-180" />}
        />
        {/* The full picture is in the card once the tile is open. */}
        <span className="block mt-2.5 group-open:hidden">{lab.graph}</span>
      </summary>
      <div className="border-t border-zinc-800/80 pt-3 flex flex-col gap-3">
        <p className="text-caption text-zinc-500">{lab.gloss}</p>
        {lab.parts}
        {!lab.found && <Spec k={lab.key} />}
        <HowItWorks k={lab.key} />
      </div>
    </details>
  );
}

function Overview({ labs }: { labs: Lab[] }) {
  const jump = (e: React.MouseEvent, key: LabKey) => {
    e.preventDefault();
    document.getElementById(`lab-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <nav aria-label={t('labs.overview.label')} className="grid grid-cols-3 gap-2.5">
      {labs.map((lab) => (
        <a
          key={lab.key} href={`#lab-${lab.key}`} onClick={(e) => jump(e, lab.key)}
          className="flex flex-col gap-3 px-3.5 pt-3 pb-3.5 rounded-[14px] bg-card border border-zinc-800/80 hover:border-zinc-700 transition-colors"
        >
          <TileHead lab={lab} chevron={<ChevronRight size={14} aria-hidden className="self-start mt-0.5 shrink-0 text-zinc-600" />} />
          <span className="block mt-auto">{lab.graph}</span>
        </a>
      ))}
    </nav>
  );
}

export function LabsView({ data, intraday = {} }: { data: SyncResult; intraday?: IntradayDays }) {
  const wide = useMediaQuery('(min-width: 768px)');
  const { judged } = useCycle();
  const labs = useMemo(
    () => [
      sdbLab(data.days), strainLab(data.days, judged), irnLab(data), dipLab(data.days, intraday, judged), entropyLab(data.days), tachyLab(data.days, intraday),
    ],
    [data, intraday, judged],
  );

  if (!wide) {
    return (
      <div>
        <Intro />
        <section aria-label={t('labs.list.label')} className="mt-4 flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <span className="text-eyebrow-sm font-bold uppercase text-page-ink">{t('labs.list.count', { count: labs.length })}</span>
            <span className="text-note text-page-ink">{t('labs.list.hint')}</span>
          </div>
          {labs.map((lab) => <LabRow key={lab.key} lab={lab} />)}
          <div className="px-1"><Legend /></div>
        </section>
      </div>
    );
  }

  return (
    <div>
      <Intro wide />
      <div className="mt-5">
        <Overview labs={labs} />
        <div className="flex justify-end"><Legend /></div>
      </div>
      <div className="mt-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {labs.map((lab) => <LabCard key={lab.key} lab={lab} />)}
      </div>
    </div>
  );
}
