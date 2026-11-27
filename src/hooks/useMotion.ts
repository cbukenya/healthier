import { useEffect, useRef, useState } from 'react';

/**
 * The hero cards' small entrances: a figure filling, a ring closing, a cloud drifting in. Each plays
 * once when its card first shows and eases as it arrives; with reduced motion asked for, everything
 * is simply where it ends.
 */

export const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/**
 * A number easing to `target`: from `from` when the card first shows, then from wherever it was
 * whenever `target` changes. `ms` is how long the move takes, or works it out from the distance.
 */
export function useTween(
  target: number,
  { ms = 1000, from = 0, delay = 0 }: { ms?: number | ((distance: number) => number); from?: number; delay?: number } = {},
): number {
  const [shown, setShown] = useState(() => (reducedMotion() ? target : from));
  const at = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) {
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
export function useElapsed(until: number): number {
  const [elapsed, setElapsed] = useState(() => (reducedMotion() ? until : 0));
  useEffect(() => {
    if (reducedMotion()) {
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
