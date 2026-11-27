import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity as Pulse, Flame, Heart, Wind, type LucideIcon } from 'lucide-react';
import type { SyncResult } from '../pipeline/sync';
import type { CivilDate } from '../lib/date';
import {
  HEART_STAGES, HEART_WEIGHTS, heartDirection, heartScoreOn, heartScoreTrend, nextStage, stageOf,
  type HeartPart, type HeartScore, type HeartStage, type HeartTrendPoint,
} from '../pipeline/heartScore';
import { WHO_WEEK } from '../pipeline/goals';
import { useHistory } from '../hooks/useHistory';
import { useTween } from '../hooks/useMotion';
import { t, type MessageKey } from '../i18n';
import { capitalize, formatCivil, formatInteger, formatList, formatMonth, formatMonthShort, formatNumber } from '../i18n/format';
import { Contributors, StatusPill, tint, glowStyle, useGlowFrom } from '../ui/primitives';

/**
 * The heart score at the top of Vitals: the score inside a ring of its four parts, a line on where
 * it stands and the one thing that would help most, its last six months, and each part. The
 * arithmetic, its sources and why each part counts what it does are in pipeline/heartScore.ts.
 */

/** The stages in the body battery's colours, top to bottom: the two scores read alike. */
const STAGE_COLOUR: Record<HeartStage, string> = {
  thriving: 'var(--charge-charged)',
  strong: 'var(--charge-balanced)',
  building: 'var(--charge-low)',
  low: 'var(--charge-drained)',
};
const LEARNING_COLOUR = 'var(--color-zinc-400)';
const pointsColour = (points: number) => STAGE_COLOUR[stageOf(points)];

/** The ring's order: cardio fitness centred at the top, then round the clock. */
const RING: readonly HeartPart[] = ['fitness', 'restingHr', 'activity', 'hrv'];
const ICON: Record<HeartPart, LucideIcon> = { activity: Flame, fitness: Wind, restingHr: Heart, hrv: Pulse };

const TRACK = 'var(--faint)';
const INK = 'var(--color-zinc-50)';
const SOFT = 'var(--color-zinc-400)';
const RULE = 'var(--color-zinc-500)';

const key = (k: string) => `vitals.heartScore.${k}` as MessageKey;
const stageName = (s: HeartStage) => t(key(`stage.${s}`));
const signed = (n: number) => `${n > 0 ? '+' : '−'}${formatInteger(Math.abs(n))}`;

// ───────────────────────────────────────────────────────────── the words

function partDetail(part: HeartPart, s: HeartScore): string {
  const p = s.parts;
  if (part === 'activity' && p.activity) {
    return t(key('detail.activity'), { done: p.activity.perWeek >= WHO_WEEK ? 'yes' : 'no', minutes: formatInteger(p.activity.perWeek) });
  }
  if (part === 'fitness' && p.fitness) return t(key('detail.fitness'), { value: formatNumber(p.fitness.vo2Max, 1), level: p.fitness.level });
  if (part === 'restingHr' && p.restingHr) return t(key('detail.restingHr'), { bpm: formatInteger(p.restingHr.bpm) });
  if (part === 'hrv' && p.hrv) {
    const pct = Math.round(p.hrv.changePct);
    return t(key('detail.hrv'), { direction: Math.abs(pct) < 3 ? 'steady' : pct > 0 ? 'up' : 'down', pct: formatInteger(Math.abs(pct)) });
  }
  return t(key(`detail.missing.${part}`));
}

function helpText(s: HeartScore): string {
  if (s.keep) {
    return t(key(`keep.${s.keep}`), { minutes: formatInteger(s.parts.activity?.perWeek ?? 0) });
  }
  const lever = s.lever!;
  if (lever === 'activity') {
    const perWeek = s.parts.activity!.perWeek;
    if (perWeek < 60) return t(key('help.activityLow'));
    return t(key('help.activity'), { minutes: formatInteger(perWeek), days: Math.max(1, Math.ceil((WHO_WEEK - perWeek) / 30)) });
  }
  if (lever === 'restingHr') return t(key('help.restingHr'), { bpm: formatInteger(s.parts.restingHr!.bpm) });
  if (lever === 'hrv') {
    const pct = Math.round(s.parts.hrv!.changePct);
    return t(key('help.hrv'), { direction: pct <= -3 ? 'down' : 'other', pct: formatInteger(Math.abs(pct)) });
  }
  return t(key('help.fitness'));
}

