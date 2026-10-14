import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_GOALS, sameGoals, type Goals } from '../pipeline/goals';

/**
 * The person's goals, for every screen and the insights.
 *
 * A change applies everywhere at once and is saved a moment later, so a run of
 * taps on a stepper sends one request. If the save fails, the goals go back to
 * the last ones saved and the Goals card says so.
 */

interface GoalsContextValue {
  goals: Goals;
  /** Set new goals. Absent where they can't change. */
  change?: (next: Goals) => void;
  /** The last save failed, so the goals went back to the ones saved before it. */
  failed: boolean;
}

const GoalsContext = createContext<GoalsContextValue>({ goals: DEFAULT_GOALS, failed: false });

/** Changes this close together are saved once. */
const SAVE_AFTER_MS = 600;

export function GoalsProvider({
  saved,
  save,
  children,
}: {
  /** The goals as the account holds them (the defaults until any are set). Keep it stable between renders. */
  saved: Goals;
  /** Keeps changed goals. Absent in demo mode, where they last as long as the page. */
  save?: (goals: Goals) => Promise<void>;
  children: React.ReactNode;
}) {
  // What the person has chosen since the page opened; until then, what the account holds.
  const [chosen, setChosen] = useState<Goals | null>(null);
  const [failed, setFailed] = useState(false);
  const lastSaved = useRef(saved);
  const pending = useRef<Goals | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastSaved.current = saved;
  }, [saved]);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next || !save || sameGoals(next, lastSaved.current)) return;
    save(next)
      .then(() => {
        lastSaved.current = next;
      })
      .catch((err) => {
        console.error('Failed to save goals:', err);
        setChosen(lastSaved.current);
        setFailed(true);
      });
  }, [save]);

  // A change still waiting when the page goes away is saved on the way out.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const change = useCallback(
    (next: Goals) => {
      setChosen(next);
      setFailed(false);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_AFTER_MS);
    },
    [flush],
  );

  const goals = chosen ?? saved;
  const value = useMemo(() => ({ goals, change, failed }), [goals, change, failed]);
  return <GoalsContext.Provider value={value}>{children}</GoalsContext.Provider>;
}

/** The person's goals, the defaults where they haven't set one. */
export const useGoals = () => useContext(GoalsContext).goals;

/** The goals with the means to change them, for the Goals card. */
export const useGoalsControl = () => useContext(GoalsContext);
