import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, ChevronDown, ChevronRight, CircleCheck, CircleDashed, Clock, Eye, Info } from 'lucide-react';
import type { SyncResult } from '../pipeline/sync';
import {
  completedIntradayDays, dipping, entropyShift, nocturnalTachycardia, sdbScreen, strainToday,
  type EntropyShift, type IntradayDays, type NightTrace, type SdbNight, type StrainKey, type StrainSignal, type StrainToday, type TachycardiaEvent,
} from '../pipeline/labs';
import { useMediaQuery } from '../hooks/useMediaQuery';

/**
 * 🧪 Labs: experimental views of multi-week patterns in wearable data.
 *
 * Wording rule for this file: describe what was observed, against the person's
 * own usual range, with everyday explanations. Never name a condition, never
 * present a card as screening, detection or an all-clear, and suggest a
 * clinician only alongside symptoms. Healthier is a wellness tool, not a
 * medical device (see the README's intended-purpose statement).
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

// SVG fills, matching the Tailwind colours around them.
const HEX = { zinc800: '#27272a', zinc500: '#71717a', zinc400: '#a1a1aa', zinc50: '#fafafa', amber: '#fbbf24', rose: '#fb7185', emerald: '#34d399' };

const fmtClock = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── what each card watches, and how it works ──────────────────────────────

/** In the pipeline's own terms (src/pipeline/labs.ts). */
const SPEC: Record<LabKey, { watch: [string, string]; light: [string, string] }> = {
  sdb: {
    watch: ['Watches', "each night's oxygen, breathing rate and time awake against your usual range."],
    light: ['Lights up', 'when 3 or more of the last 14 nights have two of them off together.'],
  },
  strain: {
    watch: ['Watches', 'resting HR, breathing rate, HRV and skin temperature on the latest day.'],
    light: ['Lights up', 'when 2 are off together (Elevated) or 3–4 (High), marking which ones.'],
  },
  irn: {
    watch: ['Shows', 'irregular rhythm notifications your device synced to Google Health, by day.'],
    light: ['No notifications', "doesn't mean your rhythm was checked: many devices look only occasionally, or not at all."],
  },
  dip: {
    watch: ['Watches', 'how far your heart rate falls from daytime to non-REM sleep over 30 days.'],
    light: ['Lights up', 'when half or more of the measured nights drop less than 10%.'],
  },
  entropy: {
    watch: ['Watches', "your device's nightly HRV entropy against your usual range."],
    light: ['Lights up', 'when 3 or more nights in a row, up to the latest, fall outside it on the same side.'],
  },
  tachy: {
    watch: ['Watches', 'minute-level heart rate through recorded sleep and naps, skipping minutes awake.'],
    light: ['Lights up', 'for any stretch above 100 bpm lasting 10 minutes or more, listed with its peak.'],
  },
};

const em = (t: string) => <b className="text-zinc-300 font-semibold">{t}</b>;
const HOW: Record<LabKey, { explainer: React.ReactNode; extra?: string; footer: string }> = {
  sdb: {
    explainer: <>Compares each night's average oxygen, breathing rate and time awake with your own usual range. A night counts when {em('two of them are off together')}, and a pattern needs several such nights in the last two weeks — never one bad night.</>,
    footer: "Uses nightly average oxygen saturation, breathing rate and time awake as your device reports them. Wrist sensors miss a lot during sleep, so a quiet card doesn't rule anything out.",
  },
  strain: {
    explainer: <>One metric can move because of a late meal or a warm room. When {em('several move at once')}, it's a clearer sign that something changed: often recovery, sometimes a cold coming on.</>,
    extra: 'Each signal counts as off when it leaves your usual range in the direction that matters: resting HR and breathing rate above it, HRV below it, and skin temperature 0.5 °C or more above.',
    footer: 'Counts how many of resting heart rate, breathing rate, skin temperature and HRV are outside your usual range on the latest day. Several at once often follows hard training, short sleep, alcohol, heat or travel, or feeling under the weather.',
  },
  irn: {
    explainer: 'Some devices can notify you about an irregular heart rhythm. Any notifications they synced appear here with their dates.',
    footer: "Shows notifications your device reported to Google Health. This app does not analyse heart rhythm. For anything your device flags, follow its maker's guidance and talk to a clinician.",
  },
  dip: {
    explainer: <>Heart rate usually drops during sleep compared with the daytime, often by {em('10–20%')}. This tracks your own drop over the last 30 days. Late meals, alcohol, heat, evening exercise and illness all shift it from night to night, so only a multi-week change is shown.</>,
    footer: 'Daytime is the 08:00–20:00 average of your minute-level heart rate; night is your non-REM sleeping heart rate. A 10% drop is a night/day ratio of 0.90. The 10% and 20% lines come from overnight blood-pressure research and are only a rough guide for heart rate.',
  },
  entropy: {
    explainer: <>Each night your device summarises how variable the spacing between heartbeats was as a single number. Its absolute value has no standard meaning, so this tracks one thing only: a {em('sustained change against your own baseline')}.</>,
    footer: 'A number your device computes each night from the intervals between heartbeats. It has no standard scale and is not a measure of heart rhythm, so only changes against your own baseline are shown.',
  },
  tachy: {
    explainer: <>Lists stretches of recorded sleep where your heart rate stayed {em('above 100 bpm for ten minutes or more')}. Fever, alcohol, vivid dreams, waking and movement can all do this.</>,
    footer: 'Uses the one-minute heart-rate averages synced from your watch. Wrist readings during sleep can be noisy, and movement or waking raises them.',
  },
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
      <p className="font-display text-headline leading-snug font-semibold text-zinc-50">{text}</p>
      {sub && <p className="mt-1 text-caption leading-normal text-zinc-400">{sub}</p>}
    </div>
  );
}