function headline(s: HeartScore, dir: ReturnType<typeof heartDirection>, today: CivilDate): string {
  const score = s.score!;
  const stage = s.stage!;
  const pointer = s.lever ? t(key(`pointer.${s.lever}`)) : '';
  const direction = dir?.direction ?? 'steady';
  const next = nextStage(score);
  // A few points from the next stage, and not on the way down: say how close it is.
  if (next && next.min - score <= 3 && direction !== 'falling' && s.lever) {
    return t(key('headline.close'), { n: next.min - score, stage: stageName(next.id), pointer });
  }
  const values = {
    n: stage === 'strong' && direction === 'rising' ? 85 - score : Math.abs(dir?.change ?? 0),
    month: dir ? formatMonth(dir.from.date, today) : '',
    pointer,
  };
  return t(key(`headline.${stage}.${direction}`), values).trim();
}

// ───────────────────────────────────────────────────────────── the ring

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 ${a1 - a0 > 180 ? 1 : 0},1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

/** About how wide a line of 12px DM Sans is: wide enough to keep clear of the ring, never exact. */
const lineWidth = (text: string) => text.length * 6.4;

/**
 * A line inside a circle of radius `r`, `dy` below its centre: as it is when it fits the circle's
 * width there, else split between words into the two most even lines.
 */
function fitLines(text: string, r: number, dy: number): string[] {
  const room = 2 * Math.sqrt(Math.max(0, r * r - dy * dy));
  const words = text.split(' ');
  if (lineWidth(text) <= room || words.length < 2) return [text];
  let best = [text];
  let worst = Infinity;
  for (let i = 1; i < words.length; i++) {
    const pair = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const longest = Math.max(...pair.map(lineWidth));
    if (longest < worst) [best, worst] = [pair, longest];
  }
  return best;
}

/**
 * The score in the middle, its stages' starts ticked round a thin ring, and the four parts round
 * the outside, each as long as it counts and filled to its points in its own stage's colour. The
 * part that would help most shows what's left to gain, tinted and outlined.
 */
