import { ovulationOn, phaseMix, type CycleShape, type Phase } from '../pipeline/cyclePhases';

/**
 * The Cycle page's phase colours, and the blends drawn between them (pipeline/cyclePhases.ts says
 * where each boundary likely falls and how sure it is). One colour per phase; a found period is a
 * dimmer pink that fades in from its first day, so it never looks as sure as a logged one;
 * ovulation is never a colour of its own but an amber mark on the days it could be.
 */

export const PHASE_HEX: Record<Phase, string> = {
  menstrual: '#f472b6',
  follicular: '#4f8fb8',
  ovulation: '#fbbf24',
  earlyLuteal: '#a78bfa',
  lateLuteal: '#d8b4fe',
};

/** The phases' words in the same hues, lighter, for labels and eyebrows. */
export const PHASE_TEXT: Record<Phase, string> = {
  menstrual: '#f9a8d4',
  follicular: '#7cc0e8',
  ovulation: '#fcd34d',
  earlyLuteal: '#c4b5fd',
  lateLuteal: '#e9d5ff',
};

/** The page and card grounds the colours are dimmed toward. */
export const PAGE_GROUND = '#0c0c0e';
export const CARD_GROUND = '#111113';

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** `a` moved toward `b` by `t`, 0 to 1. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** A found period's pink on a day: dim on its first day, nearer the logged pink by its last. */
const foundPink = (day: number) => mix(PHASE_HEX.menstrual, PAGE_GROUND, Math.max(0.4, Math.min(0.8, 0.8 - 0.09 * (day - 1))));

/** A day's colour: its phases blended by how much of each it carries. */
export function dayColour(day: number, shape: CycleShape): string {
  const w = phaseMix(day, shape);
  const period = shape.foundStart ? foundPink(day) : PHASE_HEX.menstrual;
  const parts: [string, number][] = [
    [period, w.menstrual],
    [PHASE_HEX.follicular, w.follicular],
    [PHASE_HEX.earlyLuteal, w.earlyLuteal],
    [PHASE_HEX.lateLuteal, w.lateLuteal],
  ];
  const c = [0, 0, 0];
  for (const [hex, weight] of parts) rgb(hex).forEach((v, i) => { c[i] += v * weight; });
  return toHex(c);
}

/** How bright a day's ovulation mark is: strongest on the likely day, half as bright on days to come. */
export const ovulationAlpha = (day: number, shape: CycleShape, ahead = false) => 0.95 * ovulationOn(day, shape) * (ahead ? 0.5 : 1);

/** The amber dash a bar or chart draws over the days ovulation could be: faint, full, faint. */
export const OVULATION_DASH = 'linear-gradient(to right, rgba(251,191,36,0), rgba(251,191,36,0.95) 40%, rgba(251,191,36,0.95) 60%, rgba(251,191,36,0))';
