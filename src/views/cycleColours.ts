import { ovulationOn, phaseMix, type CycleShape, type Phase } from '../pipeline/cyclePhases';
import type { Look } from '../lib/theme';

/**
 * The Cycle page's phase colours, and the blends drawn between them (pipeline/cyclePhases.ts says
 * where each boundary likely falls and how sure it is). One colour per phase; a found period is a
 * dimmer pink that fades in from its first day, so it never looks as sure as a logged one;
 * ovulation is never a colour of its own but an amber mark on the days it could be.
 *
 * They're blended here, in code, so they're numbers rather than the theme's variables: one set
 * for each theme, the light one a step deeper so it holds its own on white.
 */
export interface CyclePalette {
  phase: Record<Phase, string>;
  /** The phases' words in the same hues, set to read on the page. */
  text: Record<Phase, string>;
  /** The page and card grounds the colours are dimmed toward. */
  page: string;
  card: string;
}

const DARK: CyclePalette = {
  phase: {
    menstrual: '#f472b6',
    follicular: '#4f8fb8',
    ovulation: '#fbbf24',
    earlyLuteal: '#a78bfa',
    lateLuteal: '#d8b4fe',
  },
  text: {
    menstrual: '#f9a8d4',
    follicular: '#7cc0e8',
    ovulation: '#fcd34d',
    earlyLuteal: '#c4b5fd',
    lateLuteal: '#e9d5ff',
  },
  page: '#0c0c0e',
  card: '#111113',
};

const LIGHT: CyclePalette = {
  phase: {
    menstrual: '#ec4899',
    follicular: '#4581ad',
    ovulation: '#d97706',
    earlyLuteal: '#8b5cf6',
    lateLuteal: '#c084fc',
  },
  text: {
    menstrual: '#be185d',
    follicular: '#2c6690',
    ovulation: '#b45309',
    earlyLuteal: '#6d28d9',
    lateLuteal: '#9333ea',
  },
  page: '#ffffff',
  card: '#ffffff',
};

export const cyclePalette = (look: Look): CyclePalette => (look === 'light' ? LIGHT : DARK);

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** `a` moved toward `b` by `t`, 0 to 1. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** A found period's pink on a day: dim on its first day, nearer the logged pink by its last. */
const foundPink = (p: CyclePalette, day: number) => mix(p.phase.menstrual, p.page, Math.max(0.4, Math.min(0.8, 0.8 - 0.09 * (day - 1))));

/** A day's colour: its phases blended by how much of each it carries. */
export function dayColour(day: number, shape: CycleShape, p: CyclePalette): string {
  const w = phaseMix(day, shape);
  const period = shape.foundStart ? foundPink(p, day) : p.phase.menstrual;
  const parts: [string, number][] = [
    [period, w.menstrual],
    [p.phase.follicular, w.follicular],
    [p.phase.earlyLuteal, w.earlyLuteal],
    [p.phase.lateLuteal, w.lateLuteal],
  ];
  const c = [0, 0, 0];
  for (const [hex, weight] of parts) rgb(hex).forEach((v, i) => { c[i] += v * weight; });
  return toHex(c);
}

/** How bright a day's ovulation mark is: strongest on the likely day, half as bright on days to come. */
export const ovulationAlpha = (day: number, shape: CycleShape, ahead = false) => 0.95 * ovulationOn(day, shape) * (ahead ? 0.5 : 1);

/** The amber dash a bar or chart draws over the days ovulation could be: faint, full, faint. */
export function ovulationDash(p: CyclePalette): string {
  const [r, g, b] = rgb(p.phase.ovulation);
  const at = (alpha: number) => `rgba(${r},${g},${b},${alpha})`;
  return `linear-gradient(to right, ${at(0)}, ${at(0.95)} 40%, ${at(0.95)} 60%, ${at(0)})`;
}