function Ring({ s, since, phone }: { s: HeartScore; since: string | null; phone: boolean }) {
  const size = phone ? 232 : 320;
  const width = phone ? 326 : 440;
  const pad = 10;
  const cx = width / 2;
  const cy = size / 2 + pad;
  const R = size / 2 - 28;
  const SW = phone ? 18 : 20;
  const r2 = R - SW / 2 - 14;
  const gap = 3;
  const fs = phone ? 11 : 11.5;
  const learning = s.score === null;
  // The score ring closes from the top as the number counts up with it, and settles on the score.
  const shown = useTween(s.score ?? 0, { ms: 2000 });
  const out: React.ReactNode[] = [];

  out.push(<circle key="track" cx={cx} cy={cy} r={r2} fill="none" stroke={TRACK} strokeWidth={6} />);
  for (const edge of [50, 70, 85]) {
    const a = ((-90 + 3.6 * edge) * Math.PI) / 180;
    out.push(
      <line key={`tick${edge}`} x1={cx + (r2 - 7) * Math.cos(a)} y1={cy + (r2 - 7) * Math.sin(a)} x2={cx + (r2 + 7) * Math.cos(a)} y2={cy + (r2 + 7) * Math.sin(a)} stroke={RULE} strokeWidth={1.5} />,
    );
  }
  if (!learning) {
    const a1 = -90 + 3.6 * Math.max(1, shown);
    const colour = STAGE_COLOUR[s.stage!];
    const ex = cx + r2 * Math.cos((a1 * Math.PI) / 180);
    const ey = cy + r2 * Math.sin((a1 * Math.PI) / 180);
    out.push(<path key="score" d={arc(cx, cy, r2, -90, a1)} fill="none" stroke={colour} strokeWidth={6} strokeLinecap="round" />);
    out.push(<circle key="endGlow" cx={ex} cy={ey} r={7} fill={colour} fillOpacity={0.25} />);
    out.push(<circle key="end" cx={ex} cy={ey} r={3.5} fill={INK} />);
  }

  let a = -90 - (3.6 * HEART_WEIGHTS[RING[0]] - gap) / 2;
  for (const part of RING) {
    const span = 3.6 * HEART_WEIGHTS[part] - gap;
    const reading = s.parts[part];
    out.push(<path key={`${part}track`} d={arc(cx, cy, R, a, a + span)} fill="none" stroke={TRACK} strokeWidth={SW} />);
    if (!reading) {
      out.push(<path key={`${part}wait`} d={arc(cx, cy, R, a, a + span)} fill="none" stroke={RULE} strokeWidth={1.5} strokeDasharray="3 4" />);
    } else {
      const colour = pointsColour(reading.points);
      const filled = a + (span * reading.points) / 100;
      if (s.lever === part && reading.points < 100) {
        out.push(<path key={`${part}room`} d={arc(cx, cy, R, filled, a + span)} fill="none" stroke={colour} strokeOpacity={0.22} strokeWidth={SW} />);
        out.push(<path key={`${part}edge`} d={arc(cx, cy, R + SW / 2 + 4, filled, a + span)} fill="none" stroke={colour} strokeWidth={1.5} strokeDasharray="2 3" />);
      }
      if (reading.points > 0) out.push(<path key={`${part}fill`} d={arc(cx, cy, R, a, filled)} fill="none" stroke={colour} strokeWidth={SW} />);
    }
    // Its name and points just outside, on two lines at the sides where a line would run out of room.
    const mid = ((a + span / 2) * Math.PI) / 180;
    const lr = R + SW / 2 + (phone ? 10 : 14);
    const lx = cx + lr * Math.cos(mid);
    const ly = cy + lr * Math.sin(mid);
    const anchor = Math.cos(mid) > 0.3 ? 'start' : Math.cos(mid) < -0.3 ? 'end' : 'middle';
    const value = reading ? formatInteger(reading.points) : '··';
    const name = t(key(`short.${part}`));
    if (Math.abs(Math.cos(mid)) > 0.8) {
      out.push(<text key={`${part}name`} x={lx} y={ly - 2} textAnchor={anchor} fontSize={fs} fill={SOFT}>{name}</text>);
      out.push(<text key={`${part}value`} x={lx} y={ly + 14} textAnchor={anchor} fontSize={13} fontWeight={700} fill={INK}>{value}</text>);
    } else {
      const dy = Math.sin(mid) < -0.3 ? -4 : Math.sin(mid) > 0.3 ? 12 : 4;
      out.push(
        <text key={`${part}label`} x={lx} y={ly + dy} textAnchor={anchor} fontSize={fs} fill={SOFT}>
          {name} <tspan fill={INK} fontWeight={700}>{value}</tspan>
        </text>,
      );
    }
    a += span + gap;
  }

  const counting = RING.filter((p) => s.parts[p]).length;
  if (learning) {
    out.push(<text key="c1" x={cx} y={cy + 8} textAnchor="middle" fontFamily="var(--font-display)" fontSize={phone ? 26 : 32} fontWeight={600} fill={INK}>{t(key('learning.centre'), { count: counting })}</text>);
    out.push(<text key="c2" x={cx} y={cy + 30} textAnchor="middle" fontSize={12} fill={SOFT}>{t(key('learning.centreSub'))}</text>);
  } else {
    // The change under the score, on two lines when one would run into the ring.
    const lines = since ? fitLines(since, r2 - 10, 36) : [];
    const lift = lines.length > 1 ? 7 : 0;
    out.push(<text key="c1" x={cx} y={cy + (since ? 14 : 20) - lift} textAnchor="middle" fontFamily="var(--font-display)" fontSize={size * 0.2} fontWeight={600} fill={INK} className="tabular-nums">{formatInteger(Math.round(shown))}</text>);
    lines.forEach((line, i) => out.push(<text key={`c2${i}`} x={cx} y={cy + 36 - lift + i * 15} textAnchor="middle" fontSize={12} fill={SOFT}>{line}</text>));
  }

  const parts = formatList(RING.map((p) => t(key('ariaPart'), { name: t(key(`parts.${p}`)), points: s.parts[p] ? formatInteger(s.parts[p]!.points) : 'none' })));
  const label = learning ? t(key('ariaLearning'), { parts }) : t(key('aria'), { score: s.score!, stage: stageName(s.stage!), parts });
  return (
    <svg viewBox={`0 0 ${width} ${size + pad}`} className="block w-full h-auto" style={{ maxWidth: width }} role="img" aria-label={label}>
      {out}
    </svg>
  );
}