function Progress({ done, total, unit }: { done: number; total: number; unit: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${done} of ${total} ${unit}`}
        className="flex-1 grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, i) => <span key={i} className={`h-1.5 rounded-full ${i < done ? 'bg-amber-400' : 'bg-zinc-800'}`} />)}
      </div>
      <span className="text-caption text-amber-300 whitespace-nowrap tabular-nums">{done} of {total} {unit}</span>
    </div>
  );
}

function Collecting({ text, done, total, unit, note }: { text: string; done: number; total: number; unit: string; note: string }) {
  return (
    <div>
      <p className="font-display text-headline leading-snug font-semibold text-zinc-50">{text}</p>
      <div className="mt-2"><Progress done={done} total={total} unit={unit} /></div>
      <p className="mt-1.5 text-caption leading-normal text-zinc-500">{note}</p>
    </div>
  );
}

type Stat = [label: string, value: React.ReactNode, sub?: string];

function Stats({ items }: { items: Stat[] }) {
  return (
    <div className="flex flex-wrap gap-x-[22px] gap-y-2">
      {items.map(([k, v, sub]) => (
        <div key={k}>
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
      {items.map(([swatch, label]) => <span key={label} className="flex items-center gap-1.5">{swatch}{label}</span>)}
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

/** The one element that carries the alert treatment: what was seen. */
function Callout({ lead, children }: { lead: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-[10px] border px-3.5 py-3 text-caption leading-normal text-zinc-300"
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

function DeviceNote() {
  return (
    <p className="rounded-[10px] border border-zinc-800/80 bg-[#111114] px-3 py-2.5 text-caption leading-normal text-zinc-300">
      <b className="font-semibold text-zinc-50">As your device reported them.</b> Healthier doesn't analyse heart rhythm: for anything your device flags, follow its maker's guidance and talk to a clinician.
    </p>
  );
}

function Spec({ k }: { k: LabKey }) {
  const { watch, light } = SPEC[k];
  return (
    <div className="flex flex-col gap-2 px-3 py-[11px] rounded-xl border border-[#1c1c20] bg-[#111114]">
      <p className="flex gap-2 text-caption leading-normal text-zinc-400">
        <Eye size={13} aria-hidden className="shrink-0 mt-[3px]" />
        <span><b className="font-semibold text-zinc-100">{watch[0]}</b> {watch[1]}</span>
      </p>
      <p className="flex gap-2 text-caption leading-normal text-zinc-400">
        <span className="shrink-0 w-[13px] h-[13px] mt-[3px] grid place-items-center">
          <span className={`w-[7px] h-[7px] rounded-full ${k === 'irn' ? 'bg-zinc-600' : 'bg-rose-400'}`} />
        </span>
        <span><b className="font-semibold text-zinc-100">{light[0]}</b> {light[1]}</span>
      </p>
    </div>
  );
}

function HowItWorks({ k }: { k: LabKey }) {
  const { explainer, extra, footer } = HOW[k];
  return (
    <details className="group/how mt-auto border-t border-zinc-800/80">
      <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer flex items-center justify-between min-h-11 text-detail font-medium text-zinc-400 hover:text-zinc-200 transition-colors">
        How it works
        <ChevronDown size={14} aria-hidden className="transition-transform group-open/how:rotate-180" />
      </summary>
      <p className="text-caption leading-relaxed text-zinc-400">{explainer}</p>
      {extra && <p className="mt-2 text-caption leading-relaxed text-zinc-400">{extra}</p>}
      <p className="mt-2 pb-1 text-note leading-relaxed text-zinc-500">{footer}</p>
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

const SDB_SIGNALS = [['oxygen', 'Oxygen'], ['breathing', 'Breathing'], ['awake', 'Time awake']] as const;
const offCount = (n: SdbNight) => Number(n.oxygen) + Number(n.breathing) + Number(n.awake);
const offNames = (n: SdbNight) => SDB_SIGNALS.filter(([k]) => n[k]).map(([, label]) => label.toLowerCase());

function SdbGrid({ nights, judged }: { nights: SdbNight[]; judged: boolean }) {
  if (!nights.length) return null;
  const fired = nights.filter((n) => offCount(n) >= 2).length;
  const aria = judged
    ? `The last ${nights.length} nights: ${fired ? `${plural(fired, 'night')} with two or more signals off together` : 'no night with two signals off together'}`
    : `${nights.filter((n) => n.measured).length} of the last ${nights.length} nights measured so far, none judged yet`;
  const dashed = <Swatch className="border border-dashed border-zinc-700" />;
  return (
    <div role="img" aria-label={aria}>
      <div className="grid items-center gap-y-[7px]" style={{ gridTemplateColumns: `74px repeat(${nights.length}, minmax(0, 1fr))` }}>
        {SDB_SIGNALS.map(([k, label]) => (
          <React.Fragment key={k}>
            <span className="text-caption leading-tight text-zinc-400">{label}</span>
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
      <div className="pl-[74px]"><Ends left={fmtDay(nights[0].date)} right={fmtDay(nights[nights.length - 1].date)} /></div>
      <div className="mt-2">
        <Keys items={judged
          ? [[<Swatch className="bg-amber-400" />, 'off for you'], [<Swatch className="bg-rose-400" />, 'two or more off on one night'], [dashed, 'not measured yet']]
          : [[<Swatch className="bg-zinc-800" />, 'measured, not judged yet'], [dashed, 'not measured yet']]}
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
      <Ends compact left={fmtDay(nights[0].date)} right={fmtDay(nights[nights.length - 1].date)} />
    </div>
  );
}

function sdbLab(days: Days): Lab {
  const r = sdbScreen(days);
  const base = { key: 'sdb' as const, title: 'Sleep-disordered breathing patterns', gloss: 'breathing during sleep', graph: <SdbBars nights={r.nights} /> };
  const fired = r.nights.filter((n) => offCount(n) >= 2);
  const singles = r.nights.filter((n) => offCount(n) === 1);
  const stats = (
    <Stats items={[
      ['Nights measured', r.nightsInWindow, 'last 6 weeks'],
      ['Usual arousals', r.stats.arousalsPerHourTypical !== null ? `${r.stats.arousalsPerHourTypical}/h` : '—'],
    ]} />
  );

  if (r.status === 'collecting') {
    const collected = Math.min(r.beforeNights, r.beforeWanted) + Math.min(r.testedNights, r.testedWanted);
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: 'Collecting', glance: `Collecting · ${collected} of ${r.nightsWanted} nights`, found: false,
      parts: (
        <>
          <Collecting
            text="Learning your usual range" done={collected} total={r.nightsWanted} unit="nights"
            note="Needs about four weeks of nights: 14 to learn your usual range, then 7 recent ones to compare with it."
          />
          <SdbGrid nights={r.nights} judged={false} />
          {stats}
        </>
      ),
    };
  }

  if (r.status === 'pattern') {
    const chip = `${r.firedCount} nights · last 14`;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={`${r.firedCount} of the last 14 nights had two or more off together`} />
          <SdbGrid nights={r.nights} judged />
          <DayList dot="bg-rose-400" rows={fired.map((n) => [fmtDate(n.date), offCount(n) === 3 ? 'All three' : sentence(offNames(n).join(', '))])} />
          <Callout lead={`On ${r.firedCount} of the last 14 nights, two or more of these were outside your usual range together.`}>
            A cold, alcohol, a stuffy or hot room, altitude or a late meal can all do this. If you also
            snore heavily, wake unrefreshed or feel very sleepy during the day, that's worth raising
            with a clinician.
          </Callout>
          {stats}
        </>
      ),
    };
  }

  const sub = fired.length
    ? `${plural(fired.length, 'night')} had two or more off together; it takes 3 in 14 nights to count.`
    : singles.length === 1
      ? `On ${fmtDay(singles[0].date)} only ${offNames(singles[0])[0]} was off. One signal on its own doesn't count.`
      : singles.length > 1
        ? `${singles.length} nights had one signal off. One signal on its own doesn't count.`
        : 'Every measured night stayed inside your usual range.';
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: 'No pattern', glance: 'No pattern · last 14 nights', found: false,
    parts: (
      <>
        <Answer text="No pattern in the last 14 nights" sub={sub} />
        <SdbGrid nights={r.nights} judged />
        {stats}
      </>
    ),
  };
}

