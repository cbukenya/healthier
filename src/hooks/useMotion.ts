import { useEffect, useRef, useState } from 'react';

/**
 * The hero cards' small entrances: a figure filling, a ring closing, a cloud drifting in. Each plays
 * the first time its card shows after the app starts, and eases as it arrives. Back on a page later
 * in the same session, the card is simply where it ends, as it is with reduced motion asked for.
 */

/** The device's own ask for less motion. */
export const systemReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────────────────────────── Settings › Animations, kept on this device

const PREF = { animations: 'healthier.animations', blur: 'healthier.blur' } as const;
const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
};
/** Animations turned off in Settings. */
export const animationsOff = (): boolean => read(PREF.animations) === 'off';
/** Blur reduced in Settings: glass shows as plain panels. */
export const blurReduced = (): boolean => read(PREF.blur) === 'reduced';

/** Marks the page for theme.css: whether glass blurs and stars twinkle. On start, and on every change. */
export function applyMotionPrefs(): void {
  const root = document.documentElement;
  root.dataset.blur = blurReduced() ? 'off' : 'on';
  root.dataset.motion = animationsOff() ? 'off' : 'on';
}

const listeners = new Set<() => void>();
const changed = () => {
  applyMotionPrefs();
  listeners.forEach((l) => l());
};

/** The two choices, and setting them, for the Settings card. */
export function useMotionPrefs() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return {
    animations: !animationsOff(),
    reduceBlur: blurReduced(),
    setAnimations(on: boolean) {
      write(PREF.animations, on ? null : 'off');
      changed();
    },
    setReduceBlur(on: boolean) {
      write(PREF.blur, on ? 'reduced' : null);
      changed();
    },
  };
}

/** No entrances: the device asks for less motion, or they're turned off in Settings. */
export const reducedMotion = (): boolean => systemReducedMotion() || animationsOff();

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** The entrances already played since the app started: kept in memory, so a relaunch plays them again. */
const played = new Set<string>();

/**
 * Whether the entrance called `key` should play: the first time a card with it shows this session,
 * and never with reduced motion. Cards drawn together, two rings say, share a key and all play.
 */
export function usePlayOnce(key: string): boolean {
  const [play] = useState(() => !played.has(key) && !reducedMotion());
  useEffect(() => {
    played.add(key);
  }, [key]);
  return play;
}

/**
 * A number easing to `target`: from `from` when the card first shows, then from wherever it was
 * whenever `target` changes. `ms` is how long the move takes, or works it out from the distance.
 */
export function useTween(
  target: number,
  { ms = 1000, from = 0, delay = 0, play = true }: { ms?: number | ((distance: number) => number); from?: number; delay?: number; play?: boolean } = {},
): number {
  const [shown, setShown] = useState(() => (play && !reducedMotion() ? from : target));
  const at = useRef(shown);
  const first = useRef(true);
  useEffect(() => {
    // Not playing this time: it starts where it ends; a later change still moves.
    const still = first.current && !play;
    first.current = false;
    if (still || reducedMotion()) {
      at.current = target;
      setShown(target);
      return;
    }
    const start = at.current;
    const span = typeof ms === 'function' ? ms(Math.abs(target - start)) : ms;
    const t0 = performance.now() + delay;
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - t0) / span));
      at.current = start + (target - start) * easeOut(k);
      setShown(at.current);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // `ms`, `from` and `delay` set how a move looks, not where it goes: only a new target starts one.
  }, [target]);
  return shown;
}

/**
 * Milliseconds since the card first showed, counting up to `until` and then holding there; `until`
 * at once with reduced motion. For entrances played as a sequence of steps.
 */
export function useElapsed(until: number, play = true): number {
  const [elapsed, setElapsed] = useState(() => (play && !reducedMotion() ? 0 : until));
  useEffect(() => {
    if (!play || reducedMotion()) {
      setElapsed(until);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const e = Math.min(until, now - t0);
      setElapsed(e);
      if (e < until) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [until]);
  return elapsed;
}