// ───────────────────────────────────────────────────────────── the trend

/**
 * Six months of weekly scores on a stage scale: each stage the same height and a score placed in
 * proportion inside its own stage, so the bands read evenly and 62 is still 60% of the way up
 * Building. The line takes each stage's colour as it passes through; the next stage is dashed.
 */
function Trend({ trend, phone }: { trend: HeartTrendPoint[]; phone: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = phone ? 326 : 420;
  const H = phone ? 204 : 236;
  const pl = 4;
  const pr = 6;
  const top = 4;
  const bot = 30;
  const n = trend.length;
  const stages = [...HEART_STAGES].reverse();
  const band = (H - top - bot) / stages.length;
  const X = (i: number) => pl + (i * (W - pl - pr)) / Math.max(1, n - 1);
  const Y = (v: number) => {
    const i = stages.findIndex((st, k) => v < (stages[k + 1]?.min ?? Infinity));
    const lo = stages[i].min;
    const hi = stages[i + 1]?.min ?? 100;
    return H - bot - (i + Math.min(1, Math.max(0, (v - lo) / (hi - lo)))) * band;
  };
  const last = trend.at(-1)!;
  const now = last.score!;
  const current = stageOf(now);
  const next = nextStage(now);
  const o: React.ReactNode[] = [];
  const labels: React.ReactNode[] = [];

  stages.forEach((st, i) => {
    const hi = stages[i + 1]?.min ?? 101;
    const yTop = H - bot - (i + 1) * band;
    const on = st.id === current;
    const colour = STAGE_COLOUR[st.id];
    o.push(<rect key={`b${st.id}`} x={pl} y={yTop} width={W - pl - pr} height={band} fill={colour} fillOpacity={on ? 0.2 : 0.09} />);
    if (st.min > 0) o.push(<line key={`e${st.id}`} x1={pl} x2={W - pr} y1={H - bot - i * band} y2={H - bot - i * band} stroke={colour} strokeOpacity={0.7} />);
    const name = stageName(st.id).toLocaleUpperCase();
    const range = t(key('trend.range'), { from: formatInteger(st.min), to: formatInteger(hi - 1) });
    const w = name.length * 7.6 + range.length * 6.2 + 12;
    labels.push(
      <g key={`l${st.id}`}>
        <rect x={pl + 3} y={yTop + 3} width={w} height={17} rx={5} fill="var(--card)" fillOpacity={0.72} />
        <text x={pl + 8} y={yTop + 15} fontSize={11} fontWeight={on ? 700 : 600} letterSpacing="0.06em" fill={on ? INK : SOFT}>
          {name} <tspan fontWeight={500} letterSpacing={0}>{range}</tspan>
        </text>
      </g>,
    );
  });
  for (let i = 0; i < n - 1; i++) {
    const a = trend[i].score;
    const b = trend[i + 1].score;
    if (a === null || b === null) continue;
    o.push(<line key={`s${i}`} x1={X(i)} y1={Y(a)} x2={X(i + 1)} y2={Y(b)} stroke={STAGE_COLOUR[stageOf((a + b) / 2)]} strokeWidth={3} strokeLinecap="round" />);
  }
  if (next) {
    const y = Y(next.min);
    o.push(<line key="next" x1={pl} x2={W - pr} y1={y} y2={y} stroke={INK} strokeWidth={1.5} strokeDasharray="5 4" />);
    o.push(<text key="nextText" x={W - pr - 4} y={y - 7} textAnchor="end" fontSize={12} fontWeight={600} fill={INK}>{t(key('trend.toNext'), { n: next.min - now, stage: stageName(next.id) })}</text>);
  }
  const shown = hover ?? n - 1;
  const point = trend[shown];
  if (hover !== null) o.push(<line key="scrub" x1={X(hover)} x2={X(hover)} y1={top} y2={H - bot} stroke={INK} strokeOpacity={0.5} />);
  if (point.score !== null) {
    const colour = STAGE_COLOUR[stageOf(point.score)];
    o.push(<circle key="dotGlow" cx={X(shown)} cy={Y(point.score)} r={10} fill={colour} fillOpacity={0.3} />);
    o.push(<circle key="dot" cx={X(shown)} cy={Y(point.score)} r={5.5} fill={colour} stroke="var(--card)" strokeWidth={2} />);
  }

  // A tick under every week, a longer one with the month where each starts, and now bright.
  const base = H - bot + 6;
  o.push(<line key="axis" x1={pl} x2={W - pr} y1={base} y2={base} stroke={RULE} />);
  trend.forEach((p, i) => {
    const starts = i === 0 || p.date.slice(0, 7) !== trend[i - 1].date.slice(0, 7);
    const isNow = i === n - 1;
    const long = starts || isNow;
    o.push(<line key={`t${i}`} x1={X(i)} x2={X(i)} y1={base} y2={base + (long ? 6 : 3)} stroke={isNow ? INK : long ? SOFT : RULE} />);
    // A month's name where it starts, unless it would crowd the start or the end.
    if (starts && i > 0 && X(i) < W - pr - 30) {
      o.push(<text key={`m${i}`} x={X(i)} y={base + 19} textAnchor="middle" fontSize={11.5} fill={SOFT}>{formatMonthShort(p.date)}</text>);
    }
  });
  o.push(<text key="mNow" x={X(n - 1)} y={base + 19} textAnchor="end" fontSize={11.5} fontWeight={700} fill={INK}>{formatMonthShort(last.date)}</text>);

  const scrub = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((x - pl) / (W - pl - pr)) * (n - 1)))));
  };
  const weeks = trend
    .map((p) => t(key('trend.week'), { date: formatCivil(p.date), score: p.score === null ? 'none' : formatInteger(p.score) }))
    .join(t(key('trend.separator')));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-eyebrow uppercase text-zinc-400">{t(key('trend.title'))}</span>
        {hover !== null && (
          <span className="text-caption text-zinc-300 tabular-nums">
            {t(key('trend.readout'), { date: formatCivil(point.date), score: point.score === null ? '—' : formatInteger(point.score) })}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-auto touch-pan-y cursor-crosshair"
        role="img"
        aria-label={t(key('trend.aria'), { weeks })}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => e.pointerType !== 'mouse' && setHover(null)}
      >
        {o}
        {labels}
      </svg>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── the parts

function MiniRing({ points }: { points: number | null }) {
  const size = 26;
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK} strokeWidth={4} />
      {points !== null && points > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={pointsColour(points)} strokeWidth={4} strokeDasharray={`${(c * points) / 100} ${c}`} strokeLinecap="round" />
      )}
    </svg>
  );
}