// ── card 2 · system strain ────────────────────────────────────────────────

const STRAIN_NAME: Record<StrainKey, string> = { restingHr: 'Resting HR', breathing: 'Breathing rate', hrv: 'HRV', skinTemp: 'Skin temp' };
const STRAIN_WORDS: Record<StrainKey, string> = { restingHr: 'resting HR', breathing: 'breathing rate', hrv: 'HRV', skinTemp: 'skin temperature' };
const STRAIN_DIR: Record<StrainKey, 'above' | 'below'> = { restingHr: 'above', breathing: 'above', hrv: 'below', skinTemp: 'above' };

/** Each tile says only how its signal stands today; which way counts as off is in "How it works". */
function StrainTiles({ signals, rose }: { signals: StrainSignal[]; rose: boolean }) {
  const word = (s: StrainSignal) => (s.status === 'off' ? 'off' : s.status === 'in' ? 'normal' : 'no data');
  return (
    <div role="img" aria-label={`Today: ${signals.map((s) => `${STRAIN_WORDS[s.key]} ${word(s)}`).join(', ')}`} className="grid grid-cols-2 gap-2">
      {signals.map((s) => {
        const off = s.status === 'off';
        return (
          <div key={s.key} className={`rounded-xl border px-[11px] py-[9px] ${off ? (rose ? 'border-rose-500/40' : 'border-amber-400/35') : 'border-zinc-800/80'}`}>
            <div className="flex items-center justify-between gap-1.5">
              <span className="text-detail font-semibold text-zinc-200">{STRAIN_NAME[s.key]}</span>
              <span className={`shrink-0 w-2 h-2 rounded-full ${
                s.status === 'none' ? 'border-[1.5px] border-zinc-600' : off ? (rose ? 'bg-rose-400' : 'bg-amber-400') : 'bg-emerald-400/70'}`}
              />
            </div>
            <div className={`mt-0.5 text-note ${off ? (rose ? 'text-rose-300' : 'text-amber-300') : 'text-zinc-500'}`}>
              {off ? `${sentence(STRAIN_DIR[s.key])} usual today` : s.status === 'in' ? 'Normal' : 'No data'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const LEVELS = [
  { key: 'baseline', name: 'Baseline', label: 'Baseline · 0–1 off', bar: 'bg-emerald-400 rounded-l', today: 'text-emerald-400 text-left', align: 'text-left' },
  { key: 'elevated', name: 'Elevated', label: 'Elevated · 2 off', bar: 'bg-amber-400', today: 'text-amber-400 text-center', align: 'text-center' },
  { key: 'high', name: 'High', label: 'High · 3–4 off', bar: 'bg-rose-500 rounded-r', today: 'text-rose-400 text-right', align: 'text-right' },
] as const;

/** The stages; on a tile, just their names, with today's in bold. */
function StrainScale({ level, compact = false }: { level: StrainToday['level']; compact?: boolean }) {
  return (
    <div
      role={compact ? undefined : 'img'}
      aria-hidden={compact || undefined}
      aria-label={compact ? undefined : level
        ? `Today sits at ${level}. Baseline is 0 or 1 signals off, Elevated 2, High 3 or 4`
        : "Baseline is 0 or 1 signals off, Elevated 2, High 3 or 4; no position until today's readings arrive"}
    >
      {level && !compact && (
        <div className="grid grid-cols-3 mb-1 text-eyebrow-sm font-bold">
          {LEVELS.map((l) => <span key={l.key} className={l.today}>{l.key === level ? 'TODAY' : ''}</span>)}
        </div>
      )}
      <div className={`grid grid-cols-3 ${compact ? 'gap-[3px]' : 'gap-1'}`}>
        {LEVELS.map((l) => <span key={l.key} className={`${compact ? 'h-1.5' : 'h-2'} ${l.bar} ${l.key === level ? 'opacity-65' : 'opacity-20'}`} />)}
      </div>
      <div className={`${compact ? 'mt-[5px] text-note leading-tight text-zinc-600' : 'mt-1.5 text-note text-zinc-500'} grid grid-cols-3`}>
        {LEVELS.map((l) => (
          <span key={l.key} className={`${l.align} ${l.key === level ? 'font-semibold text-zinc-200' : ''}`}>{compact ? l.name : l.label}</span>
        ))}
      </div>
    </div>
  );
}

function strainLab(days: Days): Lab {
  const r = strainToday(days);
  const base = { key: 'strain' as const, title: 'System Strain Radar', gloss: 'physiological deviations', graph: <StrainScale level={r.level} compact /> };
  const rose = r.level === 'high';
  const off = r.signals.filter((s) => s.status === 'off');
  const offWords = listOf(off.map((s) => STRAIN_WORDS[s.key]));
  const picture = <><StrainTiles signals={r.signals} rose={rose} /><StrainScale level={r.level} /></>;

  if (r.status === 'collecting') {
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: 'Collecting', glance: 'Collecting · learning your ranges', found: false,
      parts: <><Answer text="Learning your usual ranges" sub="Needs about four weeks of readings before today can be compared with them." />{picture}</>,
    };
  }
  if (r.status === 'waiting') {
    return {
      ...base, tone: 'wait', mark: 'waiting', chip: 'Waiting', glance: "Waiting for today's readings", found: false,
      parts: (
        <>
          <Answer
            text="Waiting for today's readings"
            sub={r.arrived === 0
              ? "Your usual ranges are ready. None of today's four readings has arrived yet."
              : "Your usual ranges are ready. It compares once two of today's readings are in."}
          />
          {picture}
        </>
      ),
    };
  }
  if (r.level === 'high') {
    const chip = `High · ${r.off} signals off`;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={`${r.off} of 4 signals off today`} />
          {picture}
          <Callout lead={`${sentence(offWords)} were all outside your usual range today.`}>
            Several at once often follows hard training, short sleep, alcohol, heat or travel, or feeling under the weather.
          </Callout>
        </>
      ),
    };
  }
  if (r.level === 'elevated') {
    return {
      ...base, tone: 'wait', mark: 'notice', chip: 'Elevated · 2 signals off', glance: 'Elevated · 2 signals off', found: true,
      parts: (
        <>
          <Answer
            text="2 of 4 signals off today"
            sub={`${sentence(offWords)} are outside your usual range. Several at once often follows hard training, short sleep, alcohol, heat or travel.`}
          />
          {picture}
        </>
      ),
    };
  }
  const judged = r.signals.filter((s) => s.status !== 'none').length;
  const sub = r.off === 1
    ? `Only ${STRAIN_WORDS[off[0].key]} is ${STRAIN_DIR[off[0].key]} usual. One on its own doesn't count.`
    : judged === 4 ? 'All four are inside your usual range.' : `Today's ${judged} readings so far are inside your usual range.`;
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: 'Baseline', glance: `Baseline · ${r.off} of 4 off`, found: false,
    parts: <><Answer text="Baseline today" sub={sub} />{picture}</>,
  };
}

// ── card 3 · irregular rhythm notifications ───────────────────────────────

function IrnStrip({ days, ghost = false, compact = false }: { days: Days; ghost?: boolean; compact?: boolean }) {
  if (!days.length) return null;
  const marked = days.filter((d) => d.irn && d.irn > 0);
  const h = compact ? 16 : 20;
  const aria = ghost
    ? 'Not synced, so there are no days to show'
    : marked.length
      ? `The last ${days.length} days, with notifications on ${listOf(marked.map((d) => fmtDay(d.date)))}`
      : `The last ${days.length} days, with no notifications synced`;
  return (
    <div role={compact ? undefined : 'img'} aria-hidden={compact || undefined} aria-label={compact ? undefined : aria}>
      <div className="relative">
        <svg viewBox={`0 0 ${days.length * 10} ${h}`} preserveAspectRatio="none" width="100%" height={h} className={`block ${ghost ? 'opacity-30' : ''}`}>
          {days.map((d, i) => (!ghost && d.irn && d.irn > 0
            ? <rect key={d.date} x={i * 10} y={0} width={6.5} height={h} rx={1} fill={HEX.amber} />
            : <rect key={d.date} x={i * 10} y={h * 0.3} width={6.5} height={h * 0.4} rx={1} fill={HEX.zinc800} />))}
        </svg>
        {ghost && <span className="absolute inset-0 flex items-center justify-center text-note text-zinc-400">not synced</span>}
      </div>
      <Ends compact={compact} left={fmtDay(days[0].date)} right="today" />
    </div>
  );
}

function irnLab(data: SyncResult): Lab {
  const days = data.days;
  const events = days.filter((d) => d.irn && d.irn > 0);
  const stream = data.meta.streams.find((s) => s.dataType === 'irregular-rhythm-notification');
  const synced = !!stream && stream.status !== 'skipped' && stream.status !== 'unauthorized' && stream.status !== 'error';
  const base = { key: 'irn' as const, title: 'Irregular rhythm notifications', gloss: 'reported by your device' };

  if (events.length) {
    const text = `${plural(events.length, 'day')} with notifications`;
    return {
      ...base, tone: 'wait', mark: 'reported', chip: 'Reported', glance: text, found: true, graph: <IrnStrip days={days} compact />,
      parts: (
        <>
          <Answer text={text} />
          <IrnStrip days={days} />
          <DayList dot="bg-amber-400" rows={events.map((e) => [fmtDate(e.date), plural(e.irn!, 'notification')])} />
          <DeviceNote />
        </>
      ),
    };
  }
  if (!synced) {
    return {
      ...base, tone: 'wait', mark: 'unsynced', chip: 'Not synced', glance: 'Not synced', found: false, graph: <IrnStrip days={days} ghost compact />,
      parts: <><Answer text="Not shared with Healthier" sub="Its permission wasn't granted, or the last sync couldn't read it." /><IrnStrip days={days} ghost /></>,
    };
  }
  return {
    ...base, tone: 'neutral', mark: 'none', chip: 'None synced', glance: 'None synced', found: false, graph: <IrnStrip days={days} compact />,
    parts: <><Answer text="No notifications synced" sub={`Nothing in the last ${days.length} days.`} /><IrnStrip days={days} /></>,
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
const DROP_LABEL: Record<string, string> = {
  dipper: 'Typical drop',
  'extreme dipper': 'Large drop',
  'non-dipper': 'Small drop',
  riser: 'Higher at night',
};

function Corridor({ median, rose = false, compact = false }: { median: number | null; rose?: boolean; compact?: boolean }) {
  const left = median === null ? null : corridorLeft(median);
  return (
    <div
      role={compact ? undefined : 'img'}
      aria-hidden={compact || undefined}
      aria-label={compact ? undefined : median === null
        ? 'The bands your median drop will be placed on: rise below 0%, small 0 to 10%, typical 10 to 20%, large over 20%'
        : `Your median drop, ${median}%, on the bands: rise below 0%, small 0 to 10%, typical 10 to 20%, large over 20%`}
    >
      {left === null && !compact && <p className="mb-1.5 text-note text-zinc-500">Your median drop will be marked on these bands</p>}
      <div className={`relative ${left === null ? '' : compact ? 'pt-[15px]' : 'pt-[17px]'}`}>
        {left !== null && (
          <span
            className={`absolute top-0 -translate-x-1/2 text-micro ${compact ? '' : 'leading-3'} font-bold tracking-widest whitespace-nowrap ${rose ? 'text-rose-300' : 'text-zinc-50'}`}
            style={{ left: `${Math.min(Math.max(left, 9), 91)}%` }}
          >
            YOU · {median}%
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
          <span>Rise &lt; 0%</span><span>Small 0–10%</span><span>Typical 10–20%</span><span>Large &gt; 20%</span>
        </div>
      </div>
    </div>
  );
}

function dipLab(days: Days, intraday: IntradayDays): Lab {
  // Leaves out nights with several signals off, exactly as the insight does.
  const r = dipping(days, intraday);
  const base = { key: 'dip' as const, title: 'Nocturnal HR dipping', gloss: 'day-to-night heart rate' };
  const latestNonRem = [...days].reverse().find((d) => d.nonRemHr !== null)?.nonRemHr ?? null;
  const latestRhr = [...days].reverse().find((d) => d.restingHr !== null)?.restingHr ?? null;
  const day7 = r.nights.slice(-7);
  const dayMean = day7.length ? Math.round(day7.reduce((a, n) => a + n.dayMean, 0) / day7.length) : null;
  const nightMean = day7.length ? Math.round(day7.reduce((a, n) => a + n.nightMean, 0) / day7.length) : null;
  const daytime: Stat = ['Daytime HR', dayMean !== null ? `${dayMean} bpm` : '—', '7 days'];
  const sleeping: Stat = nightMean !== null
    ? ['Sleeping HR', `${nightMean} bpm`]
    : ['Sleeping HR', latestNonRem !== null ? `${latestNonRem} bpm` : '—', latestNonRem !== null ? 'non-REM' : undefined];
  const median = r.medianDipPct;

  if (r.status === 'collecting' || median === null) {
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: 'Collecting', glance: `Collecting · ${r.daysCollected} of ${r.daysWanted} days`, found: false,
      graph: <Corridor median={null} compact />,
      parts: (
        <>
          <Collecting
            text="Collecting daytime heart rate" done={Math.min(r.daysCollected, r.daysWanted)} total={r.daysWanted} unit="days"
            note={`${latestNonRem !== null ? 'The night side is already tracking. ' : ''}Each daily sync adds a day by itself; no action needed.`}
          />
          <Corridor median={null} />
          <Stats items={[sleeping, ...(latestRhr !== null ? [['Resting HR', `${latestRhr} bpm`] as Stat] : []), daytime, ['Median drop', '—', 'after 7 days']]} />
        </>
      ),
    };
  }

  const stats = (
    <Stats items={[daytime, sleeping, ['Median drop', `${median}%`, '30 days'], ['Nights under 10%', `${r.nightsUnder10} of ${r.measurableNights}`]]} />
  );

  if (r.status === 'pattern') {
    const chip = r.riser ? 'Higher at night' : 'Smaller drop';
    const text = median < 0 ? `Heart rate is ${-median}% higher at night` : median === 0 ? "Heart rate doesn't drop at night" : `Heart rate drops ${median}% at night`;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: r.riser ? chip : `${chip} · ${median}%`, found: true,
      graph: <Corridor median={median} rose compact />,
      parts: (
        <>
          <Answer text={text} />
          <Corridor median={median} rose />
          <Callout lead={`${r.nightsUnder10} of the last ${r.measurableNights} measured nights dropped less than 10%.`}>
            {r.excludedIllnessNights > 0
              ? `${plural(r.excludedIllnessNights, 'night')} with several signals off at once ${r.excludedIllnessNights > 1 ? 'were' : 'was'} left out. `
              : ''}
            Single nights never count on their own. Late meals, alcohol, heat, evening exercise and a
            busy schedule all reduce the drop. If it persists for weeks alongside symptoms, you could
            mention it to a clinician.
          </Callout>
          {stats}
        </>
      ),
    };
  }

  const label = DROP_LABEL[r.category] ?? 'No pattern';
  const band = r.category === 'extreme dipper' ? 'In the large band, over 20%.' : 'In the typical 10–20% band.';
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: label, glance: `${label} · ${median}%`, found: false,
    graph: <Corridor median={median} compact />,
    parts: (
      <>
        <Answer text={`Heart rate drops ${median}% at night`} sub={`${band} ${r.nightsUnder10} of ${r.measurableNights} measured nights dropped less than 10%.`} />
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
      : <p className="text-caption text-zinc-500">No nights with HRV entropy synced yet.</p>;
  }
  const H = compact ? 28 : 66;
  const band = r.usualLow !== null && r.usualHigh !== null && r.baselineMedian !== null;
  const y = compact ? entropyScale(r, 3, H - 3) : entropyScale(r, 6, H - 8);
  const inset = compact ? 4 : 8;
  const x = (i: number) => (pts.length === 1 ? W / 2 : inset + i * ((W - 2 * inset) / (pts.length - 1)));
  const alone = pts.some((_, i) => entropyFill(r, i) === HEX.amber);
  const aria = band
    ? `The last ${plural(pts.length, 'night')} against your usual range of ${r.usualLow!.toFixed(2)} to ${r.usualHigh!.toFixed(2)}`
    : `${plural(pts.length, 'night')} so far, with no usual range yet`;
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
      <Ends compact={compact} left={fmtDay(pts[0].date)} right={fmtDay(pts[pts.length - 1].date)} />
      {!compact && (
        <div className="mt-1.5">
          <Keys items={band
            ? [
              [<span className="w-3.5 h-2 rounded-[2px] bg-emerald-400/15" />, 'your usual range'],
              [<Dot className="bg-zinc-50" />, 'latest night'],
              ...(alone ? [[<Dot className="bg-amber-400" />, 'outside, on its own'] as [React.ReactNode, string]] : []),
              ...(r.status === 'shift' ? [[<Dot className="bg-rose-400" />, 'outside, nights in a row'] as [React.ReactNode, string]] : []),
            ]
            : [
              [<Dot className="bg-zinc-400" />, 'nights so far'],
              [<Dot className="bg-zinc-50" />, 'latest night'],
              [<span className="w-3.5 h-2 rounded-[2px] border border-dashed border-zinc-700" />, 'usual range: after about 3 weeks'],
            ]}
          />
        </div>
      )}
    </div>
  );
}

function entropyLab(days: Days): Lab {
  const r = entropyShift(days);
  const base = { key: 'entropy' as const, title: 'HRV entropy', gloss: 'a nightly HRV metric from your device', graph: <EntropyPlot r={r} compact /> };
  const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(2));
  const stats: Stat[] = [
    ['Latest night', fmt(r.lastNight)],
    ['Your baseline', fmt(r.baselineMedian)],
    ['Usual range', r.usualLow !== null && r.usualHigh !== null ? `${r.usualLow.toFixed(2)}–${r.usualHigh.toFixed(2)}` : '—'],
  ];

  if (r.status === 'collecting') {
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: 'Collecting', glance: 'Collecting · needs about 3 weeks', found: false,
      parts: <><Answer text="Learning your usual range" sub="Needs about 3 weeks of nights before it can judge a change." /><EntropyPlot r={r} /><Stats items={stats} /></>,
    };
  }
  if (r.status === 'shift') {
    const chip = `Shift · ${r.shiftNights} nights`;
    const below = r.recent[r.recent.length - 1].side < 0;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true,
      parts: (
        <>
          <Answer text={`${below ? 'Below' : 'Above'} your usual range ${r.shiftNights} nights in a row`} />
          <EntropyPlot r={r} />
          <Callout lead={`Outside your usual range on ${r.shiftNights} recent nights.`}>
            This metric moves with everyday things: a cold, alcohol, poor sleep, hard training, stress.
            It doesn't indicate any condition on its own.
          </Callout>
          <Stats items={[...stats, ['Shifted for', plural(r.shiftNights, 'night')]]} />
        </>
      ),
    };
  }
  const alone = r.recent.filter((p) => p.shifted).length;
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: 'Steady', glance: `Steady · ${plural(r.steadyNights, 'night')}`, found: false,
    parts: (
      <>
        <Answer
          text={`Steady for ${plural(r.steadyNights, 'night')}`}
          sub={alone ? `${plural(alone, 'night')} fell outside on ${alone === 1 ? 'its' : 'their'} own; it takes 3 in a row to count.` : undefined}
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
        viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" width="100%" height={H} className={`block ${compact ? 'rounded' : 'rounded-md'} bg-[#17171b]`}
        role={compact ? undefined : 'img'}
        aria-label={compact ? undefined : `Heart rate through the ${what} filed under ${fmtDate(trace.date)}${trace.stretches.length
          ? `, above 100 bpm for ${plural(trace.stretches.length, 'stretch', 'stretches')}`
          : ', with no stretch above 100 bpm while asleep'}`}
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
      <Ends compact={compact} left={fmtClock(trace.bedtimeMin)} mid={`${trace.isNap ? 'Nap' : 'Night'} · ${fmtDate(trace.date)}`} right={fmtClock(trace.wakeMin)} />
      {!compact && (
        <div className="mt-2">
          <Keys items={[
            [<span className="w-3.5 border-t border-dashed border-rose-400/60" />, '100 bpm'],
            [<span className="w-3.5 h-0.5 rounded-full bg-zinc-500" />, 'heart rate'],
            ...(trace.stretches.length ? [[<span className="w-3.5 h-0.5 rounded-full bg-rose-400" />, '10+ minutes above'] as [React.ReactNode, string]] : []),
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
      aria-label={compact ? undefined : 'One night of sleep with the 100 bpm line; stretches of ten minutes or more above it would show here'}
    >
      <div className={`relative ${compact ? 'h-[22px] rounded' : 'h-10 rounded-md'} bg-[#17171b]`}>
        <span className={`absolute inset-x-0 ${compact ? 'top-1.5' : 'top-[10px]'} border-t border-dashed border-rose-400/45`} />
        {!compact && (
          <>
            <span className="absolute right-1.5 top-0 text-micro leading-none text-zinc-400">100 bpm</span>
            <span className="absolute inset-x-0 top-[17px] text-center text-note text-zinc-600">10+ minutes above the line would show here</span>
          </>
        )}
      </div>
      <Ends compact={compact} left="fell asleep" right="woke up" />
    </div>
  );
}

function EventRows({ events }: { events: TachycardiaEvent[] }) {
  return (
    <div>
      {events.map((e) => (
        <div key={`${e.date}-${e.startMin}-${e.peakBpm}`} className="flex flex-wrap items-center justify-between gap-y-1.5 gap-x-3 py-2 border-t border-zinc-800/60 text-caption">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-zinc-200 font-semibold min-w-[76px]">{fmtDate(e.date)}</span>
            <span className="text-zinc-400 tabular-nums">{fmtClock(e.startMin)} → {fmtClock(e.endMin)} · {e.durationMin} min</span>
            {e.sleepWindow && (
              <span className="text-note px-1.5 py-0.5 rounded bg-zinc-800/90 text-zinc-300 border border-zinc-700/60 font-medium">{e.sleepWindow}</span>
            )}
            {e.stage && !['Night sleep', 'Sleep', 'Nap'].includes(e.stage) && <span className="text-note text-zinc-400">{e.stage}</span>}
          </div>
          <span className="text-rose-300 font-semibold tabular-nums whitespace-nowrap ml-auto">peak {e.peakBpm} bpm</span>
        </div>
      ))}
    </div>
  );
}

function tachyLab(days: Days, intraday: IntradayDays): Lab {
  const r = nocturnalTachycardia(days, intraday);
  const base = { key: 'tachy' as const, title: 'Nocturnal tachycardia', gloss: 'high heart rate during sleep' };
  const trace = r.trace;

  if (r.status === 'collecting' || !trace) {
    const collected = Math.min(completedIntradayDays(intraday).length, 7);
    return {
      ...base, tone: 'wait', mark: 'collecting', chip: 'Collecting', glance: `Collecting · ${collected} of 7 days`, found: false,
      graph: <EmptyNight compact />,
      parts: (
        <>
          <Collecting
            text="Collecting whole-night heart rate" done={collected} total={7} unit="days"
            note={collected >= 7
              ? 'No night has had enough heart-rate readings yet; each sync adds more by itself.'
              : 'Minute-level detail collects by itself with each sync; no action needed.'}
          />
          <EmptyNight />
          <Stats items={[['Nights scanned', r.nightsScanned], ['Stretches', r.events.length]]} />
        </>
      ),
    };
  }

  const graph = <NightTraceChart trace={trace} compact />;
  if (r.status === 'events') {
    const n = r.events.length;
    const longest = r.events.reduce((a, e) => Math.max(a, e.durationMin), 0);
    const peak = Math.max(...r.events.map((e) => e.peakBpm));
    const chip = `${plural(n, 'stretch', 'stretches')} · ${r.nightsScanned} nights`;
    return {
      ...base, tone: 'found', mark: 'found', chip, glance: chip, found: true, graph,
      parts: (
        <>
          <Answer text={`${plural(n, 'stretch', 'stretches')} above 100 bpm in ${plural(r.nightsScanned, 'night')}`} />
          <NightTraceChart trace={trace} />
          <EventRows events={r.events.slice(-6).reverse()} />
          <Callout lead={n > 1 ? `${n} stretches in ${r.nightsScanned} nights.` : 'One stretch.'}>
            Occasional ones are common. If you notice palpitations, chest pain, dizziness or
            breathlessness, seek medical care.
          </Callout>
          <Stats items={[['Nights scanned', r.nightsScanned], ['Stretches', n], ['Longest', `${longest} min`, `peak ${peak}`]]} />
        </>
      ),
    };
  }
  return {
    ...base, tone: 'quiet', mark: 'quiet', chip: 'None found', glance: `None found · ${plural(r.nightsScanned, 'night')}`, found: false, graph,
    parts: (
      <>
        <Answer text="No stretches above 100 bpm" sub={`In ${plural(r.nightsScanned, 'night')} with enough heart-rate data.`} />
        <NightTraceChart trace={trace} />
        <Stats items={[['Nights scanned', r.nightsScanned], ['Stretches', 0]]} />
      </>
    ),
  };
}

// ── page ──────────────────────────────────────────────────────────────────

function Intro({ wide = false }: { wide?: boolean }) {
  return (
    <header className={`px-1 ${wide ? 'max-w-3xl' : ''}`}>
      <p className="text-body leading-normal text-zinc-400">
        Experimental views of <b className="font-semibold text-zinc-50">multi-week patterns in your wearable data</b>, each
        against your own usual range.
      </p>
      <p className="mt-2 flex gap-2 text-caption leading-relaxed text-zinc-500">
        <Info size={14} aria-hidden className="shrink-0 mt-px text-zinc-400" />
        <span>
          Healthier is not a medical device: these cards don't detect, screen for or rule out any condition, and a
          quiet card isn't an all-clear. If you have symptoms or concerns, talk to a clinician.
        </span>
      </p>
    </header>
  );
}

function Legend() {
  const items: [Mark, string][] = [['quiet', 'nothing found'], ['collecting', 'collecting or waiting'], ['reported', 'from your device'], ['found', 'pattern found']];
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 py-2.5 text-note text-zinc-500">
      {items.map(([mark, label]) => <span key={mark} className="flex items-center gap-1.5"><StatusIcon mark={mark} size={12} />{label}</span>)}
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
    <section id={`lab-${lab.key}`} aria-label={lab.title} className="scroll-mt-20 min-w-0 bg-[#0c0c0e] border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-3">
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
    <details className="group bg-[#0c0c0e] border border-zinc-800/80 rounded-2xl px-3.5">
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
    <nav aria-label="Labs at a glance" className="grid grid-cols-3 gap-2.5">
      {labs.map((lab) => (
        <a
          key={lab.key} href={`#lab-${lab.key}`} onClick={(e) => jump(e, lab.key)}
          className="flex flex-col gap-3 px-3.5 pt-3 pb-3.5 rounded-[14px] bg-[#0c0c0e] border border-zinc-800/80 hover:border-zinc-700 transition-colors"
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
  const labs = useMemo(
    () => [sdbLab(data.days), strainLab(data.days), irnLab(data), dipLab(data.days, intraday), entropyLab(data.days), tachyLab(data.days, intraday)],
    [data, intraday],
  );

  if (!wide) {
    return (
      <div>
        <Intro />
        <section aria-label="Labs" className="mt-4 flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <span className="text-eyebrow-sm font-bold uppercase text-zinc-500">{labs.length} labs</span>
            <span className="text-note text-zinc-600">tap one to open it</span>
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