function PartRow({ part, s }: { part: HeartPart; s: HeartScore }) {
  const reading = s.parts[part];
  const Icon = ICON[part];
  const colour = reading ? pointsColour(reading.points) : LEARNING_COLOUR;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5 border-t border-zinc-800/80">
      <span className="grid size-8 place-items-center rounded-[10px]" style={{ background: tint(colour, 14) }}>
        <Icon size={16} aria-hidden style={{ color: colour }} />
      </span>
      <div className="min-w-0">
        <div className="text-body-sm font-semibold text-zinc-200">{t(key(`parts.${part}`))}</div>
        <div className="mt-0.5 text-detail text-zinc-400">{partDetail(part, s)}</div>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-right">
          <div className="text-body font-bold tabular-nums text-zinc-50">{reading ? formatInteger(reading.points) : '—'}</div>
          <div className="whitespace-nowrap text-caption text-zinc-400">{t(key('counts'), { n: HEART_WEIGHTS[part] })}</div>
        </div>
        <MiniRing points={reading?.points ?? null} />
      </div>
    </div>
  );
}

/** What would help most, or from Thriving what keeps it there, with the points it could add. */
function Help({ s }: { s: HeartScore }) {
  const part = (s.keep ?? s.lever)!;
  const Icon = ICON[part];
  const colour = pointsColour(s.parts[part]!.points);
  const gain = s.lever ? Math.round(s.gains[s.lever]!) : 0;
  const perWeek = s.parts.activity?.perWeek ?? 0;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-card-edge bg-panel p-4">
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2">
          <span className="grid size-[26px] place-items-center rounded-full" style={{ background: tint(colour, 16) }}>
            <Icon size={14} aria-hidden style={{ color: colour }} />
          </span>
          <span className="text-eyebrow uppercase text-zinc-300">{t(key(s.keep ? 'keep.title' : 'help.title'))}</span>
        </div>
        {gain > 0 && (
          <span className="shrink-0 rounded-full border px-2.5 py-0.5 text-detail font-bold text-zinc-50" style={{ borderColor: tint(colour, 50), background: tint(colour, 12) }}>
            {t(key('help.gain'), { n: gain })}
          </span>
        )}
      </div>
      <p className="text-body leading-normal text-zinc-200">{helpText(s)}</p>
      {s.lever === 'activity' && (
        <div className="mt-1.5">
          <div className="h-2 rounded-full" style={{ background: TRACK }}>
            <div className="h-2 rounded-full" style={{ width: `${Math.min(100, (perWeek / WHO_WEEK) * 100)}%`, background: colour }} />
          </div>
          <div className="mt-1.5 flex justify-between text-caption text-zinc-400">
            <span>{t(key('help.meter'), { minutes: formatInteger(perWeek) })}</span>
            <span>{formatInteger(WHO_WEEK)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── the card

export function HeartScoreCard({ data, wide }: { data: SyncResult; wide: boolean }) {
  const window = data.days;
  const today = window.at(-1)?.date ?? null;
  const history = useHistory();
  // The trend reads the six months before the window from stored history, fetched once.
  useEffect(() => {
    if (!history.days && !history.loading) history.request();
  }, [history]);
  const all = useMemo(() => {
    if (!history.days?.length || !window.length) return window;
    const first = window[0].date;
    return [...history.days.filter((d) => d.date < first), ...window];
  }, [history.days, window]);
  const now = useMemo(() => (today ? heartScoreOn(window, today) : null), [window, today]);
  const trend = useMemo(() => (today ? heartScoreTrend(all, today, 26) : []), [all, today]);
  const dir = useMemo(() => heartDirection(trend), [trend]);
  const card = useRef<HTMLElement>(null);
  const dot = useRef<HTMLSpanElement>(null);
  useGlowFrom(card, dot);
  if (!now || !today) return null;

  const learning = now.score === null;
  const colour = learning ? LEARNING_COLOUR : STAGE_COLOUR[now.stage!];
  const since = !learning && dir ? t(key('since'), { change: dir.change === 0 ? 'same' : signed(dir.change), month: formatMonth(dir.from.date, today) }) : null;
  const scored = trend.filter((p) => p.score !== null).length;
  const counting = (['activity', 'fitness', 'restingHr', 'hrv'] as const).filter((p) => now.parts[p]);
  const waiting = (['activity', 'fitness', 'restingHr', 'hrv'] as const).filter((p) => !now.parts[p]);
  const phone = !wide;

  return (
    <section
      ref={card}
      aria-label={t(key('title'))}
      className={`bg-card border border-card-edge rounded-[24px] md:rounded-[28px] p-4 md:p-[36px_40px] flex flex-col gap-5 md:gap-7 ${learning ? '' : 'glow-score'}`}
      style={learning ? undefined : glowStyle(colour)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="card-title-detail text-zinc-50">{t(key('title'))}</h2>
        <StatusPill name={learning ? t(key('stage.learning')) : stageName(now.stage!)} dot={colour} dotRef={dot} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,440px)_minmax(0,1fr)] items-center gap-4 md:gap-6">
        <div className="flex justify-center">
          <Ring s={now} since={since} phone={phone} />
        </div>
        <div className="flex flex-col gap-4">
          <p className="font-display text-headline md:text-display leading-snug text-zinc-50 text-center md:text-left">
            {learning ? t(key('learning.headline')) : headline(now, dir, today)}
          </p>
          {learning ? (
            <p className="text-body leading-normal text-zinc-300">
              {counting.length > 0 && t(key('learning.counting'), { parts: capitalize(formatList(counting.map((p) => t(key(`inText.${p}`))))), count: counting.length })}
              {waiting.map((p) => ` ${t(key('learning.joins'), { part: p })}`).join('')}
            </p>
          ) : (
            (now.lever || now.keep) && <Help s={now} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 items-start gap-5 md:gap-9">
        {!learning && scored >= 2 && <Trend trend={trend} phone={phone} />}
        <div className={!learning && scored >= 2 ? '' : 'md:col-span-2'}>
          <Contributors heading="text-eyebrow uppercase text-zinc-400 mb-1">
            {(['fitness', 'restingHr', 'activity', 'hrv'] as const).map((p) => <PartRow key={p} part={p} s={now} />)}
          </Contributors>
        </div>
      </div>
    </section>
  );
}
